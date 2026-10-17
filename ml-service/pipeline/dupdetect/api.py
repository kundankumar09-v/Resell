
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
import base64, io, os
import numpy as np
from PIL import Image

from .pipeline import DuplicatePipeline
from .preprocess import preprocess_image

_DIR = os.path.dirname(__file__)
_thr = os.path.join(_DIR, "thresholds.json")
if not os.path.exists(_thr): _thr = "thresholds.json"

app = FastAPI(title="ReSell Duplicate Detection", version="2.1")
pipe = DuplicatePipeline(thr_path=_thr)

def _jsonable(o):
    if o is None or isinstance(o, (str, int, float, bool)): return o
    if isinstance(o, bytes): return o.hex()
    if isinstance(o, np.ndarray): return o.tolist()
    if isinstance(o, dict): return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)): return [_jsonable(v) for v in o]
    if hasattr(o, "to_dict"): return _jsonable(o.to_dict())
    if hasattr(o, "__dict__"): return _jsonable(vars(o))
    return str(o)

class ImageReq(BaseModel):
    listing_id: str
    seller_id: str
    image_b64: str
    title: Optional[str] = ""
    description: Optional[str] = ""

class DeleteReq(BaseModel):
    listing_id: str

def _img(b64: str):
    return preprocess_image(base64.b64decode(b64)).image

@app.get("/health")
def health():
    return {"ok": True, "model": "sscd", "signals": ["hash", "embedding", "identifier", "text"]}

@app.post("/dup/add")
def dup_add(r: ImageReq):
    rec = pipe.add_listing(r.listing_id, r.seller_id, _img(r.image_b64), title=r.title or "", description=r.description or "")
    return {"listing_id": r.listing_id, "result": _jsonable(rec)}

@app.post("/dup/query")
def dup_query(r: ImageReq):
    res = pipe.query(r.seller_id, _img(r.image_b64), title=r.title or "", description=r.description or "")
    return {"listing_id": r.listing_id, "result": _jsonable(res)}

@app.post("/dup/delete")
def dup_delete(r: DeleteReq):
    return {"listing_id": r.listing_id, "result": _jsonable(pipe.delete_listing(r.listing_id))}
