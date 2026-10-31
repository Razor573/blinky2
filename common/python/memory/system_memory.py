from __future__ import annotations

import os
import platform
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import psutil
from utils.logging import get_logger

LOGGER = get_logger("blinky.memory.system")

_CACHED_SYSTEM_MEMORY: Optional[Dict[str, Any]] = None
_CACHED_CONTEXT_BLOCK: Optional[str] = None


def _detect_windows_os_version() -> str:
    """Detect readable Windows version, identifying Windows 11 properly from build number."""
    if platform.system() != "Windows":
        return f"{platform.system()} {platform.release()} ({platform.machine()})"

    version = platform.version()  # e.g. "10.0.26200"
    machine = platform.machine() or "AMD64"
    build = 0
    try:
        parts = version.split(".")
        if len(parts) >= 3:
            build = int(parts[2])
    except Exception:
        pass

    if build >= 22000:
        return f"Windows 11 {machine} (Build {version})"
    elif build >= 10240:
        return f"Windows 10 {machine} (Build {version})"
    return f"Windows {platform.release()} {machine} (Build {version})"


def _detect_default_browser() -> Dict[str, str]:
    """Detect default browser from Windows registry UserChoice association."""
    result = {
        "prog_id": "MSEdgeHTM",
        "name": "Microsoft Edge",
        "exe": "msedge.exe",
        "id": "msedge",
    }
    if platform.system() != "Windows":
        return result

    try:
        import winreg

        key_path = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            prog_id, _ = winreg.QueryValueEx(key, "ProgId")
            prog_id_str = str(prog_id).strip()
            result["prog_id"] = prog_id_str
            lower = prog_id_str.lower()
            if "edge" in lower or "msedge" in lower:
                result["name"] = "Microsoft Edge"
                result["exe"] = "msedge.exe"
                result["id"] = "msedge"
            elif "chrome" in lower:
                result["name"] = "Google Chrome"
                result["exe"] = "chrome.exe"
                result["id"] = "chrome"
            elif "firefox" in lower:
                result["name"] = "Mozilla Firefox"
                result["exe"] = "firefox.exe"
                result["id"] = "firefox"
            elif "brave" in lower:
                result["name"] = "Brave Browser"
                result["exe"] = "brave.exe"
                result["id"] = "brave"
            elif "opera" in lower:
                result["name"] = "Opera"
                result["exe"] = "opera.exe"
                result["id"] = "opera"
    except Exception as exc:
        LOGGER.debug("Default browser detection via registry failed: %s", exc)

    return result


def _detect_active_ecosystem_apps() -> List[Dict[str, Any]]:
    """Scan running processes for key desktop ecosystem applications."""
    monitored_apps = {
        "msedge.exe": "Microsoft Edge",
        "chrome.exe": "Google Chrome",
        "firefox.exe": "Mozilla Firefox",
        "spotify.exe": "Spotify Desktop",
        "steam.exe": "Steam",
        "discord.exe": "Discord",
        "code.exe": "Visual Studio Code",
        "notepad.exe": "Notepad",
        "vlc.exe": "VLC Media Player",
        "obs64.exe": "OBS Studio",
        "slack.exe": "Slack",
        "telegram.exe": "Telegram Desktop",
        "whatsapp.exe": "WhatsApp Desktop",
    }

    found: Dict[str, Dict[str, Any]] = {}
    try:
        for proc in psutil.process_iter(["pid", "name"]):
            name = proc.info.get("name")
            if not name:
                continue
            name_lower = str(name).lower()
            if name_lower in monitored_apps and name_lower not in found:
                found[name_lower] = {
                    "exe": name_lower,
                    "name": monitored_apps[name_lower],
                    "pid": proc.info.get("pid"),
                }
    except Exception as exc:
        LOGGER.debug("Process iteration failed: %s", exc)

    return list(found.values())


def analyze_system() -> Dict[str, Any]:
    """Execute complete system and hardware analysis, write memory.md, and ingest into Notebook Hub."""
    global _CACHED_SYSTEM_MEMORY, _CACHED_CONTEXT_BLOCK

    os_readable = _detect_windows_os_version()
    browser_info = _detect_default_browser()
    ecosystem_apps = _detect_active_ecosystem_apps()

    # Hardware stats
    try:
        ram_gb = round(psutil.virtual_memory().total / (1024**3), 2)
    except Exception:
        ram_gb = 16.0

    cpu_cores = psutil.cpu_count(logical=True) or 8
    cpu_processor = platform.processor() or "AMD64 / Intel"

    # Format Markdown document
    active_apps_md = (
        "\n".join(f"- **{app['name']}** (`{app['exe']}`)" for app in ecosystem_apps)
        if ecosystem_apps
        else "- None detected currently active"
    )

    markdown_content = f"""# System Memory & Hardware Configuration (memory.md)

- **Operating System:** {os_readable}
- **Architecture:** {platform.machine() or "AMD64"}
- **Processor:** {cpu_processor} ({cpu_cores} Logical Cores)
- **Installed Memory (RAM):** {ram_gb} GB
- **Default Web Browser:** {browser_info['name']} (`{browser_info['exe']}`) [ProgId: {browser_info['prog_id']}]
- **Primary Media Player:** Spotify Desktop (`spotify.exe` / `spotify:` URI)

## Active Ecosystem Applications
{active_apps_md}

## Behavioral & Routing Directives
- **Web Destinations:** The user's system default browser is **{browser_info['name']}** (`{browser_info['exe']}`). Always route web requests, searches, and online links to `{browser_info['exe']}` or the system default protocol handler.
- **Media Playback:** The user runs Spotify Desktop (`spotify.exe`). Music and audio track requests should always route to Spotify desktop playback via URI handler.
- **Window Automation:** Top-level application windows and controls should be automated through Windows native accessibility and desktop automation APIs.
- **Generated Timestamp:** {time.strftime('%Y-%m-%d %H:%M:%S')}
"""

    # Write to tmp/notebooks/memory.md
    storage_dir = Path("tmp") / "notebooks"
    storage_dir.mkdir(parents=True, exist_ok=True)
    memory_md_path = storage_dir / "memory.md"
    try:
        memory_md_path.write_text(markdown_content, encoding="utf-8")
        LOGGER.info("Wrote system memory to %s", memory_md_path)
    except Exception as exc:
        LOGGER.warning("Could not write memory.md: %s", exc)

    # Ingest into Notebook Hub under "Default Knowledge Hub"
    try:
        from notebooks.notebook_manager import NotebookManager

        nb_mgr = NotebookManager(storage_dir=storage_dir)
        default_nb = nb_mgr.get_notebook("default")
        if default_nb and "id" in default_nb:
            nb_mgr.add_source_to_notebook(
                notebook_id=default_nb["id"],
                source_name="System Memory & Hardware Configuration (memory.md)",
                content=markdown_content,
                file_type="md",
            )
            LOGGER.info("Ingested memory.md into Notebook Hub (notebook_id=%s)", default_nb["id"])
    except Exception as exc:
        LOGGER.warning("Failed ingesting memory.md into Notebook Hub: %s", exc)

    analysis_data = {
        "os": os_readable,
        "browser": browser_info,
        "ram_gb": ram_gb,
        "cpu_cores": cpu_cores,
        "ecosystem_apps": ecosystem_apps,
        "memory_md_path": str(memory_md_path),
        "markdown_content": markdown_content,
    }

    _CACHED_SYSTEM_MEMORY = analysis_data

    # Format context block for system prompt
    active_app_names = ", ".join(app["exe"] for app in ecosystem_apps) or "msedge.exe, spotify.exe"
    _CACHED_CONTEXT_BLOCK = f"""[System Memory & User Environment]
Operating System: {os_readable}
Default Web Browser: {browser_info['name']} ({browser_info['exe']})
Preferred Media Player: Spotify Desktop (spotify: protocol)
Active Running Applications: {active_app_names}
Directive: When the user asks to open the browser, search the web, or navigate to a website, default to Microsoft Edge ({browser_info['exe']}). When playing music, default to Spotify Desktop."""

    return analysis_data


def get_preferred_browser() -> str:
    """Return the preferred browser executable name (e.g. 'msedge')."""
    if _CACHED_SYSTEM_MEMORY:
        return _CACHED_SYSTEM_MEMORY.get("browser", {}).get("id", "msedge")
    return _detect_default_browser().get("id", "msedge")


def get_system_memory_context() -> str:
    """Return formatted context string for injection into build_system_prompt."""
    global _CACHED_CONTEXT_BLOCK
    if _CACHED_CONTEXT_BLOCK:
        return _CACHED_CONTEXT_BLOCK
    analyze_system()
    return _CACHED_CONTEXT_BLOCK or ""


def initialize_system_memory() -> Dict[str, Any]:
    """Startup initialization helper: runs system analysis and prepares memory."""
    try:
        return analyze_system()
    except Exception as exc:
        LOGGER.warning("initialize_system_memory failed: %s", exc)
        return {}
