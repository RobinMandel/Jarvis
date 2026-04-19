"""One-shot icon generator for MC PWA. Run once, commit PNGs.

Produces:
- icon-180.png (apple-touch-icon)
- icon-192.png (PWA manifest)
- icon-512.png (PWA manifest, large)
- icon-maskable-512.png (Android maskable)
- favicon-32.png
- splash placeholder via meta tags (not generated here)

Uses stdlib + PIL. No external fonts required — falls back to default bold.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUT = Path(__file__).parent
BG = (8, 10, 15)         # #080a0f — MC dark theme
FG = (255, 255, 255)
ACCENT = (217, 119, 87)  # #d97757 — Anthropic terracotta

# Try to find a bold system font
FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeuib.ttf",   # Segoe UI Bold
    "C:/Windows/Fonts/arialbd.ttf",    # Arial Bold
    "C:/Windows/Fonts/calibrib.ttf",   # Calibri Bold
]

def load_font(size):
    for f in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(f, size)
        except Exception:
            continue
    return ImageFont.load_default()

def make_icon(size, *, padding_ratio=0.0, corner_radius_ratio=0.22, accent_dot=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Background rounded rect
    pad = int(size * padding_ratio)
    radius = int(size * corner_radius_ratio)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=BG)
    # J in center
    font = load_font(int(size * 0.62))
    text = "J"
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1] - int(size * 0.03)
    d.text((x, y), text, fill=FG, font=font)
    # Accent dot top-right
    if accent_dot:
        r = int(size * 0.08)
        cx = int(size * 0.76)
        cy = int(size * 0.22)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    return img

def make_maskable(size):
    """Maskable icons need ~20% safe area around content."""
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    font = load_font(int(size * 0.45))
    bbox = d.textbbox((0, 0), "J", font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1] - int(size * 0.02)
    d.text((x, y), "J", fill=FG, font=font)
    r = int(size * 0.05)
    cx = int(size * 0.62)
    cy = int(size * 0.38)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    return img

for size, name in [(180, "icon-180.png"), (192, "icon-192.png"), (512, "icon-512.png"), (32, "favicon-32.png")]:
    make_icon(size).save(OUT / name)
    print(f"wrote {name}")

make_maskable(512).save(OUT / "icon-maskable-512.png")
print("wrote icon-maskable-512.png")
