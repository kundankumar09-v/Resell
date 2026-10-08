"""
NVIDIA vision-LLM client (NIM, OpenAI-compatible API).
Called ONLY inside the tuned uncertainty band of the fraud pipeline, with one
resized image per call (keeps latency and token cost bounded). Falls back
silently (flags = 0) when no key is configured or the call fails/times out.
"""

import base64
import io
import json
import logging
import time
from typing import Any, Dict, Optional

import requests

from . import config

logger = logging.getLogger("ml-service.pipeline.vision_llm")

_FRAUD_FLAG_PROMPT = (
    "You are a marketplace fraud analyst. Inspect this single product listing image. "
    "Answer with a JSON object only: {\"flags\": [<one or more of "
    "\"stock_photo\", \"watermark\", \"screenshot\", \"mismatch\", \"edited\", \"low_quality\">], "
    "\"confidence\": <0-1>}. Flags mean: stock_photo=generic catalog render, "
    "watermark=visible marketplace/brand watermark, screenshot=platform screenshot, "
    "mismatch=image does not look like a resellable physical product, "
    "edited=visible manipulation, low_quality=too blurry/small to judge."
)


def is_configured() -> bool:
    return bool(config.NVIDIA_API_KEY)


def _resize_one(image_bytes: bytes) -> Optional[bytes]:
    """One resized image per call (limits payload + tokens)."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        size = (config.NVIDIA_IMAGE_SIZE, config.NVIDIA_IMAGE_SIZE)
        if img.width > size[0] or img.height > size[1]:
            img.thumbnail(size)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"Image resize failed: {e}")
        return None


def _download(url: str) -> Optional[bytes]:
    try:
        resp = requests.get(url, timeout=config.NVIDIA_TIMEOUT_S,
                            headers={"User-Agent": "Mozilla/5.0 (compatible; ReSell-ML/2.0)"})
        resp.raise_for_status()
        return resp.content
    except Exception as e:
        logger.warning(f"Image download failed for {url}: {e}")
        return None


def analyze_listing_image(image_url: str) -> Optional[Dict[str, Any]]:
    """
    Call the NVIDIA vision model once with one resized image.
    Returns {"flags": [...], "confidence": float, "latency_ms": float} or None.
    """
    if not is_configured() or not image_url:
        return None

    raw = _download(image_url)
    if raw is None:
        return None
    resized = _resize_one(raw)
    if resized is None:
        return None
    b64 = base64.b64encode(resized).decode("utf-8")

    payload = {
        "model": config.NVIDIA_VISION_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": _FRAUD_FLAG_PROMPT},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ],
        }],
        "max_tokens": 128,
        "temperature": 0.0,
    }

    start = time.time()
    try:
        resp = requests.post(
            f"{config.NVIDIA_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {config.NVIDIA_API_KEY}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json=payload,
            timeout=config.NVIDIA_TIMEOUT_S,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        latency_ms = (time.time() - start) * 1000
        # Parse JSON out of the content (tolerate code fences)
        content = content.strip().strip("`")
        if content.startswith("json"):
            content = content[4:].strip()
        parsed = json.loads(content)
        flags = [str(f) for f in parsed.get("flags", [])][:6]
        confidence = float(parsed.get("confidence", 0.5))
        return {"flags": flags, "confidence": max(0.0, min(1.0, confidence)),
                "latency_ms": round(latency_ms, 1)}
    except Exception as e:
        logger.warning(f"NVIDIA vision call failed: {e}")
        return None


def in_uncertainty_band(prob: float) -> bool:
    """True when the calibrated probability falls in the tuned vision-LLM band."""
    low, high = config.VISION_LLM_BAND
    if not (low <= prob <= high):
        return False
    # Skip when the model is already confidently on one side of a threshold
    margin = min(abs(prob - config.FRAUD_HIGH_THRESHOLD), abs(prob - config.FRAUD_MEDIUM_THRESHOLD))
    return margin <= config.VISION_LLM_MARGIN
