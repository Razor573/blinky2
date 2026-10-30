use super::{AiProvider, AiResponse, ChatMessage, Role, StreamChunkCallback, ToolDefinition};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::{debug, error};

pub struct OpenAiCompatibleProvider {
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    provider_name: &'static str,
}

impl OpenAiCompatibleProvider {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
        provider_name: &'static str,
    ) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
            provider_name,
        }
    }

    fn format_messages(&self, messages: &[ChatMessage]) -> Vec<Value> {
        messages
            .iter()
            .map(|m| {
                let role_str = match m.role {
                    Role::System => "system",
                    Role::User => "user",
                    Role::Assistant => "assistant",
                    Role::Tool => "tool",
                };

                let mut obj = json!({ "role": role_str });

                if !m.parts.is_empty() {
                    let content_parts: Vec<Value> = m
                        .parts
                        .iter()
                        .map(|p| match p {
                            crate::providers::ChatMessagePart::Text { text } => {
                                json!({ "type": "text", "text": text })
                            }
                            crate::providers::ChatMessagePart::ImageUrl { url } => {
                                json!({ "type": "image_url", "image_url": { "url": url } })
                            }
                            crate::providers::ChatMessagePart::ImageBytes { mime_type, data } => {
                                let b64 = crate::providers::gemini::base64_simd(data);
                                json!({
                                    "type": "image_url",
                                    "image_url": { "url": format!("data:{};base64,{}", mime_type, b64) }
                                })
                            }
                        })
                        .collect();
                    obj["content"] = Value::Array(content_parts);
                } else if let Some(c) = &m.content {
                    obj["content"] = json!(c);
                }

                if let Some(tcs) = &m.tool_calls {
                    obj["tool_calls"] = Value::Array(
                        tcs.iter()
                            .map(|tc| {
                                json!({
                                    "id": tc.id,
                                    "type": "function",
                                    "function": {
                                        "name": tc.name,
                                        "arguments": tc.arguments.to_string()
                                    }
                                })
                            })
                            .collect(),
                    );
                }

                if let Some(tcid) = &m.tool_call_id {
                    obj["tool_call_id"] = json!(tcid);
                }

                if let Some(n) = &m.name {
                    obj["name"] = json!(n);
                }

                obj
            })
            .collect()
    }
}

#[async_trait]
impl AiProvider for OpenAiCompatibleProvider {
    async fn name(&self) -> &'static str {
        self.provider_name
    }

    async fn model_name(&self) -> &str {
        &self.model
    }

    async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
        on_chunk: StreamChunkCallback,
    ) -> Result<AiResponse> {
        let endpoint = format!("{}/chat/completions", self.base_url);
        debug!("Sending chat request to {} ({})", endpoint, self.model);

        let mut payload = json!({
            "model": self.model,
            "messages": self.format_messages(messages),
            "temperature": 0.2,
            "stream": true,
        });

        if !tools.is_empty() {
            payload["tools"] = Value::Array(
                tools
                    .iter()
                    .map(|t| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": t.name,
                                "description": t.description,
                                "parameters": t.parameters
                            }
                        })
                    })
                    .collect(),
            );
            payload["tool_choice"] = json!("auto");
        }

        let mut req = self.client.post(&endpoint).json(&payload);
        if !self.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.api_key));
        }

        let res = req
            .send()
            .await
            .with_context(|| format!("Failed to connect to AI provider endpoint {}", endpoint))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            error!("AI Provider error ({}): {}", status, text);
            bail!("AI Provider error ({}): {}", status, text);
        }

        let mut stream = res.bytes_stream();
        let mut full_text = String::new();
        let tool_calls = Vec::new();
        let mut finish_reason = None;

        while let Some(chunk_res) = stream.next().await {
            let bytes = chunk_res.context("Error reading SSE chunk")?;
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

                if let Ok(val) = serde_json::from_str::<Value>(data_str) {
                    if let Some(choice) = val["choices"].as_array().and_then(|a| a.first()) {
                        if let Some(delta) = choice.get("delta") {
                            if let Some(content) = delta["content"].as_str() {
                                full_text.push_str(content);
                                on_chunk(content.to_string());
                            }
                        }
                        if let Some(fr) = choice["finish_reason"].as_str() {
                            finish_reason = Some(fr.to_string());
                        }
                    }
                }
            }
        }

        Ok(AiResponse {
            content: if full_text.is_empty() { None } else { Some(full_text) },
            tool_calls,
            finish_reason,
            citations: Vec::new(),
            model: Some(self.model.clone()),
        })
    }
}
