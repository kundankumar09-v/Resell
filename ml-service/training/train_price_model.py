"""
Training Script: LightGBM Quantile Price Regression for ReSell
Trains 3 quantile regressors (alpha=0.25, 0.50, 0.75) using historical sold listings
and CLIP visual embeddings + metadata features.
"""

import os
import json
import argparse
import numpy as np

def train_quantile_model(data_path: str, output_dir: str = "models_saved"):
    try:
        import lightgbm as lgb
    except ImportError:
        print("LightGBM not installed. Install with: pip install lightgbm")
        return

    os.makedirs(output_dir, exist_ok=True)
    print(f"Loading dataset from {data_path}...")

    if os.path.exists(data_path):
        with open(data_path, "r") as f:
            dataset = json.load(f)
    else:
        print("Dataset not found. Generating synthetic sold listings dataset for demonstration...")
        np.random.seed(42)
        n_samples = 200
        dataset = []
        for i in range(n_samples):
            orig = np.random.uniform(50, 2000)
            years = np.random.uniform(0, 5)
            cond_w = np.random.choice([1.0, 0.88, 0.75, 0.58, 0.40])
            true_price = orig * cond_w * np.exp(-0.12 * years) + np.random.normal(0, orig * 0.05)
            true_price = max(10, true_price)
            dataset.append({
                "originalPrice": orig,
                "yearsUsed": years,
                "condition": "good",
                "price": true_price,
                "embedding": np.random.randn(512).tolist()
            })

    X = []
    y = []

    for item in dataset:
        orig = float(item.get("originalPrice", 100))
        years = float(item.get("yearsUsed", 1))
        cond = str(item.get("condition", "good"))
        cond_w = 0.75
        
        feat = [orig, years, cond_w, 5.0, orig * 0.7, orig * 0.1]
        emb = item.get("embedding", [])
        if emb:
            feat.extend(emb[:64])
        X.append(feat)
        y.append(float(item.get("price", orig * 0.7)))

    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.float32)

    train_data = lgb.Dataset(X, label=y)
    quantiles = [0.25, 0.50, 0.75]

    for q in quantiles:
        q_tag = f"p{int(q*100)}"
        params = {
            "objective": "quantile",
            "alpha": q,
            "metric": "quantile",
            "learning_rate": 0.05,
            "num_leaves": 31,
            "verbose": -1,
        }
        print(f"Training LightGBM {q_tag} quantile regressor...")
        model = lgb.train(params, train_data, num_boost_round=100)
        out_file = os.path.join(output_dir, f"price_model_{q_tag}.txt")
        model.save_model(out_file)
        print(f"Saved {q_tag} model to {out_file}")

    print("Quantile model training complete.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train LightGBM Quantile Price Model")
    parser.add_argument("--data", type=str, default="training/sold_listings.json", help="Path to sold listings json")
    parser.add_argument("--output", type=str, default="models_saved", help="Directory to save model artifacts")
    args = parser.parse_args()
    train_quantile_model(args.data, args.output)
