# 10 evasion attacks ported 1:1 from the repo's adversarial eval.
import os, time, urllib.request, io
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

Image.MAX_IMAGE_PIXELS = 89_478_485
VARIANTS = ["crop35", "rotate15", "color_shift", "watermark", "mirror",
            "screenshot", "collage", "crop_mirror", "rotate_color", "watermark_crop"]
_PICSUM_IDS = list(range(1, 120))

def _load_font(size):
    for p in ("DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try: return ImageFont.truetype(p, size)
        except Exception: pass
    return ImageFont.load_default()

def _crop35(img):
    w, h = img.size
    return img.crop((int(w*0.175), int(h*0.175), int(w*0.825), int(h*0.825)))

def _rotate15(img):
    return img.rotate(15, resample=Image.BICUBIC, expand=False, fillcolor=(255,255,255))

def _color_shift(img):
    out = ImageEnhance.Brightness(img).enhance(0.80)
    out = ImageEnhance.Contrast(out).enhance(1.20)
    return ImageEnhance.Color(out).enhance(0.65)

def _watermark(img):
    out = img.copy().convert("RGBA")
    ov = Image.new("RGBA", out.size, (0,0,0,0)); d = ImageDraw.Draw(ov)
    w, h = out.size; text = "MARKETPLACE  SAMPLE"
    font = _load_font(max(18, h//18)); bbox = d.textbbox((0,0), text, font=font)
    tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
    for k in range(-2, 3):
        d.text((int(w*0.5 - tw/2 + k*(tw+40)*0.5), int(h*0.5 + k*(th+50))),
               text, font=font, fill=(255,255,255,110))
    d.text((8, 8), "sold-via-marketplace.com", font=font, fill=(255,255,255,130))
    return Image.alpha_composite(out, ov).convert("RGB")

def _mirror(img): return ImageOps.mirror(img)

def _screenshot(img):
    w, h = img.size; pad = max(12, int(w*0.04)); bar = max(28, int(h*0.06))
    canvas = Image.new("RGB", (w+2*pad, h+pad+bar), (250,250,250))
    canvas.paste(img, (pad, bar)); d = ImageDraw.Draw(canvas)
    d.rectangle([pad, 0, pad+w, bar-4], fill=(30,30,30))
    d.text((pad+8, 4), "9:41  seller-app  v2.3", fill=(240,240,240), font=_load_font(16))
    buf = io.BytesIO(); canvas.save(buf, "JPEG", quality=55); buf.seek(0)
    return Image.open(buf).convert("RGB")

def _collage(img):
    w, h = img.size; cell = (w//2, h//2); small = img.resize(cell)
    tiles = [small, _crop35(small).resize(cell), _mirror(small), _color_shift(small).resize(cell)]
    canvas = Image.new("RGB", (w, h), (255,255,255))
    canvas.paste(tiles[0], (0,0)); canvas.paste(tiles[1], (cell[0],0))
    canvas.paste(tiles[2], (0,cell[1])); canvas.paste(tiles[3], (cell[0],cell[1]))
    ImageDraw.Draw(canvas).rectangle([0,0,w-1,h-1], outline=(200,200,200), width=3)
    return canvas

def _crop_mirror(img): return ImageOps.mirror(_crop35(img))
def _rotate_color(img): return _color_shift(_rotate15(img))
def _watermark_crop(img): return _watermark(_crop35(img))

VARIANT_FNS: Dict[str, Callable] = {
    "crop35": _crop35, "rotate15": _rotate15, "color_shift": _color_shift,
    "watermark": _watermark, "mirror": _mirror, "screenshot": _screenshot,
    "collage": _collage, "crop_mirror": _crop_mirror, "rotate_color": _rotate_color,
    "watermark_crop": _watermark_crop,
}

def _download_one(url, path, timeout=20):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; ReSell-DupDetect/3.0)"})
        with urllib.request.urlopen(req, timeout=timeout) as r: data = r.read()
        Image.open(io.BytesIO(data)).convert("RGB").save(path, "JPEG", quality=90)
        return True
    except Exception: return False

def collect_source_images(n_groups, images_dir, use_own_dir=None):
    """Own photos > previously cached > Picsum real photographs (threaded)."""
    os.makedirs(images_dir, exist_ok=True)
    local = sorted(os.path.join(images_dir, f) for f in os.listdir(images_dir)
                   if f.lower().endswith((".jpg",".jpeg",".png",".webp")))
    if use_own_dir and os.path.isdir(use_own_dir):
        own = sorted(os.path.join(use_own_dir, f) for f in os.listdir(use_own_dir)
                     if f.lower().endswith((".jpg",".jpeg",".png",".webp")))
        local = own + [p for p in local if p not in own]
    if len(local) >= n_groups: return local[:n_groups]
    wanted = n_groups - len(local)
    jobs = [(pid, os.path.join(images_dir, f"picsum_{pid:04d}.jpg")) for pid in _PICSUM_IDS
            if not os.path.exists(os.path.join(images_dir, f"picsum_{pid:04d}.jpg"))][:wanted]
    if jobs:
        with ThreadPoolExecutor(max_workers=16) as pool:
            res = list(pool.map(lambda j: _download_one(
                f"https://picsum.photos/id/{j[0]}/800/600.jpg", j[1]), jobs))
        print(f"  downloaded {sum(res)}/{len(jobs)} picsum images")
    local = sorted(os.path.join(images_dir, f) for f in os.listdir(images_dir)
                   if f.lower().endswith((".jpg",".jpeg",".png",".webp")))
    if not local: raise SystemExit("FATAL: no source images; check network or use use_own_dir=")
    return local[:n_groups]

def generate_adversarial_set(source_paths, out_dir, variants=None, jpeg_quality=88):
    """Writes <out_dir>/<variant>/g<idx>.jpg -> {variant: [paths]}."""
    variants = variants or VARIANTS; index = {}; t0 = time.perf_counter()
    for v in variants:
        vdir = os.path.join(out_dir, v); os.makedirs(vdir, exist_ok=True); paths = []
        for i, src in enumerate(source_paths):
            try:
                img = Image.open(src).convert("RGB")
                vp = os.path.join(vdir, f"g{i:03d}.jpg")
                VARIANT_FNS[v](img).save(vp, "JPEG", quality=jpeg_quality)
                paths.append(vp)
            except Exception as e: print(f"  skip {v}/g{i}: {e}")
        index[v] = paths
    print(f"  {sum(len(v) for v in index.values())} variant images in {time.perf_counter()-t0:.1f}s")
    return index
