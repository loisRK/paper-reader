# 원문 패널 그림·표 이미지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 원문 패널에서 그림·표·도표가 PDF와 같은 모양의 이미지로 보이고, 그 영역의 깨진 글자 조각은 접힌다.

**Architecture:** 추출기(PyMuPDF)가 캡션 기준으로 그림 영역을 찾아 PNG로 잘라 `<outputDir>/<id>/figures/`에 저장하고 `source.json`에 영역·파일명·접을 블록을 기록한다. 서버는 그 PNG를 안전하게 내려주고, 원문 패널은 캡션 앞에 이미지를 넣고 영역 안 블록을 `<details>`로 접는다.

**Tech Stack:** Python `.venv` PyMuPDF 2.1 (`page.get_image_info()`, `page.cluster_drawings()`, `page.find_tables()`, `page.get_pixmap(clip=, dpi=)`), Node ≥22 `node:http`, vanilla ES modules.

**Spec:** `docs/superpowers/specs/2026-11-18-paper-reader-design.md` — 3단계 "그림·표를 이미지로 보여주기".

## Global Constraints

- 문장 ID(`p{page}-s{n}`), 기존 `rects`·`pdfRects`, 블록 순서는 바꾸지 않는다(요약 근거와 Zotero 하이라이트가 그대로 동작해야 함).
- 그림 요소가 없는 캡션은 이미지를 만들지 않고 지금처럼 둔다(잘못 자른 이미지보다 글자가 낫다).
- 이미지 파일은 `<outputDir>/<id>/figures/` 아래에만 쓴다. 파일명은 `fig-<page>-<n>.png`(n = 페이지 안 순번) — 사용자 입력이 파일명에 들어가지 않는다.
- 서버는 127.0.0.1, 기존 Host 검사, `isSafeName`, 정적 경로 이탈 금지 규칙을 그대로 따른다. `image/png`만 내려준다.
- 원문 패널은 innerHTML을 쓰지 않는다. 이미지에는 `alt`(캡션 첫 문장)를 단다. 라이트/다크·모바일 폭에서 이미지가 패널 폭을 넘지 않는다(`max-width: 100%`).
- 런타임 npm 의존성 0, 사용자 문구는 한국어.

## Review Focus

1. **2단 논문에서 그림이 옆 단 본문까지 잘려 들어가는 경우** → 캡션이 한 단 폭이면 그 단으로 자른다(Task 1 fixture).
2. **페이지 머리말·쪽 번호가 그림 영역에 섞이는 경우** → 영역을 머리말·꼬리말 블록 밖으로 줄인다(Task 1).
3. **요약 🔗 근거가 접힌 그림 속 문장을 가리키는 경우** → 접힌 부분이 열리고 강조된다(Task 3).
4. **예전 추출본(`figures[].image` 없음)** → 화면이 지금처럼 동작한다(Task 3).
5. **이미지 요청 경로 조작(`..`, 다른 확장자)** → 400/404(Task 2).

---

### Task 1: 추출기 — 그림 영역 찾기와 PNG 저장

**Files:**
- Modify: `extract/extract_pdf.py`, `src/digest/extract-cli.mjs`(출력 폴더 인자 전달이 필요하면)
- Test: `tests/test_extract.py`

**Interfaces:**
- Produces: `source.figures[]` 각 항목에 `bbox: [x0,y0,x1,y1]`(MuPDF 좌표, 위쪽 원점), `image: "fig-<page>-<n>.png" | null`, `blockIds: string[]`(영역 안에 완전히 들어간 paragraph 블록 id). 각 해당 block에 `inFigure: "<label>"`. `EXTRACTOR_VERSION` +1.
- 추출기 CLI는 이미지 저장 폴더를 받는다(예: `--figures-dir <dir>`); 없으면 이미지는 만들지 않고 `image: null`.

- [ ] **Step 1: 실패 테스트** — 테스트 안에서 PyMuPDF로 2단 PDF를 만든다: 왼쪽 단에 사각형·선 몇 개(그림), 그 아래 `"Figure 1. Overview."`, 그림 안에 짧은 라벨 텍스트 `"Agent"`, 오른쪽 단에 본문 문장, 페이지 위 머리말 `"Running Header"`; 두 번째 페이지에 캡션 `"Table 1. Results."` 아래 선으로 그린 표.

```python
def test_figure_region_crops_to_caption_column_and_saves_png(tmp_path): ...
    # figures[0]: label "Figure 1", image "fig-1-1.png" exists, bbox inside left column (x1 <= page_width/2 + 10),
    # bbox excludes header (y0 > header bottom), "Agent" label block id in blockIds and that block has inFigure "Figure 1",
    # right-column body block NOT in blockIds
def test_table_region_below_caption(tmp_path): ...   # Table 1 bbox top >= caption bottom - 2
def test_caption_without_graphics_has_no_image(tmp_path): ...  # image None, blockIds []
def test_no_figures_dir_means_no_files_and_image_none(tmp_path): ...
def test_sentence_ids_unchanged_by_figure_detection(tmp_path): ...  # same ids as with detection disabled
```

- [ ] **Step 2: 실패 확인** — `.venv/bin/pytest -q tests/test_extract.py -k figure` → FAIL
- [ ] **Step 3: 구현** — 영역 규칙:
  1. 후보 그림 요소 = `get_image_info()` bbox ∪ `cluster_drawings()` 중 면적 ≥ 600pt² ∪ `find_tables()` bbox.
  2. 단 범위: 캡션 폭이 페이지 폭의 60% 미만이면 캡션 중심이 있는 단(`[0, w/2]` 또는 `[w/2, w]`), 아니면 페이지 전체. 후보를 단 범위로 자른다(교집합).
  3. 방향: Table은 캡션 아래를 먼저, Figure는 캡션 위를 먼저 본다. 캡션과 세로 간격 ≤ 24pt로 이어지는 후보를 연쇄적으로 합친다. 먼저 본 방향에 후보가 없으면 반대 방향.
  4. 머리말·꼬리말(페이지 위·아래 7% 안에 있는 블록)과 겹치는 부분은 잘라낸다. 다른 캡션 블록과 겹치지 않게 자른다.
  5. 합친 영역에 4pt 여백, 페이지 안으로 clamp. 면적 < 1500pt²면 그림 없음 처리.
  6. `page.get_pixmap(clip=bbox, dpi=150)`로 저장.
  7. 영역 안에 **완전히** 들어간 paragraph 블록 → `blockIds`, `inFigure`.
- [ ] **Step 4: 통과 확인** — `npm run test:py`, `npm test` → PASS
- [ ] **Step 5: Commit** — `feat(extract): crop figure and table regions to images`

### Task 2: 서버 — 그림 이미지 내려주기

**Files:**
- Modify: `src/reader/server.mjs` (또는 `src/reader/store.mjs`에 경로 해석 함수)
- Test: `tests/server.test.mjs`

**Interfaces:**
- Produces: `GET /api/papers/:id/figures/:name` → 200 `image/png`(바이트 그대로, `Cache-Control: no-cache`). `:id`는 `isSafeName`, `:name`은 `/^fig-\d+-\d+\.png$/`만 허용(아니면 400). 논문 폴더 → 없으면 예제 폴더 순서로 찾고, 없으면 404 `그림 파일을 찾을 수 없습니다.`
- `npm run extract`가 `--figures-dir <outputDir>/<id>/figures`를 넘기도록 `src/digest/extract-cli.mjs`를 고친다(Task 1이 이미 했으면 생략).

- [ ] **Step 1: 실패 테스트** — 200 + content-type png + 바이트 일치; `..%2Fsource.json` 400; `fig-1-1.jpg` 400; 없는 파일 404; 나쁜 Host 403.
- [ ] **Step 2~4:** RED → 구현 → `npm test` PASS
- [ ] **Step 5: Commit** — `feat(reader): serve extracted figure images`

### Task 3: 원문 패널 — 이미지 표시와 글자 조각 접기

**Files:**
- Modify: `src/reader/public/views/paper.js`, `src/reader/public/styles.css`
- Test: `tests/views.test.mjs`

**Interfaces:**
- Consumes: Task 1의 `figures[].{label,page,image,blockIds,captionSentenceId}`, Task 2 URL.
- Produces (순수 함수): `figureLayout(source): Map<blockId, { figure, role: 'image-before' | 'folded' }>` — 캡션 블록 앞에 이미지, `blockIds` 블록은 접기. `image`가 null이거나 없으면 빈 Map(예전 추출본은 그대로).
- 화면:
  - 캡션 블록 앞에 `<figure class="src-figure" id="fig-<label slug>"><img loading="lazy" alt="<캡션 첫 문장>" src="/api/papers/<id>/figures/<image>"></figure>`. 이미지를 누르면 새 탭에서 원본 크기로 연다.
  - `blockIds` 블록들은 이미지 바로 뒤 `<details class="fig-text"><summary>그림 속 글자 보기</summary>…</details>` 안으로 옮긴다(문장 span·ID 유지).
  - 🔗 근거가 접힌 문장을 가리키면 `details`를 열고 강조한다(참고문헌 접기와 같은 방식 — 기존 `closest('details')` 로직이 처리하는지 확인).
  - 요약 카드 그림 줄(`figureLine`)에 `원문에서 보기` 버튼 추가 → 원문 패널(모바일이면 시트를 열고) 해당 이미지로 스크롤. 이미지가 없는 그림은 버튼 없음.
  - 이미지 로드 실패 시 `<img>`를 숨기고 `그림을 불러오지 못했습니다 — Zotero에서 p.N 열기` 링크를 보인다.

- [ ] **Step 1: 실패 테스트** — `figureLayout`: 이미지 있는 그림 → 캡션 블록 'image-before', blockIds 'folded'; image null → 빈 Map; figures 없음 → 빈 Map.
- [ ] **Step 2~4:** RED → 구현 → `node --check`, `npm test` PASS
- [ ] **Step 5: Commit** — `feat(reader): show figure images in the source panel`

### Task 4: 실제 논문 확인 (컨트롤러)

- [ ] AIOpsLab 재추출 → 잘린 PNG 12개를 컨트롤러가 직접 열어 보고(이미지 Read) 영역이 맞는지 확인, 어긋난 그림은 원인과 함께 기록.
- [ ] `npm run check -- <id>` 통과(요약 근거 유지).
- [ ] 사용자에게 화면 확인 요청.
