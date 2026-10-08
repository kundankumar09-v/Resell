# Label-Leakage Audit: Synthetic Fraud Generator

_Generated: 2026-10-02 06:47:46 - dataset: 2000 records (360 positive)_

## Q1: Which features are the fraud labels derived from?

| Label source (generator code) | Model input(s) it maps to | Is a model input? |
|---|---|---|
| Cross-seller duplicate copy (emb noise 0.005 + pHash <=3 bit flips) | max_cross_seller_emb_sim, min_cross_phash_dist, cross_phash_exact | YES |
| Low-price scam (price = cat_median * U(0.10, 0.28)) | price_zscore_category | YES |
| New account (account_age U(1, 40) h) | log_account_age_hours | YES |
| High listing velocity (U(6, 25) / hour) | listings_per_hour | YES |
| Title-image mismatch (imageTitleSimilarity U(0.03, 0.18)) | clip_image_text_sim (passed as image_title_similarity) | YES |
| Stock dims 1920x1080/1200x800 + photoshop software | is_stock_dimensions, has_suspicious_software | YES |
| Same-seller relist excluded from label 1 (sellerId equality) | same_seller_relist, sellerId | YES |
| Non-model fields (title text, listing id, shuffled timestamp order) | none - label-independent by construction (case_seq shuffled) | no |

## Q2: Is any label signal OUTSIDE the model inputs?

- Verified: **FALSE** - no label-derived aggregate exists outside the model input set.
- Timestamp (used only for splits) label-AUC: 0.5057791327913279 (~0.5 = label-blind, as expected after the case_seq shuffle).

## Q3: Empirical per-feature class separation (label 1 vs label 0)

| Model input feature | mean (label=1) | mean (label=0) | univariate AUC | separates? |
|---|---|---|---|---|
| max_cross_seller_emb_sim | 0.088 | 0.072 | 0.518 | no |
| min_cross_phash_dist | 25.047 | 25.463 | 0.505 | no |
| cross_phash_exact | 0.000 | 0.000 | 0.506 | no |
| max_same_seller_emb_sim | 0.000 | 0.000 | 0.506 | no |
| same_seller_relist | 0.000 | 0.000 | 0.506 | no |
| clip_image_text_sim | 0.103 | 0.622 | 1.000 | YES |
| price_zscore_category | -2.308 | 0.124 | 1.000 | YES |
| log_account_age_hours | 2.814 | 8.028 | 1.000 | YES |
| listings_per_hour | 2.726 | 1.199 | 1.000 | YES |
| aspect_ratio | 1.669 | 1.333 | 0.615 | no |
| is_stock_dimensions | 0.456 | 0.000 | 0.723 | no |
| has_suspicious_software | 0.342 | 0.000 | 0.680 | no |
| vision_llm_flag_count | 0.000 | 0.000 | 0.506 | no |
| vision_llm_confidence | 0.000 | 0.000 | 0.506 | no |

**4 of 14 model inputs alone separate the label (univariate AUC >= 0.80).**

## Verdict

1. **No classic leakage**: no feature outside the model input set carries label information (title text, listing ids, and split timestamps are label-blind).
2. **But the eval is circular**: the label is a *deterministic function of the model inputs themselves* (the generator writes the scam signals and the label from the same case branch). Any model - even the generator's own inverse rule - can achieve near-perfect separation: 4 of 14 model inputs alone reach univariate AUC 1.000.
3. **Additional generator defect found**: the cross-seller duplicate visual signal is diluted by candidate sampling - the copied anchor appears among the record's 12 sampled candidates only ~3% of the time (12 of 400 anchors), so `max_cross_seller_emb_sim` / `cross_phash_exact` have univariate AUC ~0.5 despite defining half the fraud cases. The duplicate-detection features are effectively untested by the synthetic harness.
4. **Consequence**: synthetic recall / PR-AUC numbers are an UPPER BOUND that only proves the model recovers the generator's rules. They are NOT evidence of real-world fraud detection performance.
5. **Action**: production evaluation must use real labeled listings (admin approve/reject decisions and actual sold prices) via `eval/data_loader.py`, plus the adversarial duplicate test set (`eval/adversarial_duplicates.py`) which measures duplicate detection on real images where the candidate pool is the full index.
