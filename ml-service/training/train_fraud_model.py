"""
Training Script: LightGBM Binary Fraud Classifier for ReSell
Trains binary classification model using extracted fraud features.
"""

import os
import json
import argparse
import numpy as np

def train_fraud_model(data_path: str, output_path: str = "models_saved/fraud_model.txt"):
    try:
        import lightgbm as lgb
    except ImportError:
        print("LightGBM not installed. Install with: pip install lightgbm")
        return

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    print(f"Loading fraud dataset from {data_path}...")

    if os.path.exists(data_path):
        with open(data_path, "r") as f:
            dataset = json.load(f)
    else:
        print("Dataset not found. Generating synthetic fraud dataset for demonstration...")
        np.random.seed(42)
        n_samples = 300
        dataset = []
        for i in range(n_samples):
            is_fraud = 1 if np.random.rand() < 0.15 else 0
            dataset.append({
                "features": {
                    "min_phash_dist": float(np.random.choice([2, 4, 8, 20, 32])),
                    "phash_exact_match": 1.0 if is_fraud and np.random.rand() > 0.5 else 0.0,
                    "max_emb_sim": float(np.random.uniform(0.85, 0.99) if is_fraud else np.random.uniform(0.1, 0.65)),
                    "title_similarity": float(np.random.uniform(0.05, 0.2) if is_fraud else np.random.uniform(0.4, 0.9)),
                    "aspect_ratio": 1.33,
                    "is_stock_dimensions": 1.0 if is_fraud and np.random.rand() > 0.6 else 0.0,
                    "has_suspicious_software": 1.0 if is_fraud and np.random.rand() > 0.7 else 0.0,
                    "price_ratio": float(np.random.uniform(0.1, 0.25) if is_fraud else np.random.uniform(0.6, 1.2)),
                    "price_too_low": 1.0 if is_fraud else 0.0,
                    "price_too_high": 0.0,
                    "account_age_hours": float(np.random.uniform(1, 24) if is_fraud else np.random.uniform(100, 5000)),
                    "is_brand_new_account": 1.0 if is_fraud else 0.0,
                    "listings_past_hour": float(np.random.uniform(8, 20) if is_fraud else np.random.uniform(1, 3)),
                    "is_high_velocity": 1.0 if is_fraud else 0.0,
                },
                "label": is_fraud
            })

    X = np.array([list(d["features"].values()) for d in dataset], dtype=np.float32)
    y = np.array([d["label"] for d in dataset], dtype=np.float32)

    train_data = lgb.Dataset(X, label=y)
    params = {
        "objective": "binary",
        "metric": "binary_logloss",
        "learning_rate": 0.05,
        "num_leaves": 15,
        "verbose": -1,
    }

    print("Training LightGBM fraud detection model...")
    model = lgb.train(params, train_data, num_boost_round=100)
    model.save_model(output_path)
    print(f"Saved fraud model to {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train LightGBM Fraud Model")
    parser.add_argument("--data", type=str, default="training/fraud_samples.json", help="Path to fraud samples json")
    parser.add_argument("--output", type=str, default="models_saved/fraud_model.txt", help="Path to save model")
    args = parser.parse_args()
    train_fraud_model(args.data, args.output)
