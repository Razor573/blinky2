from __future__ import annotations

import base64
import io
import os
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image
from utils.logging import get_logger

LOGGER = get_logger("blinky.gemini")

# Priority model list: active modern 3.5/3.8/lite family
PREFERRED_GEMINI_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-2.5-flash",
]


def _get_candidate_models() -> list[str]:
    """Returns prioritized candidate models honoring GEMINI_MODEL env var if present."""
    pref = os.getenv("GEMINI_MODEL", "").strip()
    if pref:
        return [pref] + [m for m in PREFERRED_GEMINI_MODELS if m != pref]
    return PREFERRED_GEMINI_MODELS


def _get_gemini_client():
    """Lazy-import and construct the Gemini client, returning None if unavailable."""
    try:
        from google import genai
        from google.genai import types

        api_key = os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()
        if not api_key:
            # Auto-load from .env if running directly without Tauri parent process
            for candidate in [
                Path.cwd() / ".env",
                Path(__file__).resolve().parents[1] / ".env",
                Path(__file__).resolve().parents[2] / ".env",
                Path(__file__).resolve().parents[3] / ".env",
            ]:
                if candidate.exists():
                    try:
                        for line in candidate.read_text(encoding="utf-8").splitlines():
                            line = line.strip()
                            if line.startswith("GEMINI_API_KEY=") or line.startswith("GOOGLE_API_KEY="):
                                _, val = line.split("=", 1)
                                api_key = val.strip().strip("'\"")
                                os.environ["GEMINI_API_KEY"] = api_key
                                break
                    except Exception:
                        pass
                if api_key:
                    break
        if not api_key:
            return None
        # The SDK takes milliseconds, not seconds.
        return genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=20_000))
    except ImportError:
        return None
    except Exception as e:
        LOGGER.warning("Could not construct Gemini client: %s", e)
        return None


def _load_image(image_input: str | Path | bytes | Image.Image) -> tuple[bytes, str]:
    """Normalizes image input into (bytes, mime_type)."""
    if isinstance(image_input, Image.Image):
        buf = io.BytesIO()
        image_input.save(buf, format="JPEG", quality=85)
        return buf.getvalue(), "image/jpeg"

    if isinstance(image_input, (str, Path)) and os.path.exists(str(image_input)):
        p = Path(image_input)
        mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
        return p.read_bytes(), mime

    if isinstance(image_input, str):
        # Base64 string (possibly with data URI prefix)
        raw_b64 = image_input
        mime = "image/jpeg"
        if "base64," in raw_b64:
            header, raw_b64 = raw_b64.split("base64,", 1)
            if "image/png" in header:
                mime = "image/png"
            elif "image/webp" in header:
                mime = "image/webp"
        data = base64.b64decode(raw_b64.strip())
        return data, mime

    if isinstance(image_input, bytes):
        return image_input, "image/jpeg"

    raise ValueError(f"Unsupported image input type: {type(image_input)}")


def _try_groq_vision(prompt: str, img_bytes: bytes) -> dict[str, Any] | None:
    """Attempt Groq Vision as fast-path."""
    try:
        groq_api_key = os.getenv("GROQ_API_KEY", "").strip()
        if not groq_api_key:
            return None
        from ai.groq_client import ask_groq_vision

        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            f.write(img_bytes)
            tmp_path = Path(f.name)
        try:
            LOGGER.info("Calling Groq Vision for image analysis")
            groq_res = ask_groq_vision(prompt=f"{prompt}\n\nRespond with a plain text description. Do NOT return JSON.", screenshot_path=tmp_path)
            text = groq_res.get("summary") or groq_res.get("text") or str(groq_res)
            LOGGER.info("Groq Vision response received (%d chars)", len(text))
            return {"text": text, "model": "groq-vision"}
        finally:
            if tmp_path.exists():
                tmp_path.unlink()
    except Exception as e:
        LOGGER.warning("Groq Vision failed: %s", str(e)[:120])
        return None


def _try_gemini_vision(prompt: str, img_bytes: bytes, mime_type: str) -> dict[str, Any] | None:
    """Attempt Gemini Vision."""
    try:
        from google.genai import types
        client = _get_gemini_client()
        if client is None:
            return None
        part = types.Part.from_bytes(data=img_bytes, mime_type=mime_type)
        for model_name in _get_candidate_models():
            try:
                LOGGER.info("Calling Gemini Vision with model: %s", model_name)
                resp = client.models.generate_content(
                    model=model_name,
                    contents=[prompt, part],
                    config=types.GenerateContentConfig(temperature=0.2),
                )
                text = (resp.text or "").strip()
                LOGGER.info("Gemini Vision response received (%d chars)", len(text))
                return {"text": text, "model": model_name}
            except Exception as e:
                LOGGER.warning("Gemini model %s failed: %s", model_name, str(e)[:120])
                continue
        return None
    except Exception as e:
        LOGGER.warning("Gemini Vision setup failed: %s", str(e)[:80])
        return None


def ask_gemini_vision(
    prompt: str,
    image_input: str | Path | bytes | Image.Image,
    system_instruction: str | None = None,
) -> dict[str, Any]:
    """
    Analyzes an image with the best available vision model.
    Honors configured provider (e.g. Gemini vs Groq).
    """
    img_bytes, mime_type = _load_image(image_input)
    configured_provider = (os.getenv("BLINKY_PROVIDER") or os.getenv("AI_PROVIDER") or "gemini").strip().lower()

    if configured_provider in ("gemini", "google", "vertex", "antigravity"):
        result = _try_gemini_vision(prompt, img_bytes, mime_type)
        if result:
            return result
        result = _try_groq_vision(prompt, img_bytes)
        if result:
            return result
    else:
        result = _try_groq_vision(prompt, img_bytes)
        if result:
            return result
        result = _try_gemini_vision(prompt, img_bytes, mime_type)
        if result:
            return result

    raise RuntimeError(
        "Vision analysis failed: neither Groq Vision nor Gemini Vision could process the image. "
        "Check that GROQ_API_KEY or GEMINI_API_KEY is set in your .env file."
    )


def ask_gemini_text(
    prompt: str,
    max_tokens: int = 1000,
    web_search: bool = False,
) -> dict[str, Any]:
    """Queries Gemini text model with model fallback, supporting Google Search Grounding when web_search=True."""
    try:
        from google.genai import types
        client = _get_gemini_client()
        if client is None:
            raise RuntimeError("Gemini client not available. Set GEMINI_API_KEY in .env.")

        is_json_request = not web_search and any(k in prompt for k in ["JSON", "valid JSON", "json"])
        response_mime = "application/json" if is_json_request else None

        config = types.GenerateContentConfig(
            max_output_tokens=max_tokens,
            tools=[types.Tool(google_search=types.GoogleSearch())] if web_search else None,
            response_mime_type=response_mime,
        )

        for model_name in _get_candidate_models():
            try:
                resp = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=config,
                )
                text = (resp.text or "").strip()

                sources: list[dict[str, str]] = []
                if hasattr(resp, "candidates") and resp.candidates:
                    candidate = resp.candidates[0]
                    gm = getattr(candidate, "grounding_metadata", None)
                    if gm:
                        chunks = getattr(gm, "grounding_chunks", None) or []
                        for ch in chunks:
                            web = getattr(ch, "web", None)
                            if web:
                                sources.append({
                                    "title": str(getattr(web, "title", "") or ""),
                                    "url": str(getattr(web, "uri", "") or ""),
                                })

                return {"text": text, "model": model_name, "sources": sources}
            except Exception as e:
                LOGGER.warning("Gemini text model %s failed: %s", model_name, str(e)[:120])
                continue
    except Exception as e:
        LOGGER.warning("Gemini text setup failed: %s", e)

    raise RuntimeError("Failed to query Gemini text models.")
