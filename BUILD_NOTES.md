# Clinky Build & Architecture Notes

## 1. Project Overview & Identity
- **User-Visible Identity**: Renamed to **Clinky** across `package.json`, `common/src-tauri/tauri.conf.json`, window titles, tray tooltips, Command Bar, and Overlay.
- **Product Mission**: General-purpose Windows AI buddy that sits beside the cursor, perceives the screen, listens and talks back, and performs safe desktop actions. Tutoring is an opt-in mode, not the default script.
- **Internal Crate Retentions**:
  - `crates/blinky-agent`: Retained name to prevent workspace dependency churn and breaking imports across existing Tauri bridge and integration tests.
  - `crates/blinky-daemon`: Linux desktop daemon kept intact in the repo for Linux builds, but decoupled from Windows execution paths.
  - `blinky_lib`: Tauri library crate name preserved in `common/src-tauri/Cargo.toml` to avoid rebuild cache invalidation and FFI link mismatches.

---

## 2. Ported Behaviors from Cue (`Razor573/cue`)
The following behaviors were ported into idiomatic Rust and TypeScript without copying JavaScript directly:

### A. Gemini Provider (`crates/blinky-agent/src/providers/gemini.rs`)
- **Model Default**: Upgraded default from retired `gemini-2.5-flash` to `gemini-2.0-flash`.
- **Streaming & SSE**: Fully implemented SSE stream chunk processing.
- **Multimodal Parts**: Support for `ChatMessagePart::Text`, `ImageUrl`, and `ImageBytes` (base64 inlineData) for screen perception.
- **Search Grounding**: Injected `googleSearch` tool definition and parsed `groundingMetadata.webSearchQueries` and search chunks.

### B. Vertex AI Provider (`crates/blinky-agent/src/providers/vertex.rs`)
- **Hedged Parallel Regions**: Dispatches concurrent requests across regional endpoints (`global`, `us-central1`, `europe-west2`, etc.).
- **First Chunk Wins**: The first region to produce a valid streaming chunk wins; slower redundant region requests are cancelled immediately.
- **20-Second First-Chunk Deadline**: If no chunk arrives within 20s, times out and rotates.
- **Non-Streaming Fallback**: Falls back to `:generateContent` if streaming fails or is throttled.
- **Exponential Backoff**: Applied to retryable HTTP status codes (`429`, `409`, `500`, `502`, `503`, `504`).
- **Service Account Validation**: Validates service account JSON keys locally prior to dispatch.

### C. Antigravity Provider (`crates/blinky-agent/src/providers/antigravity.rs`)
- **OAuth Loopback**: PKCE loopback on port `51121` (`/oauth-callback`).
- **Code Assist Endpoint**: `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`.
- **Wrapped Envelope**: Crucial architectural port from Cue—the internal endpoint requires requests wrapped in:
  ```json
  {
    "project": "<project-id>",
    "model": "<wire-model>",
    "userAgent": "antigravity",
    "requestType": "agent",
    "requestId": "agent-...",
    "request": {
      "contents": [...],
      "generationConfig": {...},
      "systemInstruction": {...}
    }
  }
  ```
  *(Sending unwrapped Gemini payloads results in HTTP 400 rejection).*
- **Project Discovery & Fallback**: Discovers project ID dynamically, falling back to `rising-fact-p41fc`.

### D. Codex Provider (`crates/blinky-agent/src/providers/codex.rs`)
- **OAuth Loopback**: PKCE loopback on port `1455` (`/auth/callback`).
- **Public Client ID**: Uses OpenAI public desktop client ID (`app_EMoamEEZ73f0CkXaXp7hrann`).
- **Responses API**: Routes queries through `https://chatgpt.com/backend-api/codex/responses`.
- **Token Rotation**: Rotates refresh tokens on every refresh cycle and persists them to secure OS storage.

### E. Secure Token Storage (`crates/blinky-agent/src/providers/oauth_storage.rs`)
- Implements secure credential persistence targeting Windows DPAPI / Credential Manager storage directories, avoiding plaintext OAuth token exposure.

### F. Black-Frame Detection (`crates/blinky-agent/src/tools/desktop.rs`)
- Ported algorithm from Cue `src/screen.js`: Samples up to 2,048 pixels across captured frames. If >= 99.5% of pixels have max RGB <= 16, the frame is flagged as blacked out (`WDA_EXCLUDEFROMCAPTURE` / DRM).
- Fails open gracefully to UI Automation and OCR text scraping when pixels are unavailable.

---

## 3. Buddy Visual Parameters Sampled from Clicky
Inspected installed HeyClicky application assets (`popup.css`, `ui.css`, `mark.js`) and sampled exact values:
- **Geometry**: Small solid triangle (22px width × 20px height), rendered via clean SVG polygon (`points="11,1 21,19 1,19"`), no cartoon eyes, face, or limbs.
- **Accent Color**: `#8EC5FF` (Clicky `--focus` cyan/light blue).
- **Glow Filter**: `filter: drop-shadow(0 0 8px rgba(142, 197, 255, 0.6))`.
- **Position Offset**: Attached to native cursor at offset `+14px` horizontal, `-16px` vertical.
- **Motion Dynamics**: Smooth `requestAnimationFrame` linear interpolation loop (0.38 lerp factor) providing zero-lag cursor glide without rubber-banding or oscillation.
- **Breathing Animation**: Subtle idle pulse scaling from `1.0` to `1.06` with synchronized glow intensity variation.

---

## 4. Antigravity Search Capability Verdict
- **Finding**: The internal Cloud Code endpoint (`daily-cloudcode-pa.googleapis.com`) does not accept the Developer Gemini `googleSearch` tool schema (`{"tools": [{"googleSearch": {}}]}`). Submitting this schema causes an immediate HTTP 400 Bad Request.
- **Architectural Solution**: Search-grounded queries are routed through the Gemini developer endpoint or the dedicated web search tool in `tools/wil.rs`, ensuring queries that need live internet information remain grounded without breaking Code Assist calls.

---

## 5. Tauri Overlay Click-Through Behavior
- **Default State**: Transparent overlay runs with `appWindow.setIgnoreCursorEvents(true)`, allowing all clicks and mouse events to pass straight through to background Windows applications.
- **Interactive State**: When the mouse cursor enters Clinky's floating response bubble, copy button, dismiss button, or action confirmation dialog, `onMouseEnter` calls `appWindow.setIgnoreCursorEvents(false)`, enabling full text selection, scrolling, and button interaction. On `onMouseLeave`, click-through is instantly re-enabled.

---

## 6. Manual Setup & Testing Checklist for Maintainer

1. **Environment Setup**:
   - Ensure Bun 1.3+, Rust (stable-x86_64-pc-windows-msvc), and Python 3.11/3.12 are installed.
   - Run `bun run setup:win` or verify `.env` contains your preferred AI provider key:
     ```env
     GEMINI_API_KEY=AIzaSy...
     # Or OPENAI_API_KEY=sk-...
     # Or GROQ_API_KEY=gsk_...
     ```
2. **Launch Application**:
   - Run: `bun run dev:no-docker`
   - Notice: Docker is not required; SearXNG is dormant and replaced by native Google Search grounding.
3. **Verify Buddy Motion**:
   - Move the mouse across any Windows application.
   - Verify the solid cyan/blue triangle sits discreetly at `+14px, -16px` from your pointer and follows smoothly.
4. **Test Query & Response Bubble**:
   - Trigger Clinky via Command Bar (hotkey or tray) or voice.
   - Ask: `"What is on my screen right now?"` or a coding question.
   - Verify the floating bubble appears beside the buddy with formatted markdown, provider pill badge, copy button, and auto-hide timer.
5. **Verify Interactivity & Click-Through**:
   - Click anywhere outside the bubble: verify clicks pass directly to the app underneath.
   - Hover the bubble: verify you can highlight text and click the Copy button.
6. **Safety Confirmation Gate**:
   - Ask `"Are there any pending actions?"`
   - Verify Clinky replies: `"Nothing awaiting confirmation."`
