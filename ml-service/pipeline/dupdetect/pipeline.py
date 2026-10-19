# Stage 5 v2 — hash + SSCD + identifiers + TEXT signal, 2-signal gating
import json, re
import numpy as np
from dupdetect.hashing import HashStore, ListingRecord, ImageHashes
from dupdetect.embeddings import make_embedder, ANNIndex
from dupdetect.preprocess import preprocess_image

_IMEI_RE = re.compile(r"\b\d{15}\b")
_SER_RE = re.compile(r"\b(?=[A-Z0-9-]{8,20}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9-]+\b")

def _luhn_ok(num: str) -> bool:
    tot = 0
    for i, ch in enumerate(reversed(num)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9: d -= 9
        tot += d
    return tot % 10 == 0

def extract_identifiers(text: str):
    out = set()
    for m in _IMEI_RE.findall(text or ""):
        if _luhn_ok(m): out.add("imei:" + m)
    for m in _SER_RE.findall(text or ""):
        if len(m) >= 8: out.add("ser:" + m.upper())
    return tuple(out)

_SEV = {"block": 0, "review": 1, "allow": 2}

class DuplicatePipeline:
    """MEASURED thresholds + 2-signal gating. Signals: hash, embedding, identifier, text."""
    def __init__(self, thr_path="thresholds.json", model="sscd"):
        t = json.load(open(thr_path))
        self.block_thr, self.review_from = t["block_thr"], t["review_from"]
        self.block_solo_thr = t.get("block_solo_thr", 0.80)
        self.model_name = model
        self.store = HashStore()
        self.ann = None
        self.emb = None
        self._emb_of = {}
        self._ts = None

    def _embedder(self):
        if self.emb is None: self.emb = make_embedder(self.model_name)
        return self.emb

    def _text(self):
        if self._ts is None:
            from dupdetect.text_signal import TextSignal
            self._ts = TextSignal()
        return self._ts

    def _vec(self, image):
        return self._embedder().embed_one(preprocess_image(image).image)

    def _ensure_ann(self, dim):
        if self.ann is None: self.ann = ANNIndex(dim)

    def add_listing(self, listing_id, seller_id, image, title="", description="",
                    price=0.0, status="active", vector=None, hashes=None):
        hashes = hashes or ImageHashes.compute(preprocess_image(image).image)
        vec = vector if vector is not None else self._vec(image)
        idents = extract_identifiers(f"{title} {description}")
        rec = ListingRecord(listing_id, seller_id, hashes, title, description,
                            idents, price, status, meta={"vec": vec})
        self.store.add_listing(rec)
        self._ensure_ann(vec.shape[0])
        self.ann.add(listing_id, vec, tombstone=(status == "tombstone"))
        self._emb_of[listing_id] = vec
        return rec

    def delete_listing(self, listing_id):
        """Tombstone: hashes + embedding stay searchable (repost-after-delete)."""
        self.store.delete_listing(listing_id)
        if self.ann is not None: self.ann.mark_deleted(listing_id)

    def query(self, seller_id, image, title="", description="", top_k=5):
        hashes = ImageHashes.compute(preprocess_image(image).image)
        vec = self._vec(image)
        probe_idents = extract_identifiers(f"{title} {description}")
        qtext = " ".join(f"{title} {description}".split()).strip()

        hash_hits = self.store.search(hashes, include_tombstones=True, top_k=top_k)
        self._ensure_ann(vec.shape[0])
        ann_hits = self.ann.search(vec, k=top_k, include_tombstones=True)
        try:  # crop-variant probing - catches screenshots / collages / borders
            pre_img = preprocess_image(image).image
            pw, ph_ = pre_img.size
            side = min(pw, ph_)
            crops = []
            for frac in (0.8, 0.65):
                s = int(side * frac)
                crops.append(pre_img.crop(((pw - s) // 2, (ph_ - s) // 2,
                                           (pw + s) // 2, (ph_ + s) // 2)))
            best = {n.key: n for n in ann_hits}
            for cv in self._embedder().embed_batch(crops):
                for n in self.ann.search(cv, k=top_k, include_tombstones=True):
                    if n.key not in best or n.similarity > best[n.key].similarity:
                        best[n.key] = n
            ann_hits = list(best.values())
        except Exception:
            pass

        cands = {}
        for h in hash_hits:
            cands[h.listing_id] = {"h": h, "sim": 0.0}
        for n in ann_hits:
            c = cands.setdefault(n.key, {"h": None, "sim": n.similarity})
            c["sim"] = max(c["sim"], n.similarity)
            if n.from_tombstone and c["h"] is None:
                c["tomb"] = True
            elif n.from_tombstone:
                c["h"].from_tombstone = True

        best = None
        for lid, c in cands.items():
            sim, h = c["sim"], c["h"]
            rec = self.store.records.get(lid)
            same_seller = rec is not None and rec.seller_id == seller_id
            tomb = c.get("tomb", False) or (h is not None and h.from_tombstone)
            id_match = bool(probe_idents) and rec is not None and set(probe_idents) & set(rec.identifiers)
            hash_hit = h is not None and (h.phash_dist <= 14 or (h.pdq_dist or 999) <= 32)

            text_hit, text_sim = False, 0.0
            if rec is not None and qtext:
                rtext = " ".join(f"{rec.title} {rec.description}".split()).strip()
                if rtext:
                    tc = self._text().check(qtext, rtext)
                    text_hit, text_sim = tc["text_hit"], tc["text_sim"]

            reasons = []
            if tomb and (hash_hit or sim >= self.block_thr):
                return {"decision": "block", "score": round(sim, 3), "match": lid,
                        "reasons": ["repost_after_delete", f"hash={hash_hit}", f"sim={sim:.3f}"]}
            if id_match and sim >= self.review_from:
                return {"decision": "block", "score": round(sim, 3), "match": lid,
                        "reasons": ["identifier_match", f"sim={sim:.3f}"]}
            # 2-signal cross-seller blocks: hash+embed | hash+text | embed+text
            # solo-ultra: an embedding this close is a copy by itself (FPR ~0
            # at >= 0.80 on measured negatives) - screenshots/collages with
            # chrome defeat hash and text, so the embedding must stand alone.
            solo = sim >= getattr(self, "block_solo_thr", 0.80)
            if not same_seller and (solo or
                                    (hash_hit and sim >= self.block_thr) or
                                    (hash_hit and text_hit) or
                                    (sim >= self.block_thr and text_hit)):
                if hash_hit: reasons.append("hash_hit")
                if sim >= self.block_thr: reasons.append("embedding_above_block")
                if solo and not hash_hit and not text_hit:
                    reasons.append("embedding_solo_ultra")
                if text_hit: reasons.append(f"text={text_sim:.3f}")
                return {"decision": "block", "score": round(max(sim, text_sim), 3), "match": lid, "reasons": reasons}
            if same_seller and (hash_hit or sim >= self.block_thr or text_hit):
                cand = {"decision": "review", "score": round(sim, 3), "match": lid,
                        "reasons": ["same_seller_repost"] + ([f"text={text_sim:.3f}"] if text_hit else [])}
            elif text_hit:
                cand = {"decision": "review", "score": round(sim, 3), "match": lid,
                        "reasons": ["text_near_dup", f"text={text_sim:.3f}", f"sim={sim:.3f}"]}
            elif hash_hit and sim >= self.review_from:
                cand = {"decision": "review", "score": round(sim, 3), "match": lid,
                        "reasons": ["hash_hit", "embedding_in_review_band"]}
            elif sim >= self.review_from:
                cand = {"decision": "review", "score": round(sim, 3), "match": lid,
                        "reasons": ["embedding_in_review_band"]}
            else:
                cand = {"decision": "allow", "score": round(sim, 3), "match": lid, "reasons": []}
            if best is None or (_SEV[cand["decision"]], -cand["score"]) < (_SEV[best["decision"]], -best["score"]):
                best = cand
        return best or {"decision": "allow", "score": 0.0, "match": None, "reasons": ["no_candidates"]}
