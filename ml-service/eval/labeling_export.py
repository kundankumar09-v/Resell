"""
Labeling CSV export + loader for manual duplicate/fraud labeling.

Export (eval/labeling_export.py):
  Writes eval/data/labeling_export_<date>.csv with the RECENT listings, the
  fraud scores from BOTH pipelines (v2 + legacy) so a human labeler can
  compare, and EMPTY `label` / `labeler` columns to be filled by hand:
    id,title,category,price,sellerId,status,imageUrls,
    v2FraudScore,v2FraudProbability,legacyFraudScore,
    label,labeler,exportedAt
  `label` convention: 1 = fraud / duplicate, 0 = legit, blank = unlabeled.

Loader (load_labeling_csv / load_labeled_exports):
  Reads FILLED labeling CSVs back as product dicts compatible with
  eval/data_loader.build_fraud_records. Rows with a blank label are skipped
  (unlabeled) and counted.

Usage:
    python eval/labeling_export.py --limit 200       # export for manual labeling
"""

import argparse
import csv
import os
import sys
import time
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from eval.data_loader import (  # noqa: E402
    DATA_DIR, mongo_available, _load_products, _ensure_embeddings, _to_float)

COLUMNS = ["id", "title", "category", "price", "sellerId", "status", "imageUrls",
           "v2FraudScore", "v2FraudProbability", "legacyFraudScore",
           "label", "labeler", "exportedAt"]


def export_recent_listings(limit: int = 200, uri: Optional[str] = None) -> str:
    """Export recent listings with both pipelines' scores + empty label columns."""
    from models.clip_model import initialize_clip, is_model_loaded
    initialize_clip()
    if not is_model_loaded():
        raise SystemExit(
            "FATAL: CLIP failed to load - refusing to export listings with "
            "placeholder fallback embeddings.")

    if not mongo_available(uri):
        raise SystemExit("FATAL: MongoDB unavailable - nothing to export.")
    products = _load_products(uri)
    products.sort(key=lambda p: p.get("createdAt") or 0, reverse=True)
    products = products[:limit]
    computed = _ensure_embeddings(products)
    print(f"Exporting {len(products)} recent listings (embeddings computed: {computed})")

    from eval.data_loader import build_fraud_records
    records = build_fraud_records(products)

    from services.fraud_detector import evaluate_fraud_risk as legacy_fraud
    import pipeline.fraud_v2 as fv2

    path = os.path.join(DATA_DIR, f"labeling_export_{time.strftime('%Y%m%d')}.csv")
    rows = []
    for rec in records:
        listing = rec["listing"]
        try:
            v2 = fv2.evaluate_fraud_risk_v2(
                listing=listing, candidate_listings=rec["candidateListings"],
                category_median_price=rec["categoryMedianPrice"])
            v2_score = v2.get("fraudScore")
            v2_prob = v2.get("fraudProbability")
        except Exception as e:
            print(f"  v2 eval failed for {listing.get('id')}: {e}")
            v2_score, v2_prob = "", ""
        try:
            legacy = legacy_fraud(listing=listing, candidate_listings=rec["candidateListings"],
                                  image_title_similarity=rec["imageTitleSimilarity"],
                                  category_median_price=rec["categoryMedianPrice"])
            legacy_score = legacy.get("fraudScore")
        except Exception as e:
            print(f"  legacy eval failed for {listing.get('id')}: {e}")
            legacy_score = ""

        rows.append({
            "id": listing.get("id", ""),
            "title": listing.get("title", ""),
            "category": listing.get("category", ""),
            "price": listing.get("price", ""),
            "sellerId": listing.get("sellerId", ""),
            "status": next((p["status"] for p in products if p["id"] == listing.get("id")), ""),
            "imageUrls": ";".join(next((p.get("imageUrls") or [] for p in products
                                        if p["id"] == listing.get("id")), [])),
            "v2FraudScore": v2_score,
            "v2FraudProbability": v2_prob,
            "legacyFraudScore": legacy_score,
            "label": "",       # filled by the labeler: 1 = fraud, 0 = legit
            "labeler": "",     # filled by the labeler
            "exportedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        })

    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Labeling export written to {path} ({len(rows)} rows; fill `label` and `labeler`)")
    return path


def load_labeling_csv(path: str) -> List[Dict[str, Any]]:
    """
    Read a filled labeling CSV back as product dicts compatible with
    eval/data_loader.build_fraud_records. Blank-label rows are skipped.
    """
    if not os.path.exists(path):
        return []
    products, skipped = [], 0
    with open(path, "r", encoding="utf-8", newline="") as f:
        for raw in csv.DictReader(f):
            label_raw = (raw.get("label") or "").strip()
            if label_raw == "":
                skipped += 1
                continue
            try:
                label = int(float(label_raw))
            except ValueError:
                label = 1 if label_raw.lower() in ("fraud", "duplicate", "yes") else 0
            products.append({
                "id": raw.get("id") or f"labeled-{len(products)}",
                "title": raw.get("title") or "",
                "price": _to_float(raw.get("price")),
                "soldPrice": None,
                "originalPrice": 0.0,
                "category": raw.get("category") or "unknown",
                "condition": "good",
                "yearsUsed": 0.0,
                "status": "active",
                "sellerId": raw.get("sellerId") or "",
                "createdAt": None,
                "timestamp": 0.0,
                "embedding": [],
                "imageUrl": (raw.get("imageUrls") or "").split(";")[0] or None,
                "perceptualHash": "",
                "width": 0,
                "height": 0,
                "accountAgeHours": 720.0,
                "listingsPastHour": 1.0,
                "imageUrls": [u for u in (raw.get("imageUrls") or "").split(";") if u],
                "label": label,
            })
    if skipped:
        print(f"  {path}: skipped {skipped} unlabeled rows (blank label)")
    return products


def load_labeled_exports() -> List[Dict[str, Any]]:
    """Load ALL filled labeling CSVs in eval/data/ (newest first, deduped by id)."""
    paths = sorted(
        (os.path.join(DATA_DIR, f) for f in os.listdir(DATA_DIR)
         if f.startswith("labeling_export") and f.endswith(".csv")),
        reverse=True)
    products, seen = [], set()
    for path in paths:
        for p in load_labeling_csv(path):
            if p["id"] in seen:
                continue
            seen.add(p["id"])
            products.append(p)
    return products


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export recent listings for manual labeling")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--mongo-uri", type=str, default=None)
    args = parser.parse_args()
    export_recent_listings(limit=args.limit, uri=args.mongo_uri)
