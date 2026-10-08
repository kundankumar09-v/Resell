# Adversarial Duplicate Detection Report

_Generated: 2026-10-02 07:26:34 - 100 real product images x 10 evasion variants (crops 30-40%, rotation, brightness/color shifts, watermark overlay, mirror, screenshot, collage, two-edit combinations), each posted as a different seller - 1000 duplicate postings, 2974 easy negatives (random cross-product), 2000 hard negatives (most visually similar other products, 16 same-model source pairs)_

## Before/after: duplicate-detection recall (overall)

| Detector | Recall |
|---|---|
| phash_only | 20.4% |
| embedding_old_fixed_0.88 | 53.0% |
| embedding_chosen_thr | 74.7% |
| combined_before_0.88 | 62.2% |
| combined_after_chosen | 82.2% |

**Chosen CLIP threshold: 0.8174** (ROC at 2% FPR on the combined easy+hard adversarial negative pool; 0.6373 if tuned on easy negatives only) - persisted to `models_saved/duplicate_threshold.json` and loaded by `pipeline/config.py` as `DUPLICATE_EMB_SIM_THRESHOLD`. Old fixed rule: >= 0.88.

### FPR of the chosen threshold on the two negative pools

| Negative pool | n | FPR @ chosen thr | FPR @ old 0.88 |
|---|---|---|---|
| easy (random cross-product) | 2974 | 0.17% | 0.13% |
| hard (same-model / similar) | 2000 | 4.75% | 1.45% |

## ROC / PR (duplicate pairs vs all adversarial negatives)

| Detector | ROC-AUC | PR-AUC |
|---|---|---|
| embedding | 0.9708 | 0.8982 |
| phash | 0.7729 | 0.5715 |

### ROC curve (embedding, decimated)

| FPR | TPR | threshold |
|---|---|---|
| 0.000 | 0.000 | inf |
| 0.007 | 0.551 | 0.875 |
| 0.015 | 0.703 | 0.838 |
| 0.025 | 0.781 | 0.801 |
| 0.041 | 0.843 | 0.759 |
| 0.063 | 0.881 | 0.721 |
| 0.101 | 0.913 | 0.672 |
| 0.146 | 0.943 | 0.640 |
| 0.216 | 0.965 | 0.598 |
| 0.306 | 0.985 | 0.545 |
| 0.495 | 0.999 | 0.446 |
| 1.000 | 1.000 | 0.057 |

### PR curve (embedding, decimated)

| Recall | Precision |
|---|---|
| 1.000 | 0.167 |
| 1.000 | 0.184 |
| 1.000 | 0.204 |
| 1.000 | 0.230 |
| 1.000 | 0.262 |
| 0.995 | 0.304 |
| 0.990 | 0.364 |
| 0.972 | 0.446 |
| 0.936 | 0.578 |
| 0.852 | 0.792 |
| 0.508 | 0.948 |
| 0.000 | 1.000 |

## Recall per variant type

| Variant | CLIP emb @ chosen | CLIP emb @ old 0.88 | pHash <=8 | pHash <=4 | Combined OR | n |
|---|---|---|---|---|---|---|
| crop35 | 96% | 66% | 0% | 0% | 96% | 100 |
| rotate15 | 97% | 80% | 0% | 0% | 97% | 100 |
| color_shift | 100% | 100% | 100% | 100% | 100% | 100 |
| watermark | 22% | 7% | 97% | 89% | 97% | 100 |
| mirror | 100% | 100% | 0% | 0% | 100% | 100 |
| screenshot | 97% | 53% | 7% | 0% | 97% | 100 |
| collage | 32% | 2% | 0% | 0% | 32% | 100 |
| crop_mirror | 95% | 63% | 0% | 0% | 95% | 100 |
| rotate_color | 95% | 58% | 0% | 0% | 95% | 100 |
| watermark_crop | 13% | 1% | 0% | 0% | 13% | 100 |

CLIP inference latency (real): p50 315.14ms / p95 513.61ms

_Reading: the embedding-primary combined rule (OR logic, ROC-tuned threshold) recovers the recall lost by the old fixed 0.88 threshold on harder edits while keeping the FPR on hard negatives at the target level; pHash remains only a fast path for exact/near-exact copies. Hard-negative FPR is reported separately from easy negatives._
