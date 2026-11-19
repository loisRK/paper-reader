"""Figure/table regions next to captions, and their PNG crops.

Entry point: detect_figures(doc, figures, page_infos, body_size, figures_dir).

All geometry is in the UNROTATED page space, like text bboxes (drawings, images and tables come
back from PyMuPDF in that same space, verified on 2.1 for 0/90/270 and cropboxes). Rendering maps
a region through page.rotation_matrix, so a rotated page gets an image as it is displayed.

Per page: every caption picks a side (tables below first, figures above first) and "seeds" with
the graphics right next to it; a graphic seeds only its nearest caption. Seeds grow by chaining
nearby graphics in the caption's column; other captions, their seeds and body text are barriers.
"""
import os
import re
import sys
from dataclasses import dataclass, field

import pymupdf

# Graphic candidates (pt, unrotated page space)
MIN_CLUSTER_AREA = 600          # drawing clusters smaller than this are not graphics
MAX_CANDIDATE_PAGE_SHARE = 0.9  # page-sized backgrounds/frames are not figures
WHITE = 0.98                    # fill components at or above this are white (invisible background)
TABLE_COVER_SHARE = 0.8         # drawing and detected table this much overlapping (of the smaller): table-like
RULE_MAX_THICKNESS = 1.5        # a horizontal rule (table line) is this thin ...
RULE_MIN_LENGTH = 40            # ... and at least this long
RULE_X_TOLERANCE = 6            # rules of one table start and end at the same x
RULE_STACK_GAP = 48             # and follow each other this closely

# Page zones and text
MARGIN_BAND = 0.07              # top/bottom share of the page holding running headers/footers
HEADER_MAX_SHARE = 0.1          # a running header/footer block ends within this share of the page
ZONE_GAP = 4                    # header/footer rules sit this close to their text
BODY_MIN_CHARS = 40             # body text (vs. labels inside a figure): long and body-sized
CAPTION_ALIGN = 3               # caption lines share the left edge (or the center) within this
CAPTION_LINE_GAP = 4            # a caption continuation line starts this close below the previous one

# Regions
NARROW_CAPTION_SHARE = 0.6      # captions narrower than this share of the page width are one column
MAX_CHAIN_GAP = 24              # vertical gap that still links graphic parts (and a figure to its caption)
MAX_TABLE_CAPTION_GAP = 48      # tables often have an unruled header row between caption and first rule
FULL_WIDTH_SPILL_SHARE = 0.15   # a graphic this far past the caption's column may be full-width
LABEL_GAP = 4                   # small text this close to a graphic region is its label
PADDING = 4
MIN_FIGURE_AREA = 1500          # smaller regions mean "no figure"
FIGURE_DPI = 150

IMAGE_NAME_RE = re.compile(r"^fig-\d+-\d+\.png$")


@dataclass(eq=False)  # identity semantics: a block is itself, not any block with equal fields
class TextBlock:
    """One text block of a page as the figure detector sees it."""
    bbox: tuple
    btype: str
    text: str
    size: float
    lines: list          # line bboxes
    sids: list           # sentence ids
    block: dict          # the output block (gets "inFigure")


@dataclass(frozen=True)
class Seed:
    graphic: tuple       # the whole candidate
    piece: tuple         # its part in the caption's column band, on the caption's side
    gap: float           # distance from the caption


@dataclass
class Plan:
    caption: TextBlock
    cb: tuple            # caption extent (with continuation lines)
    col: tuple           # (x0, x1) column band
    full_width: bool     # col spans the page
    direction: str       # "up" or "down" from the caption
    pool: list           # candidates the region may grow over
    seeds: list = field(default_factory=list)


@dataclass
class PageLayout:
    width: float
    height: float
    blocks: list         # TextBlock, reading order
    top: float           # header zone ends here
    bottom: float        # footer zone starts here
    body: list           # running-text blocks (barriers)
    caption_boxes: list  # caption extents of all captions on the page


# ------------------------------------------------------------------ geometry


def _r1(v):
    return round(float(v), 1)


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


def line_boxes(cmap):
    """Line bboxes from a block's char map [(line_index, char_bbox | None)]."""
    by_line = {}
    for li, bbox in cmap:
        if bbox is not None:
            by_line[li] = bbox if li not in by_line else _union(by_line[li], bbox)
    return [tuple(by_line[li]) for li in sorted(by_line)]


# ---------------------------------------------------------------- candidates


def _page_zones(blocks, h):
    """(top, bottom): graphics and regions stay between the running header and footer text."""
    top, bottom = h * MARGIN_BAND, h * (1 - MARGIN_BAND)
    for b in blocks:
        _, y0, _, y1 = b.bbox
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

    Returns (figure_like, table_like): find_tables() boxes, rule stacks and the clusters/images that
    mostly overlap a table are table-like, everything else figure-like."""
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


# ------------------------------------------------------------------ captions


def _is_body_text(blk, body_size):
    """Running text (not a label inside a figure): a body-sized heading or a long body-sized paragraph."""
    if blk.size < body_size - 0.5:
        return False
    return blk.btype == "heading" or (blk.btype == "paragraph" and len(blk.text) >= BODY_MIN_CHARS)


def _caption_extent(cap, blocks):
    """Bbox of the caption's lines, including continuation lines MuPDF put into following blocks,
    but not sub-figure labels ("(a) Detection Task") it merged in: a caption line starts at the
    caption's left edge or is centered under it, and follows the previous line closely.
    Without line boxes the caption block's bbox is used."""
    if not cap.lines:
        return tuple(cap.bbox)
    lines = list(cap.lines)
    i = next(k for k, b in enumerate(blocks) if b is cap)
    for b in blocks[i + 1:]:
        if b.btype != "paragraph" or abs(b.size - cap.size) > 0.5:
            break
        lines += b.lines
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


# -------------------------------------------------------------------- regions


def _keeps_full_width(cap, cb, col, graphics, layout, first_gap):
    """Narrow caption next to a full-width graphic: true when a seed graphic spills well past the
    caption's column, every text block of the other column beside it lies inside that graphic and
    no other caption sits in the other column next to it."""
    w = layout.width
    half = w / 2
    other = (half, w) if col[0] == 0 else (0.0, half)

    def in_other(r):
        return other[0] <= (r[0] + r[2]) / 2 <= other[1]

    for c in graphics:
        spill = c[2] - col[1] if col[0] == 0 else col[0] - c[0]
        if spill < w * FULL_WIDTH_SPILL_SHARE:
            continue
        reach = (c[0], c[1] - first_gap, c[2], c[3] + first_gap)
        crowded = any(b is not cap and in_other(b.bbox) and _v_overlap(b.bbox, c) > 0
                      and not _inside(b.bbox, c, 2) for b in layout.blocks)
        crowded = crowded or any(r != cb and in_other(r) and _v_overlap(r, reach) > 0
                                 for r in layout.caption_boxes)
        if not crowded:
            return True
    return False


def _plan(cap, cb, is_table, figure_like, table_like, layout):
    """Choose column band, side and seed graphics for one caption, or None."""
    w = layout.width
    half = w / 2
    narrow = cb[2] - cb[0] < w * NARROW_CAPTION_SHARE
    col = ((0.0, half) if (cb[0] + cb[2]) / 2 < half else (half, w)) if narrow else (0.0, w)
    first_gap = MAX_TABLE_CAPTION_GAP if is_table else MAX_CHAIN_GAP
    order = ("down", "up") if is_table else ("up", "down")
    own = table_like if is_table else figure_like

    def seeds_for(pool, direction, band):
        out = []
        for c in pool:
            piece = _clip_to_side(c, cb, direction, band)
            if piece is None:
                continue
            g = _caption_gap(piece, cb, direction)
            if g > first_gap:
                continue
            if g > 0 and any(_intersects(_caption_strip(piece, cb, direction), b.bbox) for b in layout.body):
                continue
            out.append(Seed(c, piece, g))
        return out

    # Own kind first, so a table right above a figure (or below a table caption) is not merged in.
    for pool in (own, figure_like + table_like):
        for direction in order:
            seeds = seeds_for(pool, direction, col)
            if seeds:
                if narrow and _keeps_full_width(cap, cb, col, [s.graphic for s in seeds], layout, first_gap):
                    col = (0.0, w)
                    seeds = seeds_for(pool, direction, col)
                return Plan(caption=cap, cb=cb, col=col, full_width=col == (0.0, w),
                            direction=direction, pool=pool, seeds=seeds)
    return None


def _grow(plan, barriers, taken, layout):
    """Union of the seeds, chained over nearby pool graphics that do not run into a barrier."""
    region = None
    for s in plan.seeds:
        region = s.piece if region is None else _union(region, s.piece)
    used = {s.graphic for s in plan.seeds}
    grown = True
    while grown:
        grown = False
        for c in plan.pool:
            if c in used:
                continue
            piece = _clip_to_side(c, plan.cb, plan.direction, plan.col)
            if piece is None or piece in taken:
                continue
            if max(piece[1] - region[3], region[1] - piece[3]) > MAX_CHAIN_GAP:
                continue
            merged = _union(region, piece)
            if (any(_intersects(merged, r) for r in barriers)
                    or any(_intersects(merged, b.bbox) for b in layout.body)):
                continue
            region, grown = merged, True
            used.add(c)
    return region


def _add_labels(region, plan, layout):
    """Grow the region over small text touching it (axis labels, legends) on the caption's side."""
    cb, col, direction = plan.cb, plan.col, plan.direction
    body_ids = {id(b) for b in layout.body}
    others = [r for r in layout.caption_boxes if r != cb]
    grown = True
    while grown:
        grown = False
        for b in layout.blocks:
            bb = b.bbox
            if (b is plan.caption or b.btype == "caption" or id(b) in body_ids or _inside(bb, region)
                    or not (col[0] <= (bb[0] + bb[2]) / 2 <= col[1])
                    or bb[1] < layout.top or bb[3] > layout.bottom
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


def _finish(region, plan, layout):
    """Padding, then clip to the caption edge, the column, header/footer, other captions and text."""
    cb, col, direction = plan.cb, plan.col, plan.direction
    w, h = layout.width, layout.height
    x0, y0, x1, y1 = (max(0.0, region[0] - PADDING), max(0.0, region[1] - PADDING),
                      min(w, region[2] + PADDING), min(h, region[3] + PADDING))
    if not plan.full_width:
        x0, x1 = max(x0, col[0]), min(x1, col[1])
    # whatever lies between the graphic and its caption (axis labels, a header row) belongs to it
    if direction == "up":
        y1 = cb[1]
    else:
        y0 = cb[3]
    y0, y1 = max(y0, layout.top), min(y1, layout.bottom)
    region = _add_labels((x0, y0, x1, y1), plan, layout)
    if direction == "up":    # labels may not pull the region across the caption
        region = (region[0], region[1], region[2], min(region[3], cb[1]))
    else:
        region = (region[0], max(region[1], cb[3]), region[2], region[3])
    own_center = (cb[1] + cb[3]) / 2
    for r in layout.caption_boxes:
        if r == cb or not _intersects(r, region):
            continue
        if (r[1] + r[3]) / 2 < own_center:
            region = (region[0], max(region[1], r[3]), region[2], region[3])
        else:
            region = (region[0], region[1], region[2], min(region[3], r[1]))
    body_ids = {id(b) for b in layout.body}
    for b in layout.blocks:
        bb = b.bbox
        if b is plan.caption or not _intersects(bb, region) or _inside(bb, region):
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


# ----------------------------------------------------------------------- entry


def clear_stale_images(figures_dir):
    """Remove earlier crops (fig-<page>-<n>.png directly inside figures_dir), nothing else."""
    for entry in os.scandir(figures_dir):
        if entry.is_file(follow_symlinks=False) and IMAGE_NAME_RE.match(entry.name):
            os.remove(entry.path)


def _render(page, region, path):
    clip = pymupdf.Rect(region) * page.rotation_matrix
    page.get_pixmap(clip=clip, dpi=FIGURE_DPI).save(path)


def detect_figures(doc, figures, page_infos, body_size, figures_dir):
    """Add bbox/image/blockIds to each figure (and inFigure to enclosed paragraph blocks).

    page_infos: {page_no: (width, height, [TextBlock in reading order])}.
    figures_dir: existing directory for fig-<page>-<n>.png, or None for no files (image None)."""
    if figures_dir:
        try:
            clear_stale_images(figures_dir)
        except OSError as err:
            print(f"이전 그림 이미지를 정리하지 못했습니다(추출은 계속합니다): {err}", file=sys.stderr)
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
                b.block.pop("inFigure", None)


def _detect_page_figures(page, pno, figs, page_info, body_size, figures_dir):
    w, h, blocks = page_info
    top, bottom = _page_zones(blocks, h)
    figure_like, table_like = _candidates(page, w, h, top, bottom,
                                          any(f["label"].startswith("Table") for f in figs),
                                          [b.bbox for b in blocks if b.btype == "caption"])
    if not figure_like and not table_like:
        return
    graphics = figure_like + table_like
    # body text that is not drawn inside a graphic (e.g. table rows inside their rules)
    body = [b for b in blocks if _is_body_text(b, body_size)
            and not any(_inside(b.bbox, c, 2) for c in graphics)]
    extent = {id(b): _caption_extent(b, blocks) for b in blocks if b.btype == "caption"}
    layout = PageLayout(width=w, height=h, blocks=blocks, top=top, bottom=bottom, body=body,
                        caption_boxes=list(extent.values()))
    by_sid = {b.sids[0]: b for b in blocks}

    plans = []
    for fig in figs:
        cap = by_sid[fig["captionSentenceId"]]
        plans.append(_plan(cap, extent[id(cap)], fig["label"].startswith("Table"),
                           figure_like, table_like, layout))
    # A graphic (its part in the caption's column band) seeds only its nearest caption.
    nearest = {}
    for k, plan in enumerate(plans):
        for s in plan.seeds if plan else ():
            if s.piece not in nearest or s.gap < nearest[s.piece][0]:
                nearest[s.piece] = (s.gap, k)
    for k, plan in enumerate(plans):
        if plan:
            plan.seeds = [s for s in plan.seeds if nearest[s.piece][1] == k]

    for k, (fig, plan) in enumerate(zip(figs, plans)):
        if not plan or not plan.seeds:
            continue
        taken = {s.piece for j, p in enumerate(plans) if p and j != k for s in p.seeds}
        barriers = [r for r in layout.caption_boxes if r != plan.cb] + list(taken)
        region = _finish(_grow(plan, barriers, taken, layout), plan, layout)
        if region is None:
            continue
        fig["bbox"] = [_r1(v) for v in region]
        for b in blocks:
            if b.btype == "paragraph" and "inFigure" not in b.block and _inside(b.bbox, region):
                b.block["inFigure"] = fig["label"]
                fig["blockIds"].append(b.block["id"])
        if figures_dir:
            name = f"fig-{pno}-{k + 1}.png"
            try:
                _render(page, region, os.path.join(figures_dir, name))
            except Exception as err:  # noqa: BLE001 - one bad crop keeps its region, loses only its image
                print(f"{fig['label']} 이미지를 저장하지 못했습니다: {err}", file=sys.stderr)
                continue
            fig["image"] = name
