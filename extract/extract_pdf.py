"""PDF -> sentence-addressed JSON (source.json without id/zotero/meta).

Usage: python extract/extract_pdf.py <pdf> <out.json> [--figures-dir <dir>]
With --figures-dir, figure/table regions are saved there as fig-<page>-<n>.png.
No stdout. On failure: Korean message on stderr, exit code 2.
"""
import json
import os
import re
import sys
from collections import Counter

import pymupdf

EXTRACTOR_VERSION = 3
SCANNED_MESSAGE = "텍스트를 추출할 수 없습니다(스캔 PDF로 보입니다). OCR된 PDF로 바꿔주세요."
MIN_CHARS_PER_PAGE = 50

HEADING_NUMBER_RE = re.compile(r"^\d+(\.\d+)*\s+[A-Z]")
# Caption only if the number is followed by "." / ":" / "|" or ends the first line
# ("Figure 2 shows ..." is a body paragraph).
CAPTION_RE = re.compile(r"^(Fig\.?|Figure|Table)\s*(\d+)\s*(?:[.:|]|$)")
# A caption line merged into a figure's text block ("... Figure 4. Revoke ...") starts a new block.
CAPTION_LINE_RE = re.compile(r"^\s*(Fig\.?|Figure|Table)\s*\d+[.:]")
CAPTION_LABEL_RE = re.compile(r"(Fig\.?|Figure|Table)\s*\d+[.:]?")
MAX_NUMBERED_HEADING_CHARS = 80
REFERENCES_RE = re.compile(r"^(\d+(\.\d+)*\.?\s*)?(References|Bibliography)\s*$", re.IGNORECASE)
SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(\[“\"])")
NO_SPLIT_AFTER = ("et al.", "e.g.", "i.e.", "Fig.", "Eq.", "Sec.", "vs.", "cf.", "No.", "approx.")
# A name initial ("J.") counts only in a name context: preceded by text start, a comma/semicolon,
# another initial or a capitalized word ("Kim J. Lee", "Smith, J. A."), or followed by another
# initial ("J. K. Rowling"). "showed X. See" therefore still splits (brief's own example).
INITIAL_RE = re.compile(r"(?:^|[,;]\s*|(?<![\w.])[A-Z][\w'’-]*\.?\s+)[A-Z]\.$")
NEXT_INITIAL_RE = re.compile(r"[A-Z]\.(?:\s|,|$)")
LINE_END_HYPHENS = ("-", "\u00ad", "\u2010")  # hyphen, soft hyphen, Unicode hyphen
HEADING_SIZE_RATIO = 1.15
COLUMN_ZONE = 0.05
MIN_BLOCKS_PER_COLUMN = 3
TEXT_FLAGS = pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP

# Figure regions (pt, unrotated page space)
MIN_CLUSTER_AREA = 600          # drawing clusters smaller than this are not graphics
MIN_FIGURE_AREA = 1500          # smaller regions mean "no figure"
MAX_CANDIDATE_PAGE_SHARE = 0.9  # page-sized backgrounds/frames are not figures
MARGIN_BAND = 0.07              # top/bottom share of the page holding running headers/footers
NARROW_CAPTION_SHARE = 0.6      # captions narrower than this share of the page width are one column
MAX_CHAIN_GAP = 24              # vertical gap that still links graphic parts (and a figure to its caption)
MAX_TABLE_CAPTION_GAP = 48      # tables often have an unruled header row between caption and first rule
FULL_WIDTH_SPILL_SHARE = 0.15   # a graphic this far past the caption's column may be full-width
BODY_MIN_CHARS = 40             # body text (vs. labels inside a figure): long and body-sized
HEADER_MAX_SHARE = 0.1          # a running header/footer block ends within this share of the page
ZONE_GAP = 4                    # header/footer rules sit this close to their text
CAPTION_ALIGN = 3               # caption lines share the left edge (or the center) within this
CAPTION_LINE_GAP = 4            # a caption continuation block starts this close below the caption
RULE_MAX_THICKNESS = 1.5        # a horizontal rule (table line) is this thin ...
RULE_MIN_LENGTH = 40            # ... and at least this long
RULE_X_TOLERANCE = 6            # rules of one table start and end at the same x
RULE_STACK_GAP = 48             # and follow each other this closely
LABEL_GAP = 4                   # small text this close to a graphic region is its label
WHITE = 0.98                    # fill components at or above this are white (invisible background)
TABLE_COVER_SHARE = 0.8         # drawing and detected table this much overlapping (of the smaller): table-like
PADDING = 4
FIGURE_DPI = 150


class ScannedPdfError(Exception):
    def __init__(self, message=SCANNED_MESSAGE):
        super().__init__(message)


def _r1(v):
    return round(float(v), 1)


def _num(v):
    """Round to 1 decimal; integral values become int (612.0 -> 612)."""
    v = _r1(v)
    return int(v) if v == int(v) else v


# ---------------------------------------------------------------- blocks


def _size_bucket(size):
    # 0.5pt buckets absorb jitter like 9.9/10.0/10.1 in the same body font.
    return round(size * 2) / 2


def _split_caption_lines(block):
    """Split a text block before any non-first line that starts like a caption."""
    parts, cur = [], []
    for line in block["lines"]:
        text = "".join(span["text"] if "text" in span else "".join(c["c"] for c in span["chars"])
                       for span in line["spans"])
        if cur and CAPTION_LINE_RE.match(text):
            parts.append(cur)
            cur = []
        cur.append(line)
    parts.append(cur)
    if len(parts) == 1:
        return [block]
    out = []
    for lines in parts:
        x0 = min(l["bbox"][0] for l in lines)
        y0 = min(l["bbox"][1] for l in lines)
        x1 = max(l["bbox"][2] for l in lines)
        y1 = max(l["bbox"][3] for l in lines)
        out.append({**block, "lines": lines, "bbox": (x0, y0, x1, y1)})
    return out


def _block_chars(block):
    """Flatten a rawdict text block into (text, chars, sizes).

    chars[i] = (line_index, bbox or None) for text[i]; None marks inserted joins.
    Hyphenated line breaks ('-' at line end + lowercase next line) are joined.
    """
    lines = []
    for line in block["lines"]:
        chars = []
        for span in line["spans"]:
            for ch in span["chars"]:
                chars.append((ch["c"], tuple(ch["bbox"]), span["size"]))
        if any(not c.isspace() for c, _, _ in chars):
            lines.append(chars)

    text, cmap, sizes = [], [], Counter()

    def emit(c, li, bbox):
        if c.isspace():
            if not text or text[-1] == " ":
                return
            text.append(" ")
            cmap.append((li, None))
            return
        text.append(c)
        cmap.append((li, bbox))

    for li, chars in enumerate(lines):
        # strip trailing whitespace of the line
        while chars and chars[-1][0].isspace():
            chars = chars[:-1]
        nxt = lines[li + 1] if li + 1 < len(lines) else None
        nxt_first = next((c for c, _, _ in nxt if not c.isspace()), "") if nxt else ""
        joined = bool(chars) and chars[-1][0] in LINE_END_HYPHENS and nxt_first.islower()
        body = chars[:-1] if joined else chars
        for c, bbox, size in body:
            emit(c, li, bbox)
            if not c.isspace():
                sizes[_size_bucket(size)] += 1
        if nxt is not None and not joined:
            emit(" ", li, None)
    while text and text[-1] == " ":
        text.pop()
        cmap.pop()
    return "".join(text), cmap, sizes


def _order_blocks(blocks, width):
    """Reading order. blocks: dicts with 'bbox'. Two-column rule per brief."""
    center = width / 2
    margin = width * COLUMN_ZONE

    def crosses(b):
        x0, _, x1, _ = b["bbox"]
        return x0 < center - margin and x1 > center + margin

    crossing = [b for b in blocks if crosses(b)]
    others = [b for b in blocks if not crosses(b)]
    left = [b for b in others if (b["bbox"][0] + b["bbox"][2]) / 2 < center]
    right = [b for b in others if (b["bbox"][0] + b["bbox"][2]) / 2 >= center]

    def yx(b):
        return (b["bbox"][1], b["bbox"][0])

    if len(left) < MIN_BLOCKS_PER_COLUMN or len(right) < MIN_BLOCKS_PER_COLUMN:
        return sorted(blocks, key=yx)

    crossing.sort(key=yx)
    cuts = [b["bbox"][1] for b in crossing]

    def band(b):
        return sum(1 for y in cuts if y <= b["bbox"][1])

    ordered = []
    for k in range(len(crossing) + 1):
        ordered += sorted((b for b in left if band(b) == k), key=yx)
        ordered += sorted((b for b in right if band(b) == k), key=yx)
        if k < len(crossing):
            ordered.append(crossing[k])
    return ordered


# ------------------------------------------------------------- sentences


def _no_split_at(prefix, suffix):
    if CAPTION_LABEL_RE.fullmatch(prefix):  # "Figure 1. Overview ..." keeps its label
        return True
    if any(prefix.endswith(a) and (len(prefix) == len(a) or not prefix[-len(a) - 1].isalnum())
           for a in NO_SPLIT_AFTER):
        return True
    if not re.search(r"(?<![\w.])[A-Z]\.$", prefix):
        return False
    return bool(INITIAL_RE.search(prefix) or NEXT_INITIAL_RE.match(suffix))


def split_sentences(text):
    """Return [(start, end)] character ranges of sentences in text."""
    ranges, start = [], 0
    for m in SPLIT_RE.finditer(text):
        if _no_split_at(text[:m.start()], text[m.end():]):
            continue
        ranges.append((start, m.start()))
        start = m.end()
    ranges.append((start, len(text)))
    out = []
    for s, e in ranges:
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        if s < e:
            out.append((s, e))
    return out


def _rects(cmap, start, end, page_w, page_h):
    by_line = {}
    for li, bbox in cmap[start:end]:
        if bbox is None:
            continue
        x0, y0, x1, y1 = bbox
        if li in by_line:
            a = by_line[li]
            by_line[li] = [min(a[0], x0), min(a[1], y0), max(a[2], x1), max(a[3], y1)]
        else:
            by_line[li] = [x0, y0, x1, y1]
    rects = []
    for li in sorted(by_line):
        x0, y0, x1, y1 = by_line[li]
        r = [_r1(max(0.0, x0)), _r1(max(0.0, y0)), _r1(min(page_w, x1)), _r1(min(page_h, y1))]
        if r[0] < r[2] and r[1] < r[3]:
            rects.append(r)
    return rects


def _to_pdf_matrix(page):
    """Matrix from text-extraction coords to PDF user space.

    PyMuPDF text bboxes are y-down, relative to the cropbox's top-left, and NOT rotated
    (verified on 2.1), whereas page.transformation_matrix / rotation_matrix describe the
    rotated display, so they are not usable here. Mediabox is assumed to start at (0, 0).
    """
    cb = page.cropbox_position
    return pymupdf.Matrix(1, 0, 0, -1, cb.x, page.mediabox.height - cb.y)


def _pdf_rects(rects, to_pdf):
    """Screen rects -> PDF user space (bottom-left origin, unrotated page, mediabox coords)."""
    out = []
    for r in rects:
        q = (pymupdf.Rect(r) * to_pdf).normalize()
        out.append([_r1(q.x0), _r1(q.y0), _r1(q.x1), _r1(q.y1)])
    return out


# --------------------------------------------------------------- figures
#
# All figure geometry is in the UNROTATED page space, like text bboxes (drawings, images and
# tables come back from PyMuPDF in that same space, verified on 2.1 for 0/90/270 and cropboxes).
# Rendering maps the region through page.rotation_matrix, so a rotated page gets an image as it
# is displayed.
#
# Per page: every caption picks a side (tables below first, figures above first) and "seeds" with
# the graphics right next to it; a graphic seeds only its nearest caption. Seeds grow by chaining
# nearby graphics in the caption's column; other captions, their seeds and body text are barriers.


def _area(r):
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def _h_overlap(a, b):
    return min(a[2], b[2]) - max(a[0], b[0])


def _v_overlap(a, b):
    return min(a[3], b[3]) - max(a[1], b[1])


def _intersects(a, b):
    return _h_overlap(a, b) > 0 and _v_overlap(a, b) > 0


def _inside(inner, outer, tol=1.0):
    return (inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol
            and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol)


def _union(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def _page_zones(blocks, h):
    """(top, bottom): graphics and regions stay between the running header and footer text."""
    top, bottom = h * MARGIN_BAND, h * (1 - MARGIN_BAND)
    for b in blocks:
        _, y0, _, y1 = b["bbox"]
        if y0 < h * MARGIN_BAND and y1 <= h * HEADER_MAX_SHARE:
            top = max(top, y1 + ZONE_GAP)          # the header's rule usually sits just below it
        if y1 > h * (1 - MARGIN_BAND) and y0 >= h * (1 - HEADER_MAX_SHARE):
            bottom = min(bottom, y0 - ZONE_GAP)
    return top, bottom


def _visible(d):
    """Invisible white-filled boxes (figure backgrounds, often far larger than the figure) are skipped."""
    kind = d.get("type") or ""
    stroked = "s" in kind and d.get("color") is not None
    fill = d.get("fill")
    filled = "f" in kind and fill is not None and not all(c >= WHITE for c in fill)
    return stroked or filled


def _candidates(page, w, h, top, bottom, with_tables, captions=()):
    """Graphic element bboxes: images, clusters of visible drawings (area >= MIN_CLUSTER_AREA), tables.

    Returns (figure_like, table_like): find_tables() boxes and the clusters/images that mostly
    overlap one are table-like, everything else figure-like."""
    page_area = w * h

    def usable(r):
        r = (max(0.0, r[0]), max(top, r[1]), min(w, r[2]), min(bottom, r[3]))
        if r[0] > r[2] or r[1] > r[3]:  # zero-thickness rules are fine, off-page/header-only is not
            return None
        if _area(r) > page_area * MAX_CANDIDATE_PAGE_SHARE:
            return None
        return r

    out = []  # images and drawing clusters
    for info in page.get_image_info():
        r = usable(tuple(info["bbox"]))
        if r and _area(r) > 0:
            out.append(r)
    drawings = [d for d in page.get_drawings() if _visible(d) and usable(tuple(d["rect"])) is not None]
    if drawings:
        for c in page.cluster_drawings(drawings=drawings):
            r = usable(tuple(c))
            if r and _area(r) >= MIN_CLUSTER_AREA:
                out.append(r)
    tables = []
    if with_tables:
        try:
            found = page.find_tables().tables
        except Exception:  # noqa: BLE001 - table detection is best effort
            found = []
        tables = [r for r in (usable(tuple(t.bbox)) for t in found) if r and _area(r) > 0]

    def in_table(r):
        # find_tables() boxes may be tighter than the ruled grid, so "mostly inside" works both ways
        a = _area(r)
        return any(min(a, _area(t)) > 0 and _area((max(r[0], t[0]), max(r[1], t[1]),
                                                   min(r[2], t[2]), min(r[3], t[3])))
                   >= min(a, _area(t)) * TABLE_COVER_SHARE for t in tables)

    figure_like = [r for r in out if not in_table(r)]
    table_like = tables + [r for r in out if in_table(r)] + _rule_stacks(drawings, captions)
    return figure_like, table_like


def _rule_stacks(drawings, captions=()):
    """Booktabs-style tables: two or more horizontal rules with the same x-extent stacked closely
    (with no caption between them). find_tables() misses them when there are only three rules and
    no vertical lines."""
    rules = sorted((tuple(d["rect"]) for d in drawings
                    if d["rect"].height <= RULE_MAX_THICKNESS and d["rect"].width >= RULE_MIN_LENGTH),
                   key=lambda r: r[1])
    stacks = []  # [x0, y0, x1, y1, count]
    for r in rules:
        for st in stacks:
            if (abs(r[0] - st[0]) <= RULE_X_TOLERANCE and abs(r[2] - st[2]) <= RULE_X_TOLERANCE
                    and 0 <= r[1] - st[3] <= RULE_STACK_GAP
                    and not any(_intersects(c, (st[0], st[3], st[2], r[1])) for c in captions)):
                st[0], st[2], st[3], st[4] = min(st[0], r[0]), max(st[2], r[2]), r[3], st[4] + 1
                break
        else:
            stacks.append([r[0], r[1], r[2], r[3], 1])
    return [tuple(st[:4]) for st in stacks if st[4] >= 2]


def _is_body_text(blk, body_size):
    """Running text (not a label inside a figure): a body-sized heading or a long body-sized paragraph."""
    if blk["size"] < body_size - 0.5:
        return False
    return blk["btype"] == "heading" or (blk["btype"] == "paragraph" and len(blk["text"]) >= BODY_MIN_CHARS)


def _line_boxes(cmap):
    by_line = {}
    for li, bbox in cmap:
        if bbox is not None:
            by_line[li] = bbox if li not in by_line else _union(by_line[li], bbox)
    return [tuple(by_line[li]) for li in sorted(by_line)]


def _caption_extent(cap, blocks):
    """Bbox of the caption's lines, including continuation lines MuPDF put into following blocks,
    but not sub-figure labels ("(a) Detection Task") it merged in: a caption line starts at the
    caption's left edge or is centered under it, and follows the previous line closely."""
    lines = list(cap["lines"])
    i = next(k for k, b in enumerate(blocks) if b is cap)
    for b in blocks[i + 1:]:
        if b["btype"] != "paragraph" or abs(b["size"] - cap["size"]) > 0.5:
            break
        lines += b["lines"]
    bb = lines[0]
    for ln in lines[1:]:
        aligned = (abs(ln[0] - bb[0]) <= CAPTION_ALIGN
                   or abs((ln[0] + ln[2]) / 2 - (bb[0] + bb[2]) / 2) <= CAPTION_ALIGN)
        if not aligned or ln[1] - bb[3] > CAPTION_LINE_GAP or ln[1] < bb[1]:
            break
        bb = _union(bb, ln)
    return bb


def _clip_to_side(c, cb, direction, col):
    """Candidate c cut to the column band and to the caption's side, or None if it has no part there."""
    if _h_overlap(c, (col[0], 0, col[1], 0)) <= 0:
        return None
    if direction == "up" and c[1] < cb[1]:
        return (max(c[0], col[0]), c[1], min(c[2], col[1]), min(c[3], cb[1]))
    if direction == "down" and c[3] > cb[3]:
        return (max(c[0], col[0]), max(c[1], cb[3]), min(c[2], col[1]), c[3])
    return None


def _caption_gap(c, cb, direction):
    return cb[1] - c[3] if direction == "up" else c[1] - cb[3]


def _caption_strip(c, cb, direction):
    """The area between the caption and a graphic on its side."""
    return (c[0], c[3], c[2], cb[1]) if direction == "up" else (c[0], cb[3], c[2], c[1])


def _keeps_full_width(cap, cb, direction, col, seeds, blocks, caption_boxes, w, first_gap):
    """Narrow caption next to a full-width graphic: true when a seed graphic spills well past the
    caption's column, every text block of the other column beside it lies inside that graphic and
    no other caption sits in the other column next to it."""
    half = w / 2
    other = (half, w) if col[0] == 0 else (0.0, half)
    for c in seeds:
        spill = c[2] - col[1] if col[0] == 0 else col[0] - c[0]
        if spill < w * FULL_WIDTH_SPILL_SHARE:
            continue
        reach = (c[0], c[1] - first_gap, c[2], c[3] + first_gap)

        def in_other(r):
            return other[0] <= (r[0] + r[2]) / 2 <= other[1]

        crowded = any(b is not cap and in_other(b["bbox"]) and _v_overlap(b["bbox"], c) > 0
                      and not _inside(b["bbox"], c, 2) for b in blocks)
        crowded = crowded or any(r != cb and in_other(r) and _v_overlap(r, reach) > 0 for r in caption_boxes)
        if not crowded:
            return True
    return False


def _plan(cap, cb, is_table, figure_like, table_like, blocks, caption_boxes, body, w):
    """Choose column band, side and seed graphics for one caption. Returns a dict or None."""
    half = w / 2
    narrow = cb[2] - cb[0] < w * NARROW_CAPTION_SHARE
    col = ((0.0, half) if (cb[0] + cb[2]) / 2 < half else (half, w)) if narrow else (0.0, w)
    first_gap = MAX_TABLE_CAPTION_GAP if is_table else MAX_CHAIN_GAP
    order = ("down", "up") if is_table else ("up", "down")
    own = table_like if is_table else figure_like

    def seeds_for(pool, direction, band):
        out = []
        for c in pool:
            side = _clip_to_side(c, cb, direction, band)
            if side is None:
                continue
            g = _caption_gap(side, cb, direction)
            if g > first_gap:
                continue
            if g > 0 and any(_intersects(_caption_strip(side, cb, direction), b["bbox"]) for b in body):
                continue
            out.append((c, side, g))
        return out

    # Own kind first, so a table right above a figure (or below a table caption) is not merged in.
    for pool in (own, figure_like + table_like):
        for direction in order:
            seeds = seeds_for(pool, direction, col)
            if seeds:
                if narrow and _keeps_full_width(cap, cb, direction, col, [c for c, _, _ in seeds], blocks,
                                                caption_boxes, w, first_gap):
                    col = (0.0, w)
                    seeds = seeds_for(pool, direction, col)
                return {"cb": cb, "col": col, "narrow": col != (0.0, w), "direction": direction,
                        "pool": pool, "seeds": seeds}
    return None


def _grow(plan, barriers, taken, body):
    cb, col, direction = plan["cb"], plan["col"], plan["direction"]
    region = None
    for _, side, _ in plan["seeds"]:
        region = side if region is None else _union(region, side)
    used = {c for c, _, _ in plan["seeds"]}
    grown = True
    while grown:
        grown = False
        for c in plan["pool"]:
            if c in used:
                continue
            side = _clip_to_side(c, cb, direction, col)
            if side is None or side in taken:
                continue
            if max(side[1] - region[3], region[1] - side[3]) > MAX_CHAIN_GAP:
                continue
            merged = _union(region, side)
            if any(_intersects(merged, r) for r in barriers) or any(_intersects(merged, b["bbox"]) for b in body):
                continue
            region, grown = merged, True
            used.add(c)
    return region


def _add_labels(region, plan, cap, blocks, caption_boxes, body, top, bottom):
    """Grow the region over small text touching it (axis labels, legends) on the caption's side."""
    cb, col, direction = plan["cb"], plan["col"], plan["direction"]
    body_ids = {id(b) for b in body}
    others = [r for r in caption_boxes if r != cb]
    grown = True
    while grown:
        grown = False
        for b in blocks:
            bb = b["bbox"]
            if (b is cap or b["btype"] == "caption" or id(b) in body_ids or _inside(bb, region)
                    or not (col[0] <= (bb[0] + bb[2]) / 2 <= col[1])
                    or bb[1] < top or bb[3] > bottom
                    or (direction == "up" and (bb[1] + bb[3]) / 2 > cb[1])
                    or (direction == "down" and (bb[1] + bb[3]) / 2 < cb[3])):
                continue
            near = (region[0] - LABEL_GAP, region[1] - LABEL_GAP, region[2] + LABEL_GAP, region[3] + LABEL_GAP)
            if not _intersects(bb, near):
                continue
            merged = _union(region, bb)
            if any(_intersects(merged, r) for r in others):
                continue
            region, grown = merged, True
    return region


def _finish(region, plan, cap, blocks, caption_boxes, body, top, bottom, w, h):
    """Padding, then clip to the caption edge, the column, header/footer, other captions and text."""
    cb, col, direction = plan["cb"], plan["col"], plan["direction"]
    x0, y0, x1, y1 = (max(0.0, region[0] - PADDING), max(0.0, region[1] - PADDING),
                      min(w, region[2] + PADDING), min(h, region[3] + PADDING))
    if plan["narrow"]:
        x0, x1 = max(x0, col[0]), min(x1, col[1])
    # whatever lies between the graphic and its caption (axis labels, a header row) belongs to it
    if direction == "up":
        y1 = cb[1]
    else:
        y0 = cb[3]
    y0, y1 = max(y0, top), min(y1, bottom)
    region = (x0, y0, x1, y1)
    region = _add_labels(region, plan, cap, blocks, caption_boxes, body, top, bottom)
    if direction == "up":    # labels may not pull the region across the caption
        region = (region[0], region[1], region[2], min(region[3], cb[1]))
    else:
        region = (region[0], max(region[1], cb[3]), region[2], region[3])
    own_center = (cb[1] + cb[3]) / 2
    for r in caption_boxes:
        if r == cb or not _intersects(r, region):
            continue
        if (r[1] + r[3]) / 2 < own_center:
            region = (region[0], max(region[1], r[3]), region[2], region[3])
        else:
            region = (region[0], region[1], region[2], min(region[3], r[1]))
    body_ids = {id(b) for b in body}
    for b in blocks:
        bb = b["bbox"]
        if b is cap or not _intersects(bb, region) or _inside(bb, region):
            continue
        cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        outside_col = not (col[0] <= cx <= col[1])
        is_body = id(b) in body_ids
        if outside_col or (is_body and not (region[0] <= cx <= region[2])):
            if cx < (region[0] + region[2]) / 2:
                region = (max(region[0], bb[2] + 1), region[1], region[2], region[3])
            else:
                region = (region[0], region[1], min(region[2], bb[0] - 1), region[3])
        elif is_body:
            if cy < (region[1] + region[3]) / 2:
                region = (region[0], max(region[1], bb[3] + 1), region[2], region[3])
            else:
                region = (region[0], region[1], region[2], min(region[3], bb[1] - 1))
    if region[0] >= region[2] or region[1] >= region[3] or _area(region) < MIN_FIGURE_AREA:
        return None
    return region


def _detect_figures(doc, figures, page_infos, body_size, figures_dir):
    by_page = {}
    for fig in figures:
        by_page.setdefault(fig["page"], []).append(fig)
    for fig in figures:
        fig.update({"bbox": None, "image": None, "blockIds": []})
    for pno, figs in by_page.items():
        try:
            _detect_page_figures(doc[pno - 1], pno, figs, page_infos[pno], body_size, figures_dir)
        except Exception as err:  # noqa: BLE001 - a figure problem must not lose the text extraction
            print(f"{pno}쪽 그림 영역을 찾지 못했습니다: {err}", file=sys.stderr)
            for fig in figs:
                fig.update({"bbox": None, "image": None, "blockIds": []})
            for b in page_infos[pno][2]:
                b["block"].pop("inFigure", None)


def _detect_page_figures(page, pno, figs, page_info, body_size, figures_dir):
    w, h, blocks = page_info
    top, bottom = _page_zones(blocks, h)
    figure_like, table_like = _candidates(page, w, h, top, bottom,
                                          any(f["label"].startswith("Table") for f in figs),
                                          [b["bbox"] for b in blocks if b["btype"] == "caption"])
    if not figure_like and not table_like:
        return
    graphics = figure_like + table_like
    # body text that is not drawn inside a graphic (e.g. table rows inside their rules)
    body = [b for b in blocks if _is_body_text(b, body_size)
            and not any(_inside(b["bbox"], c, 2) for c in graphics)]
    caps = [b for b in blocks if b["btype"] == "caption"]
    extent = {id(b): _caption_extent(b, blocks) for b in caps}
    caption_boxes = list(extent.values())
    by_sid = {b["sids"][0]: b for b in blocks}

    plans = []
    for fig in figs:
        cap = by_sid[fig["captionSentenceId"]]
        plans.append(_plan(cap, extent[id(cap)], fig["label"].startswith("Table"), figure_like, table_like,
                           blocks, caption_boxes, body, w))
    # A graphic (its part in the caption's column band) seeds only its nearest caption.
    nearest = {}
    for k, plan in enumerate(plans):
        for _, side, g in plan["seeds"] if plan else ():
            if side not in nearest or g < nearest[side][0]:
                nearest[side] = (g, k)
    for k, plan in enumerate(plans):
        if plan:
            plan["seeds"] = [sd for sd in plan["seeds"] if nearest[sd[1]][1] == k]

    for k, (fig, plan) in enumerate(zip(figs, plans)):
        if not plan or not plan["seeds"]:
            continue
        cap = by_sid[fig["captionSentenceId"]]
        taken = {side for j, p in enumerate(plans) if p and j != k for _, side, _ in p["seeds"]}
        barriers = [r for r in caption_boxes if r != plan["cb"]] + list(taken)
        region = _grow(plan, barriers, taken, body)
        region = _finish(region, plan, cap, blocks, caption_boxes, body, top, bottom, w, h)
        if region is None:
            continue
        fig["bbox"] = [_r1(v) for v in region]
        for b in blocks:
            if b["btype"] == "paragraph" and "inFigure" not in b["block"] and _inside(b["bbox"], region):
                b["block"]["inFigure"] = fig["label"]
                fig["blockIds"].append(b["block"]["id"])
        if figures_dir:
            name = f"fig-{pno}-{k + 1}.png"
            clip = pymupdf.Rect(region) * page.rotation_matrix
            page.get_pixmap(clip=clip, dpi=FIGURE_DPI).save(os.path.join(figures_dir, name))
            fig["image"] = name


# ------------------------------------------------------------------ main


def extract(pdf_path, figures_dir=None, detect_figures=True):
    """figures_dir: existing directory for fig-<page>-<n>.png (None: no files, image null).
    detect_figures=False leaves figures as label/page/captionSentenceId only (no bbox/image/blockIds)."""
    doc = pymupdf.open(pdf_path)
    try:
        return _extract(doc, figures_dir, detect_figures)
    finally:
        doc.close()


def _extract(doc, figures_dir=None, detect_figures=True):
    pages, page_blocks, size_counts = [], [], Counter()
    total_chars = 0
    for pno, page in enumerate(doc, start=1):
        w, h = page.rect.width, page.rect.height
        # text bboxes live in the unrotated page space; page.rect is swapped on 90/270 pages
        uw, uh = (h, w) if page.rotation in (90, 270) else (w, h)
        pages.append({"page": pno, "width": _num(w), "height": _num(h), "rotation": page.rotation})
        raw = page.get_text("rawdict", flags=TEXT_FLAGS)
        items = []
        raw_blocks = [part for b in raw["blocks"] if b.get("type") == 0 for part in _split_caption_lines(b)]
        for b in raw_blocks:
            text, cmap, sizes = _block_chars(b)
            if not text:
                continue
            total_chars += len(text)
            size_counts.update(sizes)
            size = sizes.most_common(1)[0][0] if sizes else 0
            first_li = cmap[0][0]
            first_len = next((i for i, (li, _) in enumerate(cmap) if li != first_li), len(text))
            first_line = text[:first_len].strip()
            items.append({"bbox": b["bbox"], "text": text, "cmap": cmap, "size": size,
                          "first_line": first_line})
        page_blocks.append((pno, uw, uh, _to_pdf_matrix(page), _order_blocks(items, uw)))

    if not pages or total_chars / len(pages) < MIN_CHARS_PER_PAGE:
        raise ScannedPdfError()

    body_size = size_counts.most_common(1)[0][0]
    blocks, sentences, figures, seen_labels = [], {}, [], set()
    in_refs = False
    page_infos = {}  # pno -> (w, h, [text block info for figure detection])
    for pno, w, h, to_pdf, items in page_blocks:
        n = 0
        infos = []
        page_infos[pno] = (w, h, infos)
        for item in items:
            text = item["text"]
            big = item["size"] >= body_size * HEADING_SIZE_RATIO - 1e-6
            cap = CAPTION_RE.match(item["first_line"])
            if REFERENCES_RE.match(text):
                btype, in_refs = "heading", True
            elif in_refs:
                btype = "heading" if big else "references"
            elif cap:
                btype = "caption"
            elif big or (HEADING_NUMBER_RE.match(text) and len(text) <= MAX_NUMBERED_HEADING_CHARS):
                btype = "heading"
            else:
                btype = "paragraph"
            bid = f"b{len(blocks) + 1}"
            sids = []
            for s, e in split_sentences(text):
                n += 1
                sid = f"p{pno}-s{n}"
                rects = _rects(item["cmap"], s, e, w, h)
                sentences[sid] = {
                    "text": text[s:e],
                    "page": pno,
                    "block": bid,
                    "rects": rects,
                    "pdfRects": _pdf_rects(rects, to_pdf),
                }
                sids.append(sid)
            if not sids:
                continue
            block = {"id": bid, "type": btype, "page": pno, "sentenceIds": sids}
            blocks.append(block)
            infos.append({"bbox": tuple(item["bbox"]), "btype": btype, "text": text, "size": item["size"],
                          "lines": _line_boxes(item["cmap"]), "sids": sids, "block": block})
            if btype == "caption":
                label = f"{'Table' if cap.group(1) == 'Table' else 'Figure'} {cap.group(2)}"
                if label not in seen_labels:
                    seen_labels.add(label)
                    figures.append({"label": label, "page": pno, "captionSentenceId": sids[0]})

    if detect_figures:
        _detect_figures(doc, figures, page_infos, body_size, figures_dir)

    return {
        "extractorVersion": EXTRACTOR_VERSION,
        "pymupdfVersion": pymupdf.__version__,
        "pages": pages,
        "blocks": blocks,
        "sentences": sentences,
        "figures": figures,
    }


USAGE = "사용법: python extract/extract_pdf.py <pdf> <out.json> [--figures-dir <dir>]"


def main(argv):
    figures_dir = None
    if len(argv) == 4 and argv[2] == "--figures-dir":
        figures_dir = argv[3]
        argv = argv[:2]
    if len(argv) != 2:
        print(USAGE, file=sys.stderr)
        return 2
    pdf_path, out_path = argv
    if figures_dir is not None and not os.path.isdir(figures_dir):
        print(f"그림 저장 폴더가 없습니다: {figures_dir}", file=sys.stderr)
        return 2
    try:
        result = extract(pdf_path, figures_dir=figures_dir)
    except ScannedPdfError as err:
        print(str(err), file=sys.stderr)
        return 2
    except Exception as err:  # noqa: BLE001 - CLI boundary
        print(f"PDF를 읽을 수 없습니다: {pdf_path} ({err})", file=sys.stderr)
        return 2
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
    except OSError as err:
        print(f"결과 파일을 쓸 수 없습니다: {out_path} ({err})", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
