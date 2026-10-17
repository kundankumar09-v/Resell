# Stage 1 — pHash D4 x6 + PDQ-256, MIH + BK-tree indexes, tombstone store.
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import numpy as np
from PIL import Image, ImageOps
import imagehash, pdqhash

TRANSFORMS = ["plain", "mirror", "r90", "r180", "r270", "vflip"]
TRANSFORM_GROUPS = {"plain": (0,0), "r90": (1,0), "r180": (2,0), "r270": (3,0), "mirror": (0,1), "vflip": (2,1)}
RELATIONSHIP_THRESHOLDS = {"identical": (6,12), "mirror": (7,13), "rotation": (8,14)}
PHASH_EXACT_MAX_DIST = 4
PDQ_MATCH_MAX_DIST = 32
MIN_PDQ_QUALITY = 20

def _mod4(n): return ((n % 4) + 4) % 4

def compose_d4(g, h):
    gk, gf = g; hk, hf = h
    return (_mod4(gk+hk), hf) if gf == 0 else (_mod4(gk-hk), (hf+1) % 2)

def invert_d4(g):
    k, f = g
    return (_mod4(-k), 0) if f == 0 else (k, 1)

def relationship_of(probe_t, stored_t):
    """identical | mirror | rotation implied by probe/stored variant pair."""
    x = compose_d4(invert_d4(TRANSFORM_GROUPS.get(probe_t,(0,0))), TRANSFORM_GROUPS.get(stored_t,(0,0)))
    return "identical" if x == (0,0) else ("rotation" if x[1] == 0 else "mirror")

def _apply_transform(img, t):
    if t == "plain": return img
    if t == "mirror": return ImageOps.mirror(img)
    if t == "r90": return img.transpose(Image.ROTATE_270)
    if t == "r180": return img.transpose(Image.ROTATE_180)
    if t == "r270": return img.transpose(Image.ROTATE_90)
    if t == "vflip": return ImageOps.flip(img)
    raise ValueError(t)

def compute_phash(img): return str(imagehash.phash(img))
def compute_phash_variants(img): return {t: compute_phash(_apply_transform(img, t)) for t in TRANSFORMS}

def compute_pdq(img):
    """256-bit PDQ hex + quality 0-100 (plain orientation)."""
    bits, quality = pdqhash.compute(np.asarray(img))
    return np.packbits(bits).tobytes().hex(), float(quality)

@dataclass
class ImageHashes:
    phash_variants: Dict[str, str]
    pdq: str
    pdq_quality: float
    @classmethod
    def compute(cls, img):
        pdq_hex, q = compute_pdq(img)
        return cls(compute_phash_variants(img), pdq_hex, q)
    @property
    def plain(self): return self.phash_variants["plain"]

def hamming_hex(a, b):
    if not a or not b: return 4096
    try: return bin(int(a,16) ^ int(b,16)).count("1")
    except ValueError: return sum(c1 != c2 for c1, c2 in zip(a, b))

class MIHIndex:
    """Multi-index hashing, 16 nibbles x 16 buckets. Complete for radius <= 15."""
    def __init__(self):
        self._buckets = [[[] for _ in range(16)] for _ in range(16)]
        self._all = {}
    @staticmethod
    def _nibbles(h): return [int(c,16) for c in h]
    def add(self, key, hex_hash):
        self._all.setdefault(key, []).append(hex_hash)
        for pos, val in enumerate(self._nibbles(hex_hash)):
            self._buckets[pos][val].append((key, hex_hash))
    def remove(self, key):
        for h in self._all.pop(key, []):
            for pos, val in enumerate(self._nibbles(h)):
                bucket = self._buckets[pos][val]
                for i in range(len(bucket)-1, -1, -1):
                    if bucket[i][0] == key: bucket.pop(i)
    def query(self, hex_hash, max_dist):
        if max_dist > 15:
            return [(k, hamming_hex(h, hex_hash)) for k, hs in self._all.items()
                    for h in hs if hamming_hex(h, hex_hash) <= max_dist]
        nib = self._nibbles(hex_hash); seen = {}
        for pos in range(16):
            for key, h in self._buckets[pos][nib[pos]]:
                d = hamming_hex(h, hex_hash)
                if d <= max_dist and d < seen.get(key, 1 << 30): seen[key] = d
        return sorted(seen.items(), key=lambda kv: kv[1])
    def __len__(self): return len(self._all)

class BKTreeIndex:
    """BK-tree over 256-bit hashes as ints; lazy removal."""
    class _Node:
        __slots__ = ("value","keys","children")
        def __init__(self, value, key):
            self.value, self.keys, self.children = value, {key}, {}
    def __init__(self):
        self._root, self.n, self._removed = None, 0, set()
    @staticmethod
    def _dist(a, b): return bin(a ^ b).count("1")
    def add(self, key, hex_hash):
        value = int(hex_hash, 16)
        if self._root is None:
            self._root = self._Node(value, key); self.n = 1; return
        node = self._root
        while True:
            d = self._dist(value, node.value)
            if d == 0: node.keys.add(key); return
            child = node.children.get(d)
            if child is None:
                node.children[d] = self._Node(value, key); self.n += 1; return
            node = child
    def remove(self, key): self._removed.add(key)
    def query(self, hex_hash, max_dist):
        if self._root is None: return []
        value = int(hex_hash, 16); out = {}; stack = [self._root]
        while stack:
            node = stack.pop()
            if not node.keys.issubset(self._removed):
                d = self._dist(value, node.value)
                if d <= max_dist:
                    for k in node.keys - self._removed:
                        if d < out.get(k, 1 << 30): out[k] = d
                for radius, child in node.children.items():
                    if d - max_dist <= radius <= d + max_dist: stack.append(child)
        return sorted(out.items(), key=lambda kv: kv[1])
    def __len__(self): return self.n

@dataclass
class ListingRecord:
    listing_id: str
    seller_id: str
    hashes: ImageHashes
    title: str = ""
    description: str = ""
    identifiers: Tuple[str, ...] = ()
    price: float = 0.0
    status: str = "active"   # active | sold | tombstone
    embedding: Optional[np.ndarray] = None
    meta: dict = field(default_factory=dict)

@dataclass
class HashHit:
    listing_id: str; seller_id: str; status: str
    phash_dist: int; phash_probe_variant: str; phash_stored_variant: str
    relationship: str; pdq_dist: Optional[int]; from_tombstone: bool; is_exact: bool
    def __repr__(self):
        tag = "TOMBSTONE" if self.from_tombstone else self.status
        return f"HashHit({self.listing_id}, d_ph={self.phash_dist}, d_pdq={self.pdq_dist}, rel={self.relationship}, {tag})"

class HashStore:
    """MIH over 6 pHash variants + BK-tree over PDQ, active + tombstone namespaces."""
    def __init__(self, phash_max_dist=14, pdq_max_dist=PDQ_MATCH_MAX_DIST, min_pdq_quality=MIN_PDQ_QUALITY):
        self.phash_max_dist, self.pdq_max_dist, self.min_pdq_quality = phash_max_dist, pdq_max_dist, min_pdq_quality
        self.records = {}
        self._active_mi, self._tombstone_mi = MIHIndex(), MIHIndex()
        self._active_bk, self._tombstone_bk = BKTreeIndex(), BKTreeIndex()

    def add_listing(self, record: ListingRecord):
        if record.hashes.pdq_quality < self.min_pdq_quality:
            record.meta["low_quality"] = True
        self.records[record.listing_id] = record
        mi = self._tombstone_mi if record.status == "tombstone" else self._active_mi
        bk = self._tombstone_bk if record.status == "tombstone" else self._active_bk
        for label, h in record.hashes.phash_variants.items():
            mi.add(f"{record.listing_id}::{label}", h)
        bk.add(record.listing_id, record.hashes.pdq)

    def delete_listing(self, listing_id):
        """Move to tombstone namespace; hashes stay searchable (repost-after-delete)."""
        rec = self.records.get(listing_id)
        if rec is None or rec.status == "tombstone": return
        for label in rec.hashes.phash_variants:
            self._active_mi.remove(f"{listing_id}::{label}")
        self._active_bk.remove(listing_id)
        rec.status = "tombstone"
        for label, h in rec.hashes.phash_variants.items():
            self._tombstone_mi.add(f"{listing_id}::{label}", h)
        self._tombstone_bk.add(listing_id, rec.hashes.pdq)

    def search(self, probe, include_tombstones=True, phash_max_dist=None, pdq_max_dist=None, top_k=10):
        ph_d = self.phash_max_dist if phash_max_dist is None else phash_max_dist
        pq_d = self.pdq_max_dist if pdq_max_dist is None else pdq_max_dist
        best = {}
        def _collect(mi, tomb):
            for label, h in probe.phash_variants.items():
                for key, d in mi.query(h, ph_d):
                    lid, stored_label = key.split("::", 1)
                    cur = best.get(lid)
                    if cur is None or d < cur["dist"]:
                        best[lid] = {"dist": d, "probe": label, "stored": stored_label, "tomb": tomb}
        _collect(self._active_mi, False)
        if include_tombstones: _collect(self._tombstone_mi, True)
        def _collect_pdq(bk, tomb):
            for lid, d in bk.query(probe.pdq, pq_d):
                cur = best.get(lid)
                if cur is None or d < cur["dist"]:
                    best[lid] = {"dist": d, "probe": "pdq", "stored": "pdq", "tomb": tomb}
        _collect_pdq(self._active_bk, False)
        if include_tombstones: _collect_pdq(self._tombstone_bk, True)
        hits = []
        for lid, info in best.items():
            rec = self.records.get(lid)
            if rec is None: continue
            rel = "identical" if info["probe"] == "pdq" else relationship_of(info["probe"], info["stored"])
            pdq_d = hamming_hex(probe.pdq, rec.hashes.pdq)
            hits.append(HashHit(lid, rec.seller_id, rec.status, info["dist"], info["probe"],
                                info["stored"], rel, pdq_d, info["tomb"],
                                info["dist"] <= PHASH_EXACT_MAX_DIST or pdq_d <= 12))
        hits.sort(key=lambda h: (h.phash_dist, h.pdq_dist or 999))
        return hits[:top_k]

    def __len__(self): return len(self.records)
