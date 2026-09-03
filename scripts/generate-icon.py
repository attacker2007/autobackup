import os
from PIL import Image, ImageDraw

def create_icon():
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background rounded rectangle with sleek gradient feel
    margin = 16
    radius = 48
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        fill=(15, 23, 42, 255),  # Slate 900
        outline=(0, 242, 254, 200),  # Cyan neon glow
        width=4
    )

    # Inner subtle glow rectangle
    draw.rounded_rectangle(
        [margin + 8, margin + 8, size - margin - 8, size - margin - 8],
        radius=radius - 8,
        fill=(11, 18, 33, 255),
        outline=(79, 70, 229, 100),  # Indigo subtle border
        width=2
    )

    # Draw Cloud Body (Center (128, 115))
    cx, cy = 128, 115
    draw.ellipse([cx - 42, cy - 25, cx + 42, cy + 30], fill=(0, 242, 254, 230))  # Center dome
    draw.ellipse([cx - 65, cy - 8, cx - 15, cy + 32], fill=(0, 210, 254, 220))   # Left puff
    draw.ellipse([cx + 15, cy - 8, cx + 65, cy + 32], fill=(0, 210, 254, 220))   # Right puff
    draw.rectangle([cx - 50, cy + 8, cx + 50, cy + 32], fill=(0, 210, 254, 240)) # Base

    # Draw Upward Sync / Backup Arrow
    arrow_color = (15, 23, 42, 255)
    tip = (cx, cy - 8)
    left_wing = (cx - 22, cy + 10)
    right_wing = (cx + 22, cy + 10)
    stem_left = cx - 9
    stem_right = cx + 9
    stem_bottom = cy + 26
    
    draw.polygon([tip, left_wing, (stem_left, cy + 10), (stem_left, stem_bottom),
                  (stem_right, stem_bottom), (stem_right, cy + 10), right_wing], fill=arrow_color)

    # Bottom status indicator / sync pulse
    draw.ellipse([cx - 18, 185, cx - 6, 197], fill=(0, 242, 254, 255))
    draw.ellipse([cx - 6, 185, cx + 6, 197], fill=(59, 130, 246, 255))
    draw.ellipse([cx + 6, 185, cx + 18, 197], fill=(168, 85, 247, 255))

    os.makedirs("public", exist_ok=True)
    os.makedirs("build", exist_ok=True)

    img.save("public/icon.png", format="PNG")
    img.save("build/icon.png", format="PNG")

    # Generate multi-size ICO for Windows
    icon_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    img.save("build/icon.ico", format="ICO", sizes=icon_sizes)
    print("Generated public/icon.png, build/icon.png, and build/icon.ico successfully!")

if __name__ == "__main__":
    create_icon()
