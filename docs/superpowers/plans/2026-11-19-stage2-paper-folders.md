# 2단계: 논문 폴더 + Zotero 선택 연동 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱에서 논문 폴더를 지정하면 그 폴더의 PDF가 목록에 나오고, 앱에서 바로 추출해 읽고 메모할 수 있다. Zotero에 같은 파일이 있으면 자동으로 연결되어 메모가 Zotero로 가고, 없으면 메모는 이 컴퓨터에만 저장된다.

**Architecture:** 서버에 `src/library/`(설정·폴더 스캔·추출 실행)와 `src/zotero/link.mjs`(파일 → Zotero 첨부 찾기)를 둔다. 추출기는 Zotero 없이 파일 경로만으로도 돌고, 서지정보는 PDF 메타데이터·첫 쪽에서 얻는다. 목록 API가 "추출된 논문"과 "폴더에만 있는 PDF"를 하나로 합쳐 내려주고, 목록 화면에 폴더 설정과 추출 버튼을 둔다. 메모 동기화는 Zotero에 연결되지 않은 논문을 "이 컴퓨터에만 저장" 상태로 다루고, 나중에 연결되면 쌓인 메모를 보낸다.

**Tech Stack:** Node ≥22 `node:http`/`node:fs`/`node:crypto`, Python PyMuPDF 2.1, vanilla ES modules.

**Spec:** `docs/superpowers/specs/2026-11-19-pdf-view-and-colleague-app-design.md` — "2단계: 논문 폴더 + Zotero 선택 연동".

## Global Constraints

- 앱은 폴더의 PDF를 **읽기만** 한다(수정·이동·삭제·이름 변경 금지). 추출 결과는 지금처럼 `<outputDir>/<id>/`에만 쓴다.
- 폴더 설정은 `data/settings.json`(`{ "folders": [절대경로...] }`, git 제외 폴더)에 원자적으로 저장한다(임시 파일 + rename). 폴더는 최대 10개, 각각 존재하는 디렉터리의 절대 경로여야 한다.
- 스캔: 하위 폴더까지, 숨김 폴더(`.`로 시작)·심볼릭 링크 폴더는 들어가지 않는다, 깊이 ≤ 8, 폴더당 PDF ≤ 5000개(넘으면 앞에서부터 자르고 경고 문구). 확장자 `.pdf`(대소문자 무관) 일반 파일만.
- 폴더 논문 id: `<파일 이름(확장자 제외)에서 isSafeName 허용 문자만 남기고 공백은 '_', 최대 60자>-<sha1(설정 폴더 realpath + '\0' + 폴더 기준 상대 경로) 앞 8자리>`. 이름 부분이 비면 `paper`. 항상 `isSafeName` 통과.
- MD5는 (realpath, size, mtimeMs)가 같으면 `data/library-cache.json`에서 재사용한다.
- **중복 합치기**: 폴더 PDF의 realpath 또는 MD5가 이미 추출된 논문(`source.pdf.path` realpath / `source.pdf.md5`)과 같으면 그 논문 항목 하나로 보여 준다(새 id를 만들지 않음).
- **Zotero 연결 규칙**(사용자 라이브러리는 링크 파일 첨부라 Zotero의 `md5`가 비어 있다): 후보 = Zotero PDF 첨부 중 `data.path`의 파일 이름(`attachments:` / `storage:` 접두어 뒤)이 폴더 PDF 파일 이름과 같은 것. 후보마다 `items/<key>/file/view/url`로 실제 경로를 얻어 **realpath가 같으면** 연결. 이름이 다르면 PDF의 DOI로 Zotero 항목을 찾고, 그 PDF 첨부 파일의 MD5(우리가 계산)가 폴더 PDF MD5와 **같을 때만** 연결. 그 외에는 연결하지 않는다.
- Zotero가 꺼져 있거나 응답하지 않으면 연결 시도는 조용히 건너뛴다(오류 문구 없음, 다음 스캔 때 다시).
- 쓰기 API(폴더 저장, 추출)는 JSON 본문이 있는 POST/PUT만 받는다(기존 authorize와 같은 415 검사). 127.0.0.1·Host 검사 그대로.
- 추출은 한 번에 하나(진행 중이면 409 `다른 논문을 추출하고 있습니다. 끝난 뒤 다시 시도하세요.`).
- 사용자 문구 한국어, innerHTML 금지, 디자인은 0단계 토큰만.
- 지금의 Zotero 기반 흐름(`npm run extract -- <citekey>`, `/paper-search` → 등록)은 그대로 동작한다.

## Review Focus

1. **같은 PDF가 폴더에도 있고 citekey로 이미 추출되어 있음** → 목록에 한 번만, 기존 요약·메모·진행률 그대로.
2. **설정 폴더가 지워졌거나 외장 디스크가 빠짐** → 목록은 뜨고, 그 폴더 줄에 `폴더를 찾을 수 없습니다` 표시. 이미 추출된 논문은 계속 읽을 수 있다.
3. **파일 이름이 같은 PDF가 두 하위 폴더에** → id가 다르고 서로 섞이지 않는다.
4. **Zotero가 꺼진 상태에서 추출 → 나중에 Zotero를 켬** → 다음 스캔 때 연결되고, 그동안 단 메모가 Zotero로 간다.
5. **폴더 경로에 한글·공백·NFD 정규화 이름** → 스캔·추출·id가 정상.

---

### Task 1: 폴더 설정과 스캔, 합친 목록 API

**Files:**
- Create: `src/library/settings.mjs`, `src/library/scan.mjs`
- Modify: `src/reader/server.mjs`, `src/reader/store.mjs`(필요 시)
- Test: `tests/library.test.mjs`, `tests/server.test.mjs`

**Interfaces:**
- Produces: `readSettings(dataDir) => { folders: string[] }`(없으면 `{folders: []}`), `writeSettings(dataDir, { folders }) => void`(검증 실패 시 `HttpError(400, …)` 또는 `Error` with Korean message).
- Produces: `folderPaperId(rootReal, relPath, fileName) => string`.
- Produces: `scanFolders(folders, { dataDir }) => { files: [{ id, path(realpath), root, rel, size, mtimeMs, md5 }], problems: [{ folder, message }] }`.
- Produces: `GET /api/papers` 응답 각 항목에 `state: 'digest' | 'extracted' | 'pdf'`, `origin: 'zotero' | 'folder' | 'example'`, `linked: boolean`(source.zotero 있음), 폴더 PDF만 있는 항목은 `{ id, title: 파일 이름, state: 'pdf', origin: 'folder', file: rel }`. 응답 최상위에 `folders: [{ path, ok, message? }]`.
- Produces: `GET /api/library/folders` → `{ folders: [...] }`, `PUT /api/library/folders` `{ folders: string[] }` → 저장 후 같은 형식. 검증 문구: `절대 경로를 입력하세요.`, `폴더를 찾을 수 없습니다: <경로>`, `폴더는 10개까지 지정할 수 있습니다.`
- `dataDir` = 설정 파일 기준 `./data`(이미 `zotero.authFile`이 쓰는 폴더). `cfg.dataDir`로 config에 추가(기본 `./data`).

- [ ] **Step 1: 실패 시험** — 임시 폴더에 PDF 바이트(작은 실제 PDF, PyMuPDF 없이 Node에서 최소 PDF 문자열로 생성)를 하위 폴더 포함해 만든다: 숨김 폴더·심볼릭 링크 폴더 제외; 같은 이름 두 파일 → id 다름; id가 `isSafeName`; 한글·공백 이름; 캐시 재사용(두 번째 스캔에서 MD5 계산 함수 호출 0회 — 주입한 해시 함수 카운트); 설정 저장 검증 3종; 이미 추출된 번들의 `source.pdf.md5`와 같은 파일 → 목록에 한 번만(`state: 'digest'` 유지); 없어진 폴더 → `folders[].ok === false` + 목록 정상.
- [ ] **Step 2:** RED — `npm test`
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** GREEN — `npm test`
- [ ] **Step 5: Commit** — `feat(library): paper folders and merged paper list`

### Task 2: 파일 경로로 추출하기

**Files:**
- Modify: `extract/extract_pdf.py`(서지정보: `meta`), `src/digest/extract-cli.mjs`
- Create: `src/library/extract-job.mjs`
- Modify: `src/reader/server.mjs`
- Test: `tests/test_extract.py`, `tests/extract-cli.test.mjs`, `tests/server.test.mjs`

**Interfaces:**
- Produces (Python): 추출 결과에 `meta: { title, authors: string[], date, doi, journal: '' }` — 제목은 PDF 메타데이터 `title`(공백·"untitled"·"Microsoft Word - …" 같은 값이면 버림) → 첫 쪽에서 글자가 가장 큰 줄들 → 파일 이름 순. 저자는 메타데이터 `author`를 `;`/`,`/` and `로 나눔(없으면 []). 날짜는 메타데이터 `creationDate`의 `YYYY-MM-DD`(없으면 ''). DOI는 첫 2쪽 글자에서 `10.\d{4,9}/[^\s"<>]+`(끝 문장부호 제거) 첫 번째.
- Produces (Node): `extractFile({ cfg, file, id, zoteroLink? }) => { id, source }` — Zotero 없이 PDF 경로로 추출, `source.meta`는 Python meta, `source.zotero`는 `zoteroLink`가 주어지면 `{ itemKey, attachmentKey }`(그리고 Zotero meta가 있으면 meta를 그것으로). 기존 `main([citekey])` 흐름은 내부적으로 같은 저장 경로를 쓰게 정리(동작 동일).
- Produces: `POST /api/library/extract` `{ id }` → 폴더 스캔 목록에서 id를 찾아 추출 → 200 `{ id, state }`; 없는 id 404 `폴더에서 이 PDF를 찾을 수 없습니다.`; 진행 중 409; 추출 실패 500 + 한국어 이유. 추출 직후 Task 3의 `linkToZotero`를 부른다(Task 3 전에는 주입 가능한 no-op).
- [ ] **Step 1: 실패 시험** — Python: 메타데이터 title 있는 PDF / 없는 PDF(첫 쪽 큰 글자) / DOI 추출 / "untitled" 버림. Node: `extractFile` 결과 `source.id`, `source.pdf.path`, `meta.title`; 서버 409·404·200(주입한 추출 함수로).
- [ ] **Step 2:** RED — `npm run test:py && npm test`
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** GREEN
- [ ] **Step 5: Commit** — `feat(library): extract a folder PDF from the app`

### Task 3: Zotero 자동 연결

**Files:**
- Create: `src/zotero/link.mjs`
- Modify: `src/library/extract-job.mjs`, `src/reader/server.mjs`(목록 요청 때 연결 안 된 폴더 논문 재시도)
- Test: `tests/zotero-link.test.mjs`

**Interfaces:**
- Produces: `findZoteroAttachment({ file, md5, doi }, cfg, { fetchImpl, md5File }) => { itemKey, attachmentKey, meta } | null` — Global Constraints의 연결 규칙 그대로. 첨부 목록은 `items?itemType=attachment&format=json&limit=100&start=N`로 모아 파일 이름 → 후보 목록 색인을 만들고, 응답 헤더 `Last-Modified-Version`이 같으면 메모리 캐시를 재사용한다. `meta`는 부모 항목에서 기존 `toMeta`로.
- Produces: `linkToZotero(outputDir, id, cfg, deps) => boolean` — 연결되면 `source.json`에 `zotero` 기록(원자적 쓰기), Zotero meta가 있으면 `meta`도 교체(제목 등), true.
- 목록(`GET /api/papers`)에서: Zotero가 켜져 있고 연결 안 된 폴더 논문이 있으면 응답을 막지 않고 백그라운드로 연결을 시도한다(한 번에 하나, 30초 안에 같은 논문 재시도 없음).
- [ ] **Step 1: 실패 시험** (가짜 fetch): 파일 이름 같고 realpath 같음 → 연결; 이름 같지만 다른 경로 → 연결 안 함; 이름 다르고 DOI 같고 MD5 같음 → 연결; DOI 같지만 MD5 다름 → 연결 안 함; Zotero 꺼짐(fetch 예외) → null, 예외 없음; `storage:` 접두어; 라이브러리 버전 같으면 첨부 목록 재요청 없음.
- [ ] **Step 2:** RED
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** GREEN — `npm test`
- [ ] **Step 5: Commit** — `feat(zotero): link folder PDFs to Zotero attachments`

### Task 4: 연결 안 된 논문의 메모 상태와 나중 연결

**Files:**
- Modify: `src/notes/sync.mjs`, `src/reader/public/views/notes.js`
- Test: `tests/notes-sync.test.mjs`, `tests/views.test.mjs`

**Interfaces:**
- Produces: `syncPaper` 결과 상태 `'local'`(source.zotero 없음) — 메시지 없이. 기존의 `'offline' + '이 논문은 Zotero 항목과 연결되어 있지 않습니다.'`를 대체. 쌓인 작업(pending)은 그대로 보관.
- Produces: `statusText('local') === '이 컴퓨터에만 저장됩니다'`, 상태 줄은 배지 없이 회색 한 줄(`st-local`), 허용 버튼 없음.
- 연결된 뒤 첫 동기화에서 쌓인 하이라이트·카드 메모가 Zotero로 간다(기존 upsert 경로).
- [ ] **Step 1: 실패 시험** — zotero 없는 source → status 'local', pending 유지; 같은 notes로 zotero를 채운 뒤 sync → 가짜 writer에 create 호출(하이라이트 수만큼); `statusText('local')`.
- [ ] **Step 2:** RED
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** GREEN — `npm test`
- [ ] **Step 5: Commit** — `feat(notes): local-only state for papers not in Zotero`

### Task 5: 목록 화면 — 폴더 설정과 추출 버튼

**Files:**
- Modify: `src/reader/public/views/list.js`, `src/reader/public/app.js`(API 함수), `src/reader/public/styles.css`
- Test: `tests/views.test.mjs`

**Interfaces:**
- Consumes: Task 1 목록·폴더 API, Task 2 추출 API.
- Produces (순수): `tileState(paper) => { tag: string, tagClass: string, action: 'open'|'extract' }` — `digest` → `요약 있음`/open, `extracted` → `요약 대기`/open, `pdf` → `PDF만 있음`/extract. `linked`이면 추가 태그 `Zotero`.
- 화면:
  - 목록 위에 "논문 폴더" 영역: 지정된 폴더 줄(경로, 찾을 수 없으면 경고 문구, 빼기 버튼) + 경로 입력칸 + `추가` 버튼 + `새로고침` 버튼. 폴더가 없으면 안내 `논문 PDF를 모아 둔 폴더의 경로를 입력하세요. 예: /Users/me/Papers`.
  - PDF만 있는 논문 타일: 제목(파일 이름) + 폴더 기준 경로(작은 회색) + `추출` 버튼. 누르면 `추출 중…`(버튼 비활성), 끝나면 목록 새로고침, 실패하면 토스트(서버 문구).
  - 섹션: "요약 있음/대기"(지금 목록)과 "폴더의 PDF"(state 'pdf')로 나눈다. 폴더 PDF가 많으면(>50) 처음 50개 + `더 보기`.
- [ ] **Step 1: 실패 시험** — `tileState` 세 경우 + linked 태그.
- [ ] **Step 2:** RED
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** GREEN — `node --check`, `npm test`
- [ ] **Step 5: 화면 확인 자료** — 임시 폴더(스크래치)에 AIOpsLab PDF 사본과 다른 작은 PDF를 넣고, **임시 설정 디렉터리로 띄운 별도 서버 인스턴스**(다른 포트, `outputDir`·`dataDir`를 스크래치로)에서 목록·폴더 추가·추출을 CDP로 캡처. 사용자의 `data/settings.json`·`digests/`는 건드리지 않는다.
- [ ] **Step 6: Commit** — `feat(reader): paper folders and extract button on the list`

### Task 6: 실제 확인 (컨트롤러)

- [ ] 5173 서버 재시작 후 목록이 지금처럼 뜨는지(폴더 미지정 상태).
- [ ] 스크래치 폴더 + 별도 인스턴스로: AIOpsLab PDF 사본 → (내용 같으므로) 중복 합치기 확인은 실제 `outputDir`가 필요하므로, 대신 별도 인스턴스에서 추출 → Zotero 연결 규칙상 경로가 달라 연결되지 않음(정상) 확인.
- [ ] 사용자에게: 자기 논문 폴더(예: Zotero 링크 파일 폴더) 추가 → 이미 읽던 AIOpsLab이 한 번만 보이는지, 다른 PDF 추출·Zotero 연결 확인 요청.
