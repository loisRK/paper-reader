# 1단계: PDF 보기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 원문 패널에 [PDF] [글로 읽기] 탭을 두고, PDF를 원본 모양 그대로 보여 주며, PDF 위에서 문장 단위 하이라이트·메모를 남기고(Zotero 연동 그대로), 요약 🔗 근거가 PDF 위치로 이동하게 한다.

**Architecture:** 추출기가 PDF 경로·MD5를 `source.json`에 기록하고 서버가 PDF를 내려준다. 브라우저는 저장소에 고정 버전으로 넣은 PDF.js로 쪽마다 canvas + 글자 선택 레이어를 그린다. PDF 좌표 ↔ 화면 좌표 변환과 "선택 영역 → 문장" 매칭은 DOM 없는 순수 모듈(`pdf-geom.js`)에 두고 Zotero 매칭 규칙과 공유한다. 메모 코드(`notes.js`)는 PDF 보기용 어댑터(선택 해석, 클릭 위치 → 문장, 표시 그리기)를 받는다. 메모 데이터 형식은 바꾸지 않는다.

**Tech Stack:** pdfjs-dist **6.5.438**(Apache-2.0, 2026-11-01 배포), Node ≥22 `node:http`, vanilla ES modules, Python PyMuPDF 2.1.

**Spec:** `docs/superpowers/specs/2026-11-19-pdf-view-and-colleague-app-design.md` — "1단계: PDF 보기"(0단계 디자인 토큰 적용 후).

## Global Constraints

- 메모 기록 형식(`notes.json`의 `highlights[].sentenceIds`, Zotero 주석 생성 경로)과 문장 ID·`pdfRects`는 바꾸지 않는다. PDF에서 만든 하이라이트도 글로 읽기·요약 카드·Zotero에서 같은 문장에 보인다.
- PDF 좌표 기준: `pdfRects`와 Zotero `annotationPosition.rects`는 PDF 사용자 좌표(왼쪽 아래 원점, `[x0, y0, x1, y1]`). 화면 ↔ PDF 변환은 PDF.js viewport의 `convertToPdfPoint` / `convertToViewportRectangle`로 한다(회전·잘림 상자 반영).
- 선택 → 문장 매칭 규칙은 Zotero 주석 매칭(`matchSentences`)과 같은 함수·같은 기준(주석 사각형의 30% 이상 겹침 **또는** 문장 면적의 50% 이상 겹침)을 쓴다. 규칙을 두 군데에 복사하지 않는다.
- PDF.js는 `src/reader/public/vendor/pdfjs/`에 넣고 버전 `6.5.438`을 파일(`VERSION`)과 내려받기 스크립트에 고정한다. `LICENSE`를 함께 둔다. 런타임 npm 의존성은 0으로 유지한다(`package.json` dependencies 없음).
- 서버는 127.0.0.1, 기존 Host 검사, `isSafeName`, 정적 경로 이탈 금지 규칙을 그대로 따른다. PDF 응답은 `application/pdf`, 일반 파일 + `.pdf` 확장자만.
- 화면 문구는 한국어. innerHTML 금지(기존 `el()` 사용). 디자인은 0단계 토큰(`--accent`, `--surface`, `--line`, `--radius` 등)만 쓴다. 다크 모드에서도 PDF 쪽은 원본 색(반전 없음).
- 사용자가 고른 탭은 `localStorage`(키 `paper-reader:source-tab`)에 기억하되 모든 읽기·쓰기는 try/catch. 실패해도 PDF 기본으로 동작.
- 예제 논문(`examples/`)은 PDF가 없다 → PDF 탭에 이유 한 줄, 글로 읽기로 연다.
- `digests/`·개인 경로·PDF는 커밋하지 않는다.

## Review Focus

1. **회전된 쪽, 잘림 상자(cropbox)가 미디어 상자와 다른 PDF** → 하이라이트 사각형이 글자 위에 정확히 그려진다(pdf-geom 시험에 회전 90° viewport 사례).
2. **선택이 두 단 사이를 가로지르거나 그림 속 글자만 걸친 경우** → 걸친 문장만 고르고, 문장이 없으면 도구 막대를 띄우지 않는다.
3. **글로 읽기에서 단 하이라이트를 PDF 탭에서 보고, PDF에서 단 것을 글로 읽기에서 본다** → 탭을 바꿔도 메모 창·표시가 같은 데이터로 갱신된다.
4. **PDF 파일이 없어졌거나 경로 기록이 없는 예전 추출본** → Zotero 재검색, 그래도 없으면 404 안내 + 글로 읽기.
5. **확대/축소 후** 하이라이트·근거 깜빡임·선택 매칭 좌표가 여전히 맞는다(변환이 viewport 기준이어야 함).

---

### Task 1: PDF 경로 기록과 PDF 내려주기

**Files:**
- Modify: `extract/extract_pdf.py`(`EXTRACTOR_VERSION` 4, `source.pdf = { path, md5 }`), `src/digest/extract-cli.mjs`(필요 시), `src/reader/server.mjs`, `src/reader/store.mjs`
- Test: `tests/test_extract.py`, `tests/server.test.mjs`

**Interfaces:**
- Produces: `source.pdf: { path: string (절대 경로), md5: string (소문자 hex) }`.
- Produces: `GET /api/papers/:id/pdf` → 200 `application/pdf`(바이트 그대로, `Cache-Control: no-cache`, `Content-Length`). 찾는 순서: ① `source.pdf.path`가 일반 파일 + `.pdf` → ② `source.zotero.itemKey`가 있으면 `resolveItem(itemKey)`의 `pdfPath`(Zotero 꺼져 있으면 건너뜀) → ③ 404 `PDF 파일을 찾을 수 없습니다. 파일이 옮겨졌다면 다시 추출하세요.`
- Produces: 논문 데이터 응답(`GET /api/papers/:id`)의 `links.pdf: boolean` — PDF를 찾을 수 있으면 true(②를 위해 Zotero를 부르지 않게 ①만으로 판단하고, ①이 실패하면 itemKey 유무로 true). 예제 폴더 논문은 false.

- [ ] **Step 1: 실패 시험** — 추출: 만든 PDF로 추출 → `pdf.path`가 입력 경로의 절대 경로, `pdf.md5`가 `hashlib.md5` 값, `extractorVersion == 4`. 서버: 200 + 바이트 일치 + content-type; `source.pdf.path`가 `.txt`면 404; 경로 없음 + itemKey 없음 404; 나쁜 Host 403; 예제 논문 `links.pdf === false`; 경로 기록이 없고 itemKey가 있으면 주입한 `resolveItem` 스텁 경로로 200.
- [ ] **Step 2:** RED 확인 — `npm run test:py`, `npm test`
- [ ] **Step 3:** 구현. 서버의 `resolveItem`은 시험에서 주입할 수 있게 `createServer` 옵션으로 받는다(기존 주입 방식이 있으면 그것을 따른다).
- [ ] **Step 4:** GREEN — `npm run test:py && npm test`
- [ ] **Step 5: Commit** — `feat: record PDF path and serve the PDF`

### Task 2: PDF.js 넣기와 정적 파일 형식

**Files:**
- Create: `scripts/vendor-pdfjs.mjs`, `src/reader/public/vendor/pdfjs/`(`pdf.min.mjs`, `pdf.worker.min.mjs`, `pdf_viewer.css` 중 글자 레이어 규칙, `standard_fonts/`, `cmaps/`, `LICENSE`, `VERSION`)
- Modify: `src/reader/server.mjs`(정적 MIME), `package.json`(스크립트 `vendor:pdfjs`만 추가), `README.md`(서드파티 고지 한 줄)
- Test: `tests/server.test.mjs`

**Interfaces:**
- Produces: 브라우저에서 `import('/vendor/pdfjs/pdf.min.mjs')`, worker `/vendor/pdfjs/pdf.worker.min.mjs`, `standardFontDataUrl: '/vendor/pdfjs/standard_fonts/'`, `cMapUrl: '/vendor/pdfjs/cmaps/'`, `cMapPacked: true`.
- `scripts/vendor-pdfjs.mjs`: npm 레지스트리에서 `pdfjs-dist@6.5.438` tarball을 받아 `npm view`가 주는 `dist.integrity`(sha512)로 검증 후 위 파일만 풀어 넣는다(Node 내장 `zlib` + 간단한 tar 해석, 외부 의존성 없음). 이미 같은 VERSION이면 아무것도 안 한다.

- [ ] **Step 1: 실패 시험** — 서버가 `.mjs` → `text/javascript; charset=utf-8`, `.css` → `text/css`, `.bcmap` → `application/octet-stream`, `.pfb`/`.ttf` → `application/octet-stream` 또는 `font/ttf`로 응답; `/vendor/pdfjs/VERSION` 내용이 `6.5.438`.
- [ ] **Step 2:** RED
- [ ] **Step 3:** 스크립트 작성 후 실행해 파일을 넣는다. 들어간 파일 목록과 총 크기를 보고서에 적는다. `pdf_viewer.css`는 `.textLayer` 관련 규칙만 남긴 파일로 넣어도 된다(출처 주석 유지).
- [ ] **Step 4:** GREEN — `npm test`
- [ ] **Step 5: Commit** — `build: vendor pdf.js 6.5.438`

### Task 3: PDF 좌표 순수 모듈과 Zotero 주석 위치 보관

**Files:**
- Create: `src/reader/public/views/pdf-geom.js`
- Modify: `src/zotero/annotations.mjs`(`matchSentences`가 `pdf-geom.js`의 매칭 함수를 쓰도록), `src/notes/sync.mjs`(pull한 Zotero 주석에 `rects`, `page` 보관)
- Test: `tests/pdf-geom.test.mjs`, 기존 `tests/*annotations*`·`tests/notes-sync.test.mjs`

**Interfaces:**
- Produces (모두 DOM 없음):
  - `matchRects(rects: number[][], page: number, source) => string[]` — 기존 `matchSentences`의 핵심(같은 30%/50% 기준, 문장 순서대로). `matchSentences(annotationData, source)`는 이것을 불러 `{page, sentenceIds}`를 돌려준다(동작 동일).
  - `clientRectsToPdf(rects: {left,top,right,bottom}[], pageBox: {left, top}, viewport) => number[][]` — 쪽 요소 기준 화면 좌표 → `viewport.convertToPdfPoint`로 PDF 좌표, `[minX, minY, maxX, maxY]`로 정규화, 너비·높이 0 사각형 제외.
  - `pdfRectToCss(rect, viewport) => {left, top, width, height}` — `viewport.convertToViewportRectangle` + 정규화.
  - `sentenceAtPoint(x, y, page, source, sids?) => string|null` — PDF 좌표 점을 포함하는 문장(후보 `sids`가 주어지면 그 안에서만, 예: 표시된 문장만).
- Produces: `notes.zoteroAnnotations[]`에 `rects: number[][]`(Zotero `annotationPosition.rects` 그대로) 추가. 예전 notes.json(없음)도 읽힌다.

- [ ] **Step 1: 실패 시험** — viewport 스텁(`convertToPdfPoint`, `convertToViewportRectangle`를 scale·회전 0°/90° 행렬로 구현): 왕복 변환 ±0.5pt; 두 문장에 걸친 선택 → 두 ID; 그림 속(문장 없는) 선택 → `[]`; `matchSentences` 기존 시험 그대로 통과; `sentenceAtPoint` 경계; sync pull 후 `rects` 보관.
- [ ] **Step 2:** RED
- [ ] **Step 3:** 구현. 서버 쪽 `annotations.mjs`는 `../reader/public/views/pdf-geom.js`를 import(브라우저·Node 공용, DOM 없음).
- [ ] **Step 4:** GREEN — `npm test`
- [ ] **Step 5: Commit** — `feat: shared PDF geometry and sentence matching`

### Task 4: PDF 보기 화면과 탭

**Files:**
- Create: `src/reader/public/views/pdf-view.js`
- Modify: `src/reader/public/views/paper.js`, `src/reader/public/styles.css`
- Test: `tests/views.test.mjs`(순수 함수만)

**Interfaces:**
- Consumes: Task 1 `links.pdf`, `/api/papers/:id/pdf`; Task 2 vendor 경로; Task 3 `pdfRectToCss`, `clientRectsToPdf`.
- Produces: `createPdfView({ paperId, source, container, onError }) => {`
  - `ready: Promise<void>` (문서 열림),
  - `scrollToSentences(sids: string[]): boolean` (해당 쪽으로 스크롤 후 문장 사각형 깜빡임, 찾지 못하면 false),
  - `scrollToPage(page: number): void`,
  - `setMarks(marks: Map<sid, {color?: string, zotero?: boolean}>, zoteroRects: {page, rects, color}[])`,
  - `setEvidence(sids: string[])`(현재 카드 근거 옅은 표시),
  - `zoom(dir: 'fit'|'in'|'out')`, `pageLayer(page) => {el, viewport} | null`, `dispose()` `}`.
- Produces (순수): `initialSourceTab({ hasPdf, stored }) => 'pdf'|'text'`.
- 화면 규칙:
  - 쪽마다 `div.pdf-page`(크기 고정 자리) 안에 canvas → 표시 레이어(`div.pdf-marks`, `pointer-events: none`) → 글자 레이어(`div.textLayer`). 보이는 쪽 ±1만 그린다(`IntersectionObserver`), HiDPI는 `devicePixelRatio`. 화면 밖으로 멀어진 쪽의 canvas는 비워 메모리를 돌려준다.
  - 기본 확대 = 패널 폭 맞춤. `− / 맞춤 / +` 버튼(0.1 단계, 50%–300%). 확대 후 현재 쪽 위치를 유지한다.
  - 원문 패널 머리에 탭 `[PDF] [글로 읽기]`(`role="tablist"`, 키보드 ←/→). 두 보기 DOM은 모두 만들어 두고 `hidden`으로 바꾼다(메모 표시·스크롤 위치 유지).
  - 🔗 근거·카드 근거 표시·"원문에서 보기": PDF 탭이면 `scrollToSentences`/`setEvidence`(그림은 캡션 문장으로), 글로 읽기면 지금 동작. 모바일 시트 열기 동작은 그대로.
  - PDF 로드 실패 → PDF 탭 안에 `PDF를 열 수 없습니다: <이유>` + "글로 읽기로 보기" 버튼, 자동으로 글로 읽기 탭 선택. 예제·`links.pdf=false`면 PDF 탭에 `이 논문은 PDF가 없어 글로만 볼 수 있습니다.`
- [ ] **Step 1: 실패 시험** — `initialSourceTab`: hasPdf false → 'text'; stored 'text' → 'text'; 그 외 'pdf'.
- [ ] **Step 2:** RED
- [ ] **Step 3:** 구현. PDF.js는 탭이 처음 열릴 때 동적 import(글로 읽기만 쓰면 내려받지 않음).
- [ ] **Step 4:** GREEN — `node --check` 모든 변경 파일, `npm test`
- [ ] **Step 5: 화면 확인 자료** — 헤드리스 Chrome(CDP)으로 AIOpsLab 논문 PDF 탭 캡처(1쪽, 9쪽), 확대 후 캡처. 스크래치 폴더에 저장, 보고서에 경로.
- [ ] **Step 6: Commit** — `feat(reader): PDF view tab in the source panel`

### Task 5: PDF 위 하이라이트·메모

**Files:**
- Modify: `src/reader/public/views/notes.js`, `src/reader/public/views/paper.js`, `src/reader/public/styles.css`
- Test: `tests/views.test.mjs`

**Interfaces:**
- Consumes: Task 3 `clientRectsToPdf`, `matchRects`, `sentenceAtPoint`; Task 4 `createPdfView` 핸들.
- Produces: `setupNotes({ ..., pdf })` — `pdf`가 주어지면(Task 4 핸들 + 컨테이너):
  - 선택: PDF 글자 레이어 안의 선택이면 `range.getClientRects()` → 쪽별 `clientRectsToPdf` → `matchRects` → 문장 ID. 결과가 비면 도구 막대 없음. 두 쪽 이상에 걸치면 지금과 같은 `MULTI_PAGE_TEXT`.
  - 클릭: 선택이 비어 있을 때 클릭 점 → PDF 좌표 → `sentenceAtPoint`(표시된 문장 후보만) → 메모 창(기존 `openPopover`, 위치는 그 문장의 첫 사각형).
  - 표시: `renderMarks()`가 글로 읽기 `.sent` 갱신과 함께 `pdf.setMarks(...)`를 부른다(내 하이라이트 = 문장 `pdfRects`에 하이라이트 색 38% 반투명, Zotero 주석 = 저장된 `rects`에 점선 테두리; `rects` 없는 예전 데이터는 `sentenceIds`의 `pdfRects`로 대신).
  - 메모 창 바깥 클릭 판정(`popoverDownAction`)은 PDF 표시 문장에도 같은 규칙.
- Produces (순수, 시험 대상): `pdfSelectionResult({ pageRects: Map<page, number[][]>, source }) => { ids: string[], pages: Set<number> }`.
- [ ] **Step 1: 실패 시험** — `pdfSelectionResult`: 한 쪽 두 문장 → 두 ID, 두 쪽 → pages.size 2, 빈 결과 → ids [].
- [ ] **Step 2:** RED
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** GREEN — `npm test`
- [ ] **Step 5: 화면 확인 자료** — CDP로 AIOpsLab PDF 탭에서 기존 하이라이트(예: p2-s18) 표시 캡처. (실제 Zotero 쓰기는 하지 않는다.)
- [ ] **Step 6: Commit** — `feat(reader): highlights and memos on the PDF view`

### Task 6: 실제 논문 확인 (컨트롤러)

- [ ] AIOpsLab 재추출(`npm run extract -- ChenEtAlAIOpsLabHolisticFrameworkEvaluateAIAgents2025`) → `source.pdf` 기록, `npm run check` 통과.
- [ ] 브라우저 캡처로 PDF 탭·근거 이동·표시 확인, Zotero 사용자 하이라이트(보라색)가 PDF 위 올바른 줄에 그려지는지 확인.
- [ ] 사용자에게 화면 확인 요청(PDF에서 새 하이라이트 → Zotero 반영은 사용자가 직접).
