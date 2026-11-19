import json
import subprocess
import sys
from pathlib import Path

import pymupdf
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "extract"))

from extract_pdf import ScannedPdfError, extract  # noqa: E402

FILLER = (
    "This is a filler sentence that pads the page with enough text. "
    "Another filler sentence keeps the average above the scanned threshold."
)


def make_pdf(path, pages):
    """pages: list of lists of (rect_tuple, text, fontsize)."""
    doc = pymupdf.open()
    for boxes in pages:
        page = doc.new_page(width=612, height=792)
        for rect, text, size in boxes:
            rc = page.insert_textbox(pymupdf.Rect(*rect), text, fontsize=size, fontname="helv")
            assert rc >= 0, f"text did not fit: {text!r}"
    doc.save(str(path))
    doc.close()
    return str(path)


def texts(result):
    return [s["text"] for s in result["sentences"].values()]


def test_ids_are_page_scoped_and_ordered(tmp_path):
    pdf = make_pdf(tmp_path / "two.pdf", [
        [((72, 72, 540, 120), "First sentence here. Second sentence here.", 10),
         ((72, 300, 540, 360), FILLER, 10)],
        [((72, 72, 540, 120), "Third sentence here.", 10),
         ((72, 300, 540, 360), FILLER, 10)],
    ])
    result = extract(pdf)
    keys = list(result["sentences"].keys())
    p1 = [k for k in keys if k.startswith("p1-")]
    p2 = [k for k in keys if k.startswith("p2-")]
    assert p1 == [f"p1-s{i}" for i in range(1, len(p1) + 1)]
    assert p2 == [f"p2-s{i}" for i in range(1, len(p2) + 1)]
    assert keys == p1 + p2
    assert result["sentences"]["p1-s1"]["text"] == "First sentence here."
    assert result["sentences"]["p1-s2"]["text"] == "Second sentence here."
    assert result["sentences"]["p2-s1"]["text"] == "Third sentence here."
    assert result["sentences"]["p2-s1"]["page"] == 2
    assert result["extractorVersion"] == 3
    assert result["pages"] == [
        {"page": 1, "width": 612, "height": 792, "rotation": 0},
        {"page": 2, "width": 612, "height": 792, "rotation": 0},
    ]
    for block in result["blocks"]:
        for sid in block["sentenceIds"]:
            assert result["sentences"][sid]["block"] == block["id"]


def test_two_column_reads_left_column_first(tmp_path):
    left = (50, 260)
    right = (350, 560)
    boxes = [
        ((left[0], 60, left[1], 110), "Alpha one. Alpha two.", 10),
        ((left[0], 250, left[1], 300), "Alpha three is a left column filler block.", 10),
        ((left[0], 450, left[1], 500), "Alpha four is another left column filler block.", 10),
        ((right[0], 67, right[1], 117), "Beta one.", 10),
        ((right[0], 257, right[1], 307), "Beta two is a right column filler block.", 10),
        ((right[0], 457, right[1], 507), "Beta three is another right column filler block.", 10),
    ]
    result = extract(make_pdf(tmp_path / "cols.pdf", [boxes]))
    order = texts(result)
    assert order[:3] == ["Alpha one.", "Alpha two.", "Alpha three is a left column filler block."]
    alpha = [i for i, t in enumerate(order) if t.startswith("Alpha")]
    beta = [i for i, t in enumerate(order) if t.startswith("Beta")]
    assert len(alpha) == 4 and len(beta) == 3
    assert max(alpha) < min(beta)
    assert order[len(alpha)] == "Beta one."


def test_full_width_block_is_placed_by_y_in_two_columns(tmp_path):
    left, right = (50, 260), (350, 560)
    title = "Full width title sits on top and runs well across the middle of this test page."
    boxes = [((50, 30, 560, 50), title, 10)]
    # Right column baselines are offset so MuPDF does not merge same-baseline lines.
    for i, y in enumerate((100, 250, 400)):
        boxes.append(((left[0], y, left[1], y + 40), f"Left block number {i + 1} sits here.", 10))
        boxes.append(((right[0], y + 20, right[1], y + 60), f"Right block number {i + 1} sits here.", 10))
    result = extract(make_pdf(tmp_path / "title.pdf", [boxes]))
    order = texts(result)
    assert order[0] == title
    assert order[1:4] == [f"Left block number {i} sits here." for i in (1, 2, 3)]
    assert order[4:7] == [f"Right block number {i} sits here." for i in (1, 2, 3)]


def test_et_al_and_fig_do_not_split(tmp_path):
    pdf = make_pdf(tmp_path / "abbr.pdf", [[
        ((72, 72, 540, 120), "Smith et al. showed X. See Fig. 2 for Y.", 10),
        ((72, 300, 540, 360), FILLER, 10),
    ]])
    result = extract(pdf)
    first_block = result["blocks"][0]
    got = [result["sentences"][sid]["text"] for sid in first_block["sentenceIds"]]
    assert got == ["Smith et al. showed X.", "See Fig. 2 for Y."]


def test_other_abbreviations_and_initials_do_not_split(tmp_path):
    pdf = make_pdf(tmp_path / "abbr2.pdf", [[
        ((72, 72, 540, 140),
         "Tools, e.g. Zotero, help. Work by Kim J. Lee, i.e. Prior art, is cited. "
         "See Eq. 3 and Sec. 4 for details. Smith, J. A. Doe and J. K. Rowling agree.", 10),
        ((72, 300, 540, 360), FILLER, 10),
    ]])
    result = extract(pdf)
    got = [result["sentences"][sid]["text"] for sid in result["blocks"][0]["sentenceIds"]]
    assert got == [
        "Tools, e.g. Zotero, help.",
        "Work by Kim J. Lee, i.e. Prior art, is cited.",
        "See Eq. 3 and Sec. 4 for details.",
        "Smith, J. A. Doe and J. K. Rowling agree.",
    ]


def test_hyphenated_line_break_is_joined(tmp_path):
    pdf = make_pdf(tmp_path / "hyph.pdf", [[
        ((72, 72, 540, 140), "The experi-\nment worked well.\nIt was fine.", 10),
        ((72, 300, 540, 360), FILLER, 10),
    ]])
    result = extract(pdf)
    got = [result["sentences"][sid]["text"] for sid in result["blocks"][0]["sentenceIds"]]
    assert got == ["The experiment worked well.", "It was fine."]
    # A sentence spanning two lines gets one rect per line.
    assert len(result["sentences"]["p1-s1"]["rects"]) == 2


def test_caption_becomes_figure(tmp_path):
    pdf = make_pdf(tmp_path / "fig.pdf", [[
        ((72, 72, 540, 120), "Body text comes first.", 10),
        ((72, 200, 540, 240), "Figure 2: Overview of the system.", 10),
        ((72, 300, 540, 360), FILLER, 10),
    ]])
    result = extract(pdf)
    fig = result["figures"][0]
    assert fig["label"] == "Figure 2"
    assert fig["page"] == 1
    assert result["sentences"][fig["captionSentenceId"]]["text"].startswith("Figure 2: Overview")
    caption_blocks = [b for b in result["blocks"] if b["type"] == "caption"]
    assert len(caption_blocks) == 1
    assert caption_blocks[0]["sentenceIds"][0] == fig["captionSentenceId"]


def test_fig_abbrev_and_table_labels_are_normalized(tmp_path):
    pdf = make_pdf(tmp_path / "fig2.pdf", [[
        ((72, 72, 540, 120), "Fig. 3. Results across sites.", 10),
        ((72, 200, 540, 240), "Table 1\nParticipant characteristics.", 10),
        ((72, 300, 540, 360), FILLER, 10),
    ]])
    labels = [f["label"] for f in extract(pdf)["figures"]]
    assert labels == ["Figure 3", "Table 1"]


def test_headings_and_references(tmp_path):
    pdf = make_pdf(tmp_path / "head.pdf", [[
        ((72, 60, 540, 90), "Big Title Text", 16),
        ((72, 120, 540, 160), FILLER, 10),
        ((72, 200, 540, 220), "2.1 Methods", 10),
        ((72, 240, 540, 280), "We measured things carefully.", 10),
        ((72, 320, 540, 340), "References", 10),
        ((72, 360, 540, 400), "Smith J. A paper title. Journal 2020.", 10),
    ]])
    blocks = extract(pdf)["blocks"]
    types = [b["type"] for b in blocks]
    assert types == ["heading", "paragraph", "heading", "paragraph", "heading", "references"]


def test_rects_inside_page(tmp_path):
    pdf = make_pdf(tmp_path / "rects.pdf", [[
        ((40, 72, 590, 200), FILLER + " " + FILLER + " " + FILLER, 10),
    ]])
    result = extract(pdf)
    width = result["pages"][0]["width"]
    height = result["pages"][0]["height"]
    assert result["sentences"]
    for s in result["sentences"].values():
        assert s["rects"]
        for x0, y0, x1, y1 in s["rects"]:
            assert 0 <= x0 < x1 <= width
            assert 0 <= y0 < y1 <= height
            for v in (x0, y0, x1, y1):
                assert round(v, 1) == v


def test_scanned_pdf_raises(tmp_path):
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 100, 100), False)
    pix.clear_with(200)
    page.insert_image(pymupdf.Rect(72, 72, 540, 720), pixmap=pix)
    path = tmp_path / "scan.pdf"
    doc.save(str(path))
    with pytest.raises(ScannedPdfError, match="스캔 PDF"):
        extract(str(path))


def test_same_pdf_same_ids(tmp_path):
    pdf = make_pdf(tmp_path / "same.pdf", [
        [((72, 72, 540, 120), "One sentence. Two sentence.", 10), ((72, 300, 540, 360), FILLER, 10)],
        [((72, 72, 540, 120), "Three sentence.", 10), ((72, 300, 540, 360), FILLER, 10)],
    ])
    a, b = extract(pdf), extract(pdf)
    assert list(a["sentences"].keys()) == list(b["sentences"].keys())
    assert a == b


def test_cli_writes_json_and_exits_2_on_scanned(tmp_path):
    script = ROOT / "extract" / "extract_pdf.py"
    pdf = make_pdf(tmp_path / "cli.pdf", [[((72, 72, 540, 120), FILLER, 10)]])
    out = tmp_path / "out.json"
    ok = subprocess.run([sys.executable, str(script), pdf, str(out)], capture_output=True, text=True)
    assert ok.returncode == 0, ok.stderr
    assert ok.stdout == ""
    data = json.loads(out.read_text(encoding="utf-8"))
    assert "id" not in data and "zotero" not in data and "meta" not in data
    assert data["sentences"]["p1-s1"]["text"].startswith("This is a filler sentence")

    doc = pymupdf.open()
    doc.new_page()
    blank = tmp_path / "blank.pdf"
    doc.save(str(blank))
    bad = subprocess.run([sys.executable, str(script), str(blank), str(tmp_path / "x.json")],
                         capture_output=True, text=True)
    assert bad.returncode == 2
    assert "스캔 PDF" in bad.stderr
    assert bad.stdout == ""

    missing = subprocess.run([sys.executable, str(script), str(tmp_path / "nope.pdf"), str(tmp_path / "y.json")],
                             capture_output=True, text=True)
    assert missing.returncode == 2
    assert missing.stderr.strip()


def test_caption_label_stays_with_caption_text(tmp_path):
    pdf = make_pdf(tmp_path / "cap.pdf", [[
        ((72, 72, 540, 120), "Figure 1. Overview of the system. It has parts.", 10),
        ((72, 300, 540, 360), FILLER, 10),
    ]])
    result = extract(pdf)
    sid = result["figures"][0]["captionSentenceId"]
    assert result["sentences"][sid]["text"] == "Figure 1. Overview of the system."


def test_caption_line_inside_figure_block_is_split_out(tmp_path):
    pdf = make_pdf(tmp_path / "figblock.pdf", [[
        ((72, 72, 540, 140), "Revoke the admin privilege\nduring execution\nFigure 4. Revoke fault example.", 10),
        ((72, 300, 540, 360), FILLER, 10),
    ]])
    result = extract(pdf)
    assert [f["label"] for f in result["figures"]] == ["Figure 4"]
    sid = result["figures"][0]["captionSentenceId"]
    assert result["sentences"][sid]["text"] == "Figure 4. Revoke fault example."
    assert [b["type"] for b in result["blocks"]][:2] == ["paragraph", "caption"]


def test_long_numbered_row_is_not_heading_and_jittered_title_is(tmp_path):
    pdf = make_pdf(tmp_path / "rows.pdf", [[
        ((72, 40, 540, 70), "A Title In Small Caps", 11.5),
        ((72, 80, 540, 130), FILLER, 9.9),
        ((72, 140, 540, 190), FILLER, 10.1),
        ((72, 200, 540, 260), FILLER, 10),
        ((72, 300, 540, 360),
         "1 AuthenticationMissing HotelReservation 1, 2, 3, 4 Functional Virtualization 12 The service fails", 10),
    ]])
    types = [b["type"] for b in extract(pdf)["blocks"]]
    assert types[0] == "heading"
    assert types[-1] == "paragraph"


def test_body_paragraph_starting_with_figure_is_not_caption(tmp_path):
    pdf = make_pdf(tmp_path / "figbody.pdf", [
        [((72, 72, 540, 120), "Figure 2 shows the pipeline we built. It works well.", 10),
         ((72, 300, 540, 360), FILLER, 10)],
        [((72, 72, 540, 120), "Figure 2. Overview of pipeline.", 10),
         ((72, 300, 540, 360), FILLER, 10)],
    ])
    result = extract(pdf)
    assert result["figures"] == [{"label": "Figure 2", "page": 2, "captionSentenceId": "p2-s1",
                                  "bbox": None, "image": None, "blockIds": []}]
    assert [b["type"] for b in result["blocks"]] == ["paragraph", "paragraph", "caption", "paragraph"]


def test_caption_label_variants(tmp_path):
    pdf = make_pdf(tmp_path / "capvar.pdf", [[
        ((72, 72, 540, 100), "Figure 3: Colon caption.", 10),
        ((72, 120, 540, 150), "Table 4 | Pipe caption.", 10),
        ((72, 170, 540, 200), "Table 5 lists the sites we used.", 10),
        ((72, 300, 540, 360), FILLER, 10),
    ]])
    result = extract(pdf)
    assert [f["label"] for f in result["figures"]] == ["Figure 3", "Table 4"]


def test_records_pymupdf_version(tmp_path):
    pdf = make_pdf(tmp_path / "ver.pdf", [[((72, 72, 540, 120), FILLER, 10)]])
    result = extract(pdf)
    assert result["extractorVersion"] == 3
    assert result["pymupdfVersion"] == pymupdf.__version__


def make_rotated_pdf(path, rotation=0, text_at=(72, 100), cropbox=None):
    """612x792 page; text inserted first, then rotation/cropbox applied (insertion is in unrotated space)."""
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text(text_at, "Hello world. Second sentence.", fontsize=11, fontname="helv")
    page.insert_text((72, 400), FILLER, fontsize=11, fontname="helv")  # keep above the scanned threshold
    if rotation:
        page.set_rotation(rotation)
    if cropbox:
        page.set_cropbox(pymupdf.Rect(*cropbox))
    doc.save(str(path / "rot.pdf"))
    doc.close()
    return str(path / "rot.pdf")


def first_sentence(result):
    return next(iter(result["sentences"].values()))


def test_pdf_rects_unrotated_bottom_left(tmp_path):
    src = extract(make_rotated_pdf(tmp_path, rotation=0))
    r = first_sentence(src)["pdfRects"][0]
    assert r[0] == pytest.approx(72, abs=2)
    assert 792 - 100 - 2 <= r[3] <= 792 - 100 + 12   # top edge near baseline, flipped
    assert r[1] < r[3]


def test_pdf_rects_rotated_page_maps_back_to_unrotated_space(tmp_path):
    src = extract(make_rotated_pdf(tmp_path, rotation=90))
    assert src["pages"][0]["rotation"] == 90
    r = first_sentence(src)["pdfRects"][0]
    assert r[0] == pytest.approx(72, abs=2)
    assert 792 - 100 - 2 <= r[3] <= 792 - 100 + 12


def test_pdf_rects_respect_cropbox_offset(tmp_path):
    src = extract(make_rotated_pdf(tmp_path, rotation=0, cropbox=(36, 36, 576, 756)))
    r = first_sentence(src)["pdfRects"][0]
    assert r[0] == pytest.approx(72, abs=2)   # PDF user space, not crop-relative


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_pdf_rects_asymmetric_cropbox_all_rotations(tmp_path, rotation):
    src = extract(make_rotated_pdf(tmp_path, rotation=rotation, cropbox=(20, 50, 500, 700)))
    r = first_sentence(src)["pdfRects"][0]
    assert r[0] == pytest.approx(72, abs=2)
    assert 792 - 100 - 2 <= r[3] <= 792 - 100 + 12


def test_pdf_rects_rotated_page_low_text_not_clipped(tmp_path):
    # y=700 unrotated is beyond the rotated page.rect height (612); must not be clipped/dropped
    base = extract(make_rotated_pdf(tmp_path, rotation=0, text_at=(72, 700)))
    rot = extract(make_rotated_pdf(tmp_path, rotation=90, text_at=(72, 700)))
    def hello(src):
        return next(x for x in src["sentences"].values() if x["text"] == "Hello world.")["pdfRects"][0]

    a, b = hello(base), hello(rot)
    assert b[2] > b[0]
    assert b == pytest.approx(a, abs=0.2)


# ---------------------------------------------------------------- figures

BODY = ("Body text in the right column talks about the method in detail. "
        "It continues with another sentence so the block is wide and long enough.")


def _box(page, rect, text, size=9):
    rc = page.insert_textbox(pymupdf.Rect(*rect), text, fontsize=size, fontname="helv")
    assert rc >= 0, f"text did not fit: {text!r}"


def make_figure_pdf(path, rotation=0):
    """Two-column page 1 with a left-column figure (one rule spills into the right column)
    under a running header; page 2 with a ruled table below its caption; page 3 caption only."""
    doc = pymupdf.open()
    p1 = doc.new_page(width=612, height=792)
    _box(p1, (55, 16, 300, 34), "Running Header", 8)
    p1.draw_line((55, 38), (557, 38))                       # header rule (header band)
    p1.draw_rect(pymupdf.Rect(60, 80, 250, 180))            # figure frame
    p1.draw_rect(pymupdf.Rect(80, 95, 150, 125), fill=(1, 0, 0))
    p1.draw_line((150, 110), (200, 140))
    p1.draw_line((60, 178), (540, 178))                     # spills across both columns
    _box(p1, (160, 148, 240, 166), "Agent", 8)
    _box(p1, (55, 188, 290, 206), "Figure 1. Overview.", 9)
    for y in (215, 330, 445):
        _box(p1, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
    for y in (60, 175, 290, 405):
        _box(p1, (330, y, 560, y + 100), BODY, 9)

    p2 = doc.new_page(width=612, height=792)
    _box(p2, (55, 78, 290, 96), "Table 1. Results.", 9)
    xs, ys = (60, 140, 210, 280), (110, 130, 150, 170)
    for x in xs:
        p2.draw_line((x, ys[0]), (x, ys[-1]))
    for y in ys:
        p2.draw_line((xs[0], y), (xs[-1], y))
    for r, y in enumerate(ys[:-1]):
        for c, x in enumerate(xs[:-1]):
            p2.insert_text((x + 4, y + 14), f"v{r}{c}", fontsize=8, fontname="helv")
    for y in (200, 320, 440):
        _box(p2, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
    for y in (60, 175, 290):
        _box(p2, (330, y, 560, y + 100), BODY, 9)

    p3 = doc.new_page(width=612, height=792)
    _box(p3, (55, 78, 290, 96), "Figure 2. No graphics here.", 9)
    _box(p3, (55, 120, 290, 220), FILLER + " " + FILLER, 9)
    if rotation:
        for p in doc:
            p.set_rotation(rotation)
    doc.save(str(path))
    doc.close()
    return str(path)


def _figure(result, label):
    return next(f for f in result["figures"] if f["label"] == label)


def _block_with(result, text):
    return next(b for b in result["blocks"]
                if any(result["sentences"][s]["text"] == text for s in b["sentenceIds"]))


def _caption_rect(result, fig):
    return result["sentences"][fig["captionSentenceId"]]["rects"][0]


def test_figure_region_crops_to_caption_column_and_saves_png(tmp_path):
    figdir = tmp_path / "figures"
    figdir.mkdir()
    result = extract(make_figure_pdf(tmp_path / "f.pdf"), figures_dir=str(figdir))
    fig = _figure(result, "Figure 1")
    assert fig["image"] == "fig-1-1.png"
    png = figdir / "fig-1-1.png"
    assert png.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    x0, y0, x1, y1 = fig["bbox"]
    width = result["pages"][0]["width"]
    assert x1 <= width / 2 + 10
    header = _block_with(result, "Running Header")
    header_bottom = result["sentences"][header["sentenceIds"][0]]["rects"][0][3]
    assert y0 > header_bottom
    assert y0 > 38                                  # header rule is outside too
    assert y1 <= _caption_rect(result, fig)[1]      # caption is not part of the image
    assert x0 <= 60 and y0 <= 80 and x1 >= 250 and y1 >= 178
    agent = _block_with(result, "Agent")
    assert agent["id"] in fig["blockIds"]
    assert agent["inFigure"] == "Figure 1"
    body = _block_with(result, BODY.split(". ")[0] + ".")
    assert body["id"] not in fig["blockIds"]
    assert "inFigure" not in body
    pix = pymupdf.Pixmap(str(png))
    assert pix.width == pytest.approx((x1 - x0) * 150 / 72, abs=2)
    assert pix.height == pytest.approx((y1 - y0) * 150 / 72, abs=2)


def test_table_region_below_caption(tmp_path):
    figdir = tmp_path / "figures"
    figdir.mkdir()
    result = extract(make_figure_pdf(tmp_path / "t.pdf"), figures_dir=str(figdir))
    table = _figure(result, "Table 1")
    assert table["page"] == 2
    cap = _caption_rect(result, table)
    x0, y0, x1, y1 = table["bbox"]
    assert y0 >= cap[3] - 2
    assert x0 <= 60 and x1 >= 280 and y1 >= 170
    assert x1 <= result["pages"][1]["width"] / 2 + 10
    assert table["image"] == "fig-2-1.png"
    assert (figdir / "fig-2-1.png").exists()


def test_caption_without_graphics_has_no_image(tmp_path):
    figdir = tmp_path / "figures"
    figdir.mkdir()
    result = extract(make_figure_pdf(tmp_path / "n.pdf"), figures_dir=str(figdir))
    fig = _figure(result, "Figure 2")
    assert fig["image"] is None
    assert fig["bbox"] is None
    assert fig["blockIds"] == []
    assert not list(figdir.glob("fig-3-*"))


def test_no_figures_dir_means_no_files_and_image_none(tmp_path):
    result = extract(make_figure_pdf(tmp_path / "nd.pdf"))
    assert [f["image"] for f in result["figures"]] == [None, None, None]
    assert _figure(result, "Figure 1")["bbox"] is not None   # region is still detected
    assert _block_with(result, "Agent")["inFigure"] == "Figure 1"
    assert not list(tmp_path.rglob("*.png"))


def test_sentence_ids_unchanged_by_figure_detection(tmp_path):
    pdf = make_figure_pdf(tmp_path / "ids.pdf")
    figdir = tmp_path / "figures"
    figdir.mkdir()
    on = extract(pdf, figures_dir=str(figdir))
    off = extract(pdf, detect_figures=False)
    assert on["sentences"] == off["sentences"]
    assert list(on["sentences"]) == list(off["sentences"])
    strip = [{k: v for k, v in b.items() if k != "inFigure"} for b in on["blocks"]]
    assert strip == off["blocks"]
    assert [{k: f[k] for k in ("label", "page", "captionSentenceId")} for f in on["figures"]] == off["figures"]
    assert on["extractorVersion"] == 3


def test_narrow_caption_under_full_width_figure_keeps_full_width(tmp_path):
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.draw_rect(pymupdf.Rect(107, 80, 488, 230))
    page.draw_rect(pymupdf.Rect(130, 100, 300, 200), fill=(0, 0, 1))
    page.draw_rect(pymupdf.Rect(320, 100, 470, 200), fill=(0, 1, 0))
    _box(page, (55, 238, 190, 256), "Figure 2. Wide.", 9)
    for y in (270, 385, 500):
        _box(page, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
        _box(page, (330, y, 560, y + 100), BODY, 9)
    doc.save(str(tmp_path / "wide.pdf"))
    doc.close()
    fig = extract(str(tmp_path / "wide.pdf"))["figures"][0]
    x0, y0, x1, y1 = fig["bbox"]
    assert x0 <= 107 and x1 >= 488 and y0 <= 80 and y1 <= 240


@pytest.mark.parametrize("rotation", [90, 270])
def test_rotated_page_crops_the_same_region(tmp_path, rotation):
    base_dir, rot_dir = tmp_path / "base", tmp_path / "rot"
    base_dir.mkdir()
    rot_dir.mkdir()
    base = extract(make_figure_pdf(tmp_path / "b.pdf"), figures_dir=str(base_dir))
    rot = extract(make_figure_pdf(tmp_path / "r.pdf", rotation=rotation), figures_dir=str(rot_dir))
    fb, fr = _figure(base, "Figure 1"), _figure(rot, "Figure 1")
    assert fr["bbox"] == fb["bbox"]          # unrotated page space, like text rects
    assert fr["blockIds"] == fb["blockIds"]
    a = pymupdf.Pixmap(str(base_dir / fb["image"]))
    b = pymupdf.Pixmap(str(rot_dir / fr["image"]))
    assert (b.width, b.height) == (a.height, a.width)   # same region, shown as the page is displayed


def test_cli_figures_dir_option(tmp_path):
    script = ROOT / "extract" / "extract_pdf.py"
    pdf = make_figure_pdf(tmp_path / "cli.pdf")
    figdir = tmp_path / "figs"
    figdir.mkdir()
    out = tmp_path / "out.json"
    ok = subprocess.run([sys.executable, str(script), pdf, str(out), "--figures-dir", str(figdir)],
                        capture_output=True, text=True)
    assert ok.returncode == 0, ok.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert _figure(data, "Figure 1")["image"] == "fig-1-1.png"
    assert (figdir / "fig-1-1.png").exists()
    bad = subprocess.run([sys.executable, str(script), pdf, str(out), "--figures-dir"],
                         capture_output=True, text=True)
    assert bad.returncode == 2


def test_side_by_side_figures_sharing_one_drawing_cluster_split_by_column(tmp_path):
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.draw_rect(pymupdf.Rect(60, 80, 552, 230))            # one frame around both figures
    page.draw_rect(pymupdf.Rect(80, 100, 280, 210), fill=(1, 0, 0))
    page.draw_rect(pymupdf.Rect(332, 100, 532, 210), fill=(0, 0, 1))
    _box(page, (55, 238, 290, 256), "Figure 6. Left one.", 9)
    _box(page, (330, 238, 560, 256), "Figure 7. Right one.", 9)
    for y in (270, 385, 500):
        _box(page, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
        _box(page, (330, y, 560, y + 100), BODY, 9)
    doc.save(str(tmp_path / "pair.pdf"))
    doc.close()
    result = extract(str(tmp_path / "pair.pdf"))
    f6, f7 = _figure(result, "Figure 6")["bbox"], _figure(result, "Figure 7")["bbox"]
    assert f6[2] <= 316 and f6[0] <= 80
    assert f7[0] >= 296 and f7[2] >= 532


def test_table_right_above_a_figure_is_not_merged_into_it(tmp_path):
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    _box(page, (55, 60, 190, 78), "Table 4. Scores.", 9)
    xs, ys = (60, 200, 340, 537), (100, 125, 150, 175)
    for x in xs:
        page.draw_line((x, ys[0]), (x, ys[-1]))
    for y in ys:
        page.draw_line((xs[0], y), (xs[-1], y))
    for r, y in enumerate(ys[:-1]):
        for c, x in enumerate(xs[:-1]):
            page.insert_text((x + 4, y + 16), f"s{r}{c}", fontsize=8, fontname="helv")
    page.draw_rect(pymupdf.Rect(80, 185, 530, 330), fill=(0, 1, 0))   # 10pt below the table
    _box(page, (55, 336, 300, 354), "Figure 8. Plot below the table.", 9)
    for y in (370, 485, 600):
        _box(page, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
        _box(page, (330, y, 560, y + 100), BODY, 9)
    doc.save(str(tmp_path / "tf.pdf"))
    doc.close()
    result = extract(str(tmp_path / "tf.pdf"))
    t4, f8 = _figure(result, "Table 4")["bbox"], _figure(result, "Figure 8")["bbox"]
    assert t4[1] >= _caption_rect(result, _figure(result, "Table 4"))[3] - 2 and t4[3] <= 185 and t4[2] >= 537     # full width under a narrow caption
    assert f8[1] >= 175 and f8[3] <= 336 and f8[2] >= 530


def test_figure_detection_error_keeps_text_and_leaves_figures_empty(tmp_path, monkeypatch, capsys):
    import extract_pdf

    def boom(*_a, **_k):
        raise RuntimeError("broken drawing")

    monkeypatch.setattr(extract_pdf, "_candidates", boom)
    pdf = make_figure_pdf(tmp_path / "err.pdf")
    result = extract(pdf)
    assert result["sentences"] == extract(pdf, detect_figures=False)["sentences"]
    assert all(f["bbox"] is None and f["image"] is None and f["blockIds"] == [] for f in result["figures"])
    assert not any("inFigure" in b for b in result["blocks"])
    assert "그림 영역을 찾지 못했습니다" in capsys.readouterr().err


CODE = "1 from lib import thing 2 def run(self): 3 return thing.go() 4 # more code here 5 done"


def _booktabs(page, x0, x1, ys, rows):
    """Horizontal rules only (no verticals), one text row per gap."""
    for y in ys:
        page.draw_line((x0, y), (x1, y), width=0.6)
    for i, text in enumerate(rows):
        page.insert_text((x0 + 4, ys[0] + 12 + 14 * i), text, fontsize=8, fontname="helv")


def _new_page(doc):
    page = doc.new_page(width=612, height=792)
    page.insert_text((124, 54), "Paper Title: A Running Header Line", fontsize=9, fontname="helv")  # ends past 7%
    page.draw_line((55, 60), (557, 60), width=1)                               # header rule
    return page


def _save(doc, path):
    doc.save(str(path))
    doc.close()
    return extract(str(path))


def test_header_text_and_rule_above_a_figure_stay_outside(tmp_path):
    doc = pymupdf.open()
    page = _new_page(doc)
    page.draw_rect(pymupdf.Rect(30, 20, 360, 200), color=None, fill=(1, 1, 1))  # invisible background
    page.draw_rect(pymupdf.Rect(70, 66, 250, 150), fill=(1, 0, 0))
    _box(page, (55, 156, 290, 174), "Figure 1. Under the header.", 9)
    for y in (190, 305, 420):
        _box(page, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
        _box(page, (330, y - 120, 560, y - 20), BODY, 9)
    result = _save(doc, tmp_path / "hdr.pdf")
    x0, y0, x1, y1 = _figure(result, "Figure 1")["bbox"]
    header = _block_with(result, "Paper Title: A Running Header Line")
    assert y0 >= result["sentences"][header["sentenceIds"][0]]["rects"][0][3]
    assert y0 > 60                     # below the header rule
    assert x0 >= 55 and x1 <= 306      # the invisible background does not widen it


def test_code_in_the_other_column_beside_a_narrow_caption_figure_is_cut_off(tmp_path):
    doc = pymupdf.open()
    page = _new_page(doc)
    page.draw_rect(pymupdf.Rect(37, 64, 540, 260), color=None, fill=(1, 1, 1))  # invisible, spans both
    page.draw_rect(pymupdf.Rect(90, 70, 250, 150), fill=(0, 0, 1))
    _box(page, (55, 156, 290, 174), "Figure 4. A tree.", 9)
    _box(page, (301, 70, 540, 160), CODE + " " + CODE, 7)                    # code starts left of center
    for y in (190, 305, 420):
        _box(page, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
        _box(page, (330, y, 560, y + 100), BODY, 9)
    result = _save(doc, tmp_path / "code.pdf")
    fig = _figure(result, "Figure 4")
    assert fig["bbox"][2] < 301
    code = next(b for b in result["blocks"] if result["sentences"][b["sentenceIds"][0]]["text"].startswith("1 from"))
    assert code["id"] not in fig["blockIds"]


def test_multi_line_caption_above_a_table_is_not_in_the_image(tmp_path):
    doc = pymupdf.open()
    page = _new_page(doc)
    _box(page, (55, 66, 290, 84), "Table 3. Overall performance of agents.", 9)
    _box(page, (55, 79, 290, 111), "We show the lines of code to register the agent and the average time.", 9)
    _booktabs(page, 57, 288, (122, 134, 174), ["Agent LoC Time", "A 41 28.6", "B 49 43.7"])
    for y in (190, 305, 420):
        _box(page, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
        _box(page, (330, y - 120, 560, y - 20), BODY, 9)
    result = _save(doc, tmp_path / "mcap.pdf")
    table = _figure(result, "Table 3")
    cont = _block_with(result, "We show the lines of code to register the agent and the average time.")
    cont_bottom = max(r[3] for s in cont["sentenceIds"] for r in result["sentences"][s]["rects"])
    assert table["bbox"][1] >= cont_bottom - 1
    assert table["bbox"][3] >= 174
    assert cont["id"] not in table["blockIds"]


def test_stacked_table_and_figure_captions_in_one_column_split_the_graphics(tmp_path):
    doc = pymupdf.open()
    page = _new_page(doc)
    _box(page, (94, 262, 251, 280), "Table 5. Occurrences.", 9)
    _booktabs(page, 58, 284, (282, 296, 325), ["Agent find echo", "REACT 0 0"])
    page.draw_rect(pymupdf.Rect(70, 335, 280, 470), fill=(0, 1, 0))          # 10pt below the table
    _box(page, (55, 476, 280, 494), "Figure 6. Actions taken.", 9)
    for y in (70, 160):
        _box(page, (55, y, 290, y + 80), FILLER + " " + FILLER, 9)
    for y in (70, 185, 300, 415):
        _box(page, (330, y, 560, y + 100), BODY, 9)
    result = _save(doc, tmp_path / "stack.pdf")
    t5, f6 = _figure(result, "Table 5")["bbox"], _figure(result, "Figure 6")["bbox"]
    assert t5[1] >= 270 and t5[3] >= 325 and t5[3] <= 335
    assert f6[1] >= 325 and f6[3] <= 476 and f6[1] <= 335


def test_full_width_table_above_a_right_column_figure_stays_out_of_it(tmp_path):
    doc = pymupdf.open()
    page = _new_page(doc)
    _box(page, (55, 66, 545, 96), "Table 4. Agent performance by task. This table summarizes the results of "
         "every agent across detection, localization, RCA and mitigation.", 9)
    _booktabs(page, 55, 289, (104, 116, 150), ["Agent Acc", "A 69%", "B 23%"])
    _booktabs(page, 308, 541, (104, 116, 150), ["Agent Acc", "C 61%", "D 30%"])
    page.draw_rect(pymupdf.Rect(330, 165, 520, 270), fill=(1, 0.5, 0))      # 15pt below the table
    _box(page, (321, 276, 528, 294), "Figure 7. Action distribution.", 9)
    for y in (170, 285, 400):
        _box(page, (55, y, 290, y + 100), FILLER + " " + FILLER, 9)
    _box(page, (330, 310, 560, 410), BODY, 9)
    result = _save(doc, tmp_path / "fw.pdf")
    t4, f7 = _figure(result, "Table 4")["bbox"], _figure(result, "Figure 7")["bbox"]
    assert t4[0] <= 55 and t4[2] >= 541 and t4[3] <= 165
    assert f7[1] >= 150 and f7[0] >= 306 and f7[2] >= 520
