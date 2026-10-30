pub mod antigravity;
pub mod codex;
pub mod factory;
pub mod gemini;
pub mod groq;
pub mod oauth_storage;
pub mod ollama;
pub mod openai;
pub mod types;
pub mod vertex;

pub use antigravity::AntigravityProvider;
pub use codex::CodexProvider;
pub use factory::{create_provider_from_env, ProviderRotator};
pub use gemini::GeminiProvider;
pub use groq::GroqProvider;
pub use ollama::OllamaProvider;
pub use openai::OpenAiCompatibleProvider;
pub use types::*;
pub use vertex::VertexAiProvider;

use anyhow::Result;
use async_trait::async_trait;

#[async_trait]
pub trait AiProvider: Send + Sync {
    async fn name(&self) -> &'static str;
    async fn model_name(&self) -> &str;
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<AiResponse> {
        self.chat_stream(messages, tools, Box::new(|_| {})).await
    }
    async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
        _on_chunk: StreamChunkCallback,
    ) -> Result<AiResponse> {
        self.chat(messages, tools).await
    }
}
