"""
Vector Index Manager for ReSell ML Microservice
Uses FAISS (IndexFlatIP) for ultra-fast cosine similarity search over 512-D embeddings,
with a native NumPy cosine similarity fallback when FAISS is not present.
"""

import logging
import numpy as np
from typing import List, Dict, Any, Tuple, Optional

logger = logging.getLogger("ml-service.vector_index")

try:
    import faiss
    _FAISS_AVAILABLE = True
except ImportError:
    _FAISS_AVAILABLE = False
    logger.info("FAISS not installed; using optimized NumPy cosine vector search fallback.")


class VectorIndex:
    def __init__(self, dimension: int = 512):
        self.dimension = dimension
        self.items: List[Dict[str, Any]] = []
        self.embeddings: Optional[np.ndarray] = None
        self._faiss_index = None

        if _FAISS_AVAILABLE:
            self._faiss_index = faiss.IndexFlatIP(dimension)

    def build_index(self, items: List[Dict[str, Any]]):
        """
        Build or rebuild the index from a list of items:
        Each item must have:
          - 'id': str
          - 'embedding': List[float] (512-D normalized vector)
          - optional metadata: 'price', 'category', 'seller', etc.
        """
        self.items = []
        valid_vectors = []

        for item in items:
            emb = item.get("embedding")
            if emb and len(emb) == self.dimension:
                vec = np.array(emb, dtype=np.float32)
                norm = np.linalg.norm(vec)
                if norm > 0:
                    vec = vec / norm
                valid_vectors.append(vec)
                self.items.append(item)

        if valid_vectors:
            self.embeddings = np.vstack(valid_vectors)
            if _FAISS_AVAILABLE:
                self._faiss_index = faiss.IndexFlatIP(self.dimension)
                self._faiss_index.add(self.embeddings)
        else:
            self.embeddings = None
            if _FAISS_AVAILABLE:
                self._faiss_index = faiss.IndexFlatIP(self.dimension)

    def search_knn(
        self,
        query_vector: np.ndarray,
        k: int = 5,
        filter_fn = None
    ) -> List[Tuple[Dict[str, Any], float]]:
        """
        Search k-nearest neighbors for query_vector.
        Returns list of (item_dict, cosine_similarity_score).
        """
        if self.embeddings is None or len(self.items) == 0:
            return []

        q_vec = np.array(query_vector, dtype=np.float32).reshape(1, -1)
        norm = np.linalg.norm(q_vec)
        if norm > 0:
            q_vec = q_vec / norm

        # If a custom filter is required (e.g., category match or exclude same seller)
        if filter_fn is not None:
            results = []
            # Calculate full cosine similarities
            sims = np.dot(self.embeddings, q_vec.T).flatten()
            sorted_indices = np.argsort(-sims)
            for idx in sorted_indices:
                item = self.items[idx]
                if filter_fn(item):
                    results.append((item, float(sims[idx])))
                    if len(results) >= k:
                        break
            return results

        # Direct FAISS search if available
        if _FAISS_AVAILABLE and self._faiss_index is not None:
            actual_k = min(k, len(self.items))
            distances, indices = self._faiss_index.search(q_vec, actual_k)
            results = []
            for d, idx in zip(distances[0], indices[0]):
                if idx >= 0 and idx < len(self.items):
                    results.append((self.items[idx], float(d)))
            return results

        # NumPy fallback
        sims = np.dot(self.embeddings, q_vec.T).flatten()
        actual_k = min(k, len(self.items))
        top_k_indices = np.argsort(-sims)[:actual_k]
        return [(self.items[idx], float(sims[idx])) for idx in top_k_indices]
