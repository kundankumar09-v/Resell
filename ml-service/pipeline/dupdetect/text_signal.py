
import torch, open_clip, numpy as np

class TextSignal:
    def __init__(self, thr=0.92, device=None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model, _, _ = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k", device=self.device)
        self.tok = open_clip.get_tokenizer("ViT-B-32")
        self.model.eval()
        self.thr = thr
        self._cache = {}

    @torch.no_grad()
    def embed(self, text):
        t = " ".join((text or "").lower().split())
        if not t: return None
        if t not in self._cache:
            tokens = self.tok([t]).to(self.device)
            v = self.model.encode_text(tokens).float().cpu().numpy()[0]
            self._cache[t] = v / (np.linalg.norm(v) + 1e-9)
        return self._cache[t]

    def sim(self, a, b):
        ea, eb = self.embed(a), self.embed(b)
        if ea is None or eb is None: return 0.0
        return float(np.dot(ea, eb))

    def check(self, a, b):
        s = self.sim(a, b)
        return {"text_sim": round(s, 4), "text_hit": s >= self.thr}
