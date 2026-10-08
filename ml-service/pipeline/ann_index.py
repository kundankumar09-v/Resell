"""
Persistent HNSW ANN index (FAISS IndexHNSWFlat) with category pre-filter.
- One HNSW graph per category so queries pre-filter by category before ANN search.
- Persisted to disk and reloaded on startup instead of being rebuilt per request
  (the legacy pipeline rebuilt a flat FAISS index on every single request).
"""

import logging
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("ml-service.pipeline.ann")

try:
    import faiss
    _FAISS_AVAILABLE = True
except ImportError:
    _FAISS_AVAILABLE = False
    logger.info("FAISS not installed; ANN index disabled, using numpy fallback.")

from . import config


class CategoryANNIndex:
    """Per-category HNSW indexes over normalized 512-D embeddings."""

    def __init__(self, dimension: int = 512):
        self.dimension = dimension
        self._lock = threading.Lock()
        # category -> {"faiss": index, "items": [item dicts], "vectors": np.ndarray}
        self._stores: Dict[str, Dict[str, Any]] = {}
        self._global_store: Dict[str, Any] = {"faiss": None, "items": [], "vectors": None}

    # ── build / update ────────────────────────────────────────────

    def _new_hnsw(self) -> Any:
        idx = faiss.IndexHNSWFlat(self.dimension, 32)
        idx.hnsw.efSearch = config.ANN_EF_SEARCH
        return idx

    def upsert(self, category: str, items: List[Dict[str, Any]]):
        """(Re)build the index for one category from its items."""
        if not _FAISS_AVAILABLE:
            return
        cat = str(category or "_global")
        valid_items, vectors = [], []
        for item in items:
            emb = item.get("embedding")
            if emb and len(emb) == self.dimension:
                v = np.array(emb, dtype=np.float32)
                n = np.linalg.norm(v)
                if n > 0:
                    v = v / n
                    vectors.append(v)
                    valid_items.append(item)
        if not vectors:
            return
        mat = np.vstack(vectors)
        with self._lock:
            idx = self._new_hnsw()
            idx.add(mat)
            self._stores[cat] = {"faiss": idx, "items": valid_items, "vectors": mat}

    def build_global(self, items: List[Dict[str, Any]]):
        """Build per-category stores + a global store in one pass."""
        if not _FAISS_AVAILABLE:
            return
        by_cat: Dict[str, List[Dict[str, Any]]] = {}
        for item in items:
            by_cat.setdefault(str(item.get("category") or "_global"), []).append(item)
        for cat, cat_items in by_cat.items():
            self.upsert(cat, cat_items)
        valid_items, vectors = [], []
        for item in items:
            emb = item.get("embedding")
            if emb and len(emb) == self.dimension:
                v = np.array(emb, dtype=np.float32)
                n = np.linalg.norm(v)
                if n > 0:
                    vectors.append(v / n)
                    valid_items.append(item)
        if vectors:
            with self._lock:
                idx = self._new_hnsw()
                idx.add(np.vstack(vectors))
                self._global_store = {"faiss": idx, "items": valid_items,
                                      "vectors": np.vstack(vectors)}

    # ── search ────────────────────────────────────────────────────

    def search(
        self,
        query: np.ndarray,
        k: int = 5,
        category: Optional[str] = None,
        exclude_seller: Optional[str] = None,
        exclude_ids: Optional[set] = None,
    ) -> List[Tuple[Dict[str, Any], float]]:
        """ANN search with category pre-filter; overfetches to survive filtering."""
        q = np.array(query, dtype=np.float32).reshape(1, -1)
        n = np.linalg.norm(q)
        if n > 0:
            q = q / n

        with self._lock:
            store = self._stores.get(str(category or "")) if category else None
            if store is None:
                store = self._global_store
            if store is None or store["faiss"] is None or not store["items"]:
                return []
            faiss_idx, items = store["faiss"], store["items"]
            overfetch = min(len(items), max(k * 8, k + 20))
            try:
                distances, indices = faiss_idx.search(q, overfetch)
            except Exception as e:
                logger.warning(f"HNSW search failed ({e}); numpy fallback")
                sims = np.dot(store["vectors"], q.T).flatten()
                order = np.argsort(-sims)[:overfetch]
                distances, indices = sims[order].reshape(1, -1), order.reshape(1, -1)

        results = []
        for d, idx in zip(distances[0], indices[0]):
            if idx < 0 or idx >= len(items):
                continue
            item = items[idx]
            if exclude_seller:
                cand_seller = str(item.get("sellerId") or item.get("seller", ""))
                if cand_seller and cand_seller == str(exclude_seller):
                    continue
            if exclude_ids and str(item.get("id") or item.get("_id")) in exclude_ids:
                continue
            results.append((item, float(d)))
            if len(results) >= k:
                break
        return results

    # ── persistence ───────────────────────────────────────────────

    def save(self, path: Optional[str] = None):
        """Serialize category stores (vectors + items) so startup can reload instead of rebuild."""
        import pickle
        path = path or os.path.join(config.MODEL_DIR, "ann_index.pkl")
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with self._lock:
                payload = {
                    "dimension": self.dimension,
                    "stores": {c: {"items": s["items"], "vectors": s["vectors"]}
                               for c, s in self._stores.items()},
                    "global": {"items": self._global_store["items"],
                               "vectors": self._global_store["vectors"]},
                }
            with open(path, "wb") as f:
                pickle.dump(payload, f)
            logger.info(f"Saved ANN index ({len(self._stores)} categories) to {path}")
            return True
        except Exception as e:
            logger.warning(f"Could not save ANN index: {e}")
            return False

    def load(self, path: Optional[str] = None) -> bool:
        import pickle
        path = path or os.path.join(config.MODEL_DIR, "ann_index.pkl")
        if not (_FAISS_AVAILABLE and os.path.exists(path)):
            return False
        try:
            with open(path, "rb") as f:
                payload = pickle.load(f)
            self.dimension = payload.get("dimension", self.dimension)
            with self._lock:
                for cat, s in payload.get("stores", {}).items():
                    idx = self._new_hnsw()
                    idx.add(s["vectors"])
                    self._stores[cat] = {"faiss": idx, "items": s["items"], "vectors": s["vectors"]}
                g = payload.get("global") or {}
                if g.get("vectors") is not None and len(g.get("items", [])) > 0:
                    idx = self._new_hnsw()
                    idx.add(g["vectors"])
                    self._global_store = {"faiss": idx, "items": g["items"], "vectors": g["vectors"]}
            logger.info(f"Loaded ANN index from {path} ({len(self._stores)} categories)")
            return True
        except Exception as e:
            logger.warning(f"Could not load ANN index: {e}")
            return False

    def stats(self) -> dict:
        with self._lock:
            return {
                "faiss_available": _FAISS_AVAILABLE,
                "categories": len(self._stores),
                "global_items": len(self._global_store["items"]),
                "ef_search": config.ANN_EF_SEARCH,
            }


# Global singleton used by both fraud v2 and price v2
ann_index = CategoryANNIndex(dimension=512)
