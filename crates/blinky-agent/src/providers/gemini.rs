use super::{AiProvider, AiResponse, ChatMessage, Role, StreamChunkCallback, ToolCall, ToolDefinition};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::{debug, error};

pub struct GeminiProvider {
    client: Client,
    api_key: String,
    model: String,
    enable_grounding: bool,
}

impl GeminiProvider {
    pub fn new(api_key: impl Into<String>, model: Option<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        // gemini-2.5-flash was retired/deprecated; gemini-2.0-flash is current
        let model_name = model.unwrap_or_else(|| "gemini-2.0-flash".to_string());

        Self {
            client,
            api_key: api_key.into(),
            model: model_name,
            enable_grounding: true,
        }
    }

    pub fn with_grounding(mut self, enabled: bool) -> Self {
        self.enable_grounding = enabled;
        self
    }

    fn build_contents(&self, messages: &[ChatMessage]) -> (Vec<Value>, Option<Value>) {
        let mut contents = Vec::new();
        let mut system_instruction: Option<Value> = None;

        for m in messages {
            match m.role {
                Role::System => {
                    let text = m.text_content();
                    if !text.is_empty() {
                        system_instruction = Some(json!({
                            "parts": [{ "text": text }]
                        }));
                    }
                }
                Role::User => {
                    let mut parts = Vec::new();
                    for part in &m.parts {
                        match part {
                            crate::providers::ChatMessagePart::Text { text } => {
                                parts.push(json!({ "text": text }));
                            }
                            crate::providers::ChatMessagePart::ImageUrl { url } => {
                                parts.push(json!({
                                    "image_url": { "url": url }
                                }));
                            }
                            crate::providers::ChatMessagePart::ImageBytes { mime_type, data } => {
                                parts.push(json!({
                                    "inlineData": {
                                        "mimeType": mime_type,
                                        "data": base64_simd(data)
                                    }
                                }));
                            }
                        }
                    }
                    if parts.is_empty() {
                        parts.push(json!({ "text": m.text_content() }));
                    }
                    contents.push(json!({
                        "role": "user",
                        "parts": parts
                    }));
                }
                Role::Assistant => {
                    let mut parts = Vec::new();
                    let text = m.text_content();
                    if !text.is_empty() {
                        parts.push(json!({ "text": text }));
                    }
                    if let Some(tcs) = &m.tool_calls {
                        for tc in tcs {
                            parts.push(json!({
                                "functionCall": {
                                    "name": tc.name,
                                    "args": tc.arguments
                                }
                            }));
                        }
                    }
                    contents.push(json!({
                        "role": "model",
                        "parts": parts
                    }));
                }
                Role::Tool => {
                    contents.push(json!({
                        "role": "function",
                        "parts": [{
                            "functionResponse": {
                                "name": m.name.as_deref().unwrap_or("tool"),
                                "response": { "result": m.text_content() }
                            }
                        }]
                    }));
                }
            }
        }
        (contents, system_instruction)
    }
}

pub fn base64_simd(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = match chunk.len() {
            3 => (chunk[0] as u32) << 16 | (chunk[1] as u32) << 8 | (chunk[2] as u32),
            2 => (chunk[0] as u32) << 16 | (chunk[1] as u32) << 8,
            1 => (chunk[0] as u32) << 16,
            _ => continue,
        };
        result.push(CHARS[((b >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((b >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((b >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(b & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[async_trait]
impl AiProvider for GeminiProvider {
    async fn name(&self) -> &'static str {
        "gemini"
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
        let endpoint = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
            self.model, self.api_key
        );

        debug!("Sending Gemini streaming API request ({})", self.model);

        let (contents, system_instruction) = self.build_contents(messages);

        let mut payload = json!({
            "contents": contents,
            "generationConfig": {
                "temperature": 0.2
            }
        });

        if let Some(sys) = system_instruction {
            payload["systemInstruction"] = sys;
        }

        let mut tools_arr = Vec::new();
        if !tools.is_empty() {
            let func_declarations: Vec<Value> = tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters
                    })
                })
                .collect();
            tools_arr.push(json!({ "functionDeclarations": func_declarations }));
        }

        if self.enable_grounding {
            tools_arr.push(json!({ "googleSearch": {} }));
        }

        if !tools_arr.is_empty() {
            payload["tools"] = Value::Array(tools_arr);
        }

        let res = self
            .client
            .post(&endpoint)
            .json(&payload)
            .send()
            .await
            .context("Failed to send request to Gemini API")?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            error!("Gemini API error ({}): {}", status, text);
            bail!("Gemini API error ({}): {}", status, text);
        }

        let mut stream = res.bytes_stream();
        let mut buffer = String::new();
        let mut full_text = String::new();
        let mut tool_calls = Vec::new();
        let mut citations = Vec::new();
        let mut finish_reason = None;

        while let Some(item) = stream.next().await {
            let chunk = item.context("Error reading Gemini SSE chunk")?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = buffer.find("\n\n") {
                let block = buffer[..pos].to_string();
                buffer.drain(..pos + 2);

                for line in block.lines() {
                    let trimmed = line.trim();
                    if !trimmed.starts_with("data:") {
                        continue;
                    }
                    let data_str = trimmed[5..].trim();
                    if data_str.is_empty() || data_str == "[DONE]" {
                        continue;
                    }

                    if let Ok(val) = serde_json::from_str::<Value>(data_str) {
                        if let Some(candidate) = val["candidates"].as_array().and_then(|a| a.first()) {
                            if let Some(parts) = candidate["content"]["parts"].as_array() {
                                for (idx, p) in parts.iter().enumerate() {
                                    if let Some(t) = p["text"].as_str() {
                                        full_text.push_str(t);
                                        on_chunk(t.to_string());
                                    }
                                    if let Some(fc) = p.get("functionCall") {
                                        let name = fc["name"].as_str().unwrap_or("").to_string();
                                        let args = fc["args"].clone();
                                        if !name.is_empty() {
                                            tool_calls.push(ToolCall {
                                                id: format!("call_gemini_{}_{}", tool_calls.len(), idx),
                                                name,
                                                arguments: args,
                                            });
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

                            if let Some(fr) = candidate["finishReason"].as_str() {
                                finish_reason = Some(fr.to_string());
                            }
                        }
                    }
                }
            }
        }

        citations.dedup();

        Ok(AiResponse {
            content: if full_text.is_empty() { None } else { Some(full_text) },
            tool_calls,
            finish_reason,
            citations,
            model: Some(self.model.clone()),
        })
    }
}
