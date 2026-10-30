use crate::decision::{DecisionRoute, System1Classifier};
use crate::grounding::OcrGrounder;
use crate::providers::{AiProvider, ChatMessage, ToolCall};
use crate::tools::desktop::DaemonRpcClient;
use crate::tools::ToolRegistry;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;
use tracing::{debug, info, warn};

pub const WINDOWS_ASSISTANT_PROMPT: &str = r#"You are Clinky (Blinky), a fast, perceptive desktop AI companion on Windows.
You help the user with any task on their computer directly and concisely.

Operational Modes:
1. General Mode (Default):
   - Answer ANY user question directly and concisely: coding, philosophy, homework, math, writing, software help, PC settings, web research, or general conversation.
   - NEVER deflect a general question or force the user into an unwanted tutoring or problem-solving script.
   - When the user asks for information, provide the clear, direct answer immediately.
   - If pointing to UI elements on the screen is helpful, output pointing tags in the format `[POINT:x,y:label]` where x,y are screen pixel coordinates and label describes the target.

2. Tutor Mode (Opt-in only):
   - Only activate when explicitly asked to tutor or guide step-by-step.
   - Provide educational hints, guidance, and visual highlights without doing everything at once.

3. Agent Mode (Opt-in only):
   - When the user asks you to perform desktop actions (e.g., launch app, click button, type text, automate workflow), use the desktop tools safely.
   - Observe the UI state before acting. Validate actions against safety gates."#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PointingTag {
    pub x: i32,
    pub y: i32,
    pub label: String,
}

pub fn parse_pointing_tags(text: &str, screen_width: i32, screen_height: i32) -> Vec<PointingTag> {
    let mut tags = Vec::new();
    let pattern = "[POINT:";
    let mut pos = 0;

    while let Some(start) = text[pos..].find(pattern) {
        let actual_start = pos + start;
        if let Some(end) = text[actual_start..].find(']') {
            let tag_content = &text[actual_start + pattern.len()..actual_start + end];
            let parts: Vec<&str> = tag_content.splitn(3, ':').collect();
            if parts.len() == 2 || parts.len() == 3 {
                let coords: Vec<&str> = parts[0].split(',').collect();
                if coords.len() == 2 {
                    if let (Ok(x), Ok(y)) = (coords[0].trim().parse::<i32>(), coords[1].trim().parse::<i32>()) {
                        let label = if parts.len() == 3 { parts[2] } else { parts[1] };
                        if x >= 0 && x <= screen_width && y >= 0 && y <= screen_height {
                            tags.push(PointingTag {
                                x,
                                y,
                                label: label.trim().to_string(),
                            });
                        }
                    }
                }
            }
            pos = actual_start + end + 1;
        } else {
            break;
        }
    }
    tags
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStep {
    pub turn: usize,
    pub tool_calls: Vec<ToolCall>,
    pub tool_results: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResult {
    pub success: bool,
    pub answer: Option<String>,
    pub pointing_tags: Vec<PointingTag>,
    pub steps: Vec<AgentStep>,
    pub elapsed_ms: f64,
}

pub struct AgentLoop {
    provider: Arc<dyn AiProvider>,
    tools: Arc<ToolRegistry>,
    daemon: DaemonRpcClient,
}

impl AgentLoop {
    pub fn new(provider: Arc<dyn AiProvider>, tools: Arc<ToolRegistry>) -> Self {
        Self {
            provider,
            tools,
            daemon: DaemonRpcClient::new(),
        }
    }

    pub async fn run(&self, user_goal: &str, max_turns: usize) -> Result<AgentResult> {
        let start_time = Instant::now();
        info!("Starting autonomous agent loop for goal: '{}'", user_goal);

        // --- SYSTEM 1 GATEWAY & CLASSIFICATION ---
        let advice = System1Classifier::classify(user_goal);
        info!(
            "System 1 Decision: Route={:?}, Confidence={:.4}, FastPath={}",
            advice.route, advice.confidence, advice.is_atomic_fast_path
        );

        // System 1 Reflex Fast-Path strictly for atomic commands (<5ms)
        if advice.is_atomic_fast_path {
            match advice.route {
                DecisionRoute::DaemonSystem => {
                    let q_lower = user_goal.trim().to_lowercase();
                    if q_lower == "mute" || q_lower == "unmute" || q_lower.contains("mute") {
                        self.tools.execute("media_control", json!({ "command": "mute" })).await.ok();
                        let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;
                        return Ok(AgentResult {
                            success: true,
                            answer: Some("Audio mute toggled successfully.".to_string()),
                            pointing_tags: Vec::new(),
                            steps: Vec::new(),
                            elapsed_ms,
                        });
                    }
                    if q_lower.contains("volume up") || q_lower.contains("increase volume") {
                        self.tools.execute("media_control", json!({ "command": "volume_up" })).await.ok();
                        let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;
                        return Ok(AgentResult {
                            success: true,
                            answer: Some("Audio volume increased.".to_string()),
                            pointing_tags: Vec::new(),
                            steps: Vec::new(),
                            elapsed_ms,
                        });
                    }
                    if q_lower.contains("volume down") || q_lower.contains("lower volume") || q_lower.contains("decrease volume") {
                        self.tools.execute("media_control", json!({ "command": "volume_down" })).await.ok();
                        let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;
                        return Ok(AgentResult {
                            success: true,
                            answer: Some("Audio volume decreased.".to_string()),
                            pointing_tags: Vec::new(),
                            steps: Vec::new(),
                            elapsed_ms,
                        });
                    }
                    if q_lower.contains("lock") {
                        self.tools.execute("system_session", json!({ "command": "lock" })).await.ok();
                        let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;
                        return Ok(AgentResult {
                            success: true,
                            answer: Some("Workstation locked.".to_string()),
                            pointing_tags: Vec::new(),
                            steps: Vec::new(),
                            elapsed_ms,
                        });
                    }
                    if let Some(app) = advice.extracted_target {
                        self.tools.execute("launch_app", json!({ "name": app })).await.ok();
                        let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;
                        return Ok(AgentResult {
                            success: true,
                            answer: Some(format!("Launched application '{}'.", app)),
                            pointing_tags: Vec::new(),
                            steps: Vec::new(),
                            elapsed_ms,
                        });
                    }
                }
                _ => {}
            }
        }

        // --- GENERAL ASSISTANT DIRECT PATH ---
        let mut messages = vec![
            ChatMessage::system(WINDOWS_ASSISTANT_PROMPT),
            ChatMessage::user(user_goal),
        ];

        let mut steps = Vec::new();
        let mut final_answer = None;
        let mut success = false;
        let mut pointing_tags = Vec::new();

        for turn in 1..=max_turns {
            debug!("Agent Loop Turn {}/{}", turn, max_turns);

            let tool_defs = self.tools.get_definitions();
            let ai_res = self
                .provider
                .chat(&messages, &tool_defs)
                .await
                .with_context(|| format!("AI provider failed on turn {}", turn))?;

            if ai_res.tool_calls.is_empty() {
                if let Some(ans) = &ai_res.content {
                    pointing_tags = parse_pointing_tags(ans, 3840, 2160);
                }
                final_answer = ai_res.content;
                success = true;
                info!("Agent achieved goal on turn {}: {:?}", turn, final_answer);
                break;
            }

            messages.push(ChatMessage::assistant(
                ai_res.content.clone(),
                Some(ai_res.tool_calls.clone()),
            ));

            let mut step_results = Vec::new();

            for tc in &ai_res.tool_calls {
                info!("Executing tool call: {} {:?}", tc.name, tc.arguments);

                let result = if tc.name == "capture_window" || tc.name == "capture_screen" {
                    self.execute_grounded_capture(&tc.name, tc.arguments.clone()).await
                } else {
                    self.tools.execute(&tc.name, tc.arguments.clone()).await
                };

                let result_val = match result {
                    Ok(val) => val,
                    Err(e) => {
                        warn!("Tool {} error: {:#}", tc.name, e);
                        json!({ "error": e.to_string() })
                    }
                };

                step_results.push(result_val.clone());

                messages.push(ChatMessage::tool_result(
                    &tc.id,
                    &tc.name,
                    serde_json::to_string(&result_val)?,
                ));
            }

            steps.push(AgentStep {
                turn,
                tool_calls: ai_res.tool_calls,
                tool_results: step_results,
            });
        }

        let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;

        Ok(AgentResult {
            success,
            answer: final_answer,
            pointing_tags,
            steps,
            elapsed_ms,
        })
    }

    async fn execute_grounded_capture(&self, method: &str, args: Value) -> Result<Value> {
        let rpc_method = if method == "capture_screen" {
            "blinky.captureScreen"
        } else {
            "blinky.captureWindow"
        };

        let cap_res = self.daemon.call(rpc_method, args).await?;
        let img_path = cap_res
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let frame_id = cap_res
            .get("frame")
            .and_then(|f| f.get("frame_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if img_path.is_empty() || frame_id.is_empty() {
            return Ok(cap_res);
        }

        let elements = OcrGrounder::extract_elements(&img_path).await.unwrap_or_default();
        let elem_count = elements.len();

        let compact_elements: Vec<String> = elements
            .iter()
            .take(100)
            .map(|e| {
                format!(
                    "[{}] \"{}\" at [{}, {}, {}, {}]",
                    e.ref_id, e.text, e.x, e.y, e.width, e.height
                )
            })
            .collect();

        Ok(json!({
            "status": "captured",
            "frame_id": frame_id,
            "image_path": img_path,
            "total_elements_grounded": elem_count,
            "detected_ui_elements": compact_elements
        }))
    }
}
