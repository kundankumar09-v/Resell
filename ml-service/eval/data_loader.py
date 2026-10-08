"""
Real-data loader for the ReSell ML eval harness.

Reads LABELED listings from real sources instead of the synthetic generator:
  1. MongoDB (MONGODB_URI / MONGO_URI, default mongodb://localhost:27017/resell):
     - fraud label: admin decision encoded in Product.status
         'rejected' / 'removed'              -> label 1 (fraud)
         'active' / 'sold'                   -> label 0 (admin-approved / legit)
         'flagged' / 'pending' / 'pendingReview' -> unlabeled, skipped
     - price label: soldPrice when present, else price for status='sold'
  2. CSV files in eval/data/:
     - fraud_listings.csv: title,price,category,sellerId,status,label,timestamp,imageUrl,
                           accountAgeHours,listingsPastHour,perceptualHash,width,height
     - sold_listings.csv:  title,price,soldPrice,category,condition,originalPrice,yearsUsed,
                           sellerId,status,timestamp,imageUrl
     Either file may additionally carry label directly, and an embedding column
     with a JSON array.

Records are converted to the exact shapes the eval harness / v2 feature
extractors expect:
  fraud: {listing, candidateListings, categoryMedianPrice, imageTitleSimilarity,
          label, timestamp, sellerId}
  price: {id, title, category, condition, originalPrice, yearsUsed, price,
          soldPrice, status, embedding, comparables, timestamp, sellerId, imageUrl}

When CLIP is loaded and a listing has no stored embedding, embeddings are
computed from the primary image URL (never placeholder projections - callers
check is_model_loaded() first and fail loudly otherwise).
"""

import csv
import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("ml-service.eval.data_loader")

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

FRAUD_POSITIVE_STATUS = {"rejected", "removed"}
FRAUD_NEGATIVE_STATUS = {"active", "sold"}
UNLABELED_STATUS = {"flagged", "pending", "pendingReview"}


def mongo_available(uri: Optional[str] = None) -> bool:
    try:
        from pymongo import MongoClient
        client = MongoClient(uri or _mongo_uri(), serverSelectionTimeoutMS=2000)
        client.admin.command("ping")
        client.close()
        return True
    except Exception:
        return False


def _mongo_uri() -> str:
    uri = os.environ.get("MONGODB_URI") or os.environ.get("MONGO_URI")
    if uri:
        return uri
    env_file = os.path.join(os.path.dirname(__file__), "..", "..", "backend", ".env")
    if os.path.exists(env_file):
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip().startswith("MONGODB_URI="):
                    return line.split("=", 1)[1].strip()
    return "mongodb://localhost:27017/resell"


def _load_products(uri: Optional[str] = None) -> List[Dict[str, Any]]:
    from pymongo import MongoClient
    client = MongoClient(uri or _mongo_uri(), serverSelectionTimeoutMS=5000)
    try:
        db = client.get_default_database("resell")
        docs = list(db.products.find({}))
    finally:
        client.close()

    products = []
    for d in docs:
        images = d.get("images") or []
        primary = next((i for i in images if i.get("isPrimary")), images[0] if images else None)
        products.append({
            "id": str(d.get("_id")),
            "title": d.get("title") or "",
            "description": d.get("description") or "",
            "price": float(d.get("price") or 0),
            "soldPrice": float(d["soldPrice"]) if d.get("soldPrice") else None,
            "originalPrice": float(d.get("originalPrice") or 0),
            "category": str(d.get("category") or "unknown"),
            "condition": str(d.get("condition") or "good"),
            "yearsUsed": float(d.get("yearsUsed") or 0),
            "status": str(d.get("status") or "active"),
            "sellerId": str(d.get("seller") or d.get("sellerId") or ""),
            "createdAt": d.get("createdAt"),
            "embedding": list(d.get("embedding") or []),
            "imageUrl": primary.get("url") if primary else None,
            "perceptualHash": (primary or {}).get("perceptualHash") or d.get("perceptualHash") or "",
            "width": (primary or {}).get("width") or 0,
            "height": (primary or {}).get("height") or 0,
            "imageUrls": [i.get("url") for i in images if i.get("url")],
        })
    return products


def _csv_path(name: str) -> str:
    return os.path.join(DATA_DIR, name)


def _load_csv(name: str) -> List[Dict[str, Any]]:
    path = _csv_path(name)
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        for raw in csv.DictReader(f):
            row = {k: (v.strip() if isinstance(v, str) else v) for k, v in raw.items() if k}
            emb = row.pop("embedding", None)
            if emb:
                try:
                    row["embedding"] = json.loads(emb)
                except Exception:
                    row["embedding"] = []
            else:
                row["embedding"] = []
            rows.append(row)
    return rows


def _to_float(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _ensure_embeddings(products: List[Dict[str, Any]], require_real: bool = True) -> int:
    """Fill in missing embeddings from images via real CLIP. Returns count computed."""
    from models.clip_model import is_model_loaded, extract_image_embedding
    if not is_model_loaded():
        if require_real:
            raise SystemExit(
                "FATAL: CLIP is not loaded - refusing to evaluate with placeholder "
                "fallback embeddings. Install torch + open-clip-torch, download the "
                "model weights, and retry. (models/clip_model.is_model_loaded() == False)")
        return 0
    computed = 0
    for p in products:
        if len(p.get("embedding") or []) == 512:
            continue
        if not p.get("imageUrl"):
            continue
        try:
            emb = extract_image_embedding(p["imageUrl"])
            if len(emb) == 512:
                p["embedding"] = emb.astype(np.float32).tolist()
                computed += 1
        except Exception as e:
            logger.warning(f"Could not embed image for {p.get('id')}: {e}")
    return computed


def _category_medians(products: List[Dict[str, Any]]) -> Dict[str, float]:
    by_cat: Dict[str, List[float]] = {}
    for p in products:
        if p.get("price", 0) > 0:
            by_cat.setdefault(str(p.get("category") or "unknown"), []).append(float(p["price"]))
    return {c: float(np.median(v)) for c, v in by_cat.items()}


def _fraud_label(p: Dict[str, Any]) -> Optional[int]:
    status = str(p.get("status", "")).lower()
    explicit = p.get("label")
    if explicit is not None and str(explicit) != "":
        try:
            return int(float(explicit))
        except (TypeError, ValueError):
            pass
    if status in FRAUD_POSITIVE_STATUS:
        return 1
    if status in FRAUD_NEGATIVE_STATUS:
        return 0
    return None


def build_fraud_records(products: List[Dict[str, Any]],
                        max_candidates: int = 12,
                        seed: int = 42) -> List[Dict[str, Any]]:
    """Convert labeled products into the eval harness fraud-record shape."""
    rng = np.random.RandomState(seed)
    medians = _category_medians(products)
    labeled = [p for p in products if _fraud_label(p) is not None]
    records = []
    for p in labeled:
        cat = str(p.get("category") or "unknown")
        # candidates: same-category listings from OTHER sellers (duplicate pool)
        pool = [q for q in products
                if q.get("imageUrl") or len(q.get("embedding") or []) == 512]
        cands = [q for q in pool
                 if q.get("sellerId") != p.get("sellerId") and q.get("id") != p.get("id")]
        rng.shuffle(cands)
        candidate_listings = [{
            "id": q["id"], "sellerId": q["sellerId"], "category": q.get("category"),
            "embedding": q.get("embedding") or [],
            "perceptualHash": q.get("perceptualHash") or "",
            "imageHashes": [q["perceptualHash"]] if q.get("perceptualHash") else [],
            "price": q.get("price", 0),
        } for q in cands[:max_candidates]]

        emb = p.get("embedding") or []
        listing = {
            "id": p["id"],
            "title": p.get("title") or "",
            "price": p.get("price", 0),
            "sellerId": p.get("sellerId"),
            "category": cat,
            "embedding": emb,
            "perceptualHash": p.get("perceptualHash") or "",
            "imageHashes": [p["perceptualHash"]] if p.get("perceptualHash") else [],
            "accountAgeHours": _to_float(p.get("accountAgeHours"), 720),
            "listingsPastHour": _to_float(p.get("listingsPastHour"), 1),
            "imageUrl": p.get("imageUrl"),
            "metadata": {"width": p.get("width") or 0, "height": p.get("height") or 0,
                         "software": ""},
            "width": p.get("width") or 0,
            "height": p.get("height") or 0,
        }

        ts = p.get("createdAt") or p.get("timestamp")
        timestamp = _to_float(getattr(ts, "timestamp", lambda: ts or 0)()) if ts is not None else 0.0

        records.append({
            "listing": listing,
            "candidateListings": candidate_listings,
            "categoryMedianPrice": medians.get(cat),
            "imageTitleSimilarity": None,  # computed by the pipeline's CLIP stage
            "label": _fraud_label(p),
            "timestamp": timestamp,
            "sellerId": p.get("sellerId"),
            "imageUrl": p.get("imageUrl"),
        })
    return records


def build_price_records(products: List[Dict[str, Any]],
                        max_comparables: int = 30,
                        seed: int = 42) -> List[Dict[str, Any]]:
    """Convert products with a price label (soldPrice or sold price) into eval price records."""
    rng = np.random.RandomState(seed)

    def price_label(p):
        if p.get("soldPrice") and float(p["soldPrice"]) > 0:
            return float(p["soldPrice"])
        if str(p.get("status", "")).lower() == "sold" and p.get("price", 0) > 0:
            return float(p["price"])
        return None

    with_price = [p for p in products if price_label(p) is not None]
    pool = [p for p in products if p.get("price", 0) > 0]
    records = []
    for p in with_price:
        cat = str(p.get("category") or "unknown")
        comps = [q for q in pool if q.get("id") != p.get("id")
                 and str(q.get("category") or "") == cat]
        rng.shuffle(comps)
        comparables = [{
            "id": q["id"], "category": q.get("category"),
            "price": q.get("price", 0),
            "soldPrice": q.get("soldPrice"),
            "status": q.get("status"),
            "condition": q.get("condition"),
            "embedding": q.get("embedding") or [],
        } for q in comps[:max_comparables]]

        ts = p.get("createdAt") or p.get("timestamp")
        timestamp = _to_float(getattr(ts, "timestamp", lambda: ts or 0)()) if ts is not None else 0.0
        records.append({
            "id": p["id"],
            "title": p.get("title") or "",
            "category": cat,
            "condition": p.get("condition") or "good",
            "originalPrice": p.get("originalPrice") or 0,
            "yearsUsed": p.get("yearsUsed") or 0,
            "price": price_label(p),
            "soldPrice": p.get("soldPrice"),
            "status": p.get("status"),
            "embedding": p.get("embedding") or [],
            "comparables": comparables,
            "timestamp": timestamp,
            "sellerId": p.get("sellerId"),
            "imageUrl": p.get("imageUrl"),
        })
    return records


def load_real_data(require_clip: bool = True,
                   uri: Optional[str] = None,
                   seed: int = 42) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], dict]:
    """
    Load labeled listings from MongoDB and/or CSV files in eval/data/.
    Returns (fraud_records, price_records, meta). Raises SystemExit when no
    labeled data can be found at all (never falls back to synthetic).
    """
    products: List[Dict[str, Any]] = []
    sources = {}
    if mongo_available(uri):
        try:
            products = _load_products(uri)
            sources["mongodb"] = len(products)
        except Exception as e:
            logger.warning(f"MongoDB load failed: {e}")
    csv_rows = _load_csv("listings.csv") or _load_csv("fraud_listings.csv")
    if csv_rows:
        sources["csv"] = len(csv_rows)
        existing = {p["id"] for p in products}
        for r in csv_rows:
            if str(r.get("id") or r.get("_id") or "") in existing:
                continue
            products.append({
                "id": str(r.get("id") or r.get("_id") or f"csv-{len(products)}"),
                "title": r.get("title") or "",
                "price": _to_float(r.get("price")),
                "soldPrice": _to_float(r.get("soldPrice")) or None,
                "originalPrice": _to_float(r.get("originalPrice")),
                "category": r.get("category") or "unknown",
                "condition": r.get("condition") or "good",
                "yearsUsed": _to_float(r.get("yearsUsed")),
                "status": r.get("status") or "active",
                "sellerId": str(r.get("sellerId") or ""),
                "createdAt": None,
                "timestamp": _to_float(r.get("timestamp")),
                "embedding": r.get("embedding") or [],
                "imageUrl": r.get("imageUrl") or None,
                "perceptualHash": r.get("perceptualHash") or "",
                "width": _to_float(r.get("width")),
                "height": _to_float(r.get("height")),
                "accountAgeHours": _to_float(r.get("accountAgeHours"), 720),
                "listingsPastHour": _to_float(r.get("listingsPastHour"), 1),
                "imageUrls": [],
                "label": r.get("label"),
            })

    # Manually labeled labeling-export CSVs (label + labeler filled by hand)
    try:
        from eval.labeling_export import load_labeled_exports
        labeled_rows = load_labeled_exports()
        if labeled_rows:
            sources["labeling_csv"] = len(labeled_rows)
            existing = {p["id"] for p in products}
            for p in labeled_rows:
                if p["id"] in existing:
                    # refresh the label on an already-loaded product
                    for q in products:
                        if q["id"] == p["id"]:
                            q["label"] = p["label"]
                    continue
                products.append(p)
    except Exception as e:
        logger.warning(f"Labeling CSV load failed: {e}")

    if not products:
        raise SystemExit(
            f"FATAL: no real labeled data found. MongoDB unavailable/empty and no CSV in "
            f"{DATA_DIR} (listings.csv / fraud_listings.csv). The eval no longer falls back "
            f"to synthetic data - export labeled listings or point MONGODB_URI at a live DB.")

    computed = _ensure_embeddings(products, require_real=require_clip)

    fraud_records = build_fraud_records(products, seed=seed)
    price_records = build_price_records(products, seed=seed)

    n_pos = sum(1 for r in fraud_records if r["label"] == 1)
    meta = {
        "sources": sources,
        "n_products": len(products),
        "embeddings_computed_via_clip": computed,
        "n_fraud_records": len(fraud_records),
        "n_fraud_positive": n_pos,
        "n_fraud_negative": len(fraud_records) - n_pos,
        "n_price_records": len(price_records),
    }
    return fraud_records, price_records, meta
