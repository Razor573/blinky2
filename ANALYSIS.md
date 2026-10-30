# Clinky Codebase Analysis (Phase 0)

## Executive Summary
Clinky is being transitioned from upstream Blinky (originally an offline-first Linux/desktop tutor) into a general-purpose, screen-aware Windows AI companion. The codebase contains a Tauri 2 + React 19 frontend, a Rust agent (`crates/blinky-agent`), a legacy Linux daemon (`crates/blinky-daemon`), Windows-specific Python helpers in `windows/python/`, and Windows Rust platform implementations in `windows/src-tauri/src/platform/`.

This document outlines what currently works, what is Linux-only, what is broken on Windows, what is missing for a general-purpose assistant, and the exact files scheduled for modification.

---

## 1. What Works
- **Windows Rust Platform Primitives**: `windows/src-tauri/src/platform/windows.rs` implements native Windows cursor tracking (`GetCursorPos`), `SendInput` mouse clicking with virtual-desktop coordinate mapping, window capture exclusion (`SetWindowDisplayAffinity`), and global click hooks (`GetAsyncKeyState`).
- **Windows Power & Audio Commands**: `windows/src-tauri/src/platform/power.rs` correctly implements audio volume step up/down and muting via `windows-sys` media keys.
- **Python Windows Grounding Assets**:
  - `windows/python/dxcam_capture.py`: Fast GPU screen capture via DXCam (DXGI Desktop Duplication).
  - `windows/python/winrt_ocr.py`: Hardware-accelerated local OCR via Windows Runtime `winrt.windows.media.ocr.OcrEngine`.
  - `windows/python/uia.py`: Complete UI Automation tree scanner with bounds filtering and process resolution.
  - `windows/python/fast_app_launcher.py`: High-speed Windows application launcher scanning start menu registry keys.
- **Frontend Overlay Architecture**: `common/frontend/src/Overlay.tsx` has hardware glide animations, dynamic DPI scaling factor handling, and click-through highlight frames.
- **Build Toolchains**: Bun 1.4+, Rust 1.99+ MSVC, and Python 3.11 are present and functional on the host machine.

---

## 2. What is Linux-Only
- **Daemon Crate (`crates/blinky-daemon`)**:
  - `src/atspi/`: Linux AT-SPI2 accessibility tree parser over D-Bus (`zbus`). Does not compile or run on Windows.
  - `src/compositor/hyprland.rs`: Hyprland Wayland IPC client for window management.
  - `src/input/uinput.rs`: Direct `/dev/uinput` kernel injection for simulated keystrokes and mouse events.
  - `src/capture/`: Wayland PipeWire and X11 screen capture.
  - Hardcoded Linux paths: References like `/home/fev/GitRepos/Blinky/target/debug/blinky-daemon` in `crates/blinky-agent/src/tools/desktop.rs`.
- **System Commands**: Shell scripts (`setup.sh`, `run.sh`, `linux/scripts/*`) and `ydotoold` autostart logic.

---

## 3. What is Broken on Windows
- **Agent Desktop Tools**: `crates/blinky-agent/src/tools/desktop.rs` bails on Windows (`DaemonRpcClient` unconditionally returns `"The Linux desktop daemon is not available on Windows; use the Windows actuator."`). Because the agent loop delegates `CaptureWindow`, `CaptureScreen`, `ActOnFrame`, `KeyboardType`, and `KeyboardKey` to this client, desktop interaction fails completely on Windows.
- **System Prompts & Mode Hardcoding**: `crates/blinky-agent/src/agent/loop.rs` contains a hardcoded Linux supervisor prompt:
  ```text
  You are Fermas-GUI (Blinky), an autonomous, screen-aware desktop AI supervisor on Linux...
  Call delegate_to_fermas(goal, workspace_path)...
  ```
- **Gemini Model Retirement**: `providers/gemini.rs` defaults to `gemini-2.5-flash`, which is retired and returns 404/400 errors.
- **Provider Limitations**:
  - `providers/types.rs`: `ChatMessage` only supports string `content` (no multimodal image parts).
  - `AiProvider::chat` is synchronous/non-streaming only; no token streaming callback or iterator.
  - Factory silently falls back to Groq when a provider is unrecognized (`providers/factory.rs`).
- **Web Search Docker Dependency**: `tools/wil.rs` calls SearXNG on `127.0.0.1:8888`, requiring Docker Desktop. `run.ps1` issues warnings when Docker is absent.
- **Plaintext Secret Storage**: API keys are saved directly into `.env` as plaintext. `.env_example` contains extraneous keys (ESP32 credentials, RevenueCat keys, promo codes).
- **Overlay Focus & Startup Behavior**: The app automatically launches the large `command` window on startup rather than staying silently in the system tray and transparent overlay.

---

## 4. What is Missing for a General-Purpose Assistant
- **Multi-Modal Vision Parts**: Vision-capable models (Gemini, Vertex AI, OpenAI) cannot receive screenshots or attached images directly.
- **Adaptive Interaction Modes**: The system assumes every request is a single-step software tutor guidance task rather than answering coding, philosophy, homework, or general queries directly.
- **Provider Rotation & Advanced Providers**: No support for Vertex AI (hedged regions), Antigravity (wrapped Code Assist endpoint with loopback OAuth), Codex (Responses API with loopback OAuth), or DPAPI-backed secure credential storage.
- **Buddy Persona & Visual Polish**: The overlay uses a generic cursor icon and pulsing circles rather than the solid glowing triangle buddy.
- **Safety Gates**: Lack of shared pending-gate state across overlay and command panel for destructive actions (file deletion, purchases, shutdowns).

---

## 5. Exact Files Scheduled for Modification
1. **Root / Configuration / Setup**:
   - `package.json`: Rename visible identity to Clinky; update scripts.
   - `common/src-tauri/tauri.conf.json`: Update app title, identifiers, overlay permissions, and default window visibility.
   - `.env_example`: Remove paywall, promo, and ESP32 secrets; keep clean placeholders.
   - `setup.ps1`: Fix Windows setup pipeline, ensure clean venv & node_modules setup.
   - `run.ps1`: Default to no-Docker without warnings.
2. **Rust Agent (`crates/blinky-agent`)**:
   - `src/providers/types.rs`: Add `ChatMessagePart` (Text, ImageUrl/ImageBytes), streaming trait methods, and provider model tiers.
   - `src/providers/mod.rs` & `src/providers/factory.rs`: Register new providers (Gemini, Vertex AI, Antigravity, Codex, OpenAI, Anthropic, Ollama, Groq); remove silent Groq fallback.
   - `src/providers/gemini.rs`: Update to current Flash models, add streaming, vision, and `googleSearch` grounding.
   - `src/providers/vertex.rs` (new): Port hedged parallel region execution, backoff, and non-streaming fallback.
   - `src/providers/antigravity.rs` (new): Port OAuth PKCE (port 51121) and wrapped Code Assist request shape.
   - `src/providers/codex.rs` (new): Port OAuth PKCE (port 1455) and Responses API with token rotation.
   - `src/agent/loop.rs`: Replace Linux supervisor prompt with Windows General Assistant prompt; keep System 1 reflex router strictly for atomic actions; integrate pointing tags `[POINT:x,y:label]`.
   - `src/tools/desktop.rs`: Replace Linux daemon RPC with direct Windows actuator bridge (using Python sidecar / native Windows platform).
   - `src/tools/wil.rs`: Replace SearXNG with `googleSearch` research routing.
3. **Tauri Host (`common/src-tauri`)**:
   - `src/lib.rs`: Tray-and-overlay startup default, DPAPI secure storage commands, Windows actuator command handlers, shared safety gate state.
   - `src/platform/windows.rs`: Click-through overlay toggling, DPI/coordinate normalization, and black frame fallback hooks.
4. **Frontend (`common/frontend`)**:
   - `src/Overlay.tsx`: Clicky-like solid blue triangle buddy with soft glow; smooth rAF easing; response bubble with waveform and spinner; non-blocking pass-through.
   - `src/CommandBar.tsx`: Settings panel on demand; masked write-only key entry; provider rotation; safety gate confirmations.
   - `src/lib/tauri.ts` & `src/lib/types.ts`: Update command interfaces for DPAPI storage, provider switching, and safety gates.
