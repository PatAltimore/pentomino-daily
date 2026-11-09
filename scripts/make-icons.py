#!/usr/bin/env python3
"""
Draws the app icon (a pentomino) and the link-preview card into site/. The results are committed, so
this only needs to be run to change the design:  python3 scripts/make-icons.py   (needs Pillow).

Writes: site/icon.svg, apple-touch-icon.png (180), icon-192.png, icon-512.png, favicon-32.png,
og-image.png (1200x630, the card shown when a link is shared in a message).
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site')
BG = (15, 18, 32)             # --bg
# The "F" pentomino, one colour per row, from sunset orange to purple (the palette of the sample picture).
CELLS = [(1, 0, (255, 180, 84)), (2, 0, (255, 128, 107)), (0, 1, (234, 88, 150)), (1, 1, (190, 92, 214)), (1, 2, (130, 96, 245))]


def hex_(c):
    return '#%02x%02x%02x' % c


def draw_piece(draw, ox, oy, cell, gap, radius, outline):
    """The F pentomino with its top-left corner at (ox, oy); each cell is `cell` px."""
    for cx, cy, color in CELLS:
        x0 = ox + cx * cell + gap
        y0 = oy + cy * cell + gap
        x1 = ox + (cx + 1) * cell - gap
        y1 = oy + (cy + 1) * cell - gap
        draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=color, outline=(255, 255, 255, 190), width=outline)


def icon(size):
    """Full-bleed square (the phone rounds the corners itself) with the piece centred."""
    scale = 4  # draw big, then shrink: smooth edges
    s = size * scale
    img = Image.new('RGB', (s, s), BG)
    d = ImageDraw.Draw(img, 'RGBA')
    cell = int(s * 0.25)
    ox = (s - 3 * cell) // 2
    oy = (s - 3 * cell) // 2
    draw_piece(d, ox, oy, cell, gap=max(1, int(cell * 0.012)), radius=int(cell * 0.11), outline=max(2, int(cell * 0.028)))
    return img.resize((size, size), Image.LANCZOS)


def card(w=1200, h=630):
    scale = 2
    img = Image.new('RGB', (w * scale, h * scale), BG)
    d = ImageDraw.Draw(img, 'RGBA')
    # soft glow behind the piece (blurred, so it has no visible rings)
    glow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    r = 280 * scale
    gd.ellipse([260 * scale - r, h * scale // 2 - r, 260 * scale + r, h * scale // 2 + r], fill=(130, 96, 245, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(90 * scale))
    img.paste(glow, (0, 0), glow)
    d = ImageDraw.Draw(img, 'RGBA')
    cell = 150 * scale
    draw_piece(d, 60 * scale, (h * scale - 3 * cell) // 2, cell, gap=max(1, int(cell * 0.012)), radius=int(cell * 0.11), outline=3 * scale)
    bold = ImageFont.truetype('/usr/share/fonts/opentype/inter/Inter-Bold.otf', 92 * scale)
    reg = ImageFont.truetype('/usr/share/fonts/opentype/inter/Inter-Regular.otf', 38 * scale)
    d.text((570 * scale, 215 * scale), 'Pentomino', font=bold, fill=(238, 240, 255))
    d.text((570 * scale, 315 * scale), 'Daily', font=bold, fill=(255, 180, 84))
    for i, line in enumerate(['Rebuild the picture of the day', 'from puzzle pieces, every day.']):
        assert d.textlength(line, font=reg) / scale < w - 572 - 40, 'preview text too wide: ' + line
        d.text((572 * scale, (440 + i * 52) * scale), line, font=reg, fill=(154, 160, 192))
    assert d.textlength('Pentomino', font=bold) / scale < w - 570 - 40
    return img.resize((w, h), Image.LANCZOS)


def svg():
    cell, gap, r = 25, 1.1, 4
    rects = ''
    for cx, cy, color in CELLS:
        rects += (f'<rect x="{12.5 + cx * cell + gap:.2f}" y="{12.5 + cy * cell + gap:.2f}" '
                  f'width="{cell - 2 * gap:.2f}" height="{cell - 2 * gap:.2f}" rx="{r}" fill="{hex_(color)}" '
                  f'stroke="#ffffff" stroke-opacity="0.75" stroke-width="0.8"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            f'<rect width="100" height="100" rx="22" fill="{hex_(BG)}"/>{rects}</svg>\n')


if __name__ == '__main__':
    for name, size in [('apple-touch-icon.png', 180), ('icon-192.png', 192), ('icon-512.png', 512), ('favicon-32.png', 32)]:
        icon(size).save(os.path.join(OUT, name), optimize=True)
    card().save(os.path.join(OUT, 'og-image.png'), optimize=True)
    with open(os.path.join(OUT, 'icon.svg'), 'w') as f:
        f.write(svg())
    print('wrote icons and og-image to site/')
