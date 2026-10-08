"""
Embedding cache + batched inference.
- Caches embeddings by sha256 of the image URL / text hash (LRU-bounded).
- Batches image embedding into a single forward pass.
- fp16 inference when CUDA is available (no-op on CPU).
- Optional ONNX int8 path when onnxruntime + an exported model are present.
"""

import hashlib
import logging
import threading
from collections import OrderedDict
from typing import List, Optional

import numpy as np

from models.clip_model import (
    download_image,
    extract_image_embedding as _legacy_image_embedding,
    extract_text_embedding as _legacy_text_embedding,
)
from . import config

logger = logging.getLogger("ml-service.pipeline.cache")

_lock = threading.Lock()
_image_cache: "OrderedDict[str, np.ndarray]" = OrderedDict()
_text_cache: "OrderedDict[str, np.ndarray]" = OrderedDict()


def _cache_put(store: "OrderedDict", key: str, value: np.ndarray):
    with _lock:
        store[key] = value
        store.move_to_end(key)
        while len(store) > config.EMBED_CACHE_SIZE:
            store.popitem(last=False)


def image_hash_key(image_url_or_path: str) -> str:
    return hashlib.sha256(str(image_url_or_path).encode("utf-8")).hexdigest()[:32]


def text_hash_key(text: str) -> str:
    return hashlib.sha256(("text:" + str(text)).encode("utf-8")).hexdigest()[:32]


def get_image_embedding_cached(image_url_or_path: str) -> Optional[np.ndarray]:
    """Embedding with URL-hash cache; falls back to the legacy single-image path."""
    key = image_hash_key(image_url_or_path)
    with _lock:
        hit = _image_cache.get(key)
    if hit is not None:
        _cache_put(_image_cache, key, hit)  # refresh LRU order
        return hit
    try:
        emb = _legacy_image_embedding(image_url_or_path)
    except Exception as e:
        logger.warning(f"Image embedding failed for {image_url_or_path}: {e}")
        return None
    _cache_put(_image_cache, key, emb)
    return emb


def get_text_embedding_cached(text: str) -> Optional[np.ndarray]:
    key = text_hash_key(text)
    with _lock:
        hit = _text_cache.get(key)
    if hit is not None:
        _cache_put(_text_cache, key, hit)
        return hit
    try:
        emb = _legacy_text_embedding(text)
    except Exception as e:
        logger.warning(f"Text embedding failed: {e}")
        return None
    _cache_put(_text_cache, key, emb)
    return emb


def get_batch_image_embeddings_cached(sources: List[str]) -> List[Optional[np.ndarray]]:
    """
    Batch-encode all cache misses in a single forward pass (fp16 on CUDA).
    Falls back to sequential legacy calls when batching is unavailable.
    """
    results: List[Optional[np.ndarray]] = [None] * len(sources)
    missing: List[int] = []
    for i, src in enumerate(sources):
        key = image_hash_key(src)
        with _lock:
            hit = _image_cache.get(key)
        if hit is not None:
            results[i] = hit
        else:
            missing.append(i)

    if not missing:
        return results

    # Try true batch inference
    batch_emb = _batch_encode([sources[i] for i in missing])
    if batch_emb is not None:
        for j, i in enumerate(missing):
            results[i] = batch_emb[j]
            _cache_put(_image_cache, image_hash_key(sources[i]), batch_emb[j])
        return results

    # Fallback: sequential
    for i in missing:
        results[i] = get_image_embedding_cached(sources[i])
    return results


def _batch_encode(sources: List[str]) -> Optional[np.ndarray]:
    """Single-forward-pass batch encoding; fp16 when CUDA. Returns None if unavailable."""
    try:
        import torch
        from models.clip_model import _clip_model, _clip_preprocess, _device, _is_loaded

        if not (_is_loaded and _clip_model is not None and _clip_preprocess is not None):
            return None
        use_cuda = _device == "cuda" and torch.cuda.is_available()
        dtype = torch.float16 if use_cuda else torch.float32

        tensors = []
        for src in sources:
            pil = download_image(src) if isinstance(src, str) else src
            tensors.append(_clip_preprocess(pil))
        batch = torch.stack(tensors).to(_device, dtype=dtype)
        with torch.no_grad():
            feats = _clip_model.encode_image(batch)
            feats /= feats.norm(dim=-1, keepdim=True)
        return feats.float().cpu().numpy().astype(np.float32)
    except Exception as e:
        logger.warning(f"Batch encoding unavailable ({e}); using sequential fallback")
        return None


def onnx_embed_available() -> bool:
    """True when onnxruntime + an exported CLIP ONNX model exist (int8-quantized path)."""
    try:
        import onnxruntime  # noqa: F401
        import os
        return os.path.exists(os.path.join(config.MODEL_DIR, "clip_vitb32_int8.onnx"))
    except ImportError:
        return False


def cache_stats() -> dict:
    with _lock:
        return {
            "image_cache_size": len(_image_cache),
            "text_cache_size": len(_text_cache),
            "max_size": config.EMBED_CACHE_SIZE,
            "onnx_available": onnx_embed_available(),
        }
