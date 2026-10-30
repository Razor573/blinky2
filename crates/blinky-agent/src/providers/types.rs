use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_PROVIDER_ROTATION: &[&str] = &["gemini", "vertex", "antigravity", "codex"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    #[default]
    Fast,
    Smart,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum ThinkingLevel {
    Minimal,
    #[default]
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatMessagePart {
    Text { text: String },
    ImageUrl { url: String },
    ImageBytes { mime_type: String, data: Vec<u8> },
}

impl ChatMessagePart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn image_url(url: impl Into<String>) -> Self {
        Self::ImageUrl { url: url.into() }
    }

    pub fn image_bytes(mime_type: impl Into<String>, data: Vec<u8>) -> Self {
        Self::ImageBytes {
            mime_type: mime_type.into(),
            data,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<ChatMessagePart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        let text = content.into();
        Self {
            role: Role::System,
            content: Some(text.clone()),
            parts: vec![ChatMessagePart::text(text)],
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        let text = content.into();
        Self {
            role: Role::User,
            content: Some(text.clone()),
            parts: vec![ChatMessagePart::text(text)],
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    pub fn user_multimodal(parts: Vec<ChatMessagePart>) -> Self {
        let text_content = parts
            .iter()
            .filter_map(|p| match p {
                ChatMessagePart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");

        Self {
            role: Role::User,
            content: if text_content.is_empty() {
                None
            } else {
                Some(text_content)
            },
            parts,
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    pub fn assistant(content: Option<String>, tool_calls: Option<Vec<ToolCall>>) -> Self {
        let parts = content
            .as_ref()
            .map(|c| vec![ChatMessagePart::text(c.clone())])
            .unwrap_or_default();

        Self {
            role: Role::Assistant,
            content,
            parts,
            tool_calls,
            tool_call_id: None,
            name: None,
        }
    }

    pub fn tool_result(
        tool_call_id: impl Into<String>,
        name: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        let text = content.into();
        Self {
            role: Role::Tool,
            content: Some(text.clone()),
            parts: vec![ChatMessagePart::text(text)],
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
            name: Some(name.into()),
        }
    }

    pub fn text_content(&self) -> String {
        if let Some(c) = &self.content {
            return c.clone();
        }
        self.parts
            .iter()
            .filter_map(|p| match p {
                ChatMessagePart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AiResponse {
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub citations: Vec<String>,
    pub model: Option<String>,
}

pub type StreamChunkCallback = Box<dyn Fn(String) + Send + Sync>;
