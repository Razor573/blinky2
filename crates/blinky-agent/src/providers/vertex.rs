use super::{AiProvider, AiResponse, ChatMessage, StreamChunkCallback, ToolDefinition};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tracing::warn;

pub const VERTEX_REGIONS: &[&str] = &[
    "global",
    "us-central1",
    "europe-west2",
    "us-east5",
    "europe-west1",
    "asia-northeast1",
];

const FIRST_CHUNK_TIMEOUT_SECS: u64 = 20;
const FALLBACK_TIMEOUT_SECS: u64 = 45;

#[derive(Debug, Clone)]
pub struct ServiceAccountCreds {
    pub project_id: String,
    pub client_email: String,
    pub private_key: String,
    pub token_uri: String,
}

pub fn validate_service_account_json(raw: &str) -> Result<ServiceAccountCreds> {
    if raw.trim().is_empty() {
        bail!("Service Account JSON is empty.");
    }
    let parsed: Value = serde_json::from_str(raw)
        .context("Invalid Service Account JSON format")?;

    if parsed["type"].as_str() != Some("service_account") {
        bail!("JSON key must have \"type\": \"service_account\".");
    }
    let client_email = parsed["client_email"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("Service Account JSON is missing \"client_email\"."))?
        .to_string();

    let private_key = parsed["private_key"]
        .as_str()
        .filter(|s| s.contains("BEGIN PRIVATE KEY"))
        .ok_or_else(|| anyhow::anyhow!("Service Account JSON is missing a valid PEM \"private_key\"."))?
        .to_string();

    let project_id = parsed["project_id"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    let token_uri = parsed["token_uri"]
        .as_str()
        .unwrap_or("https://oauth2.googleapis.com/token")
        .to_string();

    Ok(ServiceAccountCreds {
        project_id,
        client_email,
        private_key,
        token_uri,
    })
}

pub struct VertexAiProvider {
    client: Client,
    project_id: String,
    access_token: String,
    model: String,
}

impl VertexAiProvider {
    pub fn new(
        project_id: impl Into<String>,
        access_token: impl Into<String>,
        model: Option<String>,
    ) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        let model_name = model.unwrap_or_else(|| "gemini-3.8-flash".to_string());

        Self {
            client,
            project_id: project_id.into(),
            access_token: access_token.into(),
            model: model_name,
        }
    }

    fn build_endpoint(&self, location: &str, action: &str, sse: bool) -> String {
        let host = if location == "global" {
            "https://aiplatform.googleapis.com".to_string()
        } else {
            format!("https://{}-aiplatform.googleapis.com", location)
        };
        let query = if sse { "?alt=sse" } else { "" };
        format!(
            "{}/v1beta1/projects/{}/locations/{}/publishers/google/models/{}:{}{}",
            host, self.project_id, location, self.model, action, query
        )
    }

    fn is_retryable_status(status: reqwest::StatusCode) -> bool {
        let code = status.as_u16();
        code == 429 || code == 409 || code == 500 || code == 502 || code == 503 || code == 504
    }
}

#[async_trait]
impl AiProvider for VertexAiProvider {
    async fn name(&self) -> &'static str {
        "vertex"
    }

    async fn model_name(&self) -> &str {
        &self.model
    }

    async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        _tools: &[ToolDefinition],
        on_chunk: StreamChunkCallback,
    ) -> Result<AiResponse> {
        let payload = json!({
            "contents": messages.iter().map(|m| {
                json!({
                    "role": match m.role {
                        crate::providers::Role::Assistant => "model",
                        _ => "user"
                    },
                    "parts": [{ "text": m.text_content() }]
                })
            }).collect::<Vec<_>>(),
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 8192
            }
        });

        let winner_found = Arc::new(AtomicBool::new(false));
        let on_chunk = Arc::new(on_chunk);

        // Hedged streaming attempt across parallel regions
        let mut futures = Vec::new();
        for &region in VERTEX_REGIONS {
            let client = self.client.clone();
            let url = self.build_endpoint(region, "streamGenerateContent", true);
            let token = self.access_token.clone();
            let payload = payload.clone();
            let winner_found = winner_found.clone();
            let on_chunk = on_chunk.clone();

            futures.push(tokio::spawn(async move {
                let mut attempts = 0;
                loop {
                    attempts += 1;
                    if winner_found.load(Ordering::Relaxed) {
                        return Err(anyhow::anyhow!("Lost race"));
                    }

                    let res = client
                        .post(&url)
                        .header("Authorization", format!("Bearer {}", token))
                        .json(&payload)
                        .send()
                        .await;

                    match res {
                        Ok(resp) => {
                            let status = resp.status();
                            if status.is_success() {
                                let mut stream = resp.bytes_stream();
                                let mut full_text = String::new();
                                let mut first_chunk = true;

                                while let Some(chunk_res) = stream.next().await {
                                    if winner_found.load(Ordering::Relaxed) && !first_chunk {
                                        break;
                                    }
                                    if let Ok(bytes) = chunk_res {
                                        let text = String::from_utf8_lossy(&bytes);
                                        for line in text.lines() {
                                            if line.starts_with("data:") {
                                                let json_str = line[5..].trim();
                                                if let Ok(v) = serde_json::from_str::<Value>(json_str) {
                                                    if let Some(t) = v["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                                                        if first_chunk {
                                                            winner_found.store(true, Ordering::Relaxed);
                                                            first_chunk = false;
                                                        }
                                                        full_text.push_str(t);
                                                        on_chunk(t.to_string());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                return Ok(full_text);
                            } else if Self::is_retryable_status(status) && attempts < 3 {
                                tokio::time::sleep(Duration::from_millis(500 * (1 << attempts))).await;
                                continue;
                            } else {
                                return Err(anyhow::anyhow!("Status: {}", status));
                            }
                        }
                        Err(e) => {
                            if attempts >= 2 {
                                return Err(e.into());
                            }
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    }
                }
            }));
        }

        // Wait for first winner within 20s deadline
        let deadline = tokio::time::sleep(Duration::from_secs(FIRST_CHUNK_TIMEOUT_SECS));
        tokio::pin!(deadline);

        for handle in futures {
            tokio::select! {
                res = handle => {
                    if let Ok(Ok(full_text)) = res {
                        if !full_text.is_empty() {
                            return Ok(AiResponse {
                                content: Some(full_text),
                                tool_calls: Vec::new(),
                                finish_reason: Some("stop".to_string()),
                                citations: Vec::new(),
                                model: Some(self.model.clone()),
                            });
                        }
                    }
                }
                _ = &mut deadline => {
                    warn!("Vertex hedged streaming deadline exceeded (20s); falling back to generateContent");
                    break;
                }
            }
        }

        // Non-streaming fallback (:generateContent)
        let fallback_url = self.build_endpoint("global", "generateContent", false);
        let resp = self
            .client
            .post(&fallback_url)
            .header("Authorization", format!("Bearer {}", self.access_token))
            .json(&payload)
            .timeout(Duration::from_secs(FALLBACK_TIMEOUT_SECS))
            .send()
            .await
            .context("Vertex non-streaming fallback failed")?;

        let val: Value = resp.json().await?;
        let text = val["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();

        on_chunk(text.clone());

        Ok(AiResponse {
            content: Some(text),
            tool_calls: Vec::new(),
            finish_reason: Some("stop".to_string()),
            citations: Vec::new(),
            model: Some(self.model.clone()),
        })
    }
}
