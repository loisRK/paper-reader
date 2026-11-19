# 2차: Zotero 메모 실시간 연동 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 읽기 앱 원문 패널에서 단 하이라이트·메모가 Zotero PDF의 같은 위치 annotation으로 생기고, Zotero에서 단 annotation이 읽기 앱에 보이며, 요약 카드 메모가 Zotero child note로 저장된다.

**Architecture:** 브라우저는 읽기 앱 서버(127.0.0.1)만 호출한다. 서버가 Zotero 10 로컬 API(`/api/`)에 로컬 키로 쓴다. 로컬 기록(`notes.json`)이 기준이고, Zotero로 못 보낸 작업은 `pending.json`에 쌓았다가 재전송한다. 백그라운드 타이머 없이, 논문 화면이 5초마다 `GET /notes`를 부르면 서버가 그때 대기열 전송 + Zotero 변경분 가져오기를 한다.

**Tech Stack:** Node ≥22 ESM (런타임 npm 의존성 0), `node:test`; Python `.venv` + PyMuPDF 2.1 (추출기); vanilla ES modules 프런트엔드.

**Spec:** `docs/superpowers/specs/2026-11-18-paper-reader-design.md` — "4단계: Zotero 메모 실시간 연동" 절과 "제약 → Zotero" 항목.

## Global Constraints

- Zotero 로컬 API `http://localhost:23119/api/` 사용(설정 `zotero.baseUrl`, 기본 `http://127.0.0.1:23119`). Zotero Web API 키는 쓰지 않는다.
- 쓰기 키: `POST /api/local/authorize` + 헤더 `Zotero-Server-ID`, body `{ "appName": "Paper Reader" }` → 200 `{ key, remember }` / 403 `{ denied: true }` / 429 + `Retry-After`. `remember:false`면 키는 첫 쓰기에 소모된다.
- 모든 쓰기 요청: 헤더 `Zotero-API-Key: <key>`, `Zotero-Server-ID: <id>`, `Content-Type: application/json`. 쓰기 401 → 한 번 재인가 후 재시도. 412(Server ID 불일치) → 캐시(키·버전·Zotero key 매핑) 폐기.
- Zotero 7~9(응답에 `Zotero-Server-ID` 없음 또는 `X-Zotero-Version` 주 버전 < 10) → 읽기 전용 모드, 화면 문구 정확히: `Zotero 10 이상에서만 메모를 Zotero로 보낼 수 있습니다. 메모는 이 컴퓨터에 저장됩니다.`
- 읽기 앱이 만든 annotation·note에는 태그 `paper-reader`를 붙인다. 읽기 앱은 **자신이 만든 것(notes.json에 key가 있고 태그도 있는 것)만** 수정·삭제한다. 사용자가 Zotero에서 만든 것은 읽기만 한다.
- Zotero가 꺼져 있거나 쓰기가 실패하면 작업을 `<outputDir>/<id>/pending.json`에 보관하고 화면에 `Zotero 연결 대기 중`을 표시, 연결되면 재전송한다. **메모는 절대 버리지 않는다.**
- 같은 대상을 양쪽에서 고친 경우 Zotero 쪽을 기준으로 하고, 덮어쓰이기 전 읽기 앱 쪽 내용을 화면에 보여준다.
- 카드 메모는 논문 항목의 child note 하나(제목 `Paper Reader 메모`)에 카드별 제목 아래로 모은다.
- 서버는 127.0.0.1에만 바인딩. 기존 Host 검사(403), POST/PUT의 `Content-Type: application/json` 요구(415), 이름 규칙 `isSafeName`을 새 라우트에도 그대로 적용한다.
- 개인 경로·키를 커밋하지 않는다. 로컬 키는 `./data/zotero-auth.json`(git 제외, 파일 권한 600)에 Server ID별로 저장한다.
- 모든 사용자 문구는 한국어.

## Review Focus

1. **회전·cropbox가 있는 PDF 페이지**: 하이라이트가 Zotero에서 엉뚱한 위치에 생기면 안 된다 → Task 1 회전(90°)·cropbox 오프셋 fixture 테스트.
2. **"허용"이 아니라 "한 번만 허용"을 누른 사용자**: 다음 쓰기에서 다시 창이 뜨는 게 정상이고, 그 사이 메모가 사라지면 안 된다 → Task 2 `remember:false` 테스트, Task 4 401 후 대기열 유지 테스트.
3. **예전 추출본(source.json에 `pdfRects` 없음)**: 하이라이트 버튼을 눌러도 조용히 실패하면 안 되고 "다시 추출" 안내가 나와야 한다 → Task 6 테스트.
4. **사용자가 Zotero에서 읽기 앱 하이라이트를 지우거나 고친 경우**: 읽기 앱이 되살리거나 덮어쓰면 안 된다 → Task 4 테스트.
5. **Zotero 중간에 꺼짐 / 다른 Zotero 프로필(Server ID 변경)**: 쓰기가 다른 라이브러리로 가면 안 된다 → Task 2 412 테스트, Task 4 Server ID 변경 테스트.

## 전제

- 시작 전 1차 브랜치(`feat/phase1-reader`)와 미커밋 요약 형식 변경의 처리(커밋·병합)를 사용자에게 확인한다. 이 계획은 그 위에서 새 브랜치 `feat/phase2-zotero-sync`로 진행한다.
- Task 2 마지막 단계와 Task 8은 **사용자의 실제 Zotero 라이브러리에 쓴다.** 실행 전 사용자에게 확인을 받고, 사용자가 허용 창을 직접 누른다.

---

### Task 1: PDF 좌표 → Zotero 좌표 (회전·cropbox 처리)

**Files:**
- Modify: `extract/extract_pdf.py` (문장 레코드 생성부, `EXTRACTOR_VERSION`)
- Test: `tests/test_extract.py`

**Interfaces:**
- Produces: `source.json`의 각 문장에 `pdfRects: [[x1, y1, x2, y2], ...]` — PDF 사용자 공간(왼쪽 아래 원점, 회전 전 페이지), 소수 1자리. 각 페이지에 `rotation: 0|90|180|270`. `extractorVersion`을 1 올린다.
- 기존 `rects`(PyMuPDF 화면 좌표)는 그대로 둔다.

- [ ] **Step 1: 실패 테스트 작성** — PyMuPDF로 테스트 안에서 PDF를 만든다.

```python
def test_pdf_rects_unrotated_bottom_left(tmp_path):
    # 612x792 page, text inserted with baseline at y=100 from top
    src = extract(make_pdf(tmp_path, rotation=0, text_at=(72, 100)))
    r = first_sentence(src)["pdfRects"][0]
    assert r[0] == pytest.approx(72, abs=2)
    assert 792 - 100 - 2 <= r[3] <= 792 - 100 + 12   # top edge near baseline, flipped
    assert r[1] < r[3]

def test_pdf_rects_rotated_page_maps_back_to_unrotated_space(tmp_path):
    src = extract(make_pdf(tmp_path, rotation=90, text_at=(72, 100)))
    assert src["pages"][0]["rotation"] == 90
    r = first_sentence(src)["pdfRects"][0]
    # same unrotated insertion point as the rotation=0 case
    assert r[0] == pytest.approx(72, abs=2)
    assert 792 - 100 - 2 <= r[3] <= 792 - 100 + 12

def test_pdf_rects_respect_cropbox_offset(tmp_path):
    src = extract(make_pdf(tmp_path, rotation=0, text_at=(72, 100), cropbox=(36, 36, 576, 756)))
    r = first_sentence(src)["pdfRects"][0]
    assert r[0] == pytest.approx(72, abs=2)   # PDF user space, not crop-relative
```

`make_pdf`는 `page.insert_text(point, "Hello world. Second sentence.")` 후 `page.set_rotation()`·`page.set_cropbox()`를 적용해 저장하는 테스트 헬퍼다(회전·cropbox는 텍스트 삽입 **후** 적용해 삽입 좌표가 회전 전 공간 기준이 되게 한다).

- [ ] **Step 2: 실패 확인** — Run: `.venv/bin/pytest -q tests/test_extract.py -k pdf_rects` → FAIL (`KeyError: 'pdfRects'`)

- [ ] **Step 3: 구현** — 각 rect에 `fitz.Rect(r) * ~page.transformation_matrix`를 적용하고 정규화(`normalize()`)해 PDF 사용자 공간 좌표를 얻는다. `transformation_matrix`가 회전과 cropbox를 모두 반영한다. 페이지에 `rotation: page.rotation`을 기록한다.

- [ ] **Step 4: 통과 확인** — Run: `npm run test:py` → 전체 PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(extract): add PDF user-space pdfRects and page rotation"`

---

### Task 2: Zotero 쓰기 클라이언트

**Files:**
- Create: `src/zotero/write.mjs`
- Modify: `src/config.mjs` (기본값 `zotero.authFile: './data/zotero-auth.json'`)
- Test: `tests/zotero-write.test.mjs`

**Interfaces:**
- Consumes: `cfg.zotero.baseUrl`, `cfg.zotero.authFile`.
- Produces:
  - `getServerInfo(cfg, opts?): Promise<{ running: boolean, serverId: string|null, version: string|null, writable: boolean }>` — `GET <base>/api/`; `writable` = serverId 있음 && 주 버전 ≥ 10.
  - `class ZoteroWriteError extends Error { code: 'offline'|'denied'|'rate-limited'|'server-changed'|'readonly'|'http' ; status?: number; retryAfter?: number }`
  - `createZoteroWriter(cfg, opts?: { fetchImpl?, authStore? }): { serverId(): Promise<string>, createItems(items: object[]): Promise<{ success: Record<string,string>, failed: Record<string,object> }>, patchItem(key, version, data): Promise<number /*new version*/>, deleteItem(key, version): Promise<void>, getItem(key): Promise<object|null>, listChildren(parentKey, sinceVersion?): Promise<{ items: object[], libraryVersion: number, notModified: boolean }> }`
  - `fileAuthStore(path)` → `{ get(serverId): Promise<string|null>, set(serverId, key): Promise<void>, clear(serverId): Promise<void> }` — JSON `{ [serverId]: key }`, 원자적 쓰기, 권한 600.
- 규칙: 쓰기 전 키가 없으면 `POST /api/local/authorize`(`appName: "Paper Reader"`). `remember:true`일 때만 저장. 쓰기 401 → 저장 키 삭제 후 1회 재인가·재시도. 403 → `denied`. 429 → `rate-limited`(+`retryAfter`). 412 → `server-changed`(저장 키 삭제). `fetch` 예외 → `offline`. `patchItem`/`deleteItem`은 `If-Unmodified-Since-Version: <version>`; 412가 버전 충돌이면 `code:'http', status:412`로 구분한다(응답 Server ID가 캐시와 같으면 버전 충돌).
- `listChildren`은 `GET /api/users/0/items/<parentKey>/children?format=json`, `sinceVersion`이 있으면 헤더 `If-Modified-Since-Version` → 304면 `notModified:true`. `libraryVersion`은 `Last-Modified-Version` 헤더.

- [ ] **Step 1: 실패 테스트 작성** (가짜 `fetchImpl`, 실제 Zotero 호출 없음)

```js
test('authorize with remember:true stores key and sends both headers on write', ...)
  // expect POST /api/local/authorize body {appName:'Paper Reader'} with Zotero-Server-ID
  // then POST /api/users/0/items with Zotero-API-Key and Zotero-Server-ID
  // authStore.get(serverId) === key
test('remember:false key is used once and not stored; next write authorizes again', ...)
test('write 401 clears stored key, re-authorizes once, retries', ...)
test('authorize 403 → ZoteroWriteError code denied', ...)
test('authorize 429 → code rate-limited with retryAfter seconds', ...)
test('412 with different Zotero-Server-ID → code server-changed and key cleared', ...)
test('fetch throws → code offline', ...)
test('Zotero 9 (no Zotero-Server-ID header) → getServerInfo writable false; write → code readonly', ...)
test('listChildren sends If-Modified-Since-Version and maps 304 to notModified', ...)
test('fileAuthStore writes mode 0o600 and round-trips', ...)
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/zotero-write.test.mjs` → FAIL (모듈 없음)
- [ ] **Step 3: 구현** — 위 Interfaces대로. `.gitignore`에 `data/`가 이미 있는지 확인(있음).
- [ ] **Step 4: 통과 확인** — Run: `npm test` → 전체 PASS
- [ ] **Step 5: 실제 Zotero 확인 (사용자 확인 후)** — 사용자에게 "Zotero에 허용 창이 뜨고, AIOpsLab PDF에 시험용 하이라이트 1개를 만들었다가 지웁니다"라고 알리고 승인받는다. `node scripts/zotero-probe.mjs <attachmentKey>`(이 Task에서 만드는 일회용 스크립트, 커밋하지 않음)로 authorize → annotation 1개 생성(Task 3 형식) → `getItem` → `deleteItem`. 결과(상태코드, 생성 key)를 보고서에 남긴다. 로컬 API가 annotation 생성을 거부하면 **여기서 멈추고 사용자에게 보고**한다(이후 Task 전제가 무너짐).
- [ ] **Step 6: Commit** — `git commit -m "feat(zotero): local API writer with local-key authorization"`

---

### Task 3: annotation 변환·매칭 (순수 함수)

**Files:**
- Create: `src/zotero/annotations.mjs`
- Test: `tests/annotations.test.mjs`

**Interfaces:**
- Consumes: `source.json` (Task 1의 `pdfRects`, `pages[].height`).
- Produces:
  - `ZOTERO_COLORS = { yellow:'#ffd400', red:'#ff6666', green:'#5fb236', blue:'#2ea8e5', purple:'#a28ae5', magenta:'#e56eee', orange:'#f19837', gray:'#aaaaaa' }`, 기본 `'#ffd400'`.
  - `TAG = 'paper-reader'`
  - `toZoteroAnnotation({ sentenceIds, color, comment }, source, attachmentKey): object` → `{ itemType:'annotation', parentItem: attachmentKey, annotationType:'highlight', annotationText, annotationComment, annotationColor, annotationPageLabel: String(page), annotationSortIndex, annotationPosition: JSON.stringify({ pageIndex: page-1, rects }), tags:[{tag:'paper-reader'}] }`. `annotationText` = 문장 text를 공백으로 이은 것. `rects` = 해당 문장들의 `pdfRects` 합. 모든 문장이 같은 페이지여야 한다(아니면 `Error('한 하이라이트는 한 페이지 안의 문장만 담을 수 있습니다.')`). `pdfRects` 없는 문장이 있으면 `Error('NEEDS_REEXTRACT')`.
  - `sortIndex(pageIndex, charOffset, top): string` → `` `${pad5(pageIndex)}|${pad6(charOffset)}|${pad5(top)}` ``. `charOffset` = 같은 페이지에서 앞선 문장들의 text 길이 합, `top` = `Math.floor(pageHeight - max(y2))`(0 미만이면 0).
  - `matchSentences(annotationData, source): { page: number, sentenceIds: string[] }` — `annotationPosition`을 파싱해 같은 페이지 문장 중 `pdfRects`와 겹치는 면적이 annotation rect 면적의 30% 이상인 문장을 문장 순서대로 반환. 없으면 `sentenceIds: []`(화면은 페이지 끝에 표시). 파싱 실패·note/ink 등 rect 없는 annotation도 `sentenceIds: []`.
  - `isMine(item): boolean` — 태그에 `paper-reader`.

- [ ] **Step 1: 실패 테스트 작성**

```js
test('toZoteroAnnotation builds highlight with pageIndex, joined text, tag', ...)
  // annotationPosition parses to { pageIndex: 0, rects: [...pdfRects of both sentences] }
  // tags deepEqual [{ tag: 'paper-reader' }], annotationColor '#ffd400' by default
test('sortIndex pads to 00000|000123|00045', () => assert.equal(sortIndex(0, 123, 45), '00000|000123|00045'))
test('sentences on two pages → throws one-page error', ...)
test('missing pdfRects → throws NEEDS_REEXTRACT', ...)
test('matchSentences returns overlapping sentence ids in order', ...)
test('matchSentences: no overlap or note annotation → empty ids with page', ...)
test('isMine true only with paper-reader tag', ...)
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/annotations.test.mjs` → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(zotero): annotation mapping between sentences and Zotero positions"`

---

### Task 4: 로컬 메모 기록·대기열·동기화

**Files:**
- Create: `src/notes/store.mjs`, `src/notes/sync.mjs`
- Test: `tests/notes-sync.test.mjs`

**Interfaces:**
- Consumes: Task 2 writer, Task 3 함수, `resolveItem`이 아닌 `source.zotero.{itemKey, attachmentKey}`.
- Produces:
  - `notes.json` 형식: `{ version: 1, serverId: string|null, highlights: [{ id, sentenceIds, color, comment, zoteroKey|null, zoteroVersion|null, conflict|null, createdAt }], cardMemos: { [cardId]: string }, note: { zoteroKey|null, zoteroVersion|null }, zoteroAnnotations: [{ key, page, sentenceIds, text, comment, color }], libraryVersion: number|null }`. `id`는 `h-<랜덤 8자>`. `conflict` = `{ mine: { comment, color }, at }`.
  - `pending.json` 형식: `{ ops: [{ op: 'upsert-highlight'|'delete-highlight'|'upsert-note', id?, at }] }` — 대상 id만 담고, 내용은 항상 `notes.json`에서 읽는다(같은 대상 연속 수정은 op 하나로 합친다).
  - `readNotes(outputDir, id)`, `writeNotes(outputDir, id, notes)`, `readPending`, `writePending` — 원자적 쓰기(임시 파일 + rename), 파일 없으면 기본값.
  - `addHighlight(outputDir, id, { sentenceIds, color, comment })`, `updateHighlight(outputDir, id, hid, { color?, comment? })`, `removeHighlight(outputDir, id, hid)`, `setCardMemo(outputDir, id, cardId, text)` — 로컬에 먼저 저장하고 pending op를 추가한다. 같은 논문에 대한 호출은 논문별 Promise 체인으로 직렬화한다.
  - `syncPaper(outputDir, id, { source, cards, writer, serverInfo }): Promise<{ status: 'connected'|'offline'|'readonly'|'needs-auth'|'denied'|'rate-limited', pending: number, message: string|null }>`
    1. `serverInfo.running` false → `offline`. `writable` false → `readonly`(pull만 수행).
    2. `notes.serverId`가 있고 현재와 다르면: 모든 `zoteroKey/zoteroVersion/note`·`libraryVersion`을 비우고 모든 하이라이트·카드 메모를 pending에 다시 넣는다(다른 라이브러리에 쓰지 않음, 새 라이브러리에 새로 만듦).
    3. pending flush(앞에서부터): upsert-highlight → `zoteroKey` 없으면 create, 있으면 patch(If-Unmodified-Since-Version). delete-highlight → 내 것이면 delete, 404면 성공 취급. upsert-note → `noteHtml` 내용으로 create/patch. 실패하면 그 op부터 남기고 중단: `offline`/`denied`/`rate-limited` → 해당 status 반환, `NEEDS_REEXTRACT` → op 유지, message `원문을 다시 추출해야 Zotero에 보낼 수 있습니다: npm run extract -- <id>`.
    4. 버전 충돌(412 같은 서버) → Zotero 항목을 받아 로컬 하이라이트를 Zotero 값으로 바꾸고 `conflict.mine`에 내 값을 보관, op 제거.
    5. pull: `listChildren(attachmentKey, libraryVersion)` → 304면 생략. 아니면 annotation 전체로 `zoteroAnnotations`(내 것이 아닌 것, `matchSentences` 결과 포함)를 다시 만들고, 내 것은 Zotero 값(comment·color·version)으로 로컬을 갱신한다. 내 `zoteroKey`가 Zotero에 없으면(사용자가 Zotero에서 지움) 로컬 하이라이트도 지운다(되살리지 않음). 같은 방식으로 논문 항목의 child note(`note.zoteroKey`)도 확인하고, 사용자가 Zotero에서 고쳤으면 카드 메모를 덮어쓰지 않고 `note.conflict = { at }`만 표시한다.
  - `noteHtml(cards, cardMemos): string` → `<h1>Paper Reader 메모</h1>` + 메모가 있는 카드마다 `<h2>{번호}. {question}</h2><p>{text}</p>`(HTML 이스케이프, 줄바꿈 → `<br>`). note item: `{ itemType:'note', parentItem: itemKey, note, tags:[{tag:'paper-reader'}] }`.

- [ ] **Step 1: 실패 테스트 작성** (임시 디렉터리 + 가짜 writer)

```js
test('addHighlight saves locally and queues one op even when Zotero is offline', ...)
  // syncPaper → status 'offline', pending 1, notes.json still has the highlight
test('flush creates annotation, stores zoteroKey/version, clears pending', ...)
test('denied keeps op in pending and returns status denied', ...)
test('two updates to same highlight collapse into one pending op', ...)
test('version conflict: Zotero value wins, my value kept in conflict.mine', ...)
test('my highlight deleted in Zotero → removed locally, not recreated', ...)
test('user-made Zotero annotation appears in zoteroAnnotations with matched sentenceIds and is never patched/deleted', ...)
test('server id changed → keys cleared, everything re-queued, nothing written with old keys', ...)
test('readonly (Zotero 9) → no writes attempted, pull still works, memos kept', ...)
test('NEEDS_REEXTRACT keeps op and returns re-extract message', ...)
test('noteHtml escapes HTML and includes only cards with memos', ...)
test('concurrent addHighlight calls on same paper both persist', ...)
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/notes-sync.test.mjs` → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(notes): local notes, pending queue, two-way Zotero sync"`

---

### Task 5: 서버 라우트

**Files:**
- Modify: `src/reader/server.mjs`, `src/reader/store.mjs`(`readPaper` 결과에 `needsReextract: boolean` — 문장 중 `pdfRects` 없는 것이 있으면 true)
- Test: `tests/server.test.mjs`

**Interfaces:**
- Consumes: Task 4 함수, Task 2 `getServerInfo`/`createZoteroWriter`. 서버 생성 시 `opts.zotero = { getServerInfo, writer }` 주입 가능(테스트용), 기본은 실제 구현.
- Produces (모든 `:id`는 `isSafeName`, 예제 논문(`example:true`)은 쓰기 403 `예제 논문에는 메모를 저장하지 않습니다.`):
  - `GET /api/papers/:id/notes` → `syncPaper` 실행 후 `{ highlights, cardMemos, zoteroAnnotations, note, status, pending, message, needsReextract }`.
  - `POST /api/papers/:id/highlights` body `{ sentenceIds: string[] (1~20개, source에 존재), color?: ZOTERO_COLORS 값, comment?: string(≤ 2000자) }` → 201 하이라이트 레코드. 잘못된 값 400(한국어 메시지).
  - `PUT /api/papers/:id/highlights/:hid` body `{ color?, comment? }` → 200. 없는 hid 404.
  - `DELETE /api/papers/:id/highlights/:hid` → 204. (DELETE도 Host 검사 적용.)
  - `PUT /api/papers/:id/card-memos/:cardId` body `{ text: string(≤ 5000자) }` → 200. 빈 문자열은 메모 삭제.
  - `POST /api/zotero/authorize` → 허용 창을 띄우고 `{ ok: true }` 또는 `{ ok:false, status:'denied'|'rate-limited'|'readonly'|'offline' }`.
- 쓰기 라우트는 로컬 저장 후 바로 응답하고 Zotero 전송은 다음 `GET /notes`에서 한다(응답이 허용 창 대기에 묶이지 않게).

- [ ] **Step 1: 실패 테스트 작성** (가짜 zotero 주입)

```js
test('GET notes returns status and runs sync once', ...)
test('POST highlights validates sentenceIds exist and color is a Zotero color', ...)
test('POST highlights on example paper → 403', ...)
test('PUT/DELETE highlight unknown hid → 404', ...)
test('DELETE without allowed Host → 403', ...)
test('PUT card memo then GET notes shows it', ...)
test('readPaper needsReextract true when a sentence lacks pdfRects', ...)
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/server.test.mjs` → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(reader): notes and highlight API routes"`

---

### Task 6: 읽기 화면 — 원문 하이라이트·메모

**Files:**
- Create: `src/reader/public/views/notes.js`
- Modify: `src/reader/public/views/paper.js`, `src/reader/public/styles.css`
- Test: `tests/views.test.mjs`

**Interfaces:**
- Consumes: Task 5 API.
- Produces (순수 함수, Node에서 테스트):
  - `selectionSentenceIds(orderedIds: string[], anchorId: string, focusId: string): string[]` — 두 문장 사이(포함)를 문서 순서로. 순서 반대여도 같은 결과.
  - `sentenceMarks(notes): Map<sentenceId, { kind: 'mine'|'zotero', color: string, comment: string, hid?: string, key?: string }[]>`
  - `statusText(status, pending): string` — `connected` → `Zotero 연결됨`, `offline` → `Zotero 연결 대기 중 (보낼 메모 N개)`, `needs-auth`/`denied` → `Zotero 쓰기 허용이 필요합니다`, `rate-limited` → `Zotero 허용 요청이 많아 잠시 후 다시 시도합니다`, `readonly` → Global Constraints의 문구.
- 화면 동작:
  - 원문 패널에서 텍스트를 선택하면 선택 끝 근처에 떠 있는 도구 막대: `🖍 하이라이트`, `📝 메모`, 색 8개. 선택은 걸친 문장 전체로 확장(`selectionSentenceIds`). 여러 페이지에 걸치면 막대에 `한 번에 한 페이지 안에서만 표시할 수 있습니다.`.
  - 내 하이라이트: 문장 배경에 선택 색, 클릭하면 메모 편집·색 변경·삭제 팝오버. Zotero에서 단 것: 점선 밑줄 + 🟡 표시, 클릭 시 메모 읽기 전용 표시(`Zotero에서 단 메모`).
  - 매칭된 문장이 없는 Zotero annotation은 해당 페이지 끝에 목록으로 표시.
  - 충돌이 있으면 해당 하이라이트에 `Zotero에서 바뀌었습니다. 내가 쓴 내용: …` 표시와 `닫기`.
  - 상단에 상태 배지(`statusText`), `needs-auth`/`denied`일 때 `Zotero 쓰기 허용` 버튼(→ `POST /api/zotero/authorize`, 안내: `Zotero 창에서 "Always Allow(항상 허용)"를 누르면 다음부터 묻지 않습니다.`).
  - `needsReextract`면 하이라이트 버튼 대신 `npm run extract -- <id>` 안내.
  - 5초마다 `GET /notes`(탭이 숨겨지면 멈춤, `visibilitychange`), 이전 응답과 다를 때만 다시 그림.
  - 키보드: 선택 후 `h` = 하이라이트, `m` = 메모. 팝오버 `Escape`로 닫기. 버튼에 `aria-label`.

- [ ] **Step 1: 실패 테스트 작성**

```js
test('selectionSentenceIds: forward and backward selection give same ordered ids', ...)
test('sentenceMarks: mine and zotero marks on same sentence both kept', ...)
test('statusText: offline shows pending count', () => assert.equal(statusText('offline', 2), 'Zotero 연결 대기 중 (보낼 메모 2개)'))
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/views.test.mjs` → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(reader): highlight and memo UI in source panel"`

---

### Task 7: 읽기 화면 — 카드 메모

**Files:**
- Modify: `src/reader/public/views/paper.js`, `src/reader/public/views/notes.js`, `src/reader/public/styles.css`
- Test: `tests/views.test.mjs`

**Interfaces:**
- Produces: `debounce(fn, ms)`(테스트 가능한 순수 유틸, 가짜 타이머 주입).
- 화면 동작: 각 카드 아래 `📝 내 메모` 접힘 영역(메모가 있으면 펼친 상태). textarea 입력은 800ms debounce로 `PUT /card-memos/:cardId`. 저장 상태 `저장됨` / `저장 중…`. `note.conflict`가 있으면 카드 메모 영역 위에 `Zotero 노트가 직접 수정되어 덮어쓰지 않았습니다.` 표시. 3분 모드에서는 메모 영역을 숨긴다.

- [ ] **Step 1: 실패 테스트** — `test('debounce calls once with last args after quiet period', ...)`
- [ ] **Step 2: 실패 확인** — Run: `node --test tests/views.test.mjs` → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(reader): per-card memos synced to a Zotero note"`

---

### Task 8: 문서와 실제 Zotero 확인

**Files:**
- Modify: `README.md`(새 절 "Zotero에 메모 보내기": Zotero 10 이상, 처음 한 번 허용 창 — "Always Allow" 권장, 설정 → 고급 → "Clear Write Authorizations"로 취소, 예전 추출본은 다시 추출, Zotero가 꺼져 있으면 대기 후 전송, 읽기 앱은 자신이 만든 `paper-reader` 태그 항목만 수정), `AGENTS.md`(재추출 안내 한 줄)

- [ ] **Step 1: README·AGENTS.md 작성 후 Commit** — `git commit -m "docs: Zotero memo sync usage"`
- [ ] **Step 2: 실제 확인 (사용자와 함께, 실행 전 확인)** — AIOpsLab 논문으로:
  1. `npm run extract -- ChenEtAlAIOpsLabHolisticFrameworkEvaluateAIAgents2025`(pdfRects 생성), 읽기 앱 열기.
  2. `Zotero 쓰기 허용` → 사용자가 "Always Allow".
  3. 원문 2문장 하이라이트 + 메모 → Zotero PDF에서 **같은 위치**에 노란 하이라이트·메모가 보이는지 사용자가 확인.
  4. Zotero에서 그 메모 수정 → 5초 안에 읽기 앱 반영. Zotero에서 새 하이라이트 → 읽기 앱 원문에 🟡 표시.
  5. 카드 메모 작성 → Zotero 논문 아래 `Paper Reader 메모` 노트 확인.
  6. Zotero 종료 → 메모 추가 → `Zotero 연결 대기 중` → Zotero 실행 → 전송 확인.
  7. 시험용으로 만든 하이라이트·노트는 사용자에게 지울지 물어본다.
- [ ] **Step 3: 결과 보고** — 각 항목 통과/실패와 화면 확인 결과를 사용자에게 보고.
