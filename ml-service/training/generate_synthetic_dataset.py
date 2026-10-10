"""
SYNTHETIC dataset generator for the ReSell evaluation harness.

IMPORTANT: every sample produced here is SYNTHETIC. Nothing in this file is
real marketplace data and metrics computed on it are NOT evidence of
real-world performance.

Generates a class-balanced labeled set (default 100 fraud / 100 legitimate =
200 samples) whose feature distributions match the 14 engineered features in
pipeline/fraud_v2.py (FEATURE_ORDER):

  max_cross_seller_emb_sim  fraud duplicates are noisy copies of another
                            seller's listing (cosine sim ~0.97-1.0); legit
                            listings are distinct centers (sim ~0.0-0.35)
  min_cross_phash_dist      fraud: 0-4 bit flips (small Hamming distance);
                            legit: ~24-40 bit flips
  cross_phash_exact         fraud subset with 0-2 flips
  max_same_seller_emb_sim   same-seller relist samples carry a noisy copy of
                            their OWN listing (labeled legit, not fraud)
  same_seller_relist        relist flag set only for the relist sub-case
  clip_image_text_sim       fraud: 0.03-0.18 (mismatched); legit: 0.35-0.92
  price_zscore_category     fraud scams: large NEGATIVE z-scores (-3 to -9);
                            legit: -2.0 to +2.5
  log_account_age_hours     fraud: fresh accounts (1-48h); legit: 1wk-2yr
  listings_per_hour         fraud: burst rates (8-30/hr); legit: 1-4/hr
  aspect_ratio              stock dims for fraud (1.78/1.5/1.0); realistic
                            phone/camera dims for legit
  is_stock_dimensions       1920x1080 / 1200x800 / 1000x1000
  has_suspicious_software   photoshop tag on ~1/3 of scams
  vision_llm_flag_count     0 (vision-LLM not called in offline eval)
  vision_llm_confidence     0 (same)

It also emits a sold-price regression set (actual sold prices as labels) so the
price estimator can be scored with MAE / MAPE.

Records use the exact shapes the harness and v2 feature extractors expect:
  fraud: {listing, candidateListings, categoryMedianPrice, imageTitleSimilarity,
          label, timestamp, sellerId, synthetic}
  price: {id, title, category, condition, originalPrice, yearsUsed, price,
          soldPrice, status, embedding, comparables, timestamp, sellerId}

Usage:
    python training/generate_synthetic_dataset.py                 # print summary
    python training/generate_synthetic_dataset.py --save          # write JSON
    python training/generate_synthetic_dataset.py --n-fraud 150 --n-legit 150
"""

import argparse
import hashlib
import json
import os
import sys

import numpy as np

# 14-feature contract of pipeline/fraud_v2.py (duplicated here so the generator
# stays importable without pulling in the pipeline module)
FEATURE_ORDER = [
    "max_cross_seller_emb_sim",
    "min_cross_phash_dist",
    "cross_phash_exact",
    "max_same_seller_emb_sim",
    "same_seller_relist",
    "clip_image_text_sim",
    "price_zscore_category",
    "log_account_age_hours",
    "listings_per_hour",
    "aspect_ratio",
    "is_stock_dimensions",
    "has_suspicious_software",
    "vision_llm_flag_count",
    "vision_llm_confidence",
]

CATEGORIES = ["Electronics", "Clothing", "Home_Garden", "Sports", "Books", "Toys"]
CONDITIONS = ["new", "like-new", "good", "fair", "poor"]
CONDITION_W = {"new": 1.0, "like-new": 0.88, "good": 0.75, "fair": 0.58, "poor": 0.40}

STOCK_DIMS = [(1920, 1080), (1200, 800), (1000, 1000)]
REAL_DIMS = [(4032, 3024), (3024, 4032), (1170, 2532), (1284, 2778),
             (828, 1792), (750, 1334), (1536, 2048), (2048, 1536)]

DEFAULT_DATA_PATH = os.path.join(
    os.path.dirname(__file__), "..", "eval", "data", "synthetic_dataset.json")


def _phash(seed_vec: np.ndarray) -> str:
    """Deterministic 64-bit hex perceptual hash from a vector."""
    h = hashlib.sha256(np.ascontiguousarray(seed_vec, dtype=np.float32).tobytes()).digest()[:8]
    return h.hex()


def _flip_bits(phash: str, n_flips: int, rng: np.random.RandomState) -> str:
    """Flip n bits of a 64-bit hex hash -> controlled Hamming distance."""
    v = list(bin(int(phash, 16))[2:].zfill(64))
    idxs = rng.choice(64, size=n_flips, replace=False)
    for i in idxs:
        v[i] = "1" if v[i] == "0" else "0"
    return format(int("".join(v), 2), "016x")


def _unit(center: np.ndarray, noise: float, rng: np.random.RandomState) -> list:
    """Noisy copy of a center vector, L2-normalized (CLIP-like embedding)."""
    v = center + rng.randn(512).astype(np.float32) * noise
    n = np.linalg.norm(v)
    if n > 0:
        v = v / n
    return v.astype(np.float32).tolist()


def _anchor_pool(n_anchors: int, cat_median: dict, rng: np.random.RandomState) -> list:
    """Pool of legitimate 'anchor' listings that fraud duplicates copy from."""
    anchors = []
    for i in range(n_anchors):
        cat = CATEGORIES[rng.randint(len(CATEGORIES))]
        center = rng.randn(512).astype(np.float32)
        price = float(cat_median[cat] * rng.uniform(0.6, 1.5))
        w, h = REAL_DIMS[rng.randint(len(REAL_DIMS))]
        anchors.append({
            "id": f"anchor-{i}",
            "sellerId": f"seller-{rng.randint(150)}",
            "category": cat,
            "embedding": _unit(center, 0.05, rng),
            "phash": _phash(center),
            "price": price,
            "width": w,
            "height": h,
        })
    return anchors


def generate_synthetic_fraud(n_fraud: int = 100, n_legit: int = 100,
                             seed: int = 42) -> list:
    """
    Generate the class-balanced labeled fraud set.
    label: 1 = fraud, 0 = legitimate (incl. same-seller relists, which the v2
    pipeline deliberately does NOT treat as cross-seller fraud).
    """
    rng = np.random.RandomState(seed)

    # Per-category medians: the reference distribution z-scores are computed against
    cat_median = {c: float(rng.uniform(25, 900)) for c in CATEGORIES}
    anchors = _anchor_pool(300, cat_median, rng)

    t_end = 1_760_000_000.0
    t_start = t_end - 120 * 86400

    # Fraud sub-case mix: duplicates (pHash pairs), price scams, both
    n_dup = int(round(n_fraud * 0.45))
    n_scam = int(round(n_fraud * 0.35))
    n_both = n_fraud - n_dup - n_scam
    # Legit sub-case mix: normal, same-seller relists, honest bargains
    n_relist = int(round(n_legit * 0.20))
    n_bargain = int(round(n_legit * 0.15))
    n_normal = n_legit - n_relist - n_bargain

    cases = ([("dup", 1)] * n_dup + [("scam", 1)] * n_scam + [("both", 1)] * n_both
             + [("normal", 0)] * n_normal + [("relist", 0)] * n_relist
             + [("bargain", 0)] * n_bargain)
    rng.shuffle(cases)

    records = []
    for i, (case, label) in enumerate(cases):
        ts = t_start + (t_end - t_start) * (i / max(1, len(cases)))
        anchor = anchors[rng.randint(len(anchors))]
        cat = anchor["category"]
        median = cat_median[cat]
        seller_id = f"seller-{rng.randint(150) + 150}"  # offset: never an anchor's seller

        if label == 1:
            if case in ("dup", "both"):
                # Duplicate of ANOTHER seller's listing: tiny embedding noise ->
                # very high cosine sim; 0-4 bit flips -> small Hamming distance
                center = np.array(anchor["embedding"], dtype=np.float32)
                emb = _unit(center, rng.uniform(0.002, 0.02), rng)
                phash = _flip_bits(anchor["phash"], int(rng.randint(0, 5)), rng)
            else:
                center = rng.randn(512).astype(np.float32)
                emb = _unit(center, 0.05, rng)
                phash = _phash(center)

            if case in ("scam", "both"):
                # Price outlier: large NEGATIVE z-score (-3 to -9)
                z = float(rng.uniform(-9.0, -3.0))
                price = float(max(1.0, median + z * 0.35 * median))
                account_age = float(rng.uniform(1, 48))      # new account
                velocity = float(rng.uniform(8, 30))         # burst listing rate
                title_sim = float(rng.uniform(0.03, 0.17))
            else:
                price = float(median * rng.uniform(0.35, 0.9))
                account_age = float(rng.uniform(1, 2000))
                velocity = float(rng.uniform(1, 10))
                title_sim = float(rng.uniform(0.03, 0.45))

            if rng.rand() < 0.7:
                w, h = STOCK_DIMS[rng.randint(len(STOCK_DIMS))]
            else:
                w, h = REAL_DIMS[rng.randint(len(REAL_DIMS))]
            software = "photoshop" if rng.rand() < 0.33 else ""
        elif case == "relist":
            # Same-seller relist: copy of the seller's OWN listing (label 0)
            own_center = rng.randn(512).astype(np.float32)
            emb = _unit(own_center, rng.uniform(0.002, 0.02), rng)
            phash = _flip_bits(_phash(own_center), int(rng.randint(0, 7)), rng)
            price = float(median * rng.uniform(0.7, 1.3))
            account_age = float(rng.uniform(200, 17000))
            velocity = float(rng.uniform(1, 3))
            title_sim = float(rng.uniform(0.4, 0.88))
            w, h = REAL_DIMS[rng.randint(len(REAL_DIMS))]
            software = ""
            seller_id = anchor["sellerId"]  # relisting own item
        elif case == "bargain":
            # Honest bargain: price low but z-score above the -2.5 fraud cut
            z = float(rng.uniform(-2.2, -1.2))
            price = float(max(1.0, median + z * 0.35 * median))
            center = rng.randn(512).astype(np.float32)
            emb = _unit(center, 0.05, rng)
            phash = _phash(center)
            account_age = float(rng.uniform(200, 17000))
            velocity = float(rng.uniform(1, 4))
            title_sim = float(rng.uniform(0.35, 0.8))
            w, h = REAL_DIMS[rng.randint(len(REAL_DIMS))]
            software = ""
        else:
            # Normal legitimate listing
            price = float(median * rng.uniform(0.6, 1.5))
            center = rng.randn(512).astype(np.float32)
            emb = _unit(center, 0.05, rng)
            phash = _phash(center)
            account_age = float(rng.uniform(200, 17000))
            velocity = float(rng.uniform(1, 4))
            title_sim = float(rng.uniform(0.35, 0.92))
            w, h = REAL_DIMS[rng.randint(len(REAL_DIMS))]
            software = ""

        listing = {
            "id": f"syn-fraud-{i}",
            "title": f"{cat} item {i}",
            "price": round(price, 2),
            "sellerId": seller_id,
            "category": cat,
            "embedding": emb,
            "perceptualHash": phash,
            "imageHashes": [phash],
            "accountAgeHours": round(account_age, 2),
            "listingsPastHour": round(velocity, 2),
            "imageUrl": None,
            "metadata": {"width": w, "height": h, "software": software},
            "width": w,
            "height": h,
        }

        # Candidates: always include the copied anchor for duplicate cases (so
        # the duplicate signal is actually observable), plus random distractors
        candidates = []
        if label == 1 and case in ("dup", "both"):
            a = dict(anchor)
            candidates.append({
                "id": a["id"], "sellerId": a["sellerId"], "category": a["category"],
                "embedding": a["embedding"], "perceptualHash": a["phash"],
                "imageHashes": [a["phash"]], "price": a["price"],
            })
        if case == "relist":
            candidates.append({
                "id": f"own-relist-{i}", "sellerId": seller_id, "category": cat,
                "embedding": _unit(np.array(emb, dtype=np.float32), 0.004, rng),
                "perceptualHash": _flip_bits(phash, 2, rng),
                "imageHashes": [],
                "price": listing["price"],
            })
        distractors = [a for a in anchors
                       if a["id"] not in {c["id"] for c in candidates}
                       and a["sellerId"] != seller_id]
        idx = rng.choice(len(distractors), size=min(11, len(distractors)), replace=False)
        for j in idx:
            a = distractors[j]
            candidates.append({
                "id": a["id"], "sellerId": a["sellerId"], "category": a["category"],
                "embedding": a["embedding"], "perceptualHash": a["phash"],
                "imageHashes": [a["phash"]], "price": a["price"],
            })

        records.append({
            "listing": listing,
            "candidateListings": candidates,
            "categoryMedianPrice": median,
            "imageTitleSimilarity": title_sim,
            "label": label,
            "case": case,
            "timestamp": ts,
            "sellerId": seller_id,
            "synthetic": True,
        })

    return records


def generate_synthetic_price(n: int = 200, seed: int = 42) -> list:
    """
    Generate the sold-price regression set (actual sold price = label) for
    scoring the price estimator with MAE / MAPE.
    """
    rng = np.random.RandomState(seed)
    cat_base = {c: float(rng.uniform(80, 900)) for c in CATEGORIES}

    t_end = 1_760_000_000.0
    t_start = t_end - 365 * 86400

    records = []
    for i in range(n):
        cat = CATEGORIES[rng.randint(len(CATEGORIES))]
        cond = CONDITIONS[rng.randint(len(CONDITIONS))]
        orig = float(cat_base[cat] * rng.uniform(0.5, 2.0))
        years = float(round(rng.uniform(0, 6), 2))
        true_price = orig * CONDITION_W[cond] * float(np.exp(-0.15 * years))
        # Noisy market price (log-normal); sold price = noisy realization of it
        price = float(max(5.0, true_price * float(np.exp(rng.normal(0, 0.18)))))
        sold = float(max(5.0, price * float(np.exp(rng.normal(0, 0.06)))))
        ts = t_start + (t_end - t_start) * (i / max(1, n))

        records.append({
            "id": f"syn-price-{i}",
            "title": f"{cat} listing {i}",
            "category": cat,
            "condition": cond,
            "originalPrice": round(orig, 2),
            "yearsUsed": years,
            "price": round(price, 2),
            "soldPrice": round(sold, 2),   # the actual sold price = label
            "status": "sold",
            "embedding": _unit(rng.randn(512).astype(np.float32), 0.05, rng),
            "timestamp": ts,
            "sellerId": f"seller-{rng.randint(300)}",
            "synthetic": True,
        })

    # Attach same-category comparables (sold prices preferred by the pipelines)
    for rec in records:
        same_cat = [r for r in records
                    if r["category"] == rec["category"] and r["id"] != rec["id"]]
        idx = rng.choice(len(same_cat), size=min(30, len(same_cat)), replace=False)
        rec["comparables"] = [{
            "id": same_cat[j]["id"], "category": same_cat[j]["category"],
            "price": same_cat[j]["price"], "soldPrice": same_cat[j]["soldPrice"],
            "status": same_cat[j]["status"], "condition": same_cat[j]["condition"],
            "embedding": same_cat[j]["embedding"],
        } for j in idx]

    return records


def generate_synthetic_dataset(n_fraud: int = 100, n_legit: int = 100,
                               n_price: int = 200, seed: int = 42) -> dict:
    """Generate both subsets. Returns {fraud: [...], price: [...]}."""
    return {
        "fraud": generate_synthetic_fraud(n_fraud=n_fraud, n_legit=n_legit, seed=seed),
        "price": generate_synthetic_price(n=n_price, seed=seed + 1),
    }


def save_dataset(dataset: dict, path: str = DEFAULT_DATA_PATH) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dataset, f)
    return path


def load_dataset(path: str = DEFAULT_DATA_PATH) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(
        description="Generate a SYNTHETIC labeled dataset for the ReSell eval harness")
    parser.add_argument("--n-fraud", type=int, default=100)
    parser.add_argument("--n-legit", type=int, default=100)
    parser.add_argument("--n-price", type=int, default=200)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--save", action="store_true",
                        help=f"Write the dataset JSON to {DEFAULT_DATA_PATH}")
    args = parser.parse_args()

    ds = generate_synthetic_dataset(n_fraud=args.n_fraud, n_legit=args.n_legit,
                                    n_price=args.n_price, seed=args.seed)
    n_pos = sum(r["label"] for r in ds["fraud"])
    n_neg = len(ds["fraud"]) - n_pos
    print(f"SYNTHETIC fraud set: {len(ds['fraud'])} samples "
          f"({n_pos} fraud / {n_neg} legitimate)")
    print(f"SYNTHETIC price set: {len(ds['price'])} sold listings")
    cases = {}
    for r in ds["fraud"]:
        cases[f"{r['case']}(label={r['label']})"] = cases.get(
            f"{r['case']}(label={r['label']})", 0) + 1
    print("sub-cases:", json.dumps(cases, sort_keys=True))
    if args.save:
        path = save_dataset(ds)
        print(f"saved to {path}")


if __name__ == "__main__":
    main()
