import os
import subprocess
from PIL import Image, ImageDraw, ImageFilter

S = 2048  # 2x supersampling for crisp anti-aliasing
OUT_ICONSET = "/Users/antonbelyj/.gemini/antigravity/brain/7b943f40-03cd-4839-b438-85ccaacdd653/scratch/AppIcon.iconset"
PREVIEW_PNG = "/Users/antonbelyj/.gemini/antigravity/brain/7b943f40-03cd-4839-b438-85ccaacdd653/scratch/icon_preview.png"
DEST_ICNS = "/Users/antonbelyj/Desktop/Суфлёр.app/Contents/Resources/AppIcon.icns"

# 1. Base transparent canvas with macOS icon padding (~10% margin -> 1640px squircle)
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
pad = 204
w = S - 2 * pad
radius = 370  # macOS Big Sur+ squircle feel

# Squircle mask
mask = Image.new("L", (S, S), 0)
mdraw = ImageDraw.Draw(mask)
mdraw.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=255)

# Gradient background: deep modern slate-indigo (#1e2540 -> #101423)
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
px = bg.load()
for y in range(pad, S - pad):
    t = (y - pad) / w
    r = int(32 * (1 - t) + 15 * t)
    g = int(40 * (1 - t) + 19 * t)
    b = int(68 * (1 - t) + 34 * t)
    for x in range(pad, S - pad):
        px[x, y] = (r, g, b, 255)

# Subtle warm amber/indigo ambient glow
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gdraw = ImageDraw.Draw(glow)
gdraw.ellipse([S // 2 - 520, pad - 180, S // 2 + 520, pad + 680], fill=(245, 158, 11, 48))
gdraw.ellipse([S // 2 - 600, S - pad - 500, S // 2 + 600, S - pad + 260], fill=(56, 189, 248, 28))
glow = glow.filter(ImageFilter.GaussianBlur(140))
bg = Image.alpha_composite(bg, glow)

# Apply squircle mask
bg.putalpha(mask)
img = Image.alpha_composite(img, bg)

# Subtle inner glass rim
rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rdraw = ImageDraw.Draw(rim)
rdraw.rounded_rectangle([pad + 4, pad + 4, S - pad - 4, S - pad - 4], radius=radius - 2, outline=(255, 255, 255, 42), width=8)
img = Image.alpha_composite(img, rim)

# 2. Central 9:16 Studio Frame (sleek glass card)
fw, fh = 840, 1180
fx0 = (S - fw) // 2
fy0 = (S - fh) // 2 + 12
fx1, fy1 = fx0 + fw, fy0 + fh

# Card shadow
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sdraw = ImageDraw.Draw(shadow)
sdraw.rounded_rectangle([fx0, fy0 + 28, fx1, fy1 + 28], radius=120, fill=(0, 0, 0, 115))
shadow = shadow.filter(ImageFilter.GaussianBlur(48))
img = Image.alpha_composite(img, shadow)

# Card body
card = Image.new("RGBA", (S, S), (0, 0, 0, 0))
cdraw = ImageDraw.Draw(card)
cdraw.rounded_rectangle([fx0, fy0, fx1, fy1], radius=116, fill=(28, 34, 56, 238), outline=(255, 255, 255, 58), width=8)

# Top camera lens / REC indicator pill
rec_r = 46
rx, ry = fx1 - 120, fy0 + 115
# Glow for rec dot
rec_glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rgdraw = ImageDraw.Draw(rec_glow)
rgdraw.ellipse([rx - 95, ry - 95, rx + 95, ry + 95], fill=(244, 63, 94, 110))
rec_glow = rec_glow.filter(ImageFilter.GaussianBlur(36))
img = Image.alpha_composite(img, rec_glow)

cdraw.ellipse([rx - rec_r, ry - rec_r, rx + rec_r, ry + rec_r], fill=(244, 63, 94, 255))
cdraw.ellipse([rx - 18, ry - 18, rx + 18, ry + 18], fill=(255, 200, 210, 220))

# 3. Teleprompter Text Lines (bold, crisp, readable even at 16px)
lx = fx0 + 118
# Active reading line (warm amber gold)
ly1 = fy0 + 340
cdraw.rounded_rectangle([lx, ly1, fx1 - 140, ly1 + 96], radius=48, fill=(251, 191, 36, 255))
# Second line (crisp white)
ly2 = ly1 + 170
cdraw.rounded_rectangle([lx, ly2, fx1 - 210, ly2 + 84], radius=42, fill=(241, 245, 249, 220))
# Third line (soft slate)
ly3 = ly2 + 156
cdraw.rounded_rectangle([lx, ly3, fx1 - 310, ly3 + 76], radius=38, fill=(148, 163, 184, 150))

# Bottom subtle 9:16 play/lens bar
by = fy1 - 165
cdraw.rounded_rectangle([S // 2 - 120, by, S // 2 + 120, by + 26], radius=13, fill=(255, 255, 255, 70))

img = Image.alpha_composite(img, card)

# Save 1024x1024 preview
img_1024 = img.resize((1024, 1024), Image.Resampling.LANCZOS)
img_1024.save(PREVIEW_PNG)

# Generate .iconset
os.makedirs(OUT_ICONSET, exist_ok=True)
sizes = [16, 32, 128, 256, 512]
for sz in sizes:
    img.resize((sz, sz), Image.Resampling.LANCZOS).save(os.path.join(OUT_ICONSET, f"icon_{sz}x{sz}.png"))
    img.resize((sz * 2, sz * 2), Image.Resampling.LANCZOS).save(os.path.join(OUT_ICONSET, f"icon_{sz}x{sz}@2x.png"))

subprocess.run(["iconutil", "-c", "icns", OUT_ICONSET, "-o", DEST_ICNS], check=True)
print("OK:", DEST_ICNS)
