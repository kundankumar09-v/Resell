# Stage 2 — SSCD copy-detection embedding + HNSW + threshold calibration.
import os, time
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple
import numpy as np
from PIL import Image

def _imagenet_transform(size):
    import torchvision.transforms as T
    return T.Compose([
        T.Resize(size, interpolation=T.InterpolationMode.BICUBIC),
        T.CenterCrop(size), T.ToTensor(),
        T.Normalize(mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225])])

class BaseEmbedder:
    name, dim = "base", 0
    def __init__(self, device=None):
        import torch
        self.torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._model = None
    def ensure_loaded(self):
        if self._model is None:
            self._load(); print(f"  [{self.name}] loaded on {self.device}")
    def embed_batch(self, images):
        self.ensure_loaded()
        return self._embed_batch_impl(list(images))
    def embed_one(self, image): return self.embed_batch([image])[0]
    def unload(self):
        self._model = None
        import gc, torch
        if torch.cuda.is_available(): torch.cuda.empty_cache()
        gc.collect()

class SSCDEmbedder(BaseEmbedder):
    """Meta SSCD (sscd_disc_mixup), 512-d, official TorchScript checkpoint."""
    name, dim = "sscd", 512
    URL = "https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt"
    def _load(self):
        import torch
        cache = os.path.join(torch.hub.get_dir(), "checkpoints", "sscd_disc_mixup.torchscript.pt")
        if not os.path.exists(cache):
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            print("  [sscd] downloading checkpoint (~100MB)...")
            import urllib.request
            tmp = cache + ".part"; urllib.request.urlretrieve(self.URL, tmp); os.replace(tmp, cache)
        self._model = torch.jit.load(cache).eval().to(self.device)
        self._tf = _imagenet_transform(288)
    def _embed_batch_impl(self, images):
        import torch
        batch = torch.stack([self._tf(im) for im in images]).to(self.device)
        with torch.no_grad(): out = self._model(batch)
        return torch.nn.functional.normalize(out, dim=1).cpu().numpy().astype(np.float32)

def make_embedder(name="sscd", device=None):
    if name == "sscd": return SSCDEmbedder(device)
    raise ValueError("FAST_MODE: only 'sscd' enabled (dinov2/clip available post-deadline)")

class EmbeddingCache:
    """npz disk cache — resumable across Colab session resets."""
    def __init__(self, cache_dir):
        self.cache_dir = cache_dir; os.makedirs(cache_dir, exist_ok=True)
    def _path(self, model): return os.path.join(self.cache_dir, f"emb_{model}.npz")
    def load(self, model):
        p = self._path(model)
        if not os.path.exists(p): return {}, []
        z = np.load(p, allow_pickle=False)
        return {str(k): z["vecs"][i] for i, k in enumerate(z["keys"])}, list(z["keys"])
    def save(self, model, store):
        keys = list(store.keys())
        if not keys: return
        np.savez_compressed(self._path(model), keys=np.array(keys),
                            vecs=np.stack([store[k] for k in keys]).astype(np.float32))
    def get_or_compute(self, model, embedder, items, batch_size=32):
        store, _ = self.load(model)
        missing = [(k, v) for k, v in items.items() if k not in store]
        print(f"  [{model}] {len(items)-len(missing)}/{len(items)} cached, {len(missing)} to compute")
        t0 = time.perf_counter()
        for i in range(0, len(missing), batch_size):
            chunk = missing[i:i+batch_size]
            vecs = embedder.embed_batch([im for _, im in chunk])
            for (k, _), v in zip(chunk, vecs): store[k] = v
            if (i+batch_size) % 200 < batch_size or i+batch_size >= len(missing):
                self.save(model, store)
        self.save(model, store)
        print(f"  [{model}] done in {time.perf_counter()-t0:.0f}s")
        return store

@dataclass
class NeighbourHit:
    key: str; similarity: float; from_tombstone: bool = False

class ANNIndex:
    """HNSW cosine index over L2-normed vectors; numpy fallback; tombstone flags."""
    def __init__(self, dim, max_elements=200_000, ef_construction=200, M=16):
        self.dim, self.max_elements = dim, max_elements
        self.ef_construction, self.M = ef_construction, M
        self._index, self._keys, self._key_set = None, [], set()
        self._deleted, self._tombstoned = set(), set()
        self._vectors, self._ef_search = [], 64
    def _ensure_hnsw(self):
        if self._index is None:
            import hnswlib
            self._index = hnswlib.Index(space="cosine", dim=self.dim)
            self._index.init_index(max_elements=self.max_elements,
                                   ef_construction=self.ef_construction, M=self.M)
    def add(self, key, vec, tombstone=False):
        if key in self._key_set: return
        self._ensure_hnsw()
        v = np.asarray(vec, dtype=np.float32).reshape(1, -1)
        if self._index is not None:
            self._index.add_items(v, np.array([len(self._keys)]))
        else: self._vectors.append(v[0])
        self._keys.append(key); self._key_set.add(key)
        if tombstone: self._tombstoned.add(key)
    def mark_deleted(self, key):
        """Keep vector searchable but flagged (tombstone recall)."""
        self._tombstoned.add(key); self._deleted.discard(key)
    def search(self, vec, k=10, include_tombstones=True, exclude_keys=None):
        if not self._keys: return []
        q = np.asarray(vec, dtype=np.float32).reshape(1, -1)
        exclude_keys = exclude_keys or set()
        if self._index is not None:
            self._index.set_ef(self._ef_search)
            labels, dists = self._index.knn_query(q, k=min(len(self._keys), k*3))
            cands = [(self._keys[int(l)], 1.0-float(d)) for l, d in zip(labels[0], dists[0])]
        else:
            mat = np.stack(self._vectors); sims = mat @ q[0]
            order = np.argsort(-sims)[:k*3]
            cands = [(self._keys[int(i)], float(sims[i])) for i in order]
        out = []
        for key, sim in cands:
            if key in exclude_keys or key in self._deleted: continue
            if not include_tombstones and key in self._tombstoned: continue
            out.append(NeighbourHit(key, float(sim), key in self._tombstoned))
            if len(out) >= k: break
        return out
    def __len__(self): return len(self._keys)

def threshold_at_fpr(neg_scores, target_fpr=0.02):
    """Highest threshold keeping FPR <= target on measured negatives."""
    if len(neg_scores) == 0: return 1.0
    return float(np.quantile(np.asarray(neg_scores), 1 - target_fpr))

def roc_pr(y_true, scores):
    from sklearn.metrics import average_precision_score, roc_auc_score
    if len(np.unique(y_true)) < 2: return {"roc_auc": None, "pr_auc": None}
    return {"roc_auc": round(float(roc_auc_score(y_true, scores)), 4),
            "pr_auc": round(float(average_precision_score(y_true, scores)), 4)}

def recall_at(scores, thr):
    s = np.asarray(scores); return float(np.mean(s >= thr)) if len(s) else 0.0
