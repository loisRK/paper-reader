"""PDF -> sentence-addressed JSON (source.json without id/zotero; `meta` is the PDF's own bibliographic guess).

Usage: python extract/extract_pdf.py <pdf> <out.json> [--figures-dir <dir>]
With --figures-dir, figure/table regions are saved there as fig-<page>-<n>.png.
No stdout. On failure: Korean message on stderr, exit code 2.
"""
import hashlib
import json
import os
import re
import sys
from collections import Counter

import pymupdf

# The figure detector lives next to this script; make it importable under `python -I` too.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import figure_regions  # noqa: E402

EXTRACTOR_VERSION = 4
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



class ScannedPdfError(Exception):
    def __init__(self, message=SCANNED_MESSAGE):
        super().__init__(message)


def _md5_file(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _r1(v):
    return round(float(v), 1)


def _num(v):
    """Round to 1 decimal; integral values become int (612.0 -> 612)."""
    v = _r1(v)
    return int(v) if v == int(v) else v


# ------------------------------------------------------------------ meta

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>]+")
DOI_TRAILING = ".,;:)]}'\u2019\u201d"
AUTHOR_SPLIT_RE = re.compile(r"\s*;\s*|\s*,\s*|\s+and\s+", re.IGNORECASE)
JUNK_TITLE_RE = re.compile(r"^(untitled\b.*|microsoft word\s*-.*|.*\.(docx?|tex|indd|pdf)|none|null)$", re.IGNORECASE)
MAX_TITLE_CHARS = 300
TITLE_SIZE_TOLERANCE = 0.5


def _clean_title(value):
    title = re.sub(r"\s+", " ", value or "").strip()
    return "" if not title or JUNK_TITLE_RE.match(title) else title


def _largest_line_title(doc):
    """Joined lines of the largest text on the first page (title heuristic)."""
    if len(doc) == 0:
        return ""
    lines = []  # (size, text)
    for block in doc[0].get_text("dict", flags=TEXT_FLAGS)["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            spans = [sp for sp in line["spans"] if sp["text"].strip()]
            if spans:
                text = "".join(sp["text"] for sp in line["spans"]).strip()
                lines.append((max(sp["size"] for sp in spans), text))
    if not lines:
        return ""
    top = max(size for size, _ in lines)
    picked = [t for size, t in lines if size >= top - TITLE_SIZE_TOLERANCE]
    return re.sub(r"\s+", " ", " ".join(picked)).strip()[:MAX_TITLE_CHARS]


def _meta_date(value):
    m = re.match(r"D:(\d{4})(\d{2})(\d{2})", value or "")
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else ""


def _meta_doi(doc):
    text = " ".join(doc[i].get_text() for i in range(min(2, len(doc))))
    m = DOI_RE.search(text)
    return m.group(0).rstrip(DOI_TRAILING) if m else ""


def _build_meta(doc, pdf_path):
    md = doc.metadata or {}
    title = (_clean_title(md.get("title")) or _clean_title(_largest_line_title(doc))
             or os.path.splitext(os.path.basename(pdf_path))[0])
    authors = [a.strip() for a in AUTHOR_SPLIT_RE.split(md.get("author") or "") if a.strip()]
    return {"title": title, "authors": authors, "date": _meta_date(md.get("creationDate")),
            "doi": _meta_doi(doc), "journal": ""}


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


# ------------------------------------------------------------------ main


def extract(pdf_path, figures_dir=None, detect_figures=True):
    """figures_dir: existing directory for fig-<page>-<n>.png (None: no files, image null).
    detect_figures=False leaves figures as label/page/captionSentenceId only (no bbox/image/blockIds)."""
    doc = pymupdf.open(pdf_path)
    try:
        result = _extract(doc, figures_dir, detect_figures)
        result["meta"] = _build_meta(doc, pdf_path)
        pdf = {"path": os.path.abspath(pdf_path), "md5": _md5_file(pdf_path)}
        head = {k: result[k] for k in ("extractorVersion", "pymupdfVersion")}
        return {**head, "pdf": pdf, **{k: v for k, v in result.items() if k not in head}}
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
    page_infos = {}  # pno -> (w, h, [figure_regions.TextBlock])
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
            infos.append(figure_regions.TextBlock(
                bbox=tuple(item["bbox"]), btype=btype, text=text, size=item["size"],
                lines=figure_regions.line_boxes(item["cmap"]), sids=sids, block=block))
            if btype == "caption":
                label = f"{'Table' if cap.group(1) == 'Table' else 'Figure'} {cap.group(2)}"
                if label not in seen_labels:
                    seen_labels.add(label)
                    figures.append({"label": label, "page": pno, "captionSentenceId": sids[0]})

    if detect_figures:
        figure_regions.detect_figures(doc, figures, page_infos, body_size, figures_dir)

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
