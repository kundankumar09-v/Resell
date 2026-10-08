"""
Split strategies for the ReSell ML eval harness:
- time-based split (train on earlier listings, test on later ones)
- seller-grouped split (all listings of a seller stay on one side)
"""

from typing import Tuple
import numpy as np


def time_based_split(timestamps: np.ndarray, train_frac: float = 0.8) -> Tuple[np.ndarray, np.ndarray]:
    """Order by timestamp; train = earliest train_frac, test = rest (no leakage)."""
    assert len(timestamps) > 10, "not enough samples for a time-based split"
    order = np.argsort(timestamps)
    cut = int(len(order) * train_frac)
    return order[:cut], order[cut:]


def seller_grouped_split(seller_ids, train_frac: float = 0.8, seed: int = 42) -> Tuple[np.ndarray, np.ndarray]:
    """GroupKFold-style: each seller's listings are entirely in train or test."""
    seller_ids = np.array([str(s) for s in seller_ids])
    unique_sellers = np.unique(seller_ids)
    rng = np.random.RandomState(seed)
    perm = rng.permutation(len(unique_sellers))
    cut = int(len(unique_sellers) * train_frac)
    test_sellers = set(unique_sellers[perm[:cut]])
    train_idx = np.where(~np.isin(seller_ids, list(test_sellers)))[0]
    test_idx = np.where(np.isin(seller_ids, list(test_sellers)))[0]
    return train_idx, test_idx
