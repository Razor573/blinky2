use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use blinky_agent::providers::antigravity::{
    resolve_wire_model, ANTIGRAVITY_CALLBACK_PORT, ANTIGRAVITY_CLIENT_ID,
    ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_DEFAULT_PROJECT_ID, ANTIGRAVITY_STREAM_URL,
};
use blinky_agent::providers::codex::{
    CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_PREFERRED_PORT,
};
use blinky_agent::providers::oauth_storage::{
    delete_provider_tokens, get_provider_tokens, set_provider_tokens, OAuthTokens,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingResult {
    pub ok: bool,
    pub provider: String,
    pub model: String,
    pub latency_ms: u64,
    pub status_code: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(rename = "isCustom", skip_serializing_if = "Option::is_none")]
    pub is_custom: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthSession {
    pub auth_url: String,
    pub state: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthStatus {
    pub connected: bool,
    pub provider: String,
    pub email: Option<String>,
    pub project_id: Option<String>,
    pub expires_at: Option<u64>,
}

fn generate_pkce() -> Result<(String, String), String> {
    let mut random_bytes = [0u8; 32];
    getrandom::fill(&mut random_bytes)
        .map_err(|e| format!("Failed to generate random entropy: {e}"))?;
    let verifier = URL_SAFE_NO_PAD.encode(random_bytes);

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());

    Ok((verifier, challenge))
}

#[tauri::command]
pub async fn start_antigravity_login() -> Result<OAuthSession, String> {
    let (code_verifier, code_challenge) = generate_pkce()?;
    let state = uuid::Uuid::new_v4().to_string();

    let redirect_uri = format!("http://127.0.0.1:{}/oauth-callback", ANTIGRAVITY_CALLBACK_PORT);
    let scopes = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email openid";

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencoding::encode(ANTIGRAVITY_CLIENT_ID),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(scopes),
        urlencoding::encode(&code_challenge),
        urlencoding::encode(&state)
    );

    let listener = TcpListener::bind(("127.0.0.1", ANTIGRAVITY_CALLBACK_PORT))
        .await
        .map_err(|e| format!("Failed to bind loopback listener on port {}: {}", ANTIGRAVITY_CALLBACK_PORT, e))?;

    let expected_state = state.clone();
    let verifier = code_verifier.clone();
    let redirect_for_token = redirect_uri.clone();

    tokio::spawn(async move {
        let timeout = Duration::from_secs(300);
        let accept_fut = async {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = [0u8; 4096];
                if let Ok(n) = stream.read(&mut buffer).await {
                    let req_str = String::from_utf8_lossy(&buffer[..n]);
                    if let Some(first_line) = req_str.lines().next() {
                        let parts: Vec<&str> = first_line.split_whitespace().collect();
                        if parts.len() >= 2 {
                            let uri = parts[1];
                            if let Some(query) = uri.split('?').nth(1) {
                                let mut code_opt = None;
                                let mut state_opt = None;
                                for param in query.split('&') {
                                    let mut kv = param.split('=');
                                    if let (Some(k), Some(v)) = (kv.next(), kv.next()) {
                                        if k == "code" {
                                            code_opt = Some(urlencoding::decode(v).unwrap_or_default().to_string());
                                        } else if k == "state" {
                                            state_opt = Some(urlencoding::decode(v).unwrap_or_default().to_string());
                                        }
                                    }
                                }

                                if let (Some(code), Some(rec_state)) = (code_opt, state_opt) {
                                    if rec_state == expected_state {
                                        let client = reqwest::Client::new();
                                        let params = [
                                            ("client_id", ANTIGRAVITY_CLIENT_ID),
                                            ("client_secret", ANTIGRAVITY_CLIENT_SECRET),
                                            ("code", code.as_str()),
                                            ("code_verifier", verifier.as_str()),
                                            ("grant_type", "authorization_code"),
                                            ("redirect_uri", redirect_for_token.as_str()),
                                        ];

                                        if let Ok(res) = client.post("https://oauth2.googleapis.com/token").form(&params).send().await {
                                            if res.status().is_success() {
                                                if let Ok(body) = res.json::<Value>().await {
                                                    let access_token = body["access_token"].as_str().unwrap_or_default().to_string();
                                                    let refresh_token = body["refresh_token"].as_str().unwrap_or_default().to_string();
                                                    let expires_in = body["expires_in"].as_u64().unwrap_or(3600);
                                                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

                                                    let mut email = String::new();
                                                    if let Ok(u_res) = client.get("https://www.googleapis.com/oauth2/v2/userinfo")
                                                        .bearer_auth(&access_token)
                                                        .send().await {
                                                        if let Ok(u_body) = u_res.json::<Value>().await {
                                                            if let Some(em) = u_body["email"].as_str() {
                                                                email = em.to_string();
                                                            }
                                                        }
                                                    }

                                                    let tokens = OAuthTokens {
                                                        access_token,
                                                        refresh_token,
                                                        expires_at: Some(now + expires_in),
                                                        email,
                                                        project_id: ANTIGRAVITY_DEFAULT_PROJECT_ID.to_string(),
                                                        account_id: String::new(),
                                                    };
                                                    let _ = set_provider_tokens("antigravity", tokens);

                                                    let resp_html = "<!DOCTYPE html><html><body style=\"font-family:system-ui,sans-serif;background:#090d16;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:90vh\"><div style=\"background:#131c2e;padding:36px;border-radius:14px;border:1px solid #1e293b;text-align:center\"><h2 style=\"color:#38bdf8;margin-top:0\">Sign In Successful</h2><p style=\"color:#94a3b8\">Google Antigravity is now connected to Clinky. You can close this tab.</p></div><script>setTimeout(()=>window.close(),2000)</script></body></html>";
                                                    let http_res = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", resp_html.len(), resp_html);
                                                    let _ = stream.write_all(http_res.as_bytes()).await;
                                                    let _ = stream.flush().await;
                                                    return;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let err_html = "<!DOCTYPE html><html><body style=\"font-family:sans-serif;background:#0f172a;color:#ef4444;text-align:center;padding:40px\"><h2>Authentication Failed</h2><p>Could not verify OAuth code. Please try again.</p></body></html>";
                    let http_res = format!("HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", err_html.len(), err_html);
                    let _ = stream.write_all(http_res.as_bytes()).await;
                    let _ = stream.flush().await;
                }
            }
        };

        let _ = tokio::time::timeout(timeout, accept_fut).await;
    });

    let _ = crate::platform::open_url_impl(&auth_url);

    Ok(OAuthSession {
        auth_url,
        state,
        port: ANTIGRAVITY_CALLBACK_PORT,
    })
}

#[tauri::command]
pub async fn start_codex_login() -> Result<OAuthSession, String> {
    let (code_verifier, code_challenge) = generate_pkce()?;
    let state = uuid::Uuid::new_v4().to_string();

    let redirect_uri = format!("http://localhost:{}/auth/callback", CODEX_OAUTH_PREFERRED_PORT);
    let scopes = "openid profile email offline_access model.request model.read";

    let auth_url = format!(
        "https://auth.openai.com/authorize?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&prompt=login",
        urlencoding::encode(CODEX_OAUTH_CLIENT_ID),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(scopes),
        urlencoding::encode(&code_challenge),
        urlencoding::encode(&state)
    );

    let listener = TcpListener::bind(("127.0.0.1", CODEX_OAUTH_PREFERRED_PORT))
        .await
        .map_err(|e| format!("Failed to bind loopback listener on port {}: {}", CODEX_OAUTH_PREFERRED_PORT, e))?;

    let expected_state = state.clone();
    let verifier = code_verifier.clone();
    let redirect_for_token = redirect_uri.clone();

    tokio::spawn(async move {
        let timeout = Duration::from_secs(300);
        let accept_fut = async {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = [0u8; 4096];
                if let Ok(n) = stream.read(&mut buffer).await {
                    let req_str = String::from_utf8_lossy(&buffer[..n]);
                    if let Some(first_line) = req_str.lines().next() {
                        let parts: Vec<&str> = first_line.split_whitespace().collect();
                        if parts.len() >= 2 {
                            let uri = parts[1];
                            if let Some(query) = uri.split('?').nth(1) {
                                let mut code_opt = None;
                                let mut state_opt = None;
                                for param in query.split('&') {
                                    let mut kv = param.split('=');
                                    if let (Some(k), Some(v)) = (kv.next(), kv.next()) {
                                        if k == "code" {
                                            code_opt = Some(urlencoding::decode(v).unwrap_or_default().to_string());
                                        } else if k == "state" {
                                            state_opt = Some(urlencoding::decode(v).unwrap_or_default().to_string());
                                        }
                                    }
                                }

                                if let (Some(code), Some(rec_state)) = (code_opt, state_opt) {
                                    if rec_state == expected_state {
                                        let client = reqwest::Client::new();
                                        let params = [
                                            ("grant_type", "authorization_code"),
                                            ("client_id", CODEX_OAUTH_CLIENT_ID),
                                            ("code", code.as_str()),
                                            ("code_verifier", verifier.as_str()),
                                            ("redirect_uri", redirect_for_token.as_str()),
                                        ];

                                        if let Ok(res) = client.post("https://auth.openai.com/oauth/token").form(&params).send().await {
                                            if res.status().is_success() {
                                                if let Ok(body) = res.json::<Value>().await {
                                                    let access_token = body["access_token"].as_str().unwrap_or_default().to_string();
                                                    let refresh_token = body["refresh_token"].as_str().unwrap_or_default().to_string();
                                                    let expires_in = body["expires_in"].as_u64().unwrap_or(3600);
                                                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

                                                    let tokens = OAuthTokens {
                                                        access_token,
                                                        refresh_token,
                                                        expires_at: Some(now + expires_in),
                                                        email: String::new(),
                                                        project_id: String::new(),
                                                        account_id: String::new(),
                                                    };
                                                    let _ = set_provider_tokens("codex", tokens);

                                                    let resp_html = "<!DOCTYPE html><html><body style=\"font-family:system-ui,sans-serif;background:#090d16;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:90vh\"><div style=\"background:#131c2e;padding:36px;border-radius:14px;border:1px solid #1e293b;text-align:center\"><h2 style=\"color:#10b981;margin-top:0\">Sign In Successful</h2><p style=\"color:#94a3b8\">OpenAI Codex is now connected to Clinky. You can close this tab.</p></div><script>setTimeout(()=>window.close(),2000)</script></body></html>";
                                                    let http_res = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", resp_html.len(), resp_html);
                                                    let _ = stream.write_all(http_res.as_bytes()).await;
                                                    let _ = stream.flush().await;
                                                    return;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let err_html = "<!DOCTYPE html><html><body style=\"font-family:sans-serif;background:#0f172a;color:#ef4444;text-align:center;padding:40px\"><h2>Authentication Failed</h2><p>Could not verify Codex authorization code. Please try again.</p></body></html>";
                    let http_res = format!("HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", err_html.len(), err_html);
                    let _ = stream.write_all(http_res.as_bytes()).await;
                    let _ = stream.flush().await;
                }
            }
        };

        let _ = tokio::time::timeout(timeout, accept_fut).await;
    });

    let _ = crate::platform::open_url_impl(&auth_url);

    Ok(OAuthSession {
        auth_url,
        state,
        port: CODEX_OAUTH_PREFERRED_PORT,
    })
}

#[tauri::command]
pub fn get_oauth_status(provider: String) -> Result<OAuthStatus, String> {
    let prov = provider.to_lowercase().trim().to_string();
    if let Some(tokens) = get_provider_tokens(&prov) {
        let connected = !tokens.access_token.is_empty();
        let email = if tokens.email.is_empty() { None } else { Some(tokens.email) };
        let project_id = if tokens.project_id.is_empty() { None } else { Some(tokens.project_id) };
        Ok(OAuthStatus {
            connected,
            provider: prov,
            email,
            project_id,
            expires_at: tokens.expires_at,
        })
    } else {
        Ok(OAuthStatus {
            connected: false,
            provider: prov,
            email: None,
            project_id: None,
            expires_at: None,
        })
    }
}

#[tauri::command]
pub fn sign_out_oauth(provider: String) -> Result<(), String> {
    let prov = provider.to_lowercase().trim().to_string();
    delete_provider_tokens(&prov).map_err(|e| format!("Failed to sign out {}: {}", prov, e))?;
    Ok(())
}

#[tauri::command]
pub async fn ping_ai_model(
    provider: String,
    model: String,
    api_key: Option<String>,
    project_id: Option<String>,
    custom_url: Option<String>,
    service_account_json: Option<String>,
) -> Result<PingResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let t0 = Instant::now();
    let prov = provider.to_lowercase().trim().to_string();

    match prov.as_str() {
        "gemini" | "google" => {
            let active_model = if model.trim().is_empty() {
                "gemini-3.8-flash"
            } else {
                model.trim()
            };
            let key = api_key
                .filter(|k| !k.trim().is_empty())
                .or_else(|| std::env::var("GEMINI_API_KEY").ok())
                .or_else(|| std::env::var("GOOGLE_API_KEY").ok())
                .unwrap_or_default();

            if key.is_empty() {
                return Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: 0,
                    status_code: 401,
                    error: Some("Missing Gemini API Key".into()),
                    details: Some("Please enter your Google Gemini API key in Settings.".into()),
                });
            }

            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
                urlencoding::encode(active_model),
                urlencoding::encode(&key)
            );

            let res = client
                .post(&url)
                .json(&json!({
                    "contents": [{ "parts": [{ "text": "ping" }] }],
                    "generationConfig": { "maxOutputTokens": 1, "temperature": 0.0 }
                }))
                .send()
                .await;

            let latency = t0.elapsed().as_millis() as u64;
            match res {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        Ok(PingResult {
                            ok: true,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: 200,
                            error: None,
                            details: Some(format!("Online ({}ms)", latency)),
                        })
                    } else {
                        let text = resp.text().await.unwrap_or_default();
                        Ok(PingResult {
                            ok: false,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: status,
                            error: Some(format!("HTTP {}", status)),
                            details: Some(text),
                        })
                    }
                }
                Err(e) => Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: latency,
                    status_code: 0,
                    error: Some(e.to_string()),
                    details: Some("Connection failed or timed out.".into()),
                }),
            }
        }

        "vertex" => {
            let active_model = if model.trim().is_empty() {
                "gemini-3.8-flash"
            } else {
                model.trim()
            };

            // 1. Check if Service Account JSON was provided
            if let Some(sa_raw) = service_account_json.filter(|s| !s.trim().is_empty()) {
                match blinky_agent::providers::vertex::validate_service_account_json(&sa_raw) {
                    Ok(creds) => {
                        let latency = t0.elapsed().as_millis() as u64;
                        return Ok(PingResult {
                            ok: true,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: 200,
                            error: None,
                            details: Some(format!("Valid Service Account (Project: {}, Email: {})", creds.project_id, creds.client_email)),
                        });
                    }
                    Err(e) => {
                        let latency = t0.elapsed().as_millis() as u64;
                        return Ok(PingResult {
                            ok: false,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: 400,
                            error: Some("Invalid Service Account JSON".into()),
                            details: Some(e.to_string()),
                        });
                    }
                }
            }

            let proj = project_id
                .filter(|p| !p.trim().is_empty())
                .or_else(|| std::env::var("VERTEX_PROJECT_ID").ok())
                .unwrap_or_default();

            if proj.is_empty() {
                return Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: 0,
                    status_code: 400,
                    error: Some("Missing Vertex AI Project ID".into()),
                    details: Some("Please enter your Google Cloud Vertex AI Project ID or Service Account JSON in Settings.".into()),
                });
            }

            let key = api_key
                .filter(|k| !k.trim().is_empty())
                .or_else(|| std::env::var("VERTEX_API_KEY").ok())
                .or_else(|| std::env::var("GEMINI_API_KEY").ok());

            if let Some(k) = key {
                let url = format!(
                    "https://aiplatform.googleapis.com/v1beta1/projects/{}/locations/global/publishers/google/models/{}:generateContent?key={}",
                    proj,
                    urlencoding::encode(active_model),
                    urlencoding::encode(&k)
                );
                let res = client
                    .post(&url)
                    .json(&json!({
                        "contents": [{ "role": "user", "parts": [{ "text": "ping" }] }],
                        "generationConfig": { "maxOutputTokens": 1 }
                    }))
                    .send()
                    .await;

                let latency = t0.elapsed().as_millis() as u64;
                match res {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        if resp.status().is_success() {
                            Ok(PingResult {
                                ok: true,
                                provider: prov,
                                model: active_model.to_string(),
                                latency_ms: latency,
                                status_code: 200,
                                error: None,
                                details: Some(format!("Vertex AI Online ({}ms)", latency)),
                            })
                        } else {
                            Ok(PingResult {
                                ok: false,
                                provider: prov,
                                model: active_model.to_string(),
                                latency_ms: latency,
                                status_code: status,
                                error: Some(format!("HTTP {}", status)),
                                details: Some(format!("Project ID: {}", proj)),
                            })
                        }
                    }
                    Err(e) => Ok(PingResult {
                        ok: false,
                        provider: prov,
                        model: active_model.to_string(),
                        latency_ms: latency,
                        status_code: 0,
                        error: Some(e.to_string()),
                        details: Some(format!("Vertex endpoint unreachable for project {}", proj)),
                    }),
                }
            } else {
                let latency = t0.elapsed().as_millis() as u64;
                Ok(PingResult {
                    ok: true,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: latency,
                    status_code: 200,
                    error: None,
                    details: Some(format!("Project ID configured: {}", proj)),
                })
            }
        }

        "antigravity" => {
            let active_model = if model.trim().is_empty() {
                "gemini-3.8-flash"
            } else {
                model.trim()
            };
            let tokens = get_provider_tokens("antigravity");
            let Some(tok) = tokens else {
                return Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: 0,
                    status_code: 401,
                    error: Some("Not signed in with Google Antigravity".into()),
                    details: Some("Click 'Sign In with Google' in Settings to authenticate.".into()),
                });
            };

            let wire_model = resolve_wire_model(active_model);
            let proj = if tok.project_id.is_empty() {
                ANTIGRAVITY_DEFAULT_PROJECT_ID.to_string()
            } else {
                tok.project_id
            };

            let req_body = json!({
                "project": proj,
                "model": wire_model,
                "userAgent": "antigravity",
                "requestType": "agent",
                "requestId": format!("agent-ping-{}", uuid::Uuid::new_v4()),
                "request": {
                    "contents": [{ "role": "user", "parts": [{ "text": "ping" }] }],
                    "generationConfig": { "maxOutputTokens": 1 }
                }
            });

            let res = client
                .post(ANTIGRAVITY_STREAM_URL)
                .bearer_auth(&tok.access_token)
                .header("User-Agent", "antigravity/2.5.5 windows/amd64")
                .header(
                    "Client-Metadata",
                    json!({ "ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" }).to_string(),
                )
                .json(&req_body)
                .send()
                .await;

            let latency = t0.elapsed().as_millis() as u64;
            match res {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        Ok(PingResult {
                            ok: true,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: 200,
                            error: None,
                            details: Some(format!("Antigravity Online ({}ms)", latency)),
                        })
                    } else {
                        Ok(PingResult {
                            ok: false,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: status,
                            error: Some(format!("HTTP {}", status)),
                            details: Some(format!("Antigravity returned HTTP {}", status)),
                        })
                    }
                }
                Err(e) => Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: latency,
                    status_code: 0,
                    error: Some(e.to_string()),
                    details: Some("Failed to reach Google Antigravity Code Assist endpoint.".into()),
                }),
            }
        }

        "codex" => {
            let active_model = if model.trim().is_empty() {
                "gpt-5.5"
            } else {
                model.trim()
            };
            let tokens = get_provider_tokens("codex");
            let Some(tok) = tokens else {
                return Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: 0,
                    status_code: 401,
                    error: Some("Not signed in with OpenAI Codex".into()),
                    details: Some("Click 'Sign In with OpenAI' in Settings to authenticate.".into()),
                });
            };

            let latency = t0.elapsed().as_millis() as u64;
            if tok.access_token.is_empty() {
                Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: latency,
                    status_code: 401,
                    error: Some("Empty Codex access token".into()),
                    details: Some("Please re-authenticate via Settings.".into()),
                })
            } else {
                Ok(PingResult {
                    ok: true,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: latency,
                    status_code: 200,
                    error: None,
                    details: Some(format!("Codex Session Active ({}ms)", latency)),
                })
            }
        }

        "openai" => {
            let active_model = if model.trim().is_empty() {
                "gpt-4o-mini"
            } else {
                model.trim()
            };
            let key = api_key
                .filter(|k| !k.trim().is_empty())
                .or_else(|| std::env::var("OPENAI_API_KEY").ok())
                .unwrap_or_default();

            if key.is_empty() {
                return Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: 0,
                    status_code: 401,
                    error: Some("Missing OpenAI API Key".into()),
                    details: Some("Please enter your OpenAI API key in Settings.".into()),
                });
            }

            let res = client
                .post("https://api.openai.com/v1/chat/completions")
                .bearer_auth(&key)
                .json(&json!({
                    "model": active_model,
                    "messages": [{ "role": "user", "content": "ping" }],
                    "max_tokens": 1
                }))
                .send()
                .await;

            let latency = t0.elapsed().as_millis() as u64;
            match res {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        Ok(PingResult {
                            ok: true,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: 200,
                            error: None,
                            details: Some(format!("Online ({}ms)", latency)),
                        })
                    } else {
                        Ok(PingResult {
                            ok: false,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: status,
                            error: Some(format!("HTTP {}", status)),
                            details: Some("OpenAI API returned error.".into()),
                        })
                    }
                }
                Err(e) => Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: latency,
                    status_code: 0,
                    error: Some(e.to_string()),
                    details: Some("Network connection failed.".into()),
                }),
            }
        }

        "anthropic" => {
            let active_model = if model.trim().is_empty() {
                "claude-haiku-4-5-20251001"
            } else {
                model.trim()
            };
            let key = api_key
                .filter(|k| !k.trim().is_empty())
                .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
                .unwrap_or_default();

            if key.is_empty() {
                return Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: 0,
                    status_code: 401,
                    error: Some("Missing Anthropic API Key".into()),
                    details: Some("Please enter your Anthropic API key in Settings.".into()),
                });
            }

            let res = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": active_model,
                    "max_tokens": 1,
                    "messages": [{ "role": "user", "content": "ping" }]
                }))
                .send()
                .await;

            let latency = t0.elapsed().as_millis() as u64;
            match res {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        Ok(PingResult {
                            ok: true,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: 200,
                            error: None,
                            details: Some(format!("Online ({}ms)", latency)),
                        })
                    } else {
                        Ok(PingResult {
                            ok: false,
                            provider: prov,
                            model: active_model.to_string(),
                            latency_ms: latency,
                            status_code: status,
                            error: Some(format!("HTTP {}", status)),
                            details: Some("Anthropic API returned error.".into()),
                        })
                    }
                }
                Err(e) => Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model: active_model.to_string(),
                    latency_ms: latency,
                    status_code: 0,
                    error: Some(e.to_string()),
                    details: Some("Network connection failed.".into()),
                }),
            }
        }

        "ollama" => {
            let base = custom_url
                .filter(|u| !u.trim().is_empty())
                .unwrap_or_else(|| "http://localhost:11434".into());
            let clean_base = base.trim_end_matches('/');
            let url = format!("{}/api/tags", clean_base);

            let res = client.get(&url).send().await;
            let latency = t0.elapsed().as_millis() as u64;
            match res {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        Ok(PingResult {
                            ok: true,
                            provider: prov,
                            model,
                            latency_ms: latency,
                            status_code: 200,
                            error: None,
                            details: Some(format!("Ollama daemon active ({}ms)", latency)),
                        })
                    } else {
                        Ok(PingResult {
                            ok: false,
                            provider: prov,
                            model,
                            latency_ms: latency,
                            status_code: status,
                            error: Some(format!("HTTP {}", status)),
                            details: Some("Ollama returned an unexpected HTTP status.".into()),
                        })
                    }
                }
                Err(e) => Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model,
                    latency_ms: latency,
                    status_code: 0,
                    error: Some(e.to_string()),
                    details: Some("Could not reach Ollama at host address.".into()),
                }),
            }
        }

        _ => {
            let base = custom_url
                .filter(|u| !u.trim().is_empty())
                .unwrap_or_else(|| "http://localhost:11434/v1".into());
            let clean_base = base.trim_end_matches('/');
            let url = if clean_base.ends_with("/chat/completions") {
                clean_base.to_string()
            } else if clean_base.ends_with("/v1") {
                format!("{}/chat/completions", clean_base)
            } else {
                format!("{}/v1/chat/completions", clean_base)
            };

            let mut req = client.post(&url).json(&json!({
                "model": model,
                "messages": [{ "role": "user", "content": "ping" }],
                "max_tokens": 1
            }));

            if let Some(ref k) = api_key.filter(|k| !k.trim().is_empty()) {
                req = req.bearer_auth(k);
            }

            let res = req.send().await;
            let latency = t0.elapsed().as_millis() as u64;
            match res {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        Ok(PingResult {
                            ok: true,
                            provider: prov,
                            model,
                            latency_ms: latency,
                            status_code: 200,
                            error: None,
                            details: Some(format!("Custom endpoint active ({}ms)", latency)),
                        })
                    } else {
                        Ok(PingResult {
                            ok: false,
                            provider: prov,
                            model,
                            latency_ms: latency,
                            status_code: status,
                            error: Some(format!("HTTP {}", status)),
                            details: Some(format!("Custom API returned HTTP {}", status)),
                        })
                    }
                }
                Err(e) => Ok(PingResult {
                    ok: false,
                    provider: prov,
                    model,
                    latency_ms: latency,
                    status_code: 0,
                    error: Some(e.to_string()),
                    details: Some("Could not reach custom endpoint.".into()),
                }),
            }
        }
    }
}

fn with_auto_option(mut list: Vec<ModelOption>) -> Vec<ModelOption> {
    if !list.iter().any(|m| m.id == "auto") {
        list.insert(
            0,
            ModelOption {
                id: "auto".into(),
                name: "Auto (Intelligent Routing)".into(),
                desc: Some("Dynamically chooses fast model for simple tasks and pro model for complex reasoning".into()),
                badge: Some("Auto".into()),
                tier: Some("smart".into()),
                is_custom: None,
            },
        );
    }
    list
}

#[tauri::command]
pub async fn fetch_provider_models(
    provider: String,
    api_key: Option<String>,
    custom_url: Option<String>,
) -> Result<Vec<ModelOption>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let prov = provider.to_lowercase().trim().to_string();

    let models: Vec<ModelOption> = match prov.as_str() {
        "gemini" | "google" => {
            let key = api_key
                .filter(|k| !k.trim().is_empty())
                .or_else(|| std::env::var("GEMINI_API_KEY").ok())
                .or_else(|| std::env::var("GOOGLE_API_KEY").ok());

            if let Some(k) = key {
                let url = format!(
                    "https://generativelanguage.googleapis.com/v1beta/models?key={}",
                    urlencoding::encode(&k)
                );
                if let Ok(res) = client.get(&url).send().await {
                    if res.status().is_success() {
                        if let Ok(val) = res.json::<Value>().await {
                            if let Some(arr) = val["models"].as_array() {
                                let mut list = Vec::new();
                                for m in arr {
                                    let id_raw = m["name"].as_str().unwrap_or_default();
                                    let id = id_raw.trim_start_matches("models/").to_string();
                                    let can_gen = m["supportedGenerationMethods"]
                                        .as_array()
                                        .map(|g| g.iter().any(|v| v.as_str() == Some("generateContent")))
                                        .unwrap_or(false);

                                    if can_gen && (id.contains("gemini") || id.contains("flash") || id.contains("pro")) {
                                        let name = m["displayName"].as_str().unwrap_or(&id).to_string();
                                        let desc = m["description"].as_str().map(|s| s.to_string());
                                        let tier = if id.contains("pro") || id.contains("ultra") {
                                            "smart"
                                        } else {
                                            "fast"
                                        };
                                        let badge = if id.contains("3.8") {
                                            "Default Fast"
                                        } else if id.contains("3.5") {
                                            "Fast"
                                        } else if id.contains("pro") {
                                            "Smart"
                                        } else {
                                            "Gemini"
                                        };

                                        list.push(ModelOption {
                                            id,
                                            name,
                                            desc,
                                            badge: Some(badge.to_string()),
                                            tier: Some(tier.to_string()),
                                            is_custom: None,
                                        });
                                    }
                                }
                                if !list.is_empty() {
                                    return Ok(with_auto_option(list));
                                }
                            }
                        }
                    }
                }
            }

            vec![
                ModelOption { id: "gemini-3.8-flash".into(), name: "Gemini 3.8 Flash".into(), desc: Some("Current generation Flash model".into()), badge: Some("Default Fast".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gemini-3.7-flash".into(), name: "Gemini 3.7 Flash".into(), desc: Some("High-speed multimodal reasoning".into()), badge: Some("Fast".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gemini-3.6-flash".into(), name: "Gemini 3.6 Flash".into(), desc: Some("Fast multimodal".into()), badge: Some("Fast".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gemini-3.5-flash".into(), name: "Gemini 3.5 Flash".into(), desc: Some("Balanced accuracy & speed".into()), badge: Some("Fast".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gemini-3.5-flash-lite".into(), name: "Gemini 3.5 Flash-Lite".into(), desc: Some("Quota-friendly low latency".into()), badge: Some("Ultra-Fast".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gemini-3.1-flash-lite".into(), name: "Gemini 3.1 Flash-Lite".into(), desc: Some("Lightweight model".into()), badge: Some("Lite".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gemini-3.1-pro-preview".into(), name: "Gemini 3.1 Pro Preview".into(), desc: Some("Advanced reasoning model".into()), badge: Some("Smart".into()), tier: Some("smart".into()), is_custom: None },
                ModelOption { id: "gemini-4-argon".into(), name: "Gemini 4 Argon".into(), desc: Some("Deep intelligence & long context".into()), badge: Some("Flagship".into()), tier: Some("smart".into()), is_custom: None },
            ]
        }

        "vertex" => vec![
            ModelOption { id: "gemini-3.8-flash".into(), name: "Gemini 3.8 Flash".into(), desc: Some("Vertex enterprise fast model".into()), badge: Some("Default Fast".into()), tier: Some("fast".into()), is_custom: None },
            ModelOption { id: "gemini-4-argon".into(), name: "Gemini 4 Argon".into(), desc: Some("Vertex enterprise deep reasoning".into()), badge: Some("Smart".into()), tier: Some("smart".into()), is_custom: None },
            ModelOption { id: "gemini-3.1-pro-preview".into(), name: "Gemini 3.1 Pro Preview".into(), desc: Some("Vertex enterprise preview".into()), badge: Some("Pro".into()), tier: Some("smart".into()), is_custom: None },
        ],

        "antigravity" => vec![
            ModelOption { id: "gemini-3.8-flash".into(), name: "Gemini 3.8 Flash".into(), desc: Some("Google Antigravity fast tier".into()), badge: Some("Default Fast".into()), tier: Some("fast".into()), is_custom: None },
            ModelOption { id: "gemini-3.1-pro-high".into(), name: "Gemini 3.1 Pro High".into(), desc: Some("Google Antigravity high-reasoning tier".into()), badge: Some("Smart".into()), tier: Some("smart".into()), is_custom: None },
            ModelOption { id: "gemini-3.7-flash".into(), name: "Gemini 3.7 Flash".into(), desc: Some("Fast inference".into()), badge: Some("Flash".into()), tier: Some("fast".into()), is_custom: None },
        ],

        "codex" => vec![
            ModelOption { id: "gpt-5.5".into(), name: "GPT-5.5".into(), desc: Some("Codex fast completion".into()), badge: Some("Fast".into()), tier: Some("fast".into()), is_custom: None },
            ModelOption { id: "gpt-5.5-codex".into(), name: "GPT-5.5 Codex".into(), desc: Some("Codex full reasoning".into()), badge: Some("Default Smart".into()), tier: Some("smart".into()), is_custom: None },
            ModelOption { id: "gpt-5.4-codex".into(), name: "GPT-5.4 Codex".into(), desc: Some("High capability code model".into()), badge: Some("Smart".into()), tier: Some("smart".into()), is_custom: None },
            ModelOption { id: "gpt-5.2-codex".into(), name: "GPT-5.2 Codex".into(), desc: Some("Stable code intelligence".into()), badge: Some("Codex".into()), tier: Some("smart".into()), is_custom: None },
        ],

        "openai" => {
            let key = api_key
                .filter(|k| !k.trim().is_empty())
                .or_else(|| std::env::var("OPENAI_API_KEY").ok());

            if let Some(k) = key {
                if let Ok(res) = client.get("https://api.openai.com/v1/models").bearer_auth(&k).send().await {
                    if res.status().is_success() {
                        if let Ok(val) = res.json::<Value>().await {
                            if let Some(arr) = val["data"].as_array() {
                                let mut list = Vec::new();
                                for m in arr {
                                    let id = m["id"].as_str().unwrap_or_default().to_string();
                                    if id.starts_with("gpt-") || id.starts_with("o1-") || id.starts_with("o3-") {
                                        let tier = if id.contains("mini") || id.contains("nano") { "fast" } else { "smart" };
                                        list.push(ModelOption {
                                            id: id.clone(),
                                            name: id.clone(),
                                            desc: Some("OpenAI API model".into()),
                                            badge: Some(if tier == "fast" { "Fast" } else { "Smart" }.into()),
                                            tier: Some(tier.into()),
                                            is_custom: None,
                                        });
                                    }
                                }
                                if !list.is_empty() {
                                    return Ok(with_auto_option(list));
                                }
                            }
                        }
                    }
                }
            }

            vec![
                ModelOption { id: "gpt-4o-mini".into(), name: "GPT-4o mini".into(), desc: Some("Fast multimodal chat".into()), badge: Some("Default Fast".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gpt-4.1-mini".into(), name: "GPT-4.1 mini".into(), desc: Some("Next-gen mini reasoning".into()), badge: Some("Fast".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gpt-4.1-nano".into(), name: "GPT-4.1 nano".into(), desc: Some("Lowest latency completion".into()), badge: Some("Ultra-Fast".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "gpt-4o".into(), name: "GPT-4o".into(), desc: Some("High capability flagship".into()), badge: Some("Smart".into()), tier: Some("smart".into()), is_custom: None },
                ModelOption { id: "gpt-4.1".into(), name: "GPT-4.1".into(), desc: Some("Advanced flagship reasoning".into()), badge: Some("Smart".into()), tier: Some("smart".into()), is_custom: None },
                ModelOption { id: "o3-mini".into(), name: "o3-mini".into(), desc: Some("Deep math and code reasoning".into()), badge: Some("Reasoning".into()), tier: Some("smart".into()), is_custom: None },
            ]
        }

        "anthropic" => vec![
            ModelOption { id: "claude-haiku-4-5-20251001".into(), name: "Claude Haiku 4.5".into(), desc: Some("Ultra-fast Claude 4.5".into()), badge: Some("Default Fast".into()), tier: Some("fast".into()), is_custom: None },
            ModelOption { id: "claude-sonnet-4-5-20250929".into(), name: "Claude Sonnet 4.5".into(), desc: Some("Top-tier code and vision reasoning".into()), badge: Some("Default Smart".into()), tier: Some("smart".into()), is_custom: None },
        ],

        "ollama" => {
            let base = custom_url
                .filter(|u| !u.trim().is_empty())
                .unwrap_or_else(|| "http://localhost:11434".into());
            let clean_base = base.trim_end_matches('/');
            let url = format!("{}/api/tags", clean_base);

            if let Ok(res) = client.get(&url).send().await {
                if res.status().is_success() {
                    if let Ok(val) = res.json::<Value>().await {
                        if let Some(arr) = val["models"].as_array() {
                            let mut list = Vec::new();
                            for m in arr {
                                if let Some(name) = m["name"].as_str() {
                                    list.push(ModelOption {
                                        id: name.to_string(),
                                        name: name.to_string(),
                                        desc: Some("Local Ollama model".into()),
                                        badge: Some("Local".into()),
                                        tier: Some("fast".into()),
                                        is_custom: None,
                                    });
                                }
                            }
                            if !list.is_empty() {
                                return Ok(with_auto_option(list));
                            }
                        }
                    }
                }
            }

            vec![
                ModelOption { id: "qwen2.5:7b".into(), name: "Qwen 2.5 7B".into(), desc: Some("Local instruction model".into()), badge: Some("Recommended".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "llama3.2:latest".into(), name: "Llama 3.2".into(), desc: Some("Lightweight local model".into()), badge: Some("Fast Local".into()), tier: Some("fast".into()), is_custom: None },
                ModelOption { id: "deepseek-r1:8b".into(), name: "DeepSeek R1 8B".into(), desc: Some("Local reasoning model".into()), badge: Some("Local Reasoning".into()), tier: Some("smart".into()), is_custom: None },
            ]
        }

        _ => vec![
            ModelOption { id: "default".into(), name: "Custom Default".into(), desc: Some("Custom OpenAI-compatible model".into()), badge: Some("Custom".into()), tier: Some("fast".into()), is_custom: Some(true) },
        ],
    };

    Ok(with_auto_option(models))
}
