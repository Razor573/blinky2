# Windows Screen Interaction & Architecture Research (Phase 0)

## Overview & Scope
This document gathers authoritative specifications, API contracts, and implementation research for screen capture, OCR, UI Automation, coordinate transformations, and window composition on Windows 10 and 11. It provides the architectural foundation for Clinky's Windows actuator and overlay.

---

## 1. High-Performance Screen Capture: DXCam vs. Windows Graphics Capture (WGC)

### 1.1 DXCam & DXGI Desktop Duplication API (DDA)
- **Mechanism**: DXCam leverages the DirectX Graphics Infrastructure (DXGI) Desktop Duplication API (`IDXGIOutputDuplication`). It hooks directly into the Desktop Window Manager (DWM) frame presentation pipeline, pulling GPU swapchain surfaces directly into system memory or direct DirectX textures without CPU blitting.
- **Performance Characteristics**:
  - Delivers ultra-low latency (<2–4 ms per 1080p frame) and can achieve 120–240+ FPS.
  - Returns raw BGRX/RGBA frame buffers.
- **Constraints & Edge Cases**:
  - Full-screen/monitor-level capture: DDA captures the entire display output associated with a GPU output adapter (`IDXGIOutput`). It cannot capture an isolated off-screen or occluded window independently.
  - Multi-GPU systems: In laptops with hybrid graphics (integrated Intel/AMD + discrete NVIDIA GTX 1650), DXCam must initialize on the display adapter connected to the active display output, typically via `dxcam.create(device_idx=0, output_idx=0)`.
- **Primary Source**: Microsoft Learn: [Desktop Duplication API](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api); DXCam Project: [DXcam GitHub](https://github.com/ra1nty/DXcam).

### 1.2 Windows.Graphics.Capture (WGC)
- **Mechanism**: Introduced in Windows 10 Version 1903 (Build 18362), the WinRT `Windows.Graphics.Capture` API provides modern GPU-accelerated frame capture for both whole monitors and individual application windows (`HWND`).
- **Characteristics**:
  - Operates via `Direct3D11CaptureFramePool` and `GraphicsCaptureSession`.
  - Supports window-level clipping even when the window is partially occluded by other non-topmost windows.
  - Automatically respects hardware-protected and DRM-flagged surfaces by rendering them black.
- **Primary Source**: Microsoft Learn: [Windows.Graphics.Capture Namespace](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture).

---

## 2. On-Device Text Extraction: WinRT OCR
- **API**: `Windows.Media.Ocr.OcrEngine` available via `winrt.windows.media.ocr` (or `windows-media-ocr` in Python).
- **Execution Pipeline**:
  1. Open image stream via `Windows.Storage.StorageFile` or create `SoftwareBitmap` from raw bytes.
  2. Instantiate engine: `OcrEngine.TryCreateFromUserProfileLanguages()` (detects system languages).
  3. Execute recognition: `await engine.RecognizeAsync(bitmap)`.
  4. Parse output: Returns hierarchical `OcrLine` and `OcrWord` elements containing `BoundingRect` (`x`, `y`, `width`, `height`).
- **Characteristics & Resolution**:
  - Zero cloud dependency; executes via the built-in Windows OCR engine.
  - Bounds returned by WinRT OCR are in image pixel space (matching the captured screenshot resolution).
- **Primary Source**: Microsoft Learn: [OcrEngine Class](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine).

---

## 3. Accessibility Tree Traversal: Windows UI Automation (UIA)
- **API Framework**: Microsoft UI Automation (COM-based client `IUIAutomation`).
- **Python Integration**: `pywinauto` with `backend="uia"`, or direct COM via `comtypes.client`.
- **Coordinate System**:
  - **UIA Always Uses Physical (Device) Pixels**: Unlike standard Win32 logical client coordinates, `UIA` control bounding rectangles (`CurrentBoundingRectangle`) are expressed in screen-absolute physical device coordinates relative to the virtual screen origin `(0, 0)`.
- **Optimization Strategy**:
  - Unfiltered tree traversal (`active.descendants()`) on complex apps like browsers or VS Code can take 10–30+ seconds due to massive DOM-in-UIA nodes.
  - Pruning rule: Filter by `control_type` (`Button`, `Edit`, `MenuItem`, `TabItem`, `Hyperlink`, `ListItem`) and bound execution with a strict timeout budget (e.g., 2.0s max, capped at 250 interactive items).
- **Primary Source**: Microsoft Learn: [UI Automation Overview](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32); pywinauto Documentation: [UIA Backend](https://pywinauto.readthedocs.io/en/latest/).

---

## 4. Coordinate Spaces, DPI Scaling & Multi-Monitor Mapping

### 4.1 Coordinate Space Definitions
1. **Physical Virtual Screen Space**:
   - Spans all monitors. The primary monitor origin is `(0, 0)`.
   - Bounded by `SM_XVIRTUALSCREEN`, `SM_YVIRTUALSCREEN`, `SM_CXVIRTUALSCREEN`, `SM_CYVIRTUALSCREEN` from `GetSystemMetrics`.
   - Used by: `SendInput` mouse injection, DXCam full-resolution screenshots, UIA bounding rectangles.
2. **Logical CSS Pixel Space (Overlay Viewport)**:
   - Used by: Webview DOM, React rendering, HTML elements.
   - Related to physical pixels by:
     $$\text{Physical Pixels} = \text{Logical CSS Pixels} \times \text{window.devicePixelRatio}$$
3. **Downsampled Screenshot Space**:
   - Used by: Vision models to adhere to token and latency budgets (e.g. capped at max long-edge 1568px or 1920x1080).
   - Scaling ratio:
     $$s_x = \frac{\text{screenshot.width}}{\text{physical.width}}, \quad s_y = \frac{\text{screenshot.height}}{\text{physical.height}}$$

### 4.2 Multi-Monitor & DPI Transform
When displaying overlay highlights or computing clicks:
- An element located at $(x_{\text{ss}}, y_{\text{ss}})$ in screenshot space maps to physical desktop space via:
  $$x_{\text{phys}} = \text{round}\left(x_{\text{ss}} \times \frac{\text{physical.width}}{\text{screenshot.width}}\right)$$
  $$y_{\text{phys}} = \text{round}\left(y_{\text{ss}} \times \frac{\text{physical.height}}{\text{screenshot.height}}\right)$$
- `SendInput` requires normalized virtual coordinates in range $[0, 65535]$:
  $$\text{dx} = \frac{(x_{\text{phys}} - \text{SM\_XVIRTUALSCREEN}) \times 65535}{\text{SM\_CXVIRTUALSCREEN} - 1}$$
  $$\text{dy} = \frac{(y_{\text{phys}} - \text{SM\_YVIRTUALSCREEN}) \times 65535}{\text{SM\_CYVIRTUALSCREEN} - 1}$$
- **Primary Source**: Microsoft Learn: [High DPI Desktop Application Development](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows).

---

## 5. Capture Exclusion & Black-Frame Handling

### 5.1 `SetWindowDisplayAffinity`
Win32 API:
```cpp
BOOL SetWindowDisplayAffinity(HWND hWnd, DWORD dwAffinity);
```
- **`WDA_NONE` (`0x00000000`)**: Content captured normally.
- **`WDA_MONITOR` (`0x00000001`)**: Renders window content exclusively to physical monitors. Software capturing pipelines receive a solid black rectangle.
- **`WDA_EXCLUDEFROMCAPTURE` (`0x00000011`)**: Introduced in Windows 10 Version 2004. The DWM compositor completely omits the window from screen capture, allowing underlying desktop content to show through.

### 5.2 Limits & Black Frame Detection
- **Limitation**: Windows with certain layered styles (`WS_EX_LAYERED`), hardware overlay video, or DRM protection (Widevine, Netflix, protected media) fail `WDA_EXCLUDEFROMCAPTURE` and black out under DDA/WGC. Once a window is blacked out by DWM/DRM, pixel data is permanently lost and cannot be recovered from the framebuffer.
- **Sampling & Detection**:
  - Sample pixels across an evenly distributed grid (up to 2048 samples).
  - Compute maximum channel brightness: $\max(R, G, B)$.
  - If $\ge 99.5\%$ of sampled pixels have brightness $\le 16$, classify as a black frame.
- **Graceful Fallback**:
  - Rather than sending a useless black frame to a vision model, fall back immediately to OCR + UIA text trees for that window.
  - Present status note to user: `"Screenshot came back black, using captured text instead"`.
- **Primary Source**: Microsoft Learn: [SetWindowDisplayAffinity Function](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity).

---

## 6. Tauri Transparent Overlay Behavior on Windows

### 6.1 Required Window Configuration
To create a seamless, non-stealing overlay on Windows:
- `transparent: true`
- `decorations: false`
- `alwaysOnTop: true`
- `skipTaskbar: true`
- `resizable: false`

### 6.2 Win32 Extended Window Styles
In `common/src-tauri/src/platform/windows.rs`:
```cpp
LONG style = GetWindowLongW(hwnd, GWL_EXSTYLE);
SetWindowLongW(hwnd, GWL_EXSTYLE, style
    | WS_EX_TRANSPARENT    // Pass all mouse messages through to underlying windows
    | WS_EX_LAYERED        // Enable alpha blending and transparency
    | WS_EX_TOOLWINDOW     // Omit from Alt+Tab and taskbar
    | WS_EX_TOPMOST        // Maintain z-order above normal desktop windows
    | WS_EX_NOACTIVATE     // Prevent clicking or displaying from stealing keyboard focus
);
```
- **Interactive Elements**:
  - When the overlay displays interactive cards (such as confirmation buttons or disambiguation prompts), the overlay must dynamically toggle `WS_EX_TRANSPARENT` off (or call `window.set_ignore_cursor_events(false)`) when hovering interactive regions, and toggle it back on when hovering transparent regions.
- **Primary Source**: Microsoft Learn: [Extended Window Styles](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles); Tauri 2 Docs: [Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/).
