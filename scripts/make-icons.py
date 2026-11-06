#!/usr/bin/env python3
"""Generate MacPiP's app icon and menu bar (tray) icons.

The design: a dark "desktop" screen with a vivid floating picture-in-picture window docked in its
bottom-right corner, playing a video. The tray icon is the same idea as a monochrome template.

Usage:
  python3 scripts/make-icons.py                 # writes build/icon.png + assets/trayTemplate*.png
  python3 scripts/make-icons.py --theme ocean   # pick a color theme
  python3 scripts/make-icons.py --preview out.png  # render every theme side by side instead

Needs Pillow (pip3 install pillow).
"""
import argparse
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 4  # supersampling factor for smooth edges

THEMES = {
    # name: (background top, background bottom, PiP gradient start, PiP gradient end)
    'sunset': ((30, 27, 58), (10, 11, 24), (255, 122, 61), (176, 64, 255)),
    'ocean': ((18, 34, 56), (6, 12, 24), (34, 211, 238), (99, 102, 241)),
    'lime': ((24, 28, 36), (8, 9, 12), (190, 242, 100), (16, 185, 129)),
}


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def linear_gradient(size, c1, c2, diagonal=False):
    w, h = size
    grad = Image.new('RGB', (256, 1))
    for i in range(256):
        grad.putpixel((i, 0), lerp(c1, c2, i / 255))
    if diagonal:
        big = grad.resize((w + h, 1)).resize((w + h, w + h))
        return big.rotate(-45, resample=Image.BICUBIC, center=((w + h) / 2, (w + h) / 2)).crop(
            ((h) / 2, (w) / 2, (h) / 2 + w, (w) / 2 + h)).resize((w, h))
    return grad.resize((h, 1)).rotate(-90, expand=True).resize((w, h))


def rounded_mask(size, box, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m


def play_triangle(img, cx, cy, r, fill):
    # Play triangle with softly rounded corners, optically centered (nudged right).
    # Rounding: blur a sharp triangle, then threshold it, which eats into the corners.
    pts = [(cx - r * 0.42, cy - r * 0.62), (cx - r * 0.42, cy + r * 0.62), (cx + r * 0.68, cy)]
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(r * 0.1)).point(lambda v: 255 if v > 110 else 0)
    img.paste(Image.new('RGBA', img.size, fill), (0, 0), mask)


def app_icon(theme, size=1024):
    bg1, bg2, pip1, pip2 = THEMES[theme]
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # macOS icon grid: 824px rounded square centered in 1024, radius ~185.
    inset = round(S * 100 / 1024)
    body = (inset, inset, S - inset, S - inset)
    radius = round(S * 185 / 1024)

    # Drop shadow under the whole icon.
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (body[0], body[1] + S * 0.012, body[2], body[3] + S * 0.012), radius=radius, fill=(0, 0, 0, 110))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(S * 0.012)))

    # Background: vertical gradient + a soft glow of the PiP color from the bottom-right.
    bg = linear_gradient((S, S), bg1, bg2).convert('RGBA')
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gx, gy = S * 0.72, S * 0.70
    gr = S * 0.42
    gd.ellipse((gx - gr, gy - gr, gx + gr, gy + gr), fill=pip2 + (90,))
    bg.alpha_composite(glow.filter(ImageFilter.GaussianBlur(S * 0.12)))
    img.paste(bg, (0, 0), rounded_mask((S, S), body, radius))

    # Faint "desktop": a big screen outline with a few content lines (the window you work in).
    d = ImageDraw.Draw(img)
    scr = (S * 0.195, S * 0.225, S * 0.765, S * 0.635)
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle(scr, radius=S * 0.045, outline=(255, 255, 255, 60), width=round(S * 0.012))
    ld.ellipse((scr[0] + S * 0.04, scr[1] + S * 0.035, scr[0] + S * 0.062, scr[1] + S * 0.057), fill=(255, 255, 255, 70))
    for i, frac in enumerate((0.55, 0.38, 0.46)):
        y = scr[1] + S * (0.11 + i * 0.06)
        ld.rounded_rectangle((scr[0] + S * 0.04, y, scr[0] + S * 0.04 + (scr[2] - scr[0]) * frac * 0.62, y + S * 0.022),
                             radius=S * 0.011, fill=(255, 255, 255, 38))
    img.alpha_composite(layer)

    # The floating PiP window, overlapping the screen's bottom-right corner.
    pip = (S * 0.40, S * 0.445, S * 0.835, S * 0.765)
    pr = S * 0.055
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (pip[0], pip[1] + S * 0.02, pip[2], pip[3] + S * 0.02), radius=pr, fill=(0, 0, 0, 150))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(S * 0.025)))

    pw, ph = round(pip[2] - pip[0]), round(pip[3] - pip[1])
    fill = linear_gradient((pw, ph), pip1, pip2, diagonal=True).convert('RGBA')
    # Glassy sheen that fades out toward the middle.
    sheen = Image.new('RGBA', (pw, ph), (255, 255, 255, 0))
    sheen.putalpha(linear_gradient((pw, ph), (60, 60, 60), (0, 0, 0)).convert('L').point(lambda v: min(255, v)))
    fill.alpha_composite(sheen)
    img.paste(fill, (round(pip[0]), round(pip[1])), rounded_mask((pw, ph), (0, 0, pw - 1, ph - 1), pr))
    # Thin light border so it reads as a separate window.
    d.rounded_rectangle(pip, radius=pr, outline=(255, 255, 255, 90), width=round(S * 0.006))

    play_triangle(img, (pip[0] + pip[2]) / 2, (pip[1] + pip[3]) / 2, S * 0.085, (255, 255, 255, 255))

    # Thin top highlight on the icon body (subtle bevel).
    edge = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(body, radius=radius, outline=(255, 255, 255, 40), width=round(S * 0.004))
    fade = linear_gradient((S, S), (255, 255, 255), (0, 0, 0)).convert('L')
    edge.putalpha(ImageChops.multiply(edge.getchannel('A'), fade))
    img.alpha_composite(edge)

    return img.resize((size, size), Image.LANCZOS)


def tray_icon(px):
    """Monochrome template: screen outline + filled floating window in the corner."""
    S = px * 16
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    stroke = S * 0.095
    d.rounded_rectangle((S * 0.06, S * 0.14, S * 0.86, S * 0.74), radius=S * 0.14, outline=(0, 0, 0, 255), width=round(stroke))
    # Cut a gap around the PiP window so the two shapes read separately at 16px.
    gap = S * 0.08
    win = (S * 0.44, S * 0.46, S * 0.98, S * 0.90)
    d.rounded_rectangle((win[0] - gap, win[1] - gap, win[2] + gap, win[3] + gap), radius=S * 0.15, fill=(0, 0, 0, 0))
    d.rounded_rectangle(win, radius=S * 0.1, fill=(0, 0, 0, 255))
    return img.resize((px, px), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--theme', default='sunset', choices=THEMES)
    ap.add_argument('--preview', help='render all themes side by side to this PNG instead of writing icons')
    args = ap.parse_args()

    if args.preview:
        tile = 512
        sheet = Image.new('RGBA', (tile * len(THEMES) + 40 * (len(THEMES) + 1), tile + 200), (236, 236, 240, 255))
        d = ImageDraw.Draw(sheet)
        for i, name in enumerate(THEMES):
            x = 40 + i * (tile + 40)
            sheet.alpha_composite(app_icon(name, tile), (x, 20))
            d.text((x + tile / 2 - 20, tile + 30), name, fill=(40, 40, 40, 255))
        # Tray icon at 2x, on light and dark menu bars.
        t = tray_icon(64)
        for j, (bgc, col) in enumerate((((246, 246, 246, 255), (0, 0, 0)), ((40, 40, 44, 255), (255, 255, 255)))):
            x = 40 + j * 140
            d.rectangle((x, tile + 70, x + 120, tile + 170), fill=bgc)
            tinted = Image.new('RGBA', t.size, col + (0,))
            tinted.putalpha(t.getchannel('A'))
            sheet.alpha_composite(tinted, (x + 28, tile + 88))
        sheet.save(args.preview)
        print('Preview:', args.preview)
        return

    app_icon(args.theme, 1024).save(os.path.join(ROOT, 'build', 'icon.png'))
    tray_icon(16).save(os.path.join(ROOT, 'assets', 'trayTemplate.png'))
    tray_icon(32).save(os.path.join(ROOT, 'assets', 'trayTemplate@2x.png'))
    print(f'Wrote build/icon.png ({args.theme}) and assets/trayTemplate(@2x).png')


if __name__ == '__main__':
    main()
