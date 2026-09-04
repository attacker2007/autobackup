import os
import math
from PIL import Image, ImageDraw, ImageFilter

def create_autobackup_icon():
    canvas_size = 1024
    
    # ── 1. Base Squircle Container ──
    # Precision squircle proportions: margin 64px, radius 216px
    margin = 64
    radius = 216
    
    base_mask = Image.new("L", (canvas_size, canvas_size), 0)
    draw_mask = ImageDraw.Draw(base_mask)
    draw_mask.rounded_rectangle(
        [margin, margin, canvas_size - margin, canvas_size - margin],
        radius=radius,
        fill=255
    )
    
    # Render rich midnight-slate gradient
    base_layer = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw_base = ImageDraw.Draw(base_layer)
    
    for y in range(canvas_size):
        ratio_y = y / canvas_size
        for x in range(margin, canvas_size - margin):
            ratio_x = x / canvas_size
            blend = (ratio_x * 0.4 + ratio_y * 0.6)
            r = int(22 * (1 - blend) + 8 * blend)
            g = int(32 * (1 - blend) + 12 * blend)
            b = int(48 * (1 - blend) + 20 * blend)
            
            # Subtle ambient spotlight at top (x=512, y=180)
            dx = (x - 512) / 380
            dy = (y - 180) / 280
            dist = math.sqrt(dx*dx + dy*dy)
            if dist < 1.0:
                glow = (1.0 - dist) * 26
                r = min(255, int(r + glow * 0.7))
                g = min(255, int(g + glow * 1.1))
                b = min(255, int(b + glow * 1.9))
                
            draw_base.point((x, y), fill=(r, g, b, 255))
            
    base_layer.putalpha(base_mask)
    
    # Subtle dual rim borders for depth
    draw_rim = ImageDraw.Draw(base_layer)
    draw_rim.rounded_rectangle(
        [margin, margin, canvas_size - margin, canvas_size - margin],
        radius=radius,
        outline=(255, 255, 255, 42),
        width=3
    )
    draw_rim.rounded_rectangle(
        [margin + 3, margin + 3, canvas_size - margin - 3, canvas_size - margin - 3],
        radius=radius - 3,
        outline=(148, 163, 184, 20),
        width=2
    )
    
    # ── 2. AutoBackup Shield & Vault Keystone Emblem ──
    cx, cy = 512, 514
    
    # Harmonious hexagonal shield proportions
    top_w = 175
    flank_w = 265
    mid_y_flank = cy - 40
    low_flank_w = 205
    low_y_flank = cy + 130
    tip_y = cy + 265
    top_y = cy - 235
    
    # Left Facet (Cobalt Sapphire to Azure)
    poly_left = [
        (cx, top_y),
        (cx - top_w, top_y + 35),
        (cx - flank_w, mid_y_flank),
        (cx - low_flank_w, low_y_flank),
        (cx, tip_y),
        (cx, tip_y - 105),
        (cx - (low_flank_w - 75), low_y_flank - 65),
        (cx - (flank_w - 95), mid_y_flank - 25),
        (cx - (top_w - 75), top_y + 100),
        (cx, top_y + 80),
    ]
    
    # Right Facet (Electric Cerulean to Emerald Cyan)
    poly_right = [
        (cx, top_y),
        (cx + top_w, top_y + 35),
        (cx + flank_w, mid_y_flank),
        (cx + low_flank_w, low_y_flank),
        (cx, tip_y),
        (cx, tip_y - 105),
        (cx + (low_flank_w - 75), low_y_flank - 65),
        (cx + (flank_w - 95), mid_y_flank - 25),
        (cx + (top_w - 75), top_y + 100),
        (cx, top_y + 80),
    ]
    
    # Soft natural ambient shadow
    shadow_layer = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    shadow_draw.polygon([(x, y + 26) for x, y in poly_left], fill=(0, 0, 0, 160))
    shadow_draw.polygon([(x, y + 26) for x, y in poly_right], fill=(0, 0, 0, 160))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=32))
    
    # Render Left Wing Gradient
    left_mask = Image.new("L", (canvas_size, canvas_size), 0)
    ImageDraw.Draw(left_mask).polygon(poly_left, fill=255)
    
    left_grad = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    for y in range(top_y, tip_y + 1):
        t = (y - top_y) / (tip_y - top_y)
        r = int(37 * (1 - t) + 2 * t)
        g = int(99 * (1 - t) + 132 * t)
        b = int(235 * (1 - t) + 240 * t)
        for x in range(cx - flank_w - 10, cx + 10):
            left_grad.putpixel((x, y), (r, g, b, 255))
    left_grad.putalpha(left_mask)
    
    # Render Right Wing Gradient
    right_mask = Image.new("L", (canvas_size, canvas_size), 0)
    ImageDraw.Draw(right_mask).polygon(poly_right, fill=255)
    
    right_grad = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    for y in range(top_y, tip_y + 1):
        t = (y - top_y) / (tip_y - top_y)
        r = int(0 * (1 - t) + 16 * t)
        g = int(220 * (1 - t) + 185 * t)
        b = int(254 * (1 - t) + 129 * t)
        for x in range(cx - 10, cx + flank_w + 10):
            right_grad.putpixel((x, y), (r, g, b, 255))
    right_grad.putalpha(right_mask)
    
    # Top highlight specular lines on the facets
    spec_layer = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    spec_draw = ImageDraw.Draw(spec_layer)
    spec_draw.line([(cx, top_y), (cx - top_w, top_y + 35)], fill=(255, 255, 255, 110), width=4)
    spec_draw.line([(cx, top_y), (cx + top_w, top_y + 35)], fill=(255, 255, 255, 140), width=4)
    
    # ── 3. Central Vault Core: Precision Diamond Keystone ──
    core_mask = Image.new("L", (canvas_size, canvas_size), 0)
    core_h = 75
    core_w = 68
    core_cy = cy + 18
    core_poly = [
        (cx, core_cy - core_h),
        (cx + core_w, core_cy),
        (cx, core_cy + core_h),
        (cx - core_w, core_cy)
    ]
    ImageDraw.Draw(core_mask).polygon(core_poly, fill=255)
    
    core_grad = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    for y in range(core_cy - core_h - 5, core_cy + core_h + 5):
        t = (y - (core_cy - core_h)) / (core_h * 2.0)
        r = int(255 * (1 - t) + 215 * t)
        g = int(255 * (1 - t) + 238 * t)
        b = int(255 * (1 - t) + 252 * t)
        for x in range(cx - core_w - 5, cx + core_w + 5):
            core_grad.putpixel((x, y), (r, g, b, 255))
    core_grad.putalpha(core_mask)
    
    # Upward Sync Chevron inside Core
    core_draw = ImageDraw.Draw(core_grad)
    chev_cy = core_cy - 4
    chevron = [
        (cx, chev_cy - 18),
        (cx + 30, chev_cy + 18),
        (cx + 18, chev_cy + 26),
        (cx, chev_cy + 9),
        (cx - 18, chev_cy + 26),
        (cx - 30, chev_cy + 18)
    ]
    core_draw.polygon(chevron, fill=(15, 23, 42, 235))
    
    # Core drop shadow
    core_shadow = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    ImageDraw.Draw(core_shadow).polygon([(x, y + 10) for x, y in core_poly], fill=(0, 0, 0, 110))
    core_shadow = core_shadow.filter(ImageFilter.GaussianBlur(radius=12))
    
    # Facet seam lines
    seam_layer = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    seam_draw = ImageDraw.Draw(seam_layer)
    seam_draw.line([(cx, top_y), (cx, top_y + 80)], fill=(255, 255, 255, 75), width=3)
    seam_draw.line([(cx, tip_y - 105), (cx, tip_y)], fill=(0, 0, 0, 95), width=4)
    
    # ── 4. Composite All Layers ──
    final = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    final.alpha_composite(base_layer)
    final.alpha_composite(shadow_layer)
    final.alpha_composite(left_grad)
    final.alpha_composite(right_grad)
    final.alpha_composite(spec_layer)
    final.alpha_composite(seam_layer)
    final.alpha_composite(core_shadow)
    final.alpha_composite(core_grad)
    
    # ── 5. Downscale with Precision Lanczos Filter ──
    icon_256 = final.resize((256, 256), Image.Resampling.LANCZOS)
    
    os.makedirs("public", exist_ok=True)
    os.makedirs("build", exist_ok=True)
    
    icon_256.save("public/icon.png", format="PNG", optimize=True)
    icon_256.save("build/icon.png", format="PNG", optimize=True)
    print("✅ Successfully generated public/icon.png and build/icon.png (256x256)")
    
    icon_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    icon_layers = [final.resize(s, Image.Resampling.LANCZOS) for s in icon_sizes]
    icon_layers[0].save(
        "build/icon.ico",
        format="ICO",
        sizes=icon_sizes,
        append_images=icon_layers[1:]
    )
    print("✅ Successfully generated build/icon.ico (Windows multi-resolution package)")

if __name__ == "__main__":
    create_autobackup_icon()
