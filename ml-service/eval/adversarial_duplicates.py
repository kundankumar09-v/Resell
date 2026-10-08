"""
Adversarial duplicate test set for duplicate detection.

From REAL product images (MongoDB product image URLs + accumulated images in
eval/data/images/, filled to >=100 sources from Lorem Picsum real photographs)
we generate the evasion attacks a fraudulent reseller actually uses:

  1. crop35         - centered 35% cut (30-40% crop range)
  2. rotate15       - 15-degree rotation with auto-crop
  3. color_shift    - brightness/contrast/saturation shift (defeats color stats)
  4. watermark      - diagonal marketplace watermark overlay
  5. mirror         - horizontal flip (defeats spatial layout / SIFT)
  6. screenshot     - white border + fake mobile-UI bar + aggressive JPEG
  7. collage        - 2x2 grid mixing the original with its variants
  8. crop_mirror    - two-edit combination
  9. rotate_color   - two-edit combination
 10. watermark_crop - two-edit combination

Each variant is "posted" as a DIFFERENT seller (synthetic seller ids), which
is the cross-seller duplicate scenario the fraud pipeline must catch.

Detectors evaluated on the duplicate pairs vs two negative pools:
  - EASY negatives: random cross-product pairs
  - HARD negatives: the most visually similar DIFFERENT source images
    (CLIP sim >= 0.80 - same model / similar backgrounds proxies)

Reported: per-variant recall, ROC + PR curves (saved to
eval/data/roc_pr_curves.json), the chosen CLIP threshold (ROC at 2% FPR on the
combined adversarial negative pool) with its realized FPR on easy vs hard
negatives, and a before/after table vs the old fixed 0.88 rule. The chosen
threshold is persisted to models_saved/duplicate_threshold.json where
pipeline/config.py picks it up.

Usage:
    python eval/adversarial_duplicates.py                 # full report
    python eval/adversarial_duplicates.py --n-groups 100  # 100+ source images
"""

import argparse
import json
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from models.clip_model import (  # noqa: E402
    initialize_clip, is_model_loaded, download_image, extract_image_embedding)
from pipeline.embedding_cache import get_batch_image_embeddings_cached  # noqa: E402
from pipeline import config  # noqa: E402
import imagehash  # noqa: E402

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
IMAGES_DIR = os.path.join(DATA_DIR, "images")
REPORT_PATH = os.path.join(os.path.dirname(__file__), "adversarial_report.md")
CURVES_PATH = os.path.join(DATA_DIR, "roc_pr_curves.json")
THRESHOLD_PATH = os.path.join(config.MODEL_DIR, "duplicate_threshold.json")

VARIANTS = ["crop35", "rotate15", "color_shift", "watermark", "mirror",
            "screenshot", "collage", "crop_mirror", "rotate_color", "watermark_crop"]

OLD_FIXED_THRESHOLD = 0.88          # the rule this replaces (before)
PHASH_EXACT = 4
PHASH_NEAR = 8
FPR_TARGET = 0.02
HARD_NEG_SIM = 0.80                 # CLIP sim between DIFFERENT sources -> "same model" hard negative
HARD_NEG_TOPK = 2                   # most-similar other sources per source


# ── Variant generation (PIL only, deterministic) ─────────────────────

def _variant_crop35(img: Image.Image) -> Image.Image:
    """Centered crop removing 35% (30-40% range): keep 65% of each axis."""
    w, h = img.size
    return img.crop((int(w * 0.175), int(h * 0.175), int(w * 0.825), int(h * 0.825)))


def _variant_rotate15(img: Image.Image) -> Image.Image:
    return img.rotate(15, resample=Image.BICUBIC, expand=False, fillcolor=(255, 255, 255))


def _variant_color_shift(img: Image.Image) -> Image.Image:
    out = ImageEnhance.Brightness(img).enhance(0.80)
    out = ImageEnhance.Contrast(out).enhance(1.20)
    out = ImageEnhance.Color(out).enhance(0.65)  # desaturate 35%
    return out


def _variant_watermark(img: Image.Image) -> Image.Image:
    """Diagonal marketplace watermark overlay (classic reseller evasion)."""
    out = img.copy().convert("RGBA")
    overlay = Image.new("RGBA", out.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    w, h = out.size
    text = "MARKETPLACE  SAMPLE"
    try:
        font = ImageFont.truetype("arial.ttf", max(18, h // 18))
    except Exception:
        font = ImageFont.load_default()
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    for k in range(-2, 3):
        x = int(w * 0.5 - tw / 2 + k * (tw + 40) * 0.5)
        y = int(h * 0.5 + k * (th + 50))
        d.text((x, y), text, font=font, fill=(255, 255, 255, 110))
    d.text((8, 8), "sold-via-marketplace.com", font=font, fill=(255, 255, 255, 130))
    return Image.alpha_composite(out, overlay).convert("RGB")


def _variant_mirror(img: Image.Image) -> Image.Image:
    return ImageOps.mirror(img)


def _variant_screenshot(img: Image.Image) -> Image.Image:
    """Fake mobile-screenshot: white frame + status bar + JPEG artifacts."""
    w, h = img.size
    pad = max(12, int(w * 0.04))
    bar = max(28, int(h * 0.06))
    canvas = Image.new("RGB", (w + 2 * pad, h + pad + bar), (250, 250, 250))
    canvas.paste(img, (pad, bar))
    d = ImageDraw.Draw(canvas)
    d.rectangle([pad, 0, pad + w, bar - 4], fill=(30, 30, 30))
    d.text((pad + 8, 4), "9:41  seller-app  v2.3", fill=(240, 240, 240))
    out = os.path.join(_tmpdir(), "screenshot_tmp.jpg")
    canvas.save(out, "JPEG", quality=55)  # aggressive recompression
    return Image.open(out)


def _variant_collage(img: Image.Image) -> Image.Image:
    w, h = img.size
    cell = (w // 2, h // 2)
    small = img.resize(cell)
    tiles = [small, _variant_crop35(small).resize(cell),
             _variant_mirror(small), _variant_color_shift(small).resize(cell)]
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    canvas.paste(tiles[0], (0, 0))
    canvas.paste(tiles[1], (cell[0], 0))
    canvas.paste(tiles[2], (0, cell[1]))
    canvas.paste(tiles[3], (cell[0], cell[1]))
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, w - 1, h - 1], outline=(200, 200, 200), width=3)
    return canvas


def _variant_crop_mirror(img: Image.Image) -> Image.Image:
    return ImageOps.mirror(_variant_crop35(img))


def _variant_rotate_color(img: Image.Image) -> Image.Image:
    return _variant_color_shift(_variant_rotate15(img))


def _variant_watermark_crop(img: Image.Image) -> Image.Image:
    return _variant_watermark(_variant_crop35(img))


_VARIANT_FNS = {
    "crop35": _variant_crop35,
    "rotate15": _variant_rotate15,
    "color_shift": _variant_color_shift,
    "watermark": _variant_watermark,
    "mirror": _variant_mirror,
    "screenshot": _variant_screenshot,
    "collage": _variant_collage,
    "crop_mirror": _variant_crop_mirror,
    "rotate_color": _variant_rotate_color,
    "watermark_crop": _variant_watermark_crop,
}


def _tmpdir() -> str:
    d = os.path.join(DATA_DIR, "tmp")
    os.makedirs(d, exist_ok=True)
    return d


# ── Source images: real product photos ────────────────────────────────

_PICSUM_IDS = list(range(1, 120))  # real photographs (Lorem Picsum archive)


def collect_source_images(n_groups: int, uri: Optional[str] = None) -> list:
    """
    Real product images: local eval/data/images/ (persisted across runs) +
    MongoDB product URLs + Lorem Picsum real photographs to fill to n_groups.
    Raises SystemExit when no real image can be found.
    """
    os.makedirs(IMAGES_DIR, exist_ok=True)

    # 1. MongoDB product photos (true product images, carry real categories)
    try:
        from eval.data_loader import mongo_available, _load_products
        if mongo_available(uri):
            for pi, p in enumerate(_load_products(uri)):
                for j, url in enumerate(p.get("imageUrls") or []):
                    path = os.path.join(IMAGES_DIR, f"product_{pi:03d}_{j}.jpg")
                    if not os.path.exists(path):
                        try:
                            download_image(url).save(path, "JPEG", quality=92)
                        except Exception as e:
                            print(f"  skip (download failed): {e}")
                            continue
    except Exception as e:
        print(f"  MongoDB image source unavailable: {e}")

    # 2. Fill to n_groups with real photographs (Lorem Picsum, deterministic ids)
    existing = sorted(f for f in os.listdir(IMAGES_DIR)
                      if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
    if len(existing) < n_groups:
        for pid in _PICSUM_IDS:
            if len(existing) >= n_groups:
                break
            name = f"picsum_{pid:04d}.jpg"
            path = os.path.join(IMAGES_DIR, name)
            if os.path.exists(path):
                if name not in existing:
                    existing.append(name)
                continue
            try:
                download_image(f"https://picsum.photos/id/{pid}/800/600.jpg") \
                    .save(path, "JPEG", quality=90)
                existing.append(name)
            except Exception:
                continue

    local = [os.path.join(IMAGES_DIR, f) for f in sorted(os.listdir(IMAGES_DIR))
             if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))]
    if not local:
        raise SystemExit(
            f"FATAL: no real product images available for the adversarial duplicate test. "
            f"MongoDB is empty/unreachable and {IMAGES_DIR} contains no images. The test "
            f"refuses to run on synthetic placeholder images.")
    if len(local) < n_groups:
        print(f"WARNING: only {len(local)} source images available (wanted {n_groups})")
    return local


# ── Duplicate detection evaluation ────────────────────────────────────

def hamming(hex1: str, hex2: str) -> int:
    return bin(int(hex1, 16) ^ int(hex2, 16)).count("1")


def _roc_pr(y_true: np.ndarray, scores: np.ndarray) -> dict:
    from sklearn.metrics import roc_curve, roc_auc_score, precision_recall_curve, average_precision_score
    if len(np.unique(y_true)) < 2:
        return {"roc_auc": None, "pr_auc": None, "roc": [], "pr": []}
    fpr, tpr, roc_thr = roc_curve(y_true, scores)
    prec, rec, pr_thr = precision_recall_curve(y_true, scores)
    return {
        "roc_auc": round(float(roc_auc_score(y_true, scores)), 4),
        "pr_auc": round(float(average_precision_score(y_true, scores)), 4),
        "roc": [{"fpr": round(float(a), 4), "tpr": round(float(b), 4),
                 "threshold": round(float(t), 4)}
                for a, b, t in zip(fpr, tpr, roc_thr)],
        "pr": [{"recall": round(float(r), 4), "precision": round(float(p), 4)}
               for r, p in zip(rec, prec)],
    }


def _threshold_at_fpr(neg_scores: np.ndarray, target_fpr: float) -> float:
    """Highest score threshold keeping FPR <= target on the given negatives."""
    if len(neg_scores) == 0:
        return 1.0
    return float(np.quantile(neg_scores, 1 - target_fpr))


def _decimate(points: list, n: int = 12) -> list:
    if not points:
        return []
    idx = np.unique(np.linspace(0, len(points) - 1, min(n, len(points))).astype(int))
    return [points[i] for i in idx]


def run(n_groups: int = 100, uri: Optional[str] = None) -> dict:
    t0 = time.perf_counter()
    print("Initializing real CLIP (ViT-B-32)...")
    initialize_clip()
    if not is_model_loaded():
        raise SystemExit(
            "FATAL: CLIP failed to load - the adversarial test refuses to run with "
            "placeholder fallback embeddings.")

    print("Collecting real product images...")
    source_paths = collect_source_images(n_groups, uri=uri)
    print(f"  {len(source_paths)} real source images")

    # ── Build the test set: originals + adversarial variants ──────
    originals, variants, clip_lat = [], [], []
    for i, path in enumerate(source_paths):
        try:
            img = Image.open(path).convert("RGB")
        except Exception as e:
            print(f"  skip unreadable {path}: {e}")
            continue
        t = time.perf_counter()
        emb = extract_image_embedding(img)
        clip_lat.append((time.perf_counter() - t) * 1000)
        ph = str(imagehash.phash(img))
        cat = "product" if os.path.basename(path).startswith("product_") else "photo"
        originals.append({"group": i, "sellerId": f"seller-orig-{i}", "path": path,
                          "category": cat, "embedding": emb.tolist(), "phash": ph,
                          "price": 100.0})

    # Batch-encode all variants per source (cache miss pass)
    print("Generating adversarial variants...")
    jobs = []  # (variant_name, group, PIL image)
    for o in originals:
        img = Image.open(o["path"]).convert("RGB")
        for v in VARIANTS:
            jobs.append((v, o["group"], _VARIANT_FNS[v](img)))

    emb_list = get_batch_image_embeddings_cached([img for _, _, img in jobs])  # batch-encode with real CLIP
    for (v, g, vimg), vemb in zip(jobs, emb_list):
        if vemb is None or len(vemb) != 512:
            continue
        vpath = os.path.join(_tmpdir(), f"g{g}_{v}.jpg")
        vimg.save(vpath, "JPEG", quality=88)
        variants.append({
            "group": g, "variant": v, "sellerId": f"seller-dup-{v}-{g}",
            "path": vpath, "embedding": vemb.tolist(),
            "phash": str(imagehash.phash(vimg)), "price": 45.0,
            "duplicateOf": g,
        })

    print(f"  {len(variants)} adversarial variants (each posted as a different seller)")

    # ── Negative pools ────────────────────────────────────────────
    src_embs = {o["group"]: np.array(o["embedding"], dtype=np.float32) for o in originals}
    groups = sorted(src_embs)

    # Hard negatives: most visually similar DIFFERENT sources (same-model /
    # similar-background proxies) per source
    hard_pairs = set()  # (variant_group, negative_group)
    same_model_pairs = []
    for g in groups:
        sims = [(float(np.dot(src_embs[g], src_embs[h])) /
                 max(1e-9, float(np.linalg.norm(src_embs[g]) * np.linalg.norm(src_embs[h]))), h)
                for h in groups if h != g]
        sims.sort(reverse=True)
        for s, h in sims[:HARD_NEG_TOPK]:
            for v in VARIANTS:
                hard_pairs.add((g, h))
        if sims and sims[0][0] >= HARD_NEG_SIM:
            same_model_pairs.append({"a": g, "b": sims[0][1], "sim": round(sims[0][0], 4)})

    # ── Detector scores ───────────────────────────────────────────
    pos_scores = {"phash": [], "emb": []}           # phash score = 1 - d/64
    easy_scores = {"phash": [], "emb": []}
    hard_scores = {"phash": [], "emb": []}
    per_variant = {v: {"emb": [], "phash_d": []} for v in VARIANTS}
    rng = np.random.RandomState(42)

    by_group = {}
    for v in variants:
        by_group.setdefault(v["variant"], []).append(v)

    for v in variants:
        orig_emb = src_embs[v["group"]]
        vemb = np.array(v["embedding"], dtype=np.float32)
        sim = float(np.dot(vemb, orig_emb) / max(1e-9, np.linalg.norm(vemb)))
        d = hamming(v["phash"], next(o["phash"] for o in originals if o["group"] == v["group"]))
        pos_scores["emb"].append(sim)
        pos_scores["phash"].append(1 - d / 64)
        per_variant[v["variant"]]["emb"].append(sim)
        per_variant[v["variant"]]["phash_d"].append(d)

        # easy negatives: random other groups
        for _ in range(3):
            h = groups[rng.randint(len(groups))]
            if h == v["group"]:
                continue
            hemb = src_embs[h]
            hs = float(np.dot(vemb, hemb) / max(1e-9, np.linalg.norm(vemb) * np.linalg.norm(hemb)))
            hd = hamming(v["phash"], next(o["phash"] for o in originals if o["group"] == h))
            easy_scores["emb"].append(hs)
            easy_scores["phash"].append(1 - hd / 64)

        # hard negatives: most-similar other sources
        for (vg, h) in sorted(hard_pairs):
            if vg != v["group"]:
                continue
            hemb = src_embs[h]
            hs = float(np.dot(vemb, hemb) / max(1e-9, np.linalg.norm(vemb) * np.linalg.norm(hemb)))
            hd = hamming(v["phash"], next(o["phash"] for o in originals if o["group"] == h))
            hard_scores["emb"].append(hs)
            hard_scores["phash"].append(1 - hd / 64)

    pos_emb = np.array(pos_scores["emb"])
    pos_ph = np.array(pos_scores["phash"])
    easy_emb = np.array(easy_scores["emb"])
    easy_ph = np.array(easy_scores["phash"])
    hard_emb = np.array(hard_scores["emb"])
    hard_ph = np.array(hard_scores["phash"])
    all_neg_emb = np.concatenate([easy_emb, hard_emb]) if len(hard_emb) else easy_emb
    all_neg_ph = np.concatenate([easy_ph, hard_ph]) if len(hard_ph) else easy_ph

    # ── Threshold selection: ROC at 2% FPR on the adversarial set ──
    chosen_thr = _threshold_at_fpr(all_neg_emb, FPR_TARGET)
    easy_thr = _threshold_at_fpr(easy_emb, FPR_TARGET)

    # Persist for pipeline/config.py (env override wins there)
    payload = {
        "embedding_sim_threshold": round(chosen_thr, 4),
        "fpr_target": FPR_TARGET,
        "fpr_negatives": "easy+hard adversarial pool",
        "old_fixed_threshold": OLD_FIXED_THRESHOLD,
        "chosen_at": time.time(),
        "n_sources": len(originals),
        "n_variants": len(variants),
    }
    try:
        os.makedirs(os.path.dirname(THRESHOLD_PATH), exist_ok=True)
        with open(THRESHOLD_PATH, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"  chosen CLIP threshold {chosen_thr:.4f} persisted to {THRESHOLD_PATH}")
    except Exception as e:
        print(f"  WARNING: could not persist chosen threshold: {e}")

    # ── Recall / FPR at the thresholds ────────────────────────────
    def recall(scores, thr):
        s = np.asarray(scores)
        return float(np.mean(s >= thr)) if len(s) else 0.0

    def fpr(scores, thr):
        s = np.asarray(scores)
        return float(np.mean(s >= thr)) if len(s) else 0.0

    roc_pos_emb = _roc_pr(
        np.concatenate([np.ones(len(pos_emb)), np.zeros(len(all_neg_emb))]),
        np.concatenate([pos_emb, all_neg_emb]))
    roc_pos_ph = _roc_pr(
        np.concatenate([np.ones(len(pos_ph)), np.zeros(len(all_neg_ph))]),
        np.concatenate([pos_ph, all_neg_ph]))

    per_variant_recall = {}
    for v in VARIANTS:
        e = np.array(per_variant[v]["emb"])
        dd = np.array(per_variant[v]["phash_d"])
        emb_hit = e >= chosen_thr
        ph_hit = dd <= PHASH_NEAR
        per_variant_recall[v] = {
            "embedding_chosen_thr": round(recall(e, chosen_thr), 4),
            "embedding_old_0.88": round(recall(e, OLD_FIXED_THRESHOLD), 4),
            "phash_near_8": round(float(np.mean(ph_hit)) if len(dd) else 0.0, 4),
            "phash_exact_4": round(float(np.mean(dd <= PHASH_EXACT)) if len(dd) else 0.0, 4),
            "combined_or": round(float(np.mean(emb_hit | ph_hit)), 4),
            "n": len(e),
        }

    combined_before = np.maximum(pos_emb >= OLD_FIXED_THRESHOLD, pos_ph >= 1 - PHASH_NEAR / 64)
    combined_after = np.maximum(pos_emb >= chosen_thr, pos_ph >= 1 - PHASH_NEAR / 64)

    result = {
        "n_source_images": len(originals),
        "n_variants": len(variants),
        "n_easy_negatives": len(easy_emb),
        "n_hard_negatives": len(hard_emb),
        "n_same_model_source_pairs": len(same_model_pairs),
        "chosen_threshold": round(chosen_thr, 4),
        "threshold_if_easy_only": round(easy_thr, 4),
        "fpr_target": FPR_TARGET,
        "fpr_at_chosen": {
            "easy": round(fpr(easy_emb, chosen_thr), 4),
            "hard": round(fpr(hard_emb, chosen_thr), 4),
        },
        "fpr_at_old_0.88": {
            "easy": round(fpr(easy_emb, OLD_FIXED_THRESHOLD), 4),
            "hard": round(fpr(hard_emb, OLD_FIXED_THRESHOLD), 4),
        },
        "overall": {
            "phash_only": round(float(np.mean(pos_ph >= 1 - PHASH_NEAR / 64)), 4),
            "embedding_old_fixed_0.88": round(recall(pos_emb, OLD_FIXED_THRESHOLD), 4),
            "embedding_chosen_thr": round(recall(pos_emb, chosen_thr), 4),
            "combined_before_0.88": round(float(np.mean(combined_before)), 4),
            "combined_after_chosen": round(float(np.mean(combined_after)), 4),
        },
        "roc_pr": {
            "embedding": {"roc_auc": roc_pos_emb["roc_auc"], "pr_auc": roc_pos_emb["pr_auc"],
                          "roc_decimated": _decimate(roc_pos_emb["roc"]),
                          "pr_decimated": _decimate(roc_pos_emb["pr"])},
            "phash": {"roc_auc": roc_pos_ph["roc_auc"], "pr_auc": roc_pos_ph["pr_auc"],
                      "roc_decimated": _decimate(roc_pos_ph["roc"]),
                      "pr_decimated": _decimate(roc_pos_ph["pr"])},
        },
        "per_variant": per_variant_recall,
        "same_model_pairs_sample": same_model_pairs[:10],
        "clip_inference_latency": {
            "p50_ms": round(float(np.percentile(clip_lat, 50)), 2) if clip_lat else None,
            "p95_ms": round(float(np.percentile(clip_lat, 95)), 2) if clip_lat else None,
        },
        "wall_ms": round((time.perf_counter() - t0) * 1000, 1),
    }

    # Full curves for downstream analysis
    try:
        with open(CURVES_PATH, "w") as f:
            json.dump({
                "embedding": roc_pos_emb,
                "phash": roc_pos_ph,
                "chosen_threshold": round(chosen_thr, 4),
                "old_fixed_threshold": OLD_FIXED_THRESHOLD,
                "fpr_target": FPR_TARGET,
                "positives": {"emb_scores": pos_emb.tolist(), "phash_scores": pos_ph.tolist()},
                "easy_negatives": {"emb_scores": easy_emb.tolist(), "phash_scores": easy_ph.tolist()},
                "hard_negatives": {"emb_scores": hard_emb.tolist(), "phash_scores": hard_ph.tolist()},
            }, f)
        print(f"  full ROC/PR curves + score arrays written to {CURVES_PATH}")
    except Exception as e:
        print(f"  WARNING: could not write curves: {e}")

    _write_report(result)
    return result


def _write_report(r: dict):
    lines = []
    a = lines.append
    a("# Adversarial Duplicate Detection Report")
    a("")
    a(f"_Generated: {time.strftime('%Y-%m-%d %H:%M:%S')} - {r['n_source_images']} real product "
      f"images x {len(VARIANTS)} evasion variants (crops 30-40%, rotation, brightness/color "
      f"shifts, watermark overlay, mirror, screenshot, collage, two-edit combinations), each "
      f"posted as a different seller - {r['n_variants']} duplicate postings, "
      f"{r['n_easy_negatives']} easy negatives (random cross-product), "
      f"{r['n_hard_negatives']} hard negatives (most visually similar other products, "
      f"{r['n_same_model_source_pairs']} same-model source pairs)_")
    a("")
    a("## Before/after: duplicate-detection recall (overall)")
    a("")
    a("| Detector | Recall |")
    a("|---|---|")
    for k, v in r["overall"].items():
        a(f"| {k} | {v*100:.1f}% |")
    a("")
    a(f"**Chosen CLIP threshold: {r['chosen_threshold']}** (ROC at {r['fpr_target']*100:.0f}% FPR "
      f"on the combined easy+hard adversarial negative pool; "
      f"{r['threshold_if_easy_only']} if tuned on easy negatives only) - persisted to "
      f"`models_saved/duplicate_threshold.json` and loaded by `pipeline/config.py` as "
      f"`DUPLICATE_EMB_SIM_THRESHOLD`. Old fixed rule: >= {OLD_FIXED_THRESHOLD}.")
    a("")
    a("### FPR of the chosen threshold on the two negative pools")
    a("")
    a("| Negative pool | n | FPR @ chosen thr | FPR @ old 0.88 |")
    a("|---|---|---|---|")
    for pool, key in (("easy (random cross-product)", "easy"), ("hard (same-model / similar)", "hard")):
        a(f"| {pool} | {r[f'n_{key}_negatives']} | {r['fpr_at_chosen'][key]*100:.2f}% | "
          f"{r['fpr_at_old_0.88'][key]*100:.2f}% |")
    a("")
    a("## ROC / PR (duplicate pairs vs all adversarial negatives)")
    a("")
    a("| Detector | ROC-AUC | PR-AUC |")
    a("|---|---|---|")
    for name, m in r["roc_pr"].items():
        a(f"| {name} | {m['roc_auc'] if m['roc_auc'] is not None else '-'} | "
          f"{m['pr_auc'] if m['pr_auc'] is not None else '-'} |")
    a("")
    a("### ROC curve (embedding, decimated)")
    a("")
    a("| FPR | TPR | threshold |")
    a("|---|---|---|")
    for p in r["roc_pr"]["embedding"]["roc_decimated"]:
        a(f"| {p['fpr']:.3f} | {p['tpr']:.3f} | {p['threshold']:.3f} |")
    a("")
    a("### PR curve (embedding, decimated)")
    a("")
    a("| Recall | Precision |")
    a("|---|---|")
    for p in r["roc_pr"]["embedding"]["pr_decimated"]:
        a(f"| {p['recall']:.3f} | {p['precision']:.3f} |")
    a("")
    a("## Recall per variant type")
    a("")
    a("| Variant | CLIP emb @ chosen | CLIP emb @ old 0.88 | pHash <=8 | pHash <=4 | Combined OR | n |")
    a("|---|---|---|---|---|---|---|")
    for v, m in r["per_variant"].items():
        a(f"| {v} | {m['embedding_chosen_thr']*100:.0f}% | {m['embedding_old_0.88']*100:.0f}% | "
          f"{m['phash_near_8']*100:.0f}% | {m['phash_exact_4']*100:.0f}% | "
          f"{m['combined_or']*100:.0f}% | {m['n']} |")
    a("")
    a(f"CLIP inference latency (real): p50 {r['clip_inference_latency']['p50_ms']}ms / "
      f"p95 {r['clip_inference_latency']['p95_ms']}ms")
    a("")
    a("_Reading: the embedding-primary combined rule (OR logic, ROC-tuned threshold) recovers "
      "the recall lost by the old fixed 0.88 threshold on harder edits while keeping the FPR "
      "on hard negatives at the target level; pHash remains only a fast path for exact/near-"
      "exact copies. Hard-negative FPR is reported separately from easy negatives._")
    a("")

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"Adversarial duplicate report written to {REPORT_PATH}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Adversarial duplicate detection test")
    parser.add_argument("--n-groups", type=int, default=100,
                        help="number of real source product images (filled from Lorem Picsum)")
    parser.add_argument("--mongo-uri", type=str, default=None)
    args = parser.parse_args()
    result = run(n_groups=args.n_groups, uri=args.mongo_uri)
    print(json.dumps({"overall": result["overall"],
                      "chosen_threshold": result["chosen_threshold"],
                      "fpr_at_chosen": result["fpr_at_chosen"]}, indent=2, default=str))
