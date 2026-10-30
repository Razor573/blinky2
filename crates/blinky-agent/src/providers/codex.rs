use super::oauth_storage::{get_provider_tokens, set_provider_tokens, OAuthTokens};
use super::{AiProvider, AiResponse, ChatMessage, StreamChunkCallback, ToolDefinition};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::debug;

pub const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const CODEX_OAUTH_PREFERRED_PORT: u16 = 1455;
pub const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

pub struct CodexProvider {
    client: Client,
    model: String,
}

impl CodexProvider {
    pub fn new(model: Option<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        Self {
            client,
            model: model.unwrap_or_else(|| "gpt-5.5".to_string()),
        }
    }

    pub async fn ensure_valid_token(&self) -> Result<OAuthTokens> {
        let mut tokens = get_provider_tokens("codex")
            .ok_or_else(|| anyhow::anyhow!("Not signed in with ChatGPT Codex. Sign in via Settings."))?;

        // Rotate token if expired or close to expiry
        let now_sec = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        if let Some(exp) = tokens.expires_at {
            if exp <= now_sec + 300 {
                tokens = self.refresh_token_rotation(&tokens.refresh_token).await?;
            }
        }

        Ok(tokens)
    }

    async fn refresh_token_rotation(&self, refresh_token: &str) -> Result<OAuthTokens> {
        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CODEX_OAUTH_CLIENT_ID),
        ];

        let res = self
            .client
            .post("https://auth.openai.com/oauth/token")
            .form(&params)
            .send()
            .await
            .context("Failed to refresh Codex OAuth token")?;

        if !res.status().is_success() {
            bail!("Codex token refresh failed with HTTP {}", res.status());
        }

        let body: Value = res.json().await?;
        let new_access = body["access_token"].as_str().unwrap_or_default().to_string();
        let new_refresh = body["refresh_token"].as_str().unwrap_or(refresh_token).to_string();
        let expires_in = body["expires_in"].as_u64().unwrap_or(3600);
        let now_sec = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let updated = OAuthTokens {
            access_token: new_access,
            refresh_token: new_refresh,
            expires_at: Some(now_sec + expires_in),
            email: String::new(),
            project_id: String::new(),
            account_id: String::new(),
        };

        set_provider_tokens("codex", updated.clone())?;
        Ok(updated)
    }
}

#[async_trait]
impl AiProvider for CodexProvider {
    async fn name(&self) -> &'static str {
        "codex"
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
        let tokens = self.ensure_valid_token().await?;

        let input_items: Vec<Value> = messages
            .iter()
            .map(|m| {
                json!({
                    "type": "message",
                    "role": match m.role {
                        crate::providers::Role::Assistant => "assistant",
                        _ => "user"
                    },
                    "content": [{ "type": "input_text", "text": m.text_content() }]
                })
            })
            .collect();

        let payload = json!({
            "model": self.model,
            "instructions": "You are a helpful assistant.",
            "input": input_items,
            "tools": [],
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "stream": true,
            "store": false
        });

        debug!("Connecting to Codex backend-api response stream ({})", self.model);

        let mut req = self
            .client
            .post(CODEX_RESPONSES_URL)
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("originator", "codex_cli_rs")
            .json(&payload);

        if !tokens.account_id.is_empty() {
            req = req.header("chatgpt-account-id", &tokens.account_id);
        }

        let res = req.send().await.context("Failed to connect to Codex stream")?;

        if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            bail!("ChatGPT plan limit reached (429). Please wait for your ChatGPT subscription window to reset or switch providers.");
        }

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            bail!("Codex backend error ({}): {}", status, text);
        }

        let mut stream = res.bytes_stream();
        let mut full_text = String::new();

        while let Some(chunk_res) = stream.next().await {
            let bytes = chunk_res.context("Error reading Codex SSE chunk")?;
            let raw = String::from_utf8_lossy(&bytes);

            for line in raw.lines() {
                let trimmed = line.trim();
                if !trimmed.starts_with("data:") {
                    continue;
                }
                let data_str = trimmed[5..].trim();
                if data_str.is_empty() || data_str == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(data_str) {
                    let msg_type = v["type"].as_str().unwrap_or_default();
                    if msg_type == "response.output_text.delta" {
                        if let Some(delta) = v["delta"].as_str() {
                            full_text.push_str(delta);
                            on_chunk(delta.to_string());
                        }
                    }
                }
            }
        }

        Ok(AiResponse {
            content: if full_text.is_empty() { None } else { Some(full_text) },
            tool_calls: Vec::new(),
            finish_reason: Some("stop".to_string()),
            citations: Vec::new(),
            model: Some(self.model.clone()),
        })
    }
}
