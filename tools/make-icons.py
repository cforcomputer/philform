#!/usr/bin/env python3
"""Draw Phil, Philform's mascot, as PNG icons and as SVG for the pages.

Phil is a soft white cube with a kawaii cat face (round eyes, a "ω" mouth,
pink cheeks), small round bear ears, between them a little angler-fish lure
whose glowing bulb is a green check (a form, filled), and two stubby feet
in front. Flat colours inside a charcoal outline, so
it stays readable at 16 px.

In the toolbar Phil stands on a bright green rounded tile, like Honey's
orange one, so the icon stands out among grey ones; the pages draw Phil
without it. The 128 px icon keeps Chrome's store margin (a 96 px tile).

One drawing feeds both outputs. Each shape is a signed distance function
for the PNGs (sampled finely only where an edge crosses a pixel) and an SVG
element for the popup and the settings page, which import src/common/phil.js:

    python3 tools/make-icons.py                # icons/icon{16,32,48,128}.png and src/common/phil.js
    python3 tools/make-icons.py --preview DIR  # also DIR/phil-256.png and enlarged small sizes
"""
import math, os, struct, sys, zlib

SIZES = [16, 32, 48, 128]
ROOT = os.path.join(os.path.dirname(__file__), '..')

INK = (37, 40, 47)          # sumi ink: the outline and the face
WHITE = (255, 255, 255)
FRONT = (255, 251, 245)     # washi white
TOP = (255, 255, 255)
SIDE = (225, 231, 236)      # the shaded side, cool grey
EAR_IN = (255, 160, 186)    # sakura
GLOW = (6, 199, 85, .3)     # round the angler's bulb
BLUSH = (255, 182, 198)
CHECK = (6, 199, 85)        # LINE-style green: the angler's bulb, and done
CHECK_RIM = (4, 162, 70)

TILE = (6, 199, 85)         # the toolbar tile, LINE-style green
TILE_GLOW = (255, 255, 255, .5)  # on the tile the lure turns white with a dark green check,
TILE_TICK = (4, 135, 59)         # since a green bulb vanishes on green
LINE = 4.0                  # outline width on the 100-unit grid
VIEW_X, VIEW = -2, 104      # the square drawn: room below the cube for the feet


def hexc(c):
    return '#%02x%02x%02x' % c[:3]


def extra(shape, paint='fill'):
    """SVG attributes for a shape's opacity and class, if it has them."""
    out = f' {paint}-opacity="{shape.color[3]}"' if len(shape.color) > 3 else ''
    return out + (f' class="{shape.cls}"' if getattr(shape, 'cls', None) else '')


# --- geometry -----------------------------------------------------------------

def seg_dist(p, a, b):
    px, py, dx, dy = p[0] - a[0], p[1] - a[1], b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, (px * dx + py * dy) / ((dx * dx + dy * dy) or 1)))
    return math.hypot(px - dx * t, py - dy * t)


def inside(p, poly):
    x, y = p
    hit = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def inset(poly, d):
    """A convex polygon with every edge moved d inwards."""
    cx = sum(x for x, _ in poly) / len(poly)
    cy = sum(y for _, y in poly) / len(poly)
    lines = []
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        nx, ny = y2 - y1, x1 - x2
        n = math.hypot(nx, ny)
        nx, ny = nx / n, ny / n
        if (cx - x1) * nx + (cy - y1) * ny < 0:
            nx, ny = -nx, -ny
        lines.append(((x1 + nx * d, y1 + ny * d), (x2 - x1, y2 - y1)))
    out = []
    for (p, u), (q, v) in zip(lines[-1:] + lines[:-1], lines):
        det = u[0] * v[1] - u[1] * v[0]
        t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / det
        out.append((p[0] + u[0] * t, p[1] + u[1] * t))
    return out


def arc(cx, cy, r, a0, a1, n=10):
    """Points along a circle, angles in degrees, y down."""
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def f(v):
    return ('%.1f' % v).rstrip('0').rstrip('.')


def path(pts, close=True):
    return 'M' + 'L'.join(f'{f(x)} {f(y)}' for x, y in pts) + ('Z' if close else '')


class Poly:
    """A convex polygon with corners rounded by r, grown outwards by grow."""
    def __init__(self, pts, color, r=0.0, grow=0.0, min_size=0):
        self.inner, self.r, self.grow, self.color, self.min_size = inset(pts, r) if r else pts, r, grow, color, min_size
        xs, ys = [x for x, _ in pts], [y for _, y in pts]
        self.box = (min(xs) - grow, min(ys) - grow, max(xs) + grow, max(ys) + grow)

    def sdf(self, p):
        d = min(seg_dist(p, a, b) for a, b in zip(self.inner, self.inner[1:] + self.inner[:1]))
        return (-d if inside(p, self.inner) else d) - self.r - self.grow

    def svg(self):
        w = 2 * (self.r + self.grow)
        stroke = f' stroke="{hexc(self.color)}" stroke-width="{f(w)}" stroke-linejoin="round"' if w else ''
        return f'<path d="{path(self.inner)}" fill="{hexc(self.color)}"{stroke}{extra(self)}/>'


class Ellipse:
    def __init__(self, cx, cy, rx, ry, color, grow=0.0, min_size=0):
        self.c, self.rx, self.ry, self.color, self.grow, self.min_size = (cx, cy), rx + grow, ry + grow, color, grow, min_size
        self.box = (cx - self.rx, cy - self.ry, cx + self.rx, cy + self.ry)

    def sdf(self, p):
        k = math.hypot((p[0] - self.c[0]) / self.rx, (p[1] - self.c[1]) / self.ry)
        return (k - 1) * min(self.rx, self.ry)

    def svg(self):
        return f'<ellipse cx="{f(self.c[0])}" cy="{f(self.c[1])}" rx="{f(self.rx)}" ry="{f(self.ry)}" fill="{hexc(self.color)}"{extra(self)}/>'


class Stroke:
    """A polyline w wide, with round ends or, with butt, square ones."""
    def __init__(self, pts, w, color, min_size=0, butt=False):
        self.pts, self.w, self.color, self.min_size, self.butt = pts, w, color, min_size, butt
        xs, ys = [x for x, _ in pts], [y for _, y in pts]
        self.box = (min(xs) - w, min(ys) - w, max(xs) + w, max(ys) + w)

    def sdf(self, p):
        d = min(seg_dist(p, a, b) for a, b in zip(self.pts, self.pts[1:])) - self.w / 2
        if self.butt:
            # Cut off at the planes through each end, square to the line.
            for end, prev in ((self.pts[0], self.pts[1]), (self.pts[-1], self.pts[-2])):
                ux, uy = end[0] - prev[0], end[1] - prev[1]
                n = math.hypot(ux, uy)
                d = max(d, ((p[0] - end[0]) * ux + (p[1] - end[1]) * uy) / n)
        return d

    def svg(self):
        cap = 'butt' if self.butt else 'round'
        return (f'<path d="{path(self.pts, close=False)}" fill="none" stroke="{hexc(self.color)}" '
                f'stroke-width="{f(self.w)}" stroke-linecap="{cap}" stroke-linejoin="round"{extra(self, "stroke")}/>')


# --- Phil ---------------------------------------------------------------------
# An oblique cube: the front face square on, the top and right faces going
# back by DEPTH. Units are a 100 grid, y down.

DEPTH = (14, -11)
FL, FR, FT, FB = 10, 76, 38, 96                          # the front face
front = [(FL, FT), (FR, FT), (FR, FB), (FL, FB)]
back = lambda p: (p[0] + DEPTH[0], p[1] + DEPTH[1])
top = [(FL, FT), back((FL, FT)), back((FR, FT)), (FR, FT)]
side = [(FR, FT), back((FR, FT)), back((FR, FB)), (FR, FB)]
outline = [(FL, FT), back((FL, FT)), back((FR, FT)), back((FR, FB)), (FR, FB), (FL, FB)]

CX = (FL + FR) / 2                                       # the middle of the face
EYE_Y, MOUTH_Y = 62, 70
EYES = [(CX - 12.5, EYE_Y), (CX + 12.5, EYE_Y)]


def ear(c, line):
    """A small round bear ear on the head; the front face hides its lower half."""
    r = 9.5
    return [Ellipse(*c, r, r, INK, grow=line / 2), Ellipse(*c, r - line / 2, r - line / 2, WHITE),
            Ellipse(c[0], c[1] + 2, r * .5, r * .5, EAR_IN, min_size=32)]


def bezier(a, c, b, n=16):
    return [((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
             (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]) for t in (i / n for i in range(n + 1))]


LURE_C, LURE_R = (60, 11.5), 7


def angler(line):
    """A stalk from the middle of the head, between the ears, arching over to
    a glowing bulb that is a green check."""
    stalk = bezier((50, 30), (44, 4), (LURE_C[0] - 2, LURE_C[1] - LURE_R + .5))
    glow = Ellipse(*LURE_C, 12.5, 12.5, GLOW, min_size=32)
    glow.cls = 'phil-glow'
    stem = Stroke(stalk, max(2.8, line * .75), INK)
    stem.cls = 'phil-stalk'         # the pages lighten it in dark mode
    x, y = LURE_C
    bulb = [Ellipse(x, y, LURE_R, LURE_R, INK, grow=line / 2), Ellipse(x, y, LURE_R, LURE_R, CHECK_RIM),
            Ellipse(x, y, LURE_R - 1.5, LURE_R - 1.5, CHECK),
            Stroke([(x - 3.4, y + .3), (x - .9, y + 2.7), (x + 3.6, y - 2.6)], max(2.5, line * .6), WHITE)]
    bulb[1].cls, bulb[2].cls, bulb[3].cls = 'phil-bulb', 'phil-bulb', 'phil-tick'
    shapes = [glow, stem] + bulb
    # At 16 px it is a smudge on the tile: the smallest icon goes without.
    for sh in shapes:
        sh.min_size = max(sh.min_size, 32)
    return shapes


def body(line=LINE):
    """Everything but the eyes, back to front."""
    g = line / 2
    shapes = [Poly(outline, INK, r=10, grow=g)]
    # The faces sit inside the outline with an ink seam between them.
    shapes += [Poly(side, SIDE, r=4, grow=-g), Poly(top, TOP, r=4, grow=-g)]
    # The ears sit on the head either side of the angler's stalk, their lower
    # half behind the front face, which gets its seam drawn again over them.
    shapes += ear((31, 31), line) + ear((63, 31), line)
    shapes += [Poly(front, INK, r=9, grow=g), Poly(front, FRONT, r=9, grow=-g)]
    shapes += angler(line)
    shapes += [Ellipse(CX - 22, MOUTH_Y, 5.5, 3.2, BLUSH, min_size=32), Ellipse(CX + 22, MOUTH_Y, 5.5, 3.2, BLUSH, min_size=32)]
    # "ω", a cat's sideways 3: two small cups drawn left to right in one line
    # (the first one drawn right to left made the line double back over it).
    shapes += [Stroke(arc(CX - 3, MOUTH_Y - 1, 3, 180, 0) + arc(CX + 3, MOUTH_Y - 1, 3, 180, 0)[1:], 2.4, INK, min_size=32)]
    return shapes


def feet(line=LINE):
    """Two stubby feet in front, one list of shapes per foot (left, right)."""
    g = line / 2
    return [[Ellipse(x, FB + 1.5, 7.5, 4.8, INK, grow=g), Ellipse(x, FB + 1.5, 7.5 - g, 4.8 - g, FRONT)]
            for x in (CX - 21, CX + 21)]


def eyes(size=128):
    shapes = []
    for x, y in EYES:
        shapes += [Ellipse(x, y, 4.7, 5.8, INK)]
        shapes += [Ellipse(x - 1.4, y - 2.1, 1.7, 1.7, WHITE, min_size=48)]
    return shapes


def happy_eyes():
    """Closed in a smile: smooth arcs, not pointed "^ ^", which read as a frown."""
    return [Stroke(arc(x, y + 2.2, 4.6, 200, 340, 14), 3.0, INK) for x, y in EYES]


# --- PNG ------------------------------------------------------------------------

def render(size, tile=True):
    """Phil as pixels: on the green tile for the toolbar, or alone."""
    # Where the tile sits in the icon (0..100), and Phil inside it.
    edge = 12.5 if tile and size >= 128 else 0      # Chrome's store margin
    inner = 100 - 2 * edge
    pad = inner * .07 if tile else 0
    k = (inner - 2 * pad) / VIEW                    # icon units per Phil unit
    icon_unit = 100 / size                          # icon units per pixel
    phil_unit = icon_unit / k
    # Lines must stay a pixel wide or more to read in a toolbar.
    line = max(LINE, 1.06 * phil_unit)
    shapes = [s for s in body(line) + eyes(size) if size >= s.min_size]
    if size < 32:
        # At 16 px the eyes are what makes it a face; make them a full pixel.
        shapes = [s for s in shapes if not (isinstance(s, Ellipse) and s.color == INK and s.c in EYES)]
        shapes += [Ellipse(x, y, 5.8, 6.8, INK) for x, y in EYES]
    shapes += sum(feet(line), [])
    if tile:
        for sh in shapes:
            cls = getattr(sh, 'cls', None)
            if cls in ('phil-glow', 'phil-bulb', 'phil-tick'):
                sh.color = {'phil-glow': TILE_GLOW, 'phil-bulb': WHITE, 'phil-tick': TILE_TICK}[cls]
    plate = Poly([(edge, edge), (100 - edge, edge), (100 - edge, 100 - edge), (edge, 100 - edge)], TILE, r=inner * .22) if tile else None

    def to_phil(q):
        return ((q[0] - edge - pad) / k + VIEW_X, (q[1] - edge - pad) / k)

    def color_at(q):
        """(r, g, b, alpha) of one sample, painting each shape over the last."""
        rgb, alpha = (0.0, 0.0, 0.0), 0.0
        if plate and plate.sdf(q) <= 0:
            rgb, alpha = tuple(float(c) for c in TILE), 1.0
        p = to_phil(q)
        for s in shapes:
            b = s.box
            if b[0] - 1 <= p[0] <= b[2] + 1 and b[1] - 1 <= p[1] <= b[3] + 1 and s.sdf(p) <= 0:
                a = s.color[3] if len(s.color) > 3 else 1.0
                out = a + alpha * (1 - a)
                rgb = tuple((c * a + r * alpha * (1 - a)) / out for c, r in zip(s.color[:3], rgb))
                alpha = out
        return rgb, alpha

    def near_edge(q):
        if plate and abs(plate.sdf(q)) < icon_unit * .75:
            return True
        p, reach = to_phil(q), phil_unit * .75
        for s in shapes:
            b = s.box
            if b[0] - reach <= p[0] <= b[2] + reach and b[1] - reach <= p[1] <= b[3] + reach and abs(s.sdf(p)) < reach:
                return True
        return False

    px = []
    for y in range(size):
        row = []
        for x in range(size):
            ss = 6 if near_edge(((x + .5) * icon_unit, (y + .5) * icon_unit)) else 1
            acc, n = [0.0, 0.0, 0.0], 0.0
            for j in range(ss):
                for i in range(ss):
                    rgb, alpha = color_at(((x + (i + .5) / ss) * icon_unit, (y + (j + .5) / ss) * icon_unit))
                    n += alpha
                    acc = [a + c * alpha for a, c in zip(acc, rgb)]
            row.append(tuple(round(a / n) for a in acc) + (round(255 * n / (ss * ss)),) if n else (0, 0, 0, 0))
        px.append(row)
    return px


def write_png(path_, px):
    h, w = len(px), len(px[0])
    raw = b''.join(b'\x00' + b''.join(struct.pack('BBBB', *px[y][x]) for x in range(w)) for y in range(h))

    def chunk(tag, data):
        body_ = tag + data
        return struct.pack('>I', len(data)) + body_ + struct.pack('>I', zlib.crc32(body_) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path_, 'wb') as fh:
        fh.write(png)


def enlarge(px, k):
    return [[c for c in row for _ in range(k)] for row in px for _ in range(k)]


# --- SVG for the pages -----------------------------------------------------------

def phil_js():
    svg = lambda shapes: ''.join(s.svg() for s in shapes)
    feet_ = ''.join(f'<g class="phil-foot phil-foot-{side_}">{svg(foot)}</g>' for side_, foot in zip('lr', feet()))
    return f'''// Phil, Philform's mascot. Drawn by tools/make-icons.py: change it there and
// rerun the script, not here.

const BODY = '{svg(body())}';
const EYES = '<g class="phil-eyes">{svg(eyes())}</g>';
const HAPPY = '<g class="phil-eyes">{svg(happy_eyes())}</g>';
const FEET = '<g class="phil-feet">{feet_}</g>';

/** Phil as SVG markup. mood "calm" or "happy"; running makes the feet run. */
export function philSvg({{ mood = 'calm', running = false }} = {{}}) {{
  return `<svg class="phil phil-${{mood}}${{running ? ' phil-running' : ''}}" viewBox="{VIEW_X} 0 {VIEW} {VIEW}" aria-hidden="true">` +
    `<g class="phil-body">${{BODY}}${{mood === 'happy' ? HAPPY : EYES}}</g>${{FEET}}</svg>`;
}}

/** Draw Phil into every element marked data-phil="calm", "happy" or "running". */
export function drawPhils(root = document) {{
  for (const el of root.querySelectorAll('[data-phil]')) {{
    const kind = el.dataset.phil;
    el.innerHTML = philSvg({{ mood: kind === 'happy' ? 'happy' : 'calm', running: kind === 'running' }});
  }}
}}
'''


if __name__ == '__main__':
    out = os.path.join(ROOT, 'icons')
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        dest = os.path.join(out, f'icon{s}.png')
        write_png(dest, render(s))
        print(f'wrote {dest}')
    js = os.path.join(ROOT, 'src', 'common', 'phil.js')
    with open(js, 'w') as fh:
        fh.write(phil_js())
    print(f'wrote {js}')
    if '--preview' in sys.argv:
        d = sys.argv[sys.argv.index('--preview') + 1]
        write_png(os.path.join(d, 'phil-256.png'), render(256, tile=False))
        write_png(os.path.join(d, 'icon-128.png'), render(128))
        for s in (16, 32):
            write_png(os.path.join(d, f'phil-{s}x8.png'), enlarge(render(s), 8))
        print(f'previews in {d}')
