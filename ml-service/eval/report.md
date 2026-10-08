# ReSell ML Pipeline Evaluation Report

_Generated: 2026-10-02 07:31:17 - Feature flag: `ML_PIPELINE_V2` (baseline = legacy rule/heuristic pipeline, v2 = LightGBM + calibration + conformal)_

## Real evaluation data

- Sources: {"mongodb": 12}
- Labeled fraud records: 12 (0 fraud / 12 legit)
- Price records (sold listings): 2
- Embeddings computed via real CLIP: 11

> **CAVEAT: fewer than 10 positive fraud labels** - fraud precision/recall/PR-AUC are not statistically meaningful. Export admin reject decisions or add labeled rows to `eval/data/listings.csv`.

> **CAVEAT: fewer than 20 sold listings** - price metrics are not statistically meaningful (some splits are skipped entirely). Export sold prices or add rows to `eval/data/listings.csv`.

## Split: time-based

### Fraud metrics

| Metric | Baseline (legacy) | v2 (upgrade) | Delta |
|---|---|---|---|
| Precision | 0.00% | 0.00% | +0.00pp |
| Recall | 0.00% | 0.00% | +0.00pp |
| F1 | 0.00% | 0.00% | +0.00pp |
| PR-AUC | 0.00% | 0.00% | +0.00pp |
| Recall @ 2% FPR | 0.00% | 0.00% | +0.00pp |
| Flagged rate | 0.00% | 0.00% | +0.00pp |

Operating thresholds: baseline flagged >= 0.7 (fixed 0.70 on 0-100 scale) - v2 flag >= 0.5 (PR-curve max-F1, calibrated probability)

### Calibration curve (fraud probability reliability, 10 bins)

| Predicted prob bin | Baseline: predicted / observed | v2: predicted / observed |
|---|---|---|
| [0.0, 0.1) | 0.00 / 0.00 (n=3) | 0.00 / 0.00 (n=3) |
_Well-calibrated = predicted probability tracks observed fraud rate (diagonal). Sparse bins with tiny n are noise._

### Price metrics

| Metric | Baseline (legacy) | v2 (upgrade) | Delta |
|---|---|---|---|
| MAE (log-price) | - | - | - |
| MAPE | - | - | - |
| RMSE (log) | - | - | - |
| p25-p75 coverage | - | - | - |
| p10-p90 coverage | - | - | - |
| No-suggestion rate (low confidence) | 0% | 0.0% | (v2 behavior: wide range or null) |

### Latency (per call, ms)

| Stage | Baseline p50 | Baseline p95 | v2 p50 | v2 p95 |
|---|---|---|---|---|
| Fraud (total) | 550.36 | 595.7 | 558.3 | 763.3 |
| Price (total) | None | None | None | None |
| CLIP inference (real, cold) | - | - | 430.33 | 491.2 |

## Split: seller-grouped

### Fraud metrics

| Metric | Baseline (legacy) | v2 (upgrade) | Delta |
|---|---|---|---|
| Precision | 0.00% | 0.00% | +0.00pp |
| Recall | 0.00% | 0.00% | +0.00pp |
| F1 | 0.00% | 0.00% | +0.00pp |
| PR-AUC | 0.00% | 0.00% | +0.00pp |
| Recall @ 2% FPR | 0.00% | 0.00% | +0.00pp |
| Flagged rate | 0.00% | 0.00% | +0.00pp |

Operating thresholds: baseline flagged >= 0.7 (fixed 0.70 on 0-100 scale) - v2 flag >= 0.5 (PR-curve max-F1, calibrated probability)

### Calibration curve (fraud probability reliability, 10 bins)

| Predicted prob bin | Baseline: predicted / observed | v2: predicted / observed |
|---|---|---|
| [0.0, 0.1) | 0.00 / 0.00 (n=7) | 0.00 / 0.00 (n=8) |
_Well-calibrated = predicted probability tracks observed fraud rate (diagonal). Sparse bins with tiny n are noise._

### Price metrics

| Metric | Baseline (legacy) | v2 (upgrade) | Delta |
|---|---|---|---|
| MAE (log-price) | 0.9607 | - | - |
| MAPE | 0.6174 | - | - |
| RMSE (log) | 0.9607 | - | - |
| p25-p75 coverage | 0.0 | - | - |
| p10-p90 coverage | - | - | - |
| No-suggestion rate (low confidence) | 0% | 0.0% | (v2 behavior: wide range or null) |

### Latency (per call, ms)

| Stage | Baseline p50 | Baseline p95 | v2 p50 | v2 p95 |
|---|---|---|---|---|
| Fraud (total) | 536.86 | 606.31 | 4.23 | 52.84 |
| Price (total) | 2.13 | 2.13 | None | None |
| CLIP inference (real, cold) | - | - | 430.33 | 491.2 |

## Efficiency benchmark (embedding cache / batch path)

| Path | p50 ms | p95 ms | mean ms |
|---|---|---|---|
| legacy_sequential | 259.2 | 355.8 | 276.63 |
| v2_cache_miss | 254.11 | 328.2 | 259.61 |
| v2_cache_hit | 0.01 | 0.03 | 0.01 |
