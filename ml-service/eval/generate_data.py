"""
Synthetic dataset generators for the ReSell ML eval harness.

Produces realistic listings with:
- 512-D embeddings (fraud duplicates = noisy copies of another seller's listing,
  same-seller relists = noisy copies of the seller's own listing, legit = distinct)
- perceptual hashes (hex) with Hamming-distance structure per case
- timestamps (for time-based splits), seller ids (for seller-grouped splits)
- fraud labels / prices (regression targets)

Since the harness runs without torch/network, embeddings are generated directly
as arrays; the pipeline feature extractors accept embeddings via the payload.
"""

import hashlib
import numpy as np

CATEGORIES = ["Electronics", "Clothing", "Home_Garden", "Sports", "Books", "Toys"]
CONDITIONS = ["new", "like-new", "good", "fair", "poor"]
CONDITION_W = {"new": 1.0, "like-new": 0.88, "good": 0.75, "fair": 0.58, "poor": 0.40}


def _phash(seed_vec: np.ndarray) -> str:
    """Deterministic 64-bit hex perceptual hash from a vector."""
    h = hashlib.sha256(seed_vec.tobytes()).digest()[:8]
    return h.hex()


def _flip_bits(phash: str, n_flips: int, rng: np.random.RandomState) -> str:
    v = list(bin(int(phash, 16))[2:].zfill(64))
    idxs = rng.choice(64, size=n_flips, replace=False)
    for i in idxs:
        v[i] = "1" if v[i] == "0" else "0"
    return format(int("".join(v), 2), "016x")


def _cluster_embedding(center: np.ndarray, noise: float, rng: np.random.RandomState) -> list:
    v = center + rng.randn(512).astype(np.float32) * noise
    n = np.linalg.norm(v)
    if n > 0:
        v = v / n
    return v.astype(np.float32).tolist()


def generate_fraud_dataset(n: int = 2000, seed: int = 42, fraud_rate: float = 0.18,
                           relist_rate: float = 0.10) -> list:
    """
    Generate fraud eval records:
    {listing, candidateListings, categoryMedianPrice, imageTitleSimilarity,
     label, timestamp, sellerId}
    label: 1 = fraud (cross-seller duplicate or scam), 0 = legit or same-seller relist.
    """
    rng = np.random.RandomState(seed)
    records = []

    # Global pool of legit "anchor" listings that candidates reference
    n_anchors = 400
    anchors = []
    for i in range(n_anchors):
        cat = CATEGORIES[rng.randint(len(CATEGORIES))]
        center = rng.randn(512).astype(np.float32)
        anchors.append({
            "id": f"anchor-{i}",
            "sellerId": f"seller-{rng.randint(200)}",
            "category": cat,
            "embedding": _cluster_embedding(center, 0.05, rng),
            "phash": _phash(center),
            "price": float(rng.uniform(20, 1500)),
        })

    t_end = 1_700_000_000.0
    t_start = t_end - 180 * 86400  # 180 days of history

    n_dup = int(n * fraud_rate)
    n_relist = int(n * relist_rate)
    n_legit = n - n_dup - n_relist
    case_seq = ([1] * n_dup + [0] * n_relist + [2] * n_legit)
    rng.shuffle(case_seq)

    for i, case in enumerate(case_seq):
        ts = t_start + (t_end - t_start) * (i / max(1, n))
        anchor = anchors[rng.randint(len(anchors))]
        cat = anchor["category"]
        cat_median = float(np.median([a["price"] for a in anchors if a["category"] == cat]))
        seller_id = f"seller-{rng.randint(200)}"

        if case == 1:
            # ── Fraud: cross-seller duplicate or scam ─────────────
            is_dup = rng.rand() < 0.55
            if is_dup:
                # Copy of another seller's listing: high emb sim + near-identical phash
                emb = _cluster_embedding(np.array(anchor["embedding"], dtype=np.float32),
                                         0.005, rng)
                phash = _flip_bits(anchor["phash"], int(rng.randint(0, 4)), rng)
            else:
                # Low-price scam: suspiciously cheap + new account + high velocity
                emb = _cluster_embedding(rng.randn(512).astype(np.float32), 0.05, rng)
                phash = _phash(rng.randn(8).astype(np.float32))
            price = float(cat_median * rng.uniform(0.10, 0.28))
            account_age = float(rng.uniform(1, 40))
            velocity = float(rng.uniform(6, 25))
            title_sim = float(rng.uniform(0.03, 0.18))
            metadata = {"width": int(rng.choice([1920, 1200, 800])),
                        "height": int(rng.choice([1080, 800, 600])),
                        "software": str(rng.choice(["", "", "photoshop"]))}
            label = 1
        elif case == 0:
            # ── Same-seller relist (label 0, NOT cross-seller fraud) ──
            own_center = rng.randn(512).astype(np.float32)
            emb = _cluster_embedding(own_center, 0.005, rng)
            phash = _flip_bits(_phash(own_center), int(rng.randint(0, 6)), rng)
            price = float(cat_median * rng.uniform(0.7, 1.3))
            account_age = float(rng.uniform(100, 8000))
            velocity = float(rng.uniform(1, 3))
            title_sim = float(rng.uniform(0.4, 0.85))
            metadata = {"width": 800, "height": 600, "software": ""}
            seller_id = anchor["sellerId"]  # relisting own item
            label = 0
        else:
            # ── Legit listing ─────────────────────────────────────
            emb = _cluster_embedding(rng.randn(512).astype(np.float32), 0.05, rng)
            phash = _phash(rng.randn(8).astype(np.float32))
            price = float(cat_median * rng.uniform(0.6, 1.5))
            account_age = float(rng.uniform(100, 8000))
            velocity = float(rng.uniform(1, 4))
            title_sim = float(rng.uniform(0.35, 0.9))
            metadata = {"width": 800, "height": 600, "software": ""}
            label = 0

        listing = {
            "id": f"eval-{i}",
            "title": f"{cat} item {i}",
            "price": price,
            "sellerId": seller_id,
            "category": cat,
            "embedding": emb,
            "perceptualHash": phash,
            "imageHashes": [phash],
            "accountAgeHours": account_age,
            "listingsPastHour": velocity,
            "metadata": metadata,
            "width": metadata["width"],
            "height": metadata["height"],
        }

        # Candidates: sample from anchors (other sellers) + a same-seller relist
        # candidate when this record is a relist
        cand_idx = rng.choice(len(anchors), size=12, replace=False)
        candidates = []
        for j in cand_idx:
            a = dict(anchors[j])
            candidates.append({
                "id": a["id"], "sellerId": a["sellerId"], "category": a["category"],
                "embedding": a["embedding"],
                "perceptualHash": a["phash"], "imageHashes": [a["phash"]],
                "price": a["price"],
            })
        if case == 0:
            candidates.append({
                "id": f"own-relist-{i}", "sellerId": seller_id, "category": cat,
                "embedding": _cluster_embedding(
                    np.array(listing["embedding"], dtype=np.float32), 0.004, rng),
                "perceptualHash": _flip_bits(phash, 2, rng),
                "imageHashes": [],
                "price": price,
            })

        records.append({
            "listing": listing,
            "candidateListings": candidates,
            "categoryMedianPrice": cat_median,
            "imageTitleSimilarity": title_sim,
            "label": label,
            "timestamp": ts,
            "sellerId": seller_id,
            "synthetic": True,
        })

    return records


def generate_price_dataset(n: int = 1500, seed: int = 42) -> list:
    """
    Generate price eval records (sold listings with noisy market prices):
    {originalPrice, yearsUsed, condition, category, price, soldPrice, status,
     embedding, comparables, timestamp, sellerId}
    """
    rng = np.random.RandomState(seed)
    records = []

    # Per-category base value distributions
    cat_base = {c: rng.uniform(80, 1200) for c in CATEGORIES}

    t_end = 1_700_000_000.0
    t_start = t_end - 365 * 86400

    for i in range(n):
        cat = CATEGORIES[rng.randint(len(CATEGORIES))]
        cond = CONDITIONS[rng.randint(len(CONDITIONS))]
        orig = cat_base[cat] * rng.uniform(0.5, 2.0)
        years = float(rng.uniform(0, 6))
        true_price = orig * CONDITION_W[cond] * np.exp(-0.15 * years)
        # Noisy market price (log-normal)
        price = float(true_price * np.exp(rng.normal(0, 0.18)))
        price = max(5.0, price)
        sold = rng.rand() < 0.65
        ts = t_start + (t_end - t_start) * (i / n)

        # Comparable listings in the same category (other rows)
        rec = {
            "id": f"price-{i}",
            "title": f"{cat} listing {i}",
            "category": cat,
            "condition": cond,
            "originalPrice": float(orig),
            "yearsUsed": years,
            "price": price,
            "soldPrice": price if sold else None,
            "status": "sold" if sold else "active",
            "embedding": _cluster_embedding(rng.randn(512).astype(np.float32), 0.05, rng),
            "timestamp": ts,
            "sellerId": f"seller-{rng.randint(300)}",
            "synthetic": True,
        }
        records.append(rec)

    # Attach comparables (same category, from other records)
    for i, rec in enumerate(records):
        same_cat = [r for r in records if r["category"] == rec["category"] and r["id"] != rec["id"]]
        idx = rng.choice(len(same_cat), size=min(30, len(same_cat)), replace=False)
        rec["comparables"] = [same_cat[j] for j in idx]

    return records
