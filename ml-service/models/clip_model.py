"""
CLIP (ViT-B/32) Model Manager for ReSell ML Microservice
Loads open_clip / torch for generating 512-dimensional normalized embeddings for images and text.
Includes resilient fallback for environments without GPU or offline model cache.
"""

import io
import os
import logging
import hashlib
import urllib.request
import numpy as np
from PIL import Image

logger = logging.getLogger("ml-service.clip")

_clip_model = None
_clip_preprocess = None
_clip_tokenizer = None
_device = "cpu"
_is_loaded = False


def initialize_clip(model_name="ViT-B-32", pretrained="laion2b_s34b_b79k"):
    """Initialize the CLIP model and preprocessor"""
    global _clip_model, _clip_preprocess, _clip_tokenizer, _device, _is_loaded
    try:
        import torch
        import open_clip

        _device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Loading CLIP model {model_name} on {_device}...")
        
        _clip_model, _, _clip_preprocess = open_clip.create_model_and_transforms(
            model_name,
            pretrained=pretrained,
            device=_device
        )
        _clip_model.eval()
        _clip_tokenizer = open_clip.get_tokenizer(model_name)
        _is_loaded = True
        logger.info(f"CLIP ({model_name}) initialized successfully on {_device}.")
    except Exception as e:
        logger.warning(f"Failed to load open_clip model ({e}). Using robust feature-projection fallback.")
        _is_loaded = False


def is_model_loaded():
    return _is_loaded


def download_image(url_or_path: str, timeout: int = 10) -> Image.Image:
    """Download and return PIL Image with user agent headers"""
    if url_or_path.startswith("http://") or url_or_path.startswith("https://"):
        req = urllib.request.Request(
            url_or_path,
            headers={"User-Agent": "Mozilla/5.0 (compatible; ReSell-ML/1.0)"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as response:
            image_data = response.read()
        return Image.open(io.BytesIO(image_data)).convert("RGB")
    else:
        return Image.open(url_or_path).convert("RGB")


def _fallback_image_embedding(image: Image.Image, dim: int = 512) -> np.ndarray:
    """Deterministic fallback image embedding based on multi-scale color & spatial moments"""
    img_resized = image.resize((64, 64))
    arr = np.asarray(img_resized, dtype=np.float32) / 255.0  # (64, 64, 3)
    
    # Extract color statistics across 4x4 spatial grid
    features = []
    for r in range(4):
        for c in range(4):
            patch = arr[r*16:(r+1)*16, c*16:(c+1)*16, :]
            mean = np.mean(patch, axis=(0, 1))
            std = np.std(patch, axis=(0, 1))
            features.extend(mean.tolist())
            features.extend(std.tolist())
            
    # Pad or project deterministically to 512 dims
    feat_arr = np.array(features, dtype=np.float32)
    rng = np.random.RandomState(42)
    proj_matrix = rng.randn(len(feat_arr), dim).astype(np.float32)
    emb = np.dot(feat_arr, proj_matrix)
    
    # L2 normalize
    norm = np.linalg.norm(emb)
    if norm > 0:
        emb = emb / norm
    return emb


def _fallback_text_embedding(text: str, dim: int = 512) -> np.ndarray:
    """Deterministic text embedding fallback"""
    tokens = text.lower().strip().split()
    vec = np.zeros(dim, dtype=np.float32)
    for token in tokens:
        h = int(hashlib.sha256(token.encode("utf-8")).hexdigest()[:8], 16)
        idx = h % dim
        sign = 1.0 if (h % 2 == 0) else -1.0
        vec[idx] += sign
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec = vec / norm
    return vec


def extract_image_embedding(image_source) -> np.ndarray:
    """
    Generate 512-D normalized embedding for an image (URL string or PIL Image).
    Returns 512-D float numpy array.
    """
    if isinstance(image_source, str):
        pil_img = download_image(image_source)
    else:
        pil_img = image_source

    if _is_loaded and _clip_model is not None and _clip_preprocess is not None:
        try:
            import torch
            tensor = _clip_preprocess(pil_img).unsqueeze(0).to(_device)
            with torch.no_grad():
                features = _clip_model.encode_image(tensor)
                features /= features.norm(dim=-1, keepdim=True)
            return features.cpu().numpy().flatten().astype(np.float32)
        except Exception as err:
            logger.error(f"Error in CLIP encode_image: {err}")
            return _fallback_image_embedding(pil_img)
    else:
        return _fallback_image_embedding(pil_img)


def extract_text_embedding(text: str) -> np.ndarray:
    """
    Generate 512-D normalized embedding for input text.
    """
    if _is_loaded and _clip_model is not None and _clip_tokenizer is not None:
        try:
            import torch
            tokens = _clip_tokenizer([text]).to(_device)
            with torch.no_grad():
                features = _clip_model.encode_text(tokens)
                features /= features.norm(dim=-1, keepdim=True)
            return features.cpu().numpy().flatten().astype(np.float32)
        except Exception as err:
            logger.error(f"Error in CLIP encode_text: {err}")
            return _fallback_text_embedding(text)
    else:
        return _fallback_text_embedding(text)


def compute_image_text_similarity(image_source, text: str) -> float:
    """Compute cosine similarity between an image and a text string (0.0 - 1.0)"""
    img_emb = extract_image_embedding(image_source)
    txt_emb = extract_text_embedding(text)
    sim = float(np.dot(img_emb, txt_emb))
    # Rescale cosine similarity from [-1, 1] to [0, 1] for easier thresholding
    return float(max(0.0, min(1.0, (sim + 1.0) / 2.0)))
