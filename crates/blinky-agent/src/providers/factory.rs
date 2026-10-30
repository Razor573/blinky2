use super::antigravity::AntigravityProvider;
use super::codex::CodexProvider;
use super::gemini::GeminiProvider;
use super::groq::GroqProvider;
use super::ollama::OllamaProvider;
use super::openai::OpenAiCompatibleProvider;
use super::vertex::VertexAiProvider;
use super::{AiProvider, AiResponse, ChatMessage, StreamChunkCallback, ToolDefinition};
use anyhow::{bail, Result};
use async_trait::async_trait;
use std::sync::Arc;
use tracing::info;

pub struct ProviderRotator {
    providers: Vec<Arc<dyn AiProvider>>,
}

impl ProviderRotator {
    pub fn new(providers: Vec<Arc<dyn AiProvider>>) -> Self {
        Self { providers }
    }
}

#[async_trait]
impl AiProvider for ProviderRotator {
    async fn name(&self) -> &'static str {
        "rotator"
    }

    async fn model_name(&self) -> &str {
        if let Some(first) = self.providers.first() {
            first.model_name().await
        } else {
            "none"
        }
    }

    async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
        on_chunk: StreamChunkCallback,
    ) -> Result<AiResponse> {
        let mut last_err = None;
        let on_chunk: Arc<dyn Fn(String) + Send + Sync> = Arc::from(on_chunk);
        for provider in &self.providers {
            let cb: StreamChunkCallback = {
                let oc = Arc::clone(&on_chunk);
                Box::new(move |chunk: String| oc(chunk))
            };
            match provider.chat_stream(messages, tools, cb).await {
                Ok(resp) => return Ok(resp),
                Err(e) => {
                    tracing::warn!("Provider {} failed: {:#}; rotating to next", provider.name().await, e);
                    last_err = Some(e);
                }
            }
        }
        bail!("All providers in rotation failed: {:?}", last_err)
    }
}

pub fn create_provider_from_env() -> Result<Arc<dyn AiProvider>> {
    let _ = dotenvy::dotenv();

    let provider_key = std::env::var("FLICKY_AI_PROVIDER")
        .or_else(|_| std::env::var("BLINKY_AI_PROVIDER"))
        .unwrap_or_else(|_| "gemini".to_string())
        .to_lowercase();

    let model_override = std::env::var("FLICKY_AI_MODEL")
        .or_else(|_| std::env::var("BLINKY_AI_MODEL"))
        .or_else(|_| std::env::var("BLINKY_GROQ_MODEL"))
        .ok();

    match provider_key.as_str() {
        "gemini" | "google" => {
            let api_key = std::env::var("GEMINI_API_KEY")
                .or_else(|_| std::env::var("GOOGLE_API_KEY"))
                .unwrap_or_default();
            if api_key.trim().is_empty() {
                bail!("No provider key configured for 'gemini', add one in Settings");
            }
            info!("Instantiating Gemini AI Provider (model: {:?})", model_override);
            Ok(Arc::new(GeminiProvider::new(api_key, model_override)))
        }
        "vertex" | "vertex-ai" => {
            let project_id = std::env::var("VERTEX_PROJECT_ID")
                .or_else(|_| std::env::var("GOOGLE_CLOUD_PROJECT"))
                .unwrap_or_default();
            let token = std::env::var("VERTEX_ACCESS_TOKEN")
                .or_else(|_| std::env::var("GOOGLE_OAUTH_TOKEN"))
                .unwrap_or_default();
            if project_id.trim().is_empty() && token.trim().is_empty() {
                bail!("No provider credentials configured for 'vertex', add Project ID and Token in Settings");
            }
            info!("Instantiating Vertex AI Provider (model: {:?})", model_override);
            Ok(Arc::new(VertexAiProvider::new(project_id, token, model_override)))
        }
        "antigravity" => {
            info!("Instantiating Google Antigravity Provider (model: {:?})", model_override);
            Ok(Arc::new(AntigravityProvider::new(model_override)))
        }
        "codex" => {
            info!("Instantiating ChatGPT Codex Provider (model: {:?})", model_override);
            Ok(Arc::new(CodexProvider::new(model_override)))
        }
        "groq" => {
            let api_key = std::env::var("GROQ_API_KEY").unwrap_or_default();
            if api_key.trim().is_empty() {
                bail!("No provider key configured for 'groq', add one in Settings");
            }
            info!("Instantiating Groq AI Provider (model: {:?})", model_override);
            Ok(Arc::new(GroqProvider::new(api_key, model_override)))
        }
        "ollama" => {
            let base_url = std::env::var("OLLAMA_BASE_URL").ok();
            info!("Instantiating Ollama AI Provider (model: {:?})", model_override);
            Ok(Arc::new(OllamaProvider::new(base_url, model_override)))
        }
        "openai" | "custom" | "deepseek" => {
            let base_url = std::env::var("OPENAI_BASE_URL")
                .or_else(|_| std::env::var("CUSTOM_AI_BASE_URL"))
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
            let api_key = std::env::var("OPENAI_API_KEY")
                .or_else(|_| std::env::var("CUSTOM_AI_KEY"))
                .unwrap_or_default();
            if api_key.trim().is_empty() {
                bail!("No provider key configured for '{}', add one in Settings", provider_key);
            }
            let model = model_override.unwrap_or_else(|| "gpt-4o-mini".to_string());
            info!("Instantiating OpenAI-compatible Provider at {} (model: {})", base_url, model);
            Ok(Arc::new(OpenAiCompatibleProvider::new(base_url, api_key, model, "openai")))
        }
        other => {
            bail!("Unknown provider '{}'. Add one in Settings.", other)
        }
    }
}
