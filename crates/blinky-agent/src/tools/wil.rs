use super::Tool;
use crate::providers::{AiProvider, ChatMessage, GeminiProvider, ToolDefinition};
use anyhow::{Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::debug;

pub struct WebSearchTool {
    client: Client,
}

impl WebSearchTool {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self { client }
    }

    async fn search_with_google_grounding(&self, query: &str) -> Result<Value> {
        let api_key = std::env::var("GEMINI_API_KEY")
            .or_else(|_| std::env::var("GOOGLE_API_KEY"))
            .context("No GEMINI_API_KEY available for googleSearch routing")?;

        let provider = GeminiProvider::new(api_key, Some("gemini-2.0-flash".to_string()))
            .with_grounding(true);

        let messages = vec![
            ChatMessage::user(format!(
                "Search the web and provide direct, factual research findings for: '{}'",
                query
            )),
        ];

        let ai_res = provider.chat(&messages, &[]).await?;

        Ok(json!({
            "provider": "google_search_grounding",
            "query": query,
            "answer": ai_res.content,
            "citations": ai_res.citations,
        }))
    }
}

#[async_trait]
impl Tool for WebSearchTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "web_search".to_string(),
            description: "Search the web for up-to-date information, documentation, news, or technical answers using Google Search grounding".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query keywords"
                    },
                    "count": {
                        "type": "integer",
                        "description": "Maximum number of search results to return (default: 5)"
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let count = args.get("count").and_then(|v| v.as_u64()).unwrap_or(5) as usize;

        // 1. Google Search Grounding route (preferred)
        match self.search_with_google_grounding(query).await {
            Ok(val) => {
                debug!("Google Search Grounding succeeded for query '{}'", query);
                return Ok(val);
            }
            Err(e) => {
                debug!("Google Search Grounding unavailable ({:#}); trying public fallback", e);
            }
        }

        // 2. Fallback: DuckDuckGo Lite HTML Search
        let ddg_url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding::encode(query));
        let ddg_res = self
            .client
            .get(&ddg_url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .send()
            .await;

        if let Ok(resp) = ddg_res {
            if let Ok(html) = resp.text().await {
                let re_link = regex::Regex::new(r#"class="result__snippet"[^>]*>([^<]+)<"#).unwrap();
                let mut snippets = Vec::new();
                for cap in re_link.captures_iter(&html).take(count) {
                    snippets.push(json!({
                        "content": cap[1].trim()
                    }));
                }

                return Ok(json!({
                    "provider": "duckduckgo_fallback",
                    "query": query,
                    "results": snippets
                }));
            }
        }

        Ok(json!({
            "query": query,
            "results": []
        }))
    }
}

pub struct FetchWebPageTool {
    client: Client,
}

impl FetchWebPageTool {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self { client }
    }
}

#[async_trait]
impl Tool for FetchWebPageTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "fetch_web_page".to_string(),
            description: "Download and extract the readable text content of a web page URL".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The http/https URL to extract"
                    }
                },
                "required": ["url"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let resp = self
            .client
            .get(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .send()
            .await
            .context("Failed to fetch web page")?;

        let html = resp.text().await.unwrap_or_default();

        let re_script = regex::Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap();
        let cleaned1 = re_script.replace_all(&html, " ");
        let re_style = regex::Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap();
        let cleaned2 = re_style.replace_all(&cleaned1, " ");
        let re_tags = regex::Regex::new(r"<[^>]+>").unwrap();
        let text_only = re_tags.replace_all(&cleaned2, " ");
        let re_spaces = regex::Regex::new(r"\s+").unwrap();
        let normalized = re_spaces.replace_all(&text_only, " ").trim().to_string();

        let truncated = if normalized.len() > 10_000 {
            format!("{}... [truncated]", &normalized[..10_000])
        } else {
            normalized
        };

        Ok(json!({
            "url": url,
            "content": truncated,
            "length": truncated.len(),
        }))
    }
}
