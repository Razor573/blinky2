from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path
from typing import Any

import requests

from ai.groq_client import ask_groq_text, ask_groq_vision, _parse_json
from ai.ollama_client import ask_ollama, ask_ollama_text
from ai.deepseek_client import ask_deepseek_text
from ai.mimo_client import ask_mimo_text, ask_mimo_vision
from ai.custom_client import ask_custom_text, ask_custom_vision

from utils.logging import get_logger

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

LOGGER = get_logger("blinky.ai.client")

SUPPORTED_PROVIDERS = {
    "vertex",
    "antigravity",
    "codex",
    "openai",
    "anthropic",
    "gemini",
    "google",
    "groq",
    "ollama",
    "deepseek",
    "mimo",
    "custom",
}


def _resolve_provider() -> str:
    provider = os.getenv("BLINKY_AI_PROVIDER", "").strip().lower()
    if provider == "google":
        provider = "gemini"
    if provider in SUPPORTED_PROVIDERS:
        return provider

    if not (os.getenv("GROQ_API_KEY") or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY")):
        try:
            from dotenv import load_dotenv
            load_dotenv()
        except Exception:
            pass

    if os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"):
        return "gemini"
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if os.getenv("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.getenv("GROQ_API_KEY"):
        return "groq"
    if os.getenv("MIMO_API_KEY"):
        return "mimo"
    if os.getenv("DEEPSEEK_API_KEY"):
        return "deepseek"
    return "ollama"


def _call_openai_chat(prompt: str, screenshot_path: Path | None, max_tokens: int = 500) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip() or os.getenv("CODEX_API_KEY", "").strip()
    model = os.getenv("OPENAI_MODEL", "").strip() or "gpt-4o-mini"
    url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1").rstrip("/") + "/chat/completions"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    if screenshot_path and Path(screenshot_path).exists():
        with open(screenshot_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        content = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}
        ]
    else:
        content = prompt

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": max_tokens,
    }

    resp = requests.post(url, headers=headers, json=payload, timeout=40)
    resp.raise_for_status()
    data = resp.json()
    raw_text = data["choices"][0]["message"]["content"].strip()
    return _parse_json(raw_text)


def _call_anthropic_messages(prompt: str, screenshot_path: Path | None, max_tokens: int = 500) -> dict[str, Any]:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    model = os.getenv("ANTHROPIC_MODEL", "").strip() or "claude-haiku-4-5-20251001"
    url = "https://api.anthropic.com/v1/messages"

    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }

    if screenshot_path and Path(screenshot_path).exists():
        with open(screenshot_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        content = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": b64
                }
            },
            {"type": "text", "text": prompt}
        ]
    else:
        content = [{"type": "text", "text": prompt}]

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": max_tokens,
    }

    resp = requests.post(url, headers=headers, json=payload, timeout=40)
    resp.raise_for_status()
    data = resp.json()
    raw_text = ""
    for block in data.get("content", []):
        if block.get("type") == "text":
            raw_text += block.get("text", "")
    return _parse_json(raw_text.strip())


def ask_model(prompt: str, screenshot_path: Path) -> dict[str, Any]:
    provider = _resolve_provider()
    primary_err: Exception | None = None

    if provider in ("gemini", "google", "vertex", "antigravity"):
        try:
            from ai.gemini_client import ask_gemini_vision
            return ask_gemini_vision(prompt=prompt, image_input=screenshot_path)
        except Exception as exc:
            primary_err = exc
            LOGGER.warning("%s vision query failed (%s); trying fallback providers...", provider, exc)

    if provider in ("openai", "codex"):
        try:
            return _call_openai_chat(prompt=prompt, screenshot_path=screenshot_path)
        except Exception as exc:
            primary_err = exc
            LOGGER.warning("%s vision query failed (%s); trying fallback providers...", provider, exc)

    if provider == "anthropic":
        try:
            return _call_anthropic_messages(prompt=prompt, screenshot_path=screenshot_path)
        except Exception as exc:
            primary_err = exc
            LOGGER.warning("Anthropic vision query failed (%s); trying fallback providers...", exc)

    if provider == "groq":
        try:
            return ask_groq_vision(prompt=prompt, screenshot_path=screenshot_path)
        except Exception as exc:
            primary_err = exc
            LOGGER.warning("Groq vision query failed (%s); trying fallback providers...", exc)

    # Automatic fallback to Gemini Vision if other providers failed
    if (primary_err is not None) and (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")):
        try:
            from ai.gemini_client import ask_gemini_vision
            return ask_gemini_vision(prompt=prompt, image_input=screenshot_path)
        except Exception as g_exc:
            LOGGER.warning("Gemini vision fallback failed: %s", g_exc)

    if provider == "mimo":
        return ask_mimo_vision(prompt=prompt, screenshot_path=screenshot_path)
    if provider == "deepseek":
        return ask_deepseek_text(prompt, max_tokens=1024)
    if provider == "custom":
        return ask_custom_vision(prompt, screenshot_path)
    if provider == "ollama":
        return ask_ollama(prompt)

    if primary_err:
        raise primary_err

    # Fallback default instead of raising
    try:
        from ai.gemini_client import ask_gemini_vision
        return ask_gemini_vision(prompt=prompt, image_input=screenshot_path)
    except Exception:
        return ask_ollama(prompt)


def ask_text_model(prompt: str, max_tokens: int = 300) -> dict[str, Any]:
    provider = _resolve_provider()
    primary_err: Exception | None = None

    if provider in ("gemini", "google", "vertex", "antigravity"):
        try:
            from ai.gemini_client import ask_gemini_text
            res = ask_gemini_text(prompt, max_tokens)
            text = str(res.get("text", "")).strip()
            return _parse_json(text)
        except Exception as exc:
            primary_err = exc
            LOGGER.warning("%s text model hit an error (%s); trying fallback providers...", provider, exc)

    if provider in ("openai", "codex"):
        try:
            return _call_openai_chat(prompt=prompt, screenshot_path=None, max_tokens=max_tokens)
        except Exception as exc:
            primary_err = exc
            LOGGER.warning("%s text model hit an error (%s); trying fallback providers...", provider, exc)

    if provider == "anthropic":
        try:
            return _call_anthropic_messages(prompt=prompt, screenshot_path=None, max_tokens=max_tokens)
        except Exception as exc:
            primary_err = exc
            LOGGER.warning("Anthropic text model hit an error (%s); trying fallback providers...", exc)

    if provider == "groq":
        try:
            return ask_groq_text(prompt, max_tokens)
        except Exception as exc:
            primary_err = exc
            LOGGER.warning("Groq text model hit an error (%s); trying fallback providers...", exc)

    # Automatic fallback to Gemini if other provider failed
    if (primary_err is not None) and (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")):
        try:
            from ai.gemini_client import ask_gemini_text
            res = ask_gemini_text(prompt, max_tokens)
            text = str(res.get("text", "")).strip()
            return _parse_json(text)
        except Exception as g_exc:
            LOGGER.warning("Gemini text fallback failed: %s", g_exc)

    if provider == "mimo":
        return ask_mimo_text(prompt, max_tokens)
    if provider == "deepseek" or (primary_err is not None and os.getenv("DEEPSEEK_API_KEY")):
        try:
            return ask_deepseek_text(prompt, max_tokens=max_tokens)
        except Exception as d_exc:
            LOGGER.warning("DeepSeek text fallback failed: %s", d_exc)

    if provider == "custom":
        return ask_custom_text(prompt, max_tokens=max_tokens)
    if provider == "ollama":
        return ask_ollama_text(prompt, max_tokens)

    if primary_err:
        raise primary_err

    # Fallback default instead of raising
    try:
        from ai.gemini_client import ask_gemini_text
        res = ask_gemini_text(prompt, max_tokens)
        text = str(res.get("text", "")).strip()
        return _parse_json(text)
    except Exception:
        return ask_ollama_text(prompt, max_tokens)


def get_provider_label() -> str:
    provider = _resolve_provider()
    return provider.capitalize()


def has_vision_capability() -> bool:
    provider = (os.getenv("BLINKY_AI_PROVIDER", "").strip() or "").lower()
    if provider == "custom":
        from ai.custom_client import has_vision_capability as _custom_vision
        return _custom_vision()
    return provider in ("vertex", "antigravity", "codex", "openai", "anthropic", "gemini", "groq", "mimo") or bool(
        os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
    )
