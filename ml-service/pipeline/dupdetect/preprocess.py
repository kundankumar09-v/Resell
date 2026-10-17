# Stage 0 — decode, apply EXIF orientation, strip EXIF, normalise size. Video -> keyframes.
import io, os, subprocess
from dataclasses import dataclass, field
from typing import List, Optional, Union
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 89_478_485  # decompression-bomb guard

@dataclass
class ProcessedImage:
    image: Image.Image
    original_bytes: Optional[bytes] = None
    exif_stripped: bool = False
    width: int = 0
    height: int = 0
    source: str = ""
    is_keyframe: bool = False
    keyframe_index: int = 0
    extra: dict = field(default_factory=dict)

def preprocess_image(source, max_side: int = 1024, jpeg_quality: int = 90, keep_original: bool = True) -> ProcessedImage:
    """path | bytes | URL | PIL Image -> normalised RGB image (EXIF applied then stripped)."""
    original_bytes = None
    if isinstance(source, Image.Image):
        img = source
    elif isinstance(source, bytes):
        original_bytes = source; img = Image.open(io.BytesIO(source))
    elif isinstance(source, str) and source.startswith(("http://", "https://")):
        import urllib.request
        req = urllib.request.Request(source, headers={"User-Agent": "Mozilla/5.0 (compatible; ReSell-DupDetect/3.0)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            original_bytes = r.read()
        img = Image.open(io.BytesIO(original_bytes))
    else:
        with open(source, "rb") as f: original_bytes = f.read()
        img = Image.open(io.BytesIO(original_bytes))
    exif_stripped = bool(img.getexif())
    try: img = ImageOps.exif_transpose(img)
    except Exception: pass
    img = img.convert("RGB")
    w, h = img.size
    if max(w, h) > max_side:
        s = max_side / float(max(w, h))
        img = img.resize((max(1, int(w*s)), max(1, int(h*s))), Image.LANCZOS)
    return ProcessedImage(img, original_bytes, exif_stripped, img.size[0], img.size[1],
                          str(source)[:512] if isinstance(source, (str, bytes)) else "<pil>")

def extract_keyframes(video_path, out_dir, scene_threshold=0.30, max_frames=8) -> List[ProcessedImage]:
    """Scene-cut keyframes via ffmpeg; fallback 1 fps for static videos."""
    os.makedirs(out_dir, exist_ok=True)
    tpl = os.path.join(out_dir, "kf_%03d.jpg")
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",video_path,
                    "-vf",f"select='gt(scene,{scene_threshold})',showinfo",
                    "-vsync","vfr","-frames:v",str(max_frames),tpl], check=False, capture_output=True)
    frames = sorted(f for f in os.listdir(out_dir) if f.startswith("kf_") and f.endswith(".jpg"))
    if not frames:
        subprocess.run(["ffmpeg","-y","-loglevel","error","-i",video_path,
                        "-vf","fps=1","-frames:v",str(max_frames),tpl], check=False, capture_output=True)
        frames = sorted(f for f in os.listdir(out_dir) if f.startswith("kf_") and f.endswith(".jpg"))
    out = []
    for i, name in enumerate(frames):
        p = preprocess_image(os.path.join(out_dir, name), keep_original=False)
        p.is_keyframe, p.keyframe_index, p.source = True, i, name
        out.append(p)
    return out

def frames_or_image(source, video_extensions=(".mp4",".mov",".webm",".avi",".mkv"), max_side=1024):
    ext = os.path.splitext(str(source))[1].lower()
    if ext in video_extensions and os.path.exists(source):
        return extract_keyframes(source, os.path.join(os.path.dirname(source), "_keyframes"))
    return [preprocess_image(source, max_side=max_side)]
