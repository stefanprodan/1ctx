# /// script
# dependencies = ["fonttools"]
# ///
# Generates the brand files in assets/ with the type outlined, so they
# render the same everywhere without the fonts installed. The PNGs are
# not made here; see assets/README.md for how they were rasterized.
#
#   uv run scripts/brand.py
import os
import tempfile
import urllib.request
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("BRAND_OUT") or os.path.join(HERE, "..", "assets")
FONTS = os.path.join(tempfile.gettempdir(), "1ctx-brand-fonts")
os.makedirs(FONTS, exist_ok=True)
FONT_URLS = {
    "JetBrainsMono-Bold.ttf": "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Bold.ttf",
    "IBMPlexSans-Regular.ttf": "https://github.com/IBM/plex/raw/master/packages/plex-sans/fonts/complete/ttf/IBMPlexSans-Regular.ttf",
}
for name, url in FONT_URLS.items():
    path = os.path.join(FONTS, name)
    if not os.path.exists(path):
        urllib.request.urlretrieve(url, path)

MONO_BOLD = TTFont(os.path.join(FONTS, "JetBrainsMono-Bold.ttf"))
PLEX = TTFont(os.path.join(FONTS, "IBMPlexSans-Regular.ttf"))

AMBER = "#f2c14e"
AMBER_LIGHT = "#d9a53a"
FG_DARK = "#e7e7e9"   # foreground on a dark ground
FG_LIGHT = "#131314"  # foreground on a light ground
BG_DARK = "#131314"
BG_LIGHT = "#f4f2ec"
DIM_DARK = "#b3b3b8"
DIM_LIGHT = "#4f4b43"

CHIP = "M13.5 4H11C6.757 4 4.636 4 3.318 5.318S2 8.758 2 13s0 6.364 1.318 7.682S6.758 22 11 22s6.364 0 7.682-1.318S20 17.242 20 13v-2.5"
ONE = "M8.75 11.25 11.5 8.75V17.5"
# A filled four-point star with concave sides, centred on the chip's
# open corner at (19.5, 4.5) with points SPARK_R units out. Filled, not
# stroked, so it stays crisp when the mark is scaled up next to a heavy
# chip stroke.
SPARK_R = 3.5
def _spark(r, cx=19.5, cy=4.5, k=0.55):
    c = r * k
    return (f"M{cx} {cy - r}C{cx} {cy - r + c} {cx + r - c} {cy} {cx + r} {cy}"
            f"C{cx + r - c} {cy} {cx} {cy + r - c} {cx} {cy + r}"
            f"C{cx} {cy + r - c} {cx - r + c} {cy} {cx - r} {cy}"
            f"C{cx - r + c} {cy} {cx} {cy - r + c} {cx} {cy - r}Z")
SPARK = _spark(SPARK_R)


def text_path(font, text, size, x, y, tracking_em=0.0):
    """Outline `text` at `size` px with its baseline at (x, y). Returns (d, width)."""
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    scale = size / upm
    hmtx = font["hmtx"]
    kern = {}
    # pair kerning from the kern table if present (Plex has GPOS only; fine to skip)
    d = []
    cx = x
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        # flip y, scale, translate
        tpen = TransformPen(pen, (scale, 0, 0, -scale, cx, y))
        glyphs[name].draw(tpen)
        cmds = pen.getCommands()
        if cmds:
            d.append(cmds)
        adv = hmtx[name][0] * scale
        cx += adv + tracking_em * size
    width = cx - x - tracking_em * size
    return " ".join(d), width


def text_width(font, text, size, tracking_em=0.0):
    return text_path(font, text, size, 0, 0, tracking_em)[1]


def mark(x, y, s, fg, accent, sw=1.5):
    """The mark at scale s (1 = 24 px), top-left at (x, y)."""
    return (
        f'<g transform="translate({x} {y}) scale({s})" fill="none" stroke-width="{sw}" '
        f'stroke-linecap="round" stroke-linejoin="round">'
        f'<path stroke="{fg}" d="{CHIP}"/>'
        f'<path stroke="{fg}" d="{ONE}"/>'
        f'<path fill="{accent}" stroke="none" d="{SPARK}"/>'
        f"</g>"
    )


def svg(w, h, body, bg=None):
    rect = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f"{rect}{body}</svg>\n"
    )


def write(name, content):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(content)
    print(name)


# ---- marks ----
write("mark.svg", (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">\n'
    f'  <path stroke="currentColor" d="{CHIP}"/>\n'
    f'  <path stroke="currentColor" d="{ONE}"/>\n'
    f'  <path fill="{AMBER}" stroke="none" d="{SPARK}"/>\n'
    "</svg>\n"
))
for variant, fg, acc in (("dark", FG_DARK, AMBER), ("light", FG_LIGHT, AMBER_LIGHT)):
    write(f"mark-{variant}.svg", (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">\n'
        f'  <path stroke="{fg}" d="{CHIP}"/>\n'
        f'  <path stroke="{fg}" d="{ONE}"/>\n'
        f'  <path fill="{acc}" stroke="none" d="{SPARK}"/>\n'
        "</svg>\n"
    ))

# favicon: heavier stroke and a sparkle scaled 1.25x about the corner,
# so both survive 16 px; follows the browser's colour scheme
write("favicon.svg", (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n'
    "  <style>\n"
    f"    .fg {{ stroke: {FG_LIGHT}; }} .ac {{ fill: {AMBER_LIGHT}; stroke: none; }}\n"
    f"    @media (prefers-color-scheme: dark) {{ .fg {{ stroke: {FG_DARK}; }} .ac {{ fill: {AMBER}; stroke: none; }} }}\n"
    "  </style>\n"
    f'  <path class="fg" d="{CHIP}"/>\n'
    f'  <path class="fg" d="{ONE}"/>\n'
    f'  <path class="ac" transform="translate(19.5 4.5) scale(1.25) translate(-19.5 -4.5)" d="{SPARK}"/>\n'
    "</svg>\n"
))

# ---- wordmark: "1ctx" JetBrains Mono Bold, -0.02em, outlined ----
WM_SIZE = 64
asc = MONO_BOLD["hhea"].ascent / MONO_BOLD["head"].unitsPerEm * WM_SIZE
desc = -MONO_BOLD["hhea"].descent / MONO_BOLD["head"].unitsPerEm * WM_SIZE
wm_d, wm_w = text_path(MONO_BOLD, "1ctx", WM_SIZE, 0, 0, -0.02)
# tight box: cap height to baseline, plus a little for the x descender
cap = MONO_BOLD["OS/2"].sCapHeight / MONO_BOLD["head"].unitsPerEm * WM_SIZE
pad = 4
wm_h = cap + pad * 2
wm_box_w = round(wm_w + pad * 2, 2)
for variant, fg in (("dark", FG_DARK), ("light", FG_LIGHT)):
    body = f'<path fill="{fg}" transform="translate({pad} {pad + cap})" d="{wm_d}"/>'
    write(f"wordmark-{variant}.svg", svg(wm_box_w, round(wm_h, 2), body))

# ---- lockup: 44 px mark, 9 px gap ratio scaled, wordmark ----
# proportions from the app header: 22 px mark beside a 16 px wordmark, 9 px gap
LM = 44           # mark size
LW = 32           # wordmark size
LG = 18           # gap
ld, lw = text_path(MONO_BOLD, "1ctx", LW, 0, 0, -0.02)
lcap = MONO_BOLD["OS/2"].sCapHeight / MONO_BOLD["head"].unitsPerEm * LW
W = LM + LG + lw + 2 * pad
H = LM + 2 * pad
for variant, fg, acc in (("dark", FG_DARK, AMBER), ("light", FG_LIGHT, AMBER_LIGHT)):
    ty = pad + LM / 2 + lcap / 2  # centre the caps on the mark
    body = mark(pad, pad, LM / 24, fg, acc) + f'<path fill="{fg}" transform="translate({pad + LM + LG} {ty})" d="{ld}"/>'
    write(f"lockup-{variant}.svg", svg(round(W, 2), round(H, 2), body))

# ---- README header: stacked, with the tagline ----
RW, RH = 640, 220
for variant, fg, acc, dim, bg in (
    ("dark", FG_DARK, AMBER, DIM_DARK, None),
    ("light", FG_LIGHT, AMBER_LIGHT, DIM_LIGHT, None),
):
    ms = 56
    wd, ww = text_path(MONO_BOLD, "1ctx", 40, 0, 0, -0.02)
    td, tw = text_path(PLEX, "One continuous context for agents", 17, 0, 0)
    top = 32
    body = mark((RW - ms) / 2, top, ms / 24, fg, acc)
    body += f'<path fill="{fg}" transform="translate({(RW - ww) / 2} {top + ms + 20 + 29})" d="{wd}"/>'
    body += f'<path fill="{dim}" transform="translate({(RW - tw) / 2} {top + ms + 20 + 29 + 34})" d="{td}"/>'
    write(f"readme-{variant}.svg", svg(RW, RH, body, bg))

# ---- app icon 512, an SVG source for the raster ----
SW, SH = 1280, 640
# app icon: dark tile, the mark at 70%
IS = 512
inner = IS * 0.7
body = f'<rect width="{IS}" height="{IS}" rx="{IS * 0.2}" fill="{BG_DARK}"/>'
body += mark((IS - inner) / 2, (IS - inner) / 2, inner / 24, FG_DARK, AMBER, sw=1.6)
write("icon.svg", svg(IS, IS, body))


# ---- social preview 1280x640: the wordmark inside a wide chip, one 1 ----
def chip_wide(w, h, s):
    """A chip w by h with the mark's open top-right corner, in a 24-unit
    scale s (the mark's own geometry at h == 24 s)."""
    r = 4.68 * s          # the mark's corner radius
    gx = 6.5 * s          # the opening along the top edge, from the right
    gy = 6.5 * s          # the opening down the right edge, from the top
    return (
        f"M{w - gx} 0H{r}A{r} {r} 0 0 0 0 {r}V{h - r}A{r} {r} 0 0 0 {r} {h}"
        f"H{w - r}A{r} {r} 0 0 0 {w} {h - r}V{gy}"
    )

# Everything in the mark's 24-unit terms, so the wide chip keeps the
# mark's proportions: the 1 is 8.75 units tall in a chip whose stroke is
# 1.5, the sparkle sits on the corner and pokes SPARK_R - 0.5 units past
# the top and the right edge.
s = 10
CH = 18 * s                  # shorter than the mark: the word needs less headroom than the 1
bcap_units = 8.75
capr = MONO_BOLD["OS/2"].sCapHeight / MONO_BOLD["head"].unitsPerEm
fs = bcap_units * s / capr
bd, bw = text_path(MONO_BOLD, "1ctx", fs, 0, 0, -0.02)
bcap = capr * fs
side = 5 * s                 # air left and right of the text, inside the chip
CW = bw + 2 * side
sw = 1.5 * s
cx0 = (SW - CW) / 2
cy0 = 150
body = f'<g transform="translate({cx0} {cy0})" fill="none" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">'
body += f'<path stroke="{FG_DARK}" d="{chip_wide(CW, CH, s)}"/>'
# the mark's chip has its top edge at y=4 and right edge at x=20; the sparkle is drawn in those coordinates
body += f'<path fill="{AMBER}" stroke="none" transform="translate({CW - 19.5 * s} {-4.5 * s}) scale({s})" d="{SPARK}"/>'
body += "</g>"
body += f'<path fill="{FG_DARK}" transform="translate({cx0 + side} {cy0 + CH / 2 + bcap / 2})" d="{bd}"/>'
td, tw = text_path(PLEX, "One continuous context for agents", 34, 0, 0)
body += f'<path fill="{DIM_DARK}" transform="translate({(SW - tw) / 2} {cy0 + CH + 100})" d="{td}"/>'
write("social-preview.svg", svg(SW, SH, body, BG_DARK))

# ---- logo: the boxed wordmark on its own, transparent, tight box ----
# same geometry as the social preview, at s = 4 (a 96 px chip)
s = 4
CH = 18 * s                  # shorter than the mark: the word needs less headroom than the 1
fs = bcap_units * s / capr
bd, bw = text_path(MONO_BOLD, "1ctx", fs, 0, 0, -0.02)
bcap = capr * fs
side = 5 * s
CW = bw + 2 * side
sw = 1.5 * s
# the sparkle reaches SPARK_R - 0.5 units past the top and the right edge, plus half a stroke
poke = (SPARK_R - 0.5) * s
ox, oy = sw / 2, poke + sw / 2
LW_, LH_ = CW + ox + poke + sw / 2, CH + oy + sw / 2
def logo_body(fg, acc):
    b = f'<g transform="translate({ox} {oy})" fill="none" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">'
    b += f'<path stroke="{fg}" d="{chip_wide(CW, CH, s)}"/>'
    b += f'<path fill="{acc}" stroke="none" transform="translate({CW - 19.5 * s} {-4.5 * s}) scale({s})" d="{SPARK}"/>'
    b += "</g>"
    b += f'<path fill="{fg}" transform="translate({ox + side} {oy + CH / 2 + bcap / 2})" d="{bd}"/>'
    return b
write("logo.svg", svg(round(LW_, 2), round(LH_, 2), logo_body("currentColor", AMBER)))
write("logo-dark.svg", svg(round(LW_, 2), round(LH_, 2), logo_body(FG_DARK, AMBER)))
write("logo-light.svg", svg(round(LW_, 2), round(LH_, 2), logo_body(FG_LIGHT, AMBER_LIGHT)))
