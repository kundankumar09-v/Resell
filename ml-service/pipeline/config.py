"""
Pipeline v2 configuration.
Everything is env-driven; the master feature flag is ML_PIPELINE_V2 (default off,
which keeps the legacy rule-based fraud / heuristic price pipeline in control).
"""

import json
import os

# ── Master feature flag ────────────────────────────────────────────
_raw_flag = os.environ.get("ML_PIPELINE_V2", "0").strip().lower()
# "1"/"true"/"yes"/"on" -> v2 pipeline served
# "shadow"              -> BOTH pipelines run, legacy results are SERVED, both logged
ML_PIPELINE_V2 = _raw_flag in ("1", "true", "true", "yes", "on")
ML_PIPELINE_SHADOW = _raw_flag == "shadow"


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# ── Model artifacts ────────────────────────────────────────────────
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "..", "models_saved"))
FRAUD_MODEL_PATH = os.path.join(MODEL_DIR, "fraud_v2.txt")
FRAUD_CALIBRATOR_PATH = os.path.join(MODEL_DIR, "fraud_v2_calibrator.pkl")
FRAUD_THRESHOLDS_PATH = os.path.join(MODEL_DIR, "fraud_v2_thresholds.json")
PRICE_MODEL_PREFIX = os.path.join(MODEL_DIR, "price_v2")
PRICE_CONFORMAL_PATH = os.path.join(MODEL_DIR, "price_v2_conformal.json")

# ── Fraud v2 ───────────────────────────────────────────────────────
# v2 calibrated-probability thresholds (0-1 scale). NOTE: at runtime
# models_saved/fraud_v2_thresholds.json OVERRIDES these via
# fraud_v2.load_thresholds() when present (currently 0.95 flag / 0.475
# review). The env defaults below are only the missing-file fallback.
# v2 is SHADOW-only (ML_PIPELINE_V2=shadow): the Node backend v1 scorer
# (fraudDetection.js: high >= 50 / medium >= 25 on a 0-100 additive
# scale) remains authoritative for listing status.
FRAUD_HIGH_THRESHOLD = _env_float("FRAUD_HIGH_THRESHOLD", 0.60)   # flag for review
FRAUD_MEDIUM_THRESHOLD = _env_float("FRAUD_MEDIUM_THRESHOLD", 0.30)
PHASH_EXACT_MAX_DIST = _env_int("PHASH_EXACT_MAX_DIST", 4)


# ── Combined duplicate rule ────────────────────────────────────────
# CLIP embedding similarity is the PRIMARY duplicate signal. Its threshold is
# chosen from the ROC curve at 2% FPR on the adversarial duplicate set
# (eval/adversarial_duplicates.py) and persisted by that script to
# models_saved/duplicate_threshold.json. Precedence: env override > measured
# value > 0.88 (the old fixed default).
def _duplicate_emb_sim_threshold() -> float:
    env = os.environ.get("DUPLICATE_EMB_SIM_THRESHOLD")
    if env:
        try:
            return float(env)
        except ValueError:
            pass
    path = os.path.join(MODEL_DIR, "duplicate_threshold.json")
    try:
        with open(path, "r") as f:
            return float(json.load(f)["embedding_sim_threshold"])
    except Exception:
        return 0.88


DUPLICATE_EMB_SIM_THRESHOLD = _duplicate_emb_sim_threshold()

# Uncertainty band: vision-LLM is only called when the calibrated fraud
# probability falls inside [low, high] AND the margin to the nearest
# threshold is below the band width.
VISION_LLM_BAND = (_env_float("VISION_LLM_BAND_LOW", 0.25), _env_float("VISION_LLM_BAND_HIGH", 0.65))
VISION_LLM_MARGIN = _env_float("VISION_LLM_MARGIN", 0.15)

# ── NVIDIA vision-LLM (NIM, OpenAI-compatible) ─────────────────────
NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "")
NVIDIA_BASE_URL = os.environ.get("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
NVIDIA_VISION_MODEL = os.environ.get("NVIDIA_VISION_MODEL", "microsoft/phi-3-vision-128k-instruct")
NVIDIA_TIMEOUT_S = _env_float("NVIDIA_TIMEOUT_S", 8.0)
NVIDIA_IMAGE_SIZE = _env_int("NVIDIA_IMAGE_SIZE", 512)  # one resized image per call

# ── Price v2 ───────────────────────────────────────────────────────
PRICE_QUANTILES = (0.1, 0.5, 0.9)
PRICE_CONFORMAL_ALPHA = _env_float("PRICE_CONFORMAL_ALPHA", 0.20)   # 80% interval coverage
PRICE_SOLD_WEIGHT = _env_float("PRICE_SOLD_WEIGHT", 2.0)            # sold comps weigh more
PRICE_OUTLIER_MAD = _env_float("PRICE_OUTLIER_MAD", 3.0)            # MAD-based outlier cut
PRICE_MIN_COMPS_FOR_ML = _env_int("PRICE_MIN_COMPS_FOR_ML", 8)
KNN_NEIGHBORS = _env_int("KNN_NEIGHBORS", 12)

# ── Efficiency ─────────────────────────────────────────────────────
EMBED_CACHE_SIZE = _env_int("EMBED_CACHE_SIZE", 4096)
STAGE_TIMEOUT_S = _env_float("STAGE_TIMEOUT_S", 3.0)   # per-stage timeout with rule fallback
ANN_EF_SEARCH = _env_int("ANN_EF_SEARCH", 64)

# ── Logging / feedback ─────────────────────────────────────────────
PREDICTION_LOG_PATH = os.environ.get(
    "PREDICTION_LOG_PATH",
    os.path.join(os.path.dirname(__file__), "..", "models_saved", "predictions.jsonl"),
)
