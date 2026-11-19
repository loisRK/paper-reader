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
    assert result["extractorVersion"] == 2
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
    assert result["figures"] == [{"label": "Figure 2", "page": 2, "captionSentenceId": "p2-s1"}]
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
    assert result["extractorVersion"] == 2
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
