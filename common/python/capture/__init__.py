from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageGrab
from utils.logging import get_logger

LOGGER = get_logger("blinky.capture")


@dataclass
class Screenshot:
    path: Path
    width: int
    height: int
    screen_width: int
    screen_height: int


class CaptureError(Exception):
    pass


class PermissionDeniedError(CaptureError):
    pass


class TimeoutError(CaptureError):
    pass


BLACK_CHANNEL_MAX = 16
BLACK_FRACTION_MIN = 0.995


def is_black_frame(image: Image.Image) -> bool:
    """Check if the frame is almost entirely black (channel <= 16 on >= 99.5% pixels)."""
    try:
        gray = image.convert("L")
        hist = gray.histogram()
        black_pixels = sum(hist[: BLACK_CHANNEL_MAX + 1])
        total_pixels = sum(hist)
        if total_pixels == 0:
            return True
        return (black_pixels / total_pixels) >= BLACK_FRACTION_MIN
    except Exception as exc:
        LOGGER.warning("is_black_frame check failed: %s", exc)
        return False


def capture_screen() -> Screenshot:
    captures_dir = Path("screenshots")
    captures_dir.mkdir(parents=True, exist_ok=True)
    path = captures_dir / f"screen-{int(time.time() * 1000)}.jpg"

    try:
        resample_filter = Image.Resampling.LANCZOS
    except AttributeError:
        resample_filter = Image.LANCZOS

    image = None
    if os.name == "nt":
        try:
            start_time = time.perf_counter()
            # Try PIL ImageGrab first as it is extremely reliable, instantaneous,
            # and does not lock up the DirectX duplication pipeline.
            image = ImageGrab.grab(all_screens=False)
            LOGGER.info("Captured screen with PIL ImageGrab in %.2fms", (time.perf_counter() - start_time) * 1000)
        except Exception as exc:
            LOGGER.warning(
                "PIL ImageGrab failed, falling back to DXCamCaptureStrategy: %s", exc
            )
            try:
                from dxcam_capture import DXCamCaptureStrategy
                strategy = DXCamCaptureStrategy()
                image = strategy.capture()
                LOGGER.info("Captured screen with DXCamCaptureStrategy")
            except Exception as dxcam_exc:
                LOGGER.exception("DXCamCaptureStrategy failed too")
                raise CaptureError(f"Windows screen capture failed: {dxcam_exc}") from dxcam_exc
    else:
        try:
            from backend.capture import CaptureStrategyFactory

            strategy = CaptureStrategyFactory.get_strategy()
            image = strategy.capture()
            LOGGER.info("Captured screen with %s", strategy.__class__.__name__)
        except Exception as exc:
            LOGGER.exception("Linux screen capture failed")
            raise CaptureError(f"Linux screen capture failed: {exc}") from exc

    screen_w, screen_h = image.width, image.height

    if is_black_frame(image):
        LOGGER.warning(
            "Captured screen is nearly or completely black (channel <= %d on >= %.1f%% of pixels)!",
            BLACK_CHANNEL_MAX,
            BLACK_FRACTION_MIN * 100,
        )

    image.thumbnail((1568, 1568), resample=resample_filter)
    image = image.convert("RGB")
    image.save(path, format="JPEG", quality=85, optimize=True)
    LOGGER.info(
        "Saved optimized screenshot: %s (size: %dx%d, screen: %dx%d)",
        path,
        image.width,
        image.height,
        screen_w,
        screen_h,
    )

    return Screenshot(
        path=path,
        width=image.width,
        height=image.height,
        screen_width=screen_w,
        screen_height=screen_h,
    )
