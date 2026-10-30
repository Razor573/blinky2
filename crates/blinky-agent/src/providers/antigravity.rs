use super::oauth_storage::get_provider_tokens;
use super::{AiProvider, AiResponse, ChatMessage, StreamChunkCallback, ToolDefinition};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::debug;

pub const ANTIGRAVITY_CLIENT_ID: &str =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
pub const ANTIGRAVITY_CLIENT_SECRET: &str = "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";
pub const ANTIGRAVITY_CALLBACK_PORT: u16 = 51121;
pub const ANTIGRAVITY_DEFAULT_PROJECT_ID: &str = "rising-fact-p41fc";
pub const ANTIGRAVITY_STREAM_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

pub fn resolve_wire_model(model: &str) -> String {
    let clean = model.trim().trim_start_matches("models/");
    if clean.starts_with("gemini-3.8-flash") {
        "gemini-3.8-flash-tiered".to_string()
    } else if clean.starts_with("gemini-3.7-flash") {
        "gemini-3.7-flash-tiered".to_string()
    } else if clean.starts_with("gemini-3.6-flash") {
        "gemini-3.6-flash-tiered".to_string()
    } else if clean.contains("pro") || clean.starts_with("gemini-3.1-pro") {
        "gemini-pro-agent".to_string()
    } else {
        clean.to_string()
    }
}

pub struct AntigravityProvider {
    client: Client,
    model: String,
}

impl AntigravityProvider {
    pub fn new(model: Option<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        Self {
            client,
            model: model.unwrap_or_else(|| "gemini-3.8-flash".to_string()),
        }
    }

    pub async fn ensure_access_token(&self) -> Result<(String, String)> {
        let tokens = get_provider_tokens("antigravity")
            .ok_or_else(|| anyhow::anyhow!("Not signed in with Google Antigravity. Please sign in via Settings."))?;

        let project_id = if tokens.project_id.is_empty() {
            ANTIGRAVITY_DEFAULT_PROJECT_ID.to_string()
        } else {
            tokens.project_id
        };

        Ok((tokens.access_token, project_id))
    }
}

#[async_trait]
impl AiProvider for AntigravityProvider {
    async fn name(&self) -> &'static str {
        "antigravity"
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
        let (access_token, project_id) = self.ensure_access_token().await?;
        let wire_model = resolve_wire_model(&self.model);

        // WRAPPED request shape required by Google Code Assist
        let inner_request = json!({
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
                "maxOutputTokens": 8192,
                "thinkingConfig": {
                    "includeThoughts": true,
                    "thinkingLevel": "LOW"
                }
            },
            "tools": [{ "googleSearch": {} }]
        });

        let wrapped_payload = json!({
            "project": project_id,
            "model": wire_model,
            "userAgent": "antigravity",
            "requestType": "agent",
            "requestId": format!("agent-{}", uuid::Uuid::new_v4()),
            "request": inner_request
        });

        debug!("Dispatching wrapped Antigravity Code Assist request ({})", wire_model);

        let res = self
            .client
            .post(ANTIGRAVITY_STREAM_URL)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("User-Agent", "antigravity/2.5.5 windows/amd64")
            .header("X-Goog-Api-Client", "google-cloud-sdk vscode_cloudshelleditor/0.1")
            .header("Client-Metadata", json!({ "ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" }).to_string())
            .header("Accept", "text/event-stream")
            .json(&wrapped_payload)
            .send()
            .await
            .context("Failed to connect to Antigravity stream endpoint")?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            bail!("Antigravity error ({}): {}", status, text);
        }

        let mut stream = res.bytes_stream();
        let mut full_text = String::new();
        let mut citations = Vec::new();

        while let Some(chunk_res) = stream.next().await {
            let bytes = chunk_res.context("Antigravity SSE read error")?;
            let raw = String::from_utf8_lossy(&bytes);

            for line in raw.lines() {
                let trimmed = line.trim();
                if !trimmed.starts_with("data:") {
                    continue;
                }
                let json_str = trimmed[5..].trim();
                if json_str.is_empty() || json_str == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(json_str) {
                    if let Some(candidate) = v["response"]["candidates"].as_array().and_then(|a| a.first()).or_else(|| v["candidates"].as_array().and_then(|a| a.first())) {
                        if let Some(parts) = candidate["content"]["parts"].as_array() {
                            for p in parts {
                                if let Some(t) = p["text"].as_str() {
                                    if p["thought"].as_bool() != Some(true) {
                                        full_text.push_str(t);
                                        on_chunk(t.to_string());
                                    }
                                }
                            }
                        }
                        if let Some(grounding) = candidate.get("groundingMetadata") {
                            if let Some(chunks) = grounding["groundingChunks"].as_array() {
                                for c in chunks {
                                    if let Some(uri) = c["web"]["uri"].as_str() {
                                        citations.push(uri.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        citations.dedup();

        Ok(AiResponse {
            content: if full_text.is_empty() { None } else { Some(full_text) },
            tool_calls: Vec::new(),
            finish_reason: Some("stop".to_string()),
            citations,
            model: Some(wire_model),
        })
    }
}
