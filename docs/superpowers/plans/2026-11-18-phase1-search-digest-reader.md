# Paper Reader 1단계 (검색 + 요약 + 읽기 화면) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 키워드로 동료심사 저널 원저를 세 가지 트렌드 기준으로 골라 보여주고, Zotero PDF를 문장 ID가 붙은 원문으로 추출해 AI가 쓴 요약과 함께 로컬 읽기 앱에서 원문 점프하며 읽게 한다(읽기 전용, 메모 쓰기는 2단계 계획).

**Architecture:** 런타임 의존성 없는 Node ESM 모듈(검색·검증·Zotero 읽기·요약 검증·로컬 서버)과 Python 추출기(PyMuPDF) 하나. AI 도구는 `prompts/*.md` 규칙에 따라 JSON 파일(`search` 결과의 `summaryKo`, `digest.json`)만 채운다. 읽기 앱은 `127.0.0.1`에만 바인딩한 `node:http` 서버 + 빌드 없는 바닐라 JS 프론트엔드.

**Tech Stack:** Node ≥ 22 (`node:test`, 전역 `fetch`), Python ≥ 3.10 + `pymupdf` + `pytest` (프로젝트 `.venv`), OpenAlex / Crossref / doi.org, Zotero 로컬 API·Connector(`127.0.0.1:23119`).

**Spec:** `docs/superpowers/specs/2026-11-18-paper-reader-design.md` (이 계획은 스펙의 "만드는 순서" 1번 = 1단계·2단계·3단계 섹션을 구현한다. 스펙의 4단계 메모 연동, 5단계 Obsidian은 별도 계획.)

## Global Constraints

- 저장소 루트: `paper-reader/` (자체 git). 상위 폴더 코드에 의존하지 않는다.
- 런타임 npm 의존성 0개. 테스트는 `node --test`. Python 의존성은 `extract/requirements.txt`에만, `.venv`에 설치(전역 설치 금지).
- 개인 경로·계정·키를 코드에 넣지 않는다. 설정은 `paper-reader.config.json`(git 제외), 예시 `paper-reader.config.example.json`만 커밋.
- `.gitignore`: `paper-reader.config.json`, `digests/`, `data/`, `.venv/`, `node_modules/`, `__pycache__/`, `.DS_Store`.
- 선정 기준: 동료심사 저널 원저만. preprint·학회논문·리뷰·editorial·letter·erratum 제외. 검증 못 한 지표는 `null` → 화면 "미확인". 기준별 3편 미만이면 채우지 말고 `note`에 사유.
- 트렌드 기준 기본값: `perTrend: 5`, `emergingWindowMonths: 6`, `monthsBack: 24`, `topJournals: 5`.
- 문장 ID 형식 `p{1부터 시작하는 페이지}-s{페이지 내 1부터 시작하는 번호}` (예: `p5-s12`).
- 요약 항목 `kind`: `claim`(evidence ≥ 1 필수, 실패 시 제거) / `opinion`("💬 해석" 배지).
- Zotero PDF 링크 형식: `zotero://open-pdf/library/items/<attachmentKey>?page=N`.
- 서버는 `127.0.0.1`에만 바인딩.
- 사용자 표시 문구·요약은 한국어, 전문 용어 영문 병기. 라이선스 MIT.

## Review Focus

1. **한글 NFD·공백이 든 Zotero 첨부 경로** (macOS 실제 경로가 `file:///.../%E1%84%82...` 형태일 수 있음): Zotero `file/view/url`이 준 URL을 정확히 로컬 경로로 바꿔 PDF를 연다. → Task 7 테스트.
2. **텍스트 레이어 없는 PDF(스캔본)**: 빈 `source.json`을 만들지 말고 "텍스트를 추출할 수 없음(스캔 PDF)" 오류로 종료. → Task 8 테스트.
3. **2단 레이아웃**: 왼쪽 단을 끝까지 읽은 뒤 오른쪽 단으로 간다(문장 순서가 단을 넘나들지 않음). → Task 8 테스트.
4. **OpenAlex 429/네트워크 오류·결과 0건**: `Retry-After` 존중 후 재시도, 결과가 적으면 섹션 `note`에 사유를 남기고 정상 종료. → Task 2, 5 테스트.
5. **손상되거나 존재하지 않는 ID를 가리키는 `digest.json`**: 읽기 앱이 죽지 않고, 무효 claim을 뺀 요약 + 문제 배너를 보여준다. → Task 9, 10 테스트.

---

## 파일 구조

```text
paper-reader/
├── package.json                      # scripts: test, test:py, search, register, extract, check, reader, metrics:sjr
├── paper-reader.config.example.json
├── .gitignore  LICENSE  README.md  AGENTS.md
├── .claude/skills/paper-search/SKILL.md
├── .claude/skills/paper-digest/SKILL.md
├── prompts/search-summary.md         # AI: 검색 결과 summaryKo 채우기 규칙
├── prompts/digest.md                 # AI: digest.json 작성 규칙 + 스키마
├── src/config.mjs                    # 설정 로드·기본값·경로 해석
├── src/http.mjs                      # fetchJson (재시도·429)
├── src/search/openalex.mjs           # OpenAlex 조회·정규화
├── src/search/verify.mjs             # Crossref 유형·DOI 해석 확인
├── src/search/metrics.mjs            # SJR CSV·MJL CSV 매칭
├── src/search/trends.mjs             # 세 트렌드 선정
├── src/search/run.mjs                # 검색 파이프라인 조립 + CLI
├── src/zotero/local.mjs              # 로컬 API 읽기·첨부 경로·Connector 등록
├── src/zotero/register-cli.mjs
├── src/digest/validate.mjs           # digest.json 검증·정리
├── src/digest/check-cli.mjs
├── src/digest/extract-cli.mjs        # Zotero 해석 → Python 추출기 호출
├── src/reader/store.mjs              # outputDir 읽기/쓰기
├── src/reader/server.mjs             # HTTP API + 정적 파일
├── src/reader/public/index.html  app.js  views/list.js  views/search.js  views/paper.js  styles.css
├── extract/extract_pdf.py  extract/requirements.txt
├── examples/<citekey>/source.json  digest.json   # CC BY 예제 (Task 12)
└── tests/  *.test.mjs  test_extract.py  fixtures/
```

## 데이터 형식 (모든 Task 공통)

**`source.json`** (Task 8 생성, Task 9·10·11 소비)
```json
{
  "extractorVersion": 1,
  "id": "<citekey 또는 itemKey>",
  "zotero": { "itemKey": "H9RA4VSE", "attachmentKey": "IG8JQQUI" },
  "meta": { "title": "", "authors": [""], "journal": "", "date": "", "doi": "" },
  "pages": [{ "page": 1, "width": 612, "height": 792 }],
  "blocks": [{ "id": "b1", "type": "heading|paragraph|caption|references", "page": 1, "sentenceIds": ["p1-s1"] }],
  "sentences": { "p1-s1": { "text": "", "page": 1, "block": "b1", "rects": [[72.0, 90.1, 540.2, 101.3]] } },
  "figures": [{ "label": "Figure 2", "page": 4, "captionSentenceId": "p4-s3" }]
}
```
`rects`는 PyMuPDF 좌표(pt, 왼쪽 위 원점). 2단계 계획에서 Zotero annotation 위치로 변환한다.

**`digest.json`** (AI 작성, Task 9 검증)
```json
{
  "version": 1,
  "paperId": "<id>",
  "takeaway": { "text": "", "evidence": ["p1-s2"], "why": "" },
  "cards": [{
    "id": "c1",
    "section": "motivation|gap|idea|method|setup|results|analysis|limits|implications",
    "question": "", "answer": "", "bridge": "",
    "items": [{ "kind": "claim|opinion", "text": "", "evidence": ["p3-s4"] }],
    "bigNumbers": [{ "value": "13.9%", "label": "", "evidence": ["p8-s2"] }],
    "figures": [{ "label": "Figure 2", "page": 4, "note": "" }]
  }],
  "glossary": [{ "term": "", "definition": "" }]
}
```

**검색 결과 `<outputDir>/_search/<YYYY-MM-DD>-<slug>.json`** (Task 5 생성, AI가 `summaryKo` 채움, Task 10·11 표시)
```json
{
  "query": "", "createdAt": "ISO", "params": {},
  "sections": {
    "citationSurge": { "papers": [1, 2], "note": null },
    "emergingTopics": { "topics": [{ "name": "", "growth": 3.2, "isNew": false, "papers": [3] }], "note": null },
    "journalFlow": { "journals": [{ "name": "", "count": 12, "papers": [4] }], "note": null }
  },
  "papers": [{
    "n": 1, "openalexId": "", "doi": "", "title": "", "abstract": "", "authors": [""], "journal": "", "issn": [""],
    "publicationDate": "YYYY-MM-DD", "citedBy": 0, "countsByYear": [{ "year": 2026, "count": 0 }],
    "recentCitations": 0, "velocity": 0, "topic": { "id": "", "name": "" }, "oaPdfUrl": null,
    "badges": ["surge", "emerging", "journal"],
    "metrics": { "scopus": null, "sjrQuartile": null, "sjrYear": null, "wos": null, "scie": null, "ssci": null },
    "verification": { "crossrefType": "journal-article", "doiResolves": true },
    "summaryKo": null
  }],
  "excluded": [{ "title": "", "doi": "", "reason": "" }]
}
```

---

### Task 1: 프로젝트 골격과 설정 로더

**Files:**
- Create: `package.json`, `.gitignore`, `LICENSE`(MIT), `paper-reader.config.example.json`, `src/config.mjs`
- Test: `tests/config.test.mjs`

**Interfaces:**
- Produces: `loadConfig(path?: string): Promise<Config>` — `path` 기본값 `./paper-reader.config.json`. 파일이 없으면 기본값만 사용. 상대 경로(`outputDir`, `metrics.sjrCsv`, `metrics.mjlCsv`, `researchContextFile`)는 설정 파일이 있는 폴더 기준 절대 경로로 바꾼다.
- `Config` 기본값:
  ```json
  { "outputDir": "./digests",
    "zotero": { "baseUrl": "http://127.0.0.1:23119" },
    "reader": { "port": 5173 },
    "search": { "monthsBack": 24, "emergingWindowMonths": 6, "perTrend": 5, "topJournals": 5,
                "maxResults": 600, "openalexApiKey": null, "contactEmail": null,
                "excludedIssns": ["0302-9743", "1611-3349", "1613-0073", "1877-0509", "1865-0929"] },
    "metrics": { "sjrCsv": "./data/scimagojr.csv", "mjlCsv": null },
    "researchContextFile": null }
  ```
  (`excludedIssns`: LNCS, LNCS 온라인, CEUR-WS, Procedia Computer Science, CCIS — 저널 ISSN을 가진 학회 proceedings 시리즈.)

- [ ] **Step 1: `git init` 상태 확인 후 `package.json` 작성** — `"type": "module"`, `"engines": {"node": ">=22"}`, scripts: `"test": "node --test tests/"`, `"test:py": ".venv/bin/pytest -q tests/test_extract.py"`, `"search": "node src/search/run.mjs"`, `"register": "node src/zotero/register-cli.mjs"`, `"extract": "node src/digest/extract-cli.mjs"`, `"check": "node src/digest/check-cli.mjs"`, `"reader": "node src/reader/server.mjs"`, `"metrics:sjr": "node src/search/metrics.mjs --download"`. `.gitignore`, `LICENSE`, 예시 설정 작성.
- [ ] **Step 2: 실패하는 테스트 작성**
  ```js
  test('defaults when file missing', async () => {
    const c = await loadConfig('/nonexistent/paper-reader.config.json');
    assert.equal(c.search.perTrend, 5);
    assert.equal(c.reader.port, 5173);
    assert.ok(path.isAbsolute(c.outputDir));
  });
  test('merges nested values and resolves relative paths from config dir', async () => {
    // tmp/cfg/paper-reader.config.json = {"outputDir":"../out","search":{"perTrend":3}}
    const c = await loadConfig(tmpCfg);
    assert.equal(c.search.perTrend, 3);
    assert.equal(c.search.emergingWindowMonths, 6);
    assert.equal(c.outputDir, path.join(tmp, 'out'));
  });
  test('invalid JSON throws with file path in message', ...) // assert.rejects(..., /paper-reader.config.json/)
  ```
- [ ] **Step 3: `npm test` → FAIL (모듈 없음)**
- [ ] **Step 4: `src/config.mjs` 구현** (깊은 병합: 객체만 재귀, 배열은 교체)
- [ ] **Step 5: `npm test` → PASS**
- [ ] **Step 6: Commit** `git add -A && git commit -m "chore: scaffold project and config loader"`

---

### Task 2: HTTP 도우미와 OpenAlex 조회

**Files:**
- Create: `src/http.mjs`, `src/search/openalex.mjs`
- Test: `tests/http.test.mjs`, `tests/openalex.test.mjs`, `tests/fixtures/openalex-page.json`

**Interfaces:**
- Produces: `fetchJson(url: string, opts?: { fetchImpl?, headers?, retries?: number = 3, sleep?: (ms)=>Promise }): Promise<any>` — 429·5xx면 `Retry-After`(초, 또는 JSON 본문 `retryAfter`) 만큼 기다린 뒤 재시도, 없으면 2s·4s·8s. 4xx(429 제외)는 즉시 `HttpError{status,url}` throw.
- Produces: `searchWorks(query: string, cfg: Config, opts?: { fetchImpl?, now?: Date }): Promise<Work[]>` — OpenAlex `/works`, `search=<query>`, `filter=type:article,primary_location.source.type:journal,is_retracted:false,from_publication_date:<now - monthsBack>`, `per-page=200`, cursor 페이지네이션으로 `maxResults`까지. `openalexApiKey`가 있으면 `api_key` 파라미터, `contactEmail`이 있으면 `mailto`.
- Produces: `normalizeWork(raw): Work` — 위 "검색 결과" 형식의 paper 필드 중 `openalexId, doi(소문자, https://doi.org/ 제거), title, abstract(abstract_inverted_index 복원), authors, journal, issn(source.issn 배열), publicationDate, citedBy, countsByYear, topic(primary_topic), oaPdfUrl(best_oa_location.pdf_url ?? null)`.

- [ ] **Step 1: 실패하는 테스트 작성**
  ```js
  test('fetchJson retries 429 honoring retryAfter body', async () => {
    const calls = []; const sleeps = [];
    const fetchImpl = fake([{status:429, body:{retryAfter:38}}, {status:200, body:{ok:1}}], calls);
    assert.deepEqual(await fetchJson('u', {fetchImpl, sleep: ms => sleeps.push(ms)}), {ok:1});
    assert.deepEqual(sleeps, [38000]);
  });
  test('fetchJson throws HttpError on 404 without retry', ...); // calls.length === 1
  test('normalizeWork rebuilds abstract and strips doi prefix', () => {
    const w = normalizeWork(fixture.results[0]);
    assert.equal(w.doi, '10.1109/tpami.2025.3529084');
    assert.match(w.abstract, /^Detecting 3D objects/);
    assert.equal(w.oaPdfUrl, null);
  });
  test('searchWorks builds filter with from_publication_date = now - 24 months and follows cursor', ...);
  // now=2026-11-18 → from_publication_date:2024-11-18 ; 두 번째 페이지 요청에 cursor=<next_cursor>
  ```
- [ ] **Step 2: `npm test` → FAIL**
- [ ] **Step 3: 구현** (`tests/fixtures/openalex-page.json`은 실제 응답 형식을 따른 2건짜리 수작업 fixture: `meta.next_cursor`, `results[].counts_by_year`, `primary_location.source{display_name,issn,type}`, `primary_topic{id,display_name}`, `best_oa_location`)
- [ ] **Step 4: `npm test` → PASS**
- [ ] **Step 5: Commit** `feat(search): OpenAlex client with retry`

---

### Task 3: 논문 유형·DOI 교차 확인

**Files:**
- Create: `src/search/verify.mjs`
- Test: `tests/verify.test.mjs`

**Interfaces:**
- Consumes: `fetchJson`, `Work`, `Config`.
- Produces: `verifyWork(work: Work, cfg: Config, opts?: { fetchImpl? }): Promise<{ ok: boolean, reason: string|null, verification: { crossrefType: string|null, doiResolves: boolean|null } }>`
  - DOI 없음 → `ok:false, reason:"DOI 없음"`.
  - Crossref `https://api.crossref.org/works/<doi>`: `message.type !== 'journal-article'` → `"Crossref 유형: <type>"`; `message.ISSN`이 비었음 → `"ISSN 없음"`; ISSN이 `cfg.search.excludedIssns`에 있음 → `"학회 proceedings 시리즈(<issn>)"`; `container-title`이 `/proceedings|conference|symposium|workshop/i` → `"학회 proceedings로 보임"`.
  - `https://doi.org/<doi>`를 `redirect: 'manual'`, `method: 'HEAD'`로 요청해 3xx + `Location`이면 `doiResolves:true`; 아니면 `"DOI가 출판사 페이지로 연결되지 않음"`.
  - 네트워크 실패 → `ok:false, reason:"확인 실패: <message>"` (추정해서 통과시키지 않음).

- [ ] **Step 1: 실패하는 테스트** — 위 각 분기마다 하나씩(총 6개), 예:
  ```js
  test('proceedings-series ISSN is rejected', async () => {
    const r = await verifyWork(work, cfg, { fetchImpl: crossref({type:'journal-article', ISSN:['0302-9743'], 'container-title':['Lecture Notes in Computer Science']}) });
    assert.equal(r.ok, false); assert.match(r.reason, /0302-9743/);
  });
  test('network failure is not treated as pass', ...); // r.ok === false, /확인 실패/
  ```
- [ ] **Step 2: FAIL 확인** → **Step 3: 구현** → **Step 4: PASS 확인**
- [ ] **Step 5: Commit** `feat(search): verify journal-article type and DOI resolution`

---

### Task 4: 저널 지표 (SJR · MJL)

**Files:**
- Create: `src/search/metrics.mjs`
- Test: `tests/metrics.test.mjs`, `tests/fixtures/scimagojr-sample.csv`, `tests/fixtures/mjl-sample.csv`

**Interfaces:**
- Produces: `loadMetrics(cfg: Config): Promise<MetricsIndex>` — 파일이 없으면 빈 인덱스(오류 아님).
- Produces: `lookupMetrics(index: MetricsIndex, issns: string[]): { scopus: true|null, sjrQuartile: 'Q1'|'Q2'|'Q3'|'Q4'|null, sjrYear: number|null, wos: true|null, scie: true|null, ssci: true|null }` — 찾지 못한 값은 항상 `null`(`false`를 쓰지 않는다: "없음"이 아니라 "미확인").
- SCImago CSV: 구분자 `;`, 열 `Issn`(예 `"15403459, 00189448"`), `SJR Best Quartile`. ISSN은 하이픈 없이 8자로 정규화해 매칭. `sjrYear`는 파일명 `scimagojr-<YYYY>.csv` 또는 설정 `metrics.sjrYear`에서, 없으면 `null`.
- MJL CSV: 헤더에 `ISSN`, `eISSN`, 그리고 이름에 `Collection` 또는 `Index`가 들어간 열. 값에 `Science Citation Index Expanded` → `scie`, `Social Sciences Citation Index` → `ssci`, 행이 있으면 `wos:true`.
- CLI `node src/search/metrics.mjs --download`: `https://www.scimagojr.com/journalrank.php?out=xls`를 `data/scimagojr-<올해-1>.csv`로 저장하고 설정에 넣을 경로를 출력.

- [ ] **Step 1: 실패하는 테스트**
  ```js
  test('matches SJR by any ISSN ignoring hyphen', ...);   // ['0018-9448'] → {scopus:true, sjrQuartile:'Q1'}
  test('unknown journal stays null, never false', ...);    // 모든 값 null
  test('MJL marks SCIE and SSCI separately', ...);
  test('missing files yield empty index without throwing', ...);
  ```
- [ ] **Step 2: FAIL** → **Step 3: 구현** (CSV 파서는 따옴표 안 구분자 처리하는 최소 구현, 이 파일 안에) → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(search): SJR and MJL journal metrics lookup`

---

### Task 5: 세 가지 트렌드 선정과 검색 CLI

**Files:**
- Create: `src/search/trends.mjs`, `src/search/run.mjs`, `prompts/search-summary.md`
- Test: `tests/trends.test.mjs`, `tests/run.test.mjs`

**Interfaces:**
- Consumes: `searchWorks`, `verifyWork`, `loadMetrics`, `lookupMetrics`, `loadConfig`.
- Produces: `selectTrends(works: Work[], cfg: Config, now: Date): { sections, badgesById: Map<openalexId, string[]> }` — `sections`는 위 검색 결과 형식이되 `papers`에 `openalexId`를 담는다(번호 부여는 `runSearch`).
  - 🔥 `citationSurge`: `recentCitations = count(올해) + count(작년) × (12 − 현재월)/12`; `velocity = citedBy / max(1, 발표 후 개월 수)`. 발표 후 3개월 이상 & `citedBy ≥ 1`인 논문을 `recentCitations` 내림차순(동률 `velocity`)으로 `perTrend`편.
  - 🌱 `emergingTopics`: 최근 `emergingWindowMonths` 개월 = recent, 그 이전 = prior. 주제(`topic.id`)별 `growth = ((r+1)/(R+K)) / ((p+1)/(P+K))` (r,p: 주제별 편수, R,P: 전체 편수, K = 주제 수). `r ≥ 2`인 주제를 `growth` 내림차순, `isNew = (p === 0)`. 상위 주제부터 recent 논문 중 `citedBy` 최대 1편씩, 총 `perTrend`편.
  - 🏛 `journalFlow`: 최근 12개월 논문을 저널별로 세어 상위 `topJournals`개, 각 저널에서 `citedBy` 최대 1편.
  - 각 섹션 편수 < 3이면 `note`: `"조건을 만족하는 저널 원저가 N편뿐이라 N편만 선정했습니다(<기준 설명>)."`; 0편이면 `"…0편입니다."`
- Produces: `runSearch(query: string, cfg: Config, deps?: { fetchImpl?, now? }): Promise<SearchResult>` — 순서: `searchWorks` → 트렌드 후보(세 섹션에 뽑힌 것)만 `verifyWork` → 실패는 `excluded`로 옮기고 그 자리를 다음 순위로 채워 다시 선정(최대 `perTrend × 3`건 검증 후 중단) → `lookupMetrics` → 번호 `n` 1부터 → 파일 저장 `<outputDir>/_search/<YYYY-MM-DD>-<slug>.json` (slug: 소문자, 영숫자·한글 외 `-`). 반환값의 `path`에 저장 경로.
- CLI: `npm run search -- "<query>"` → 섹션별 개수, 제외 건수, 저장 경로 출력.
- `prompts/search-summary.md`: AI가 저장된 파일의 각 paper `abstract`만 근거로 `summaryKo`(한국어 한 문장, 60자 내외, 전문 용어 영문 병기)를 채운다. abstract가 비면 `"초록 없음"`. 다른 필드는 수정 금지. 다 쓰면 사용자에게 섹션별 번호·제목·summaryKo·배지·지표("미확인" 포함) 목록을 보여주고 읽기 앱 주소 `http://127.0.0.1:<port>/#/search/<파일명>`을 안내한다.

- [ ] **Step 1: 실패하는 테스트** (`now = 2026-11-18`)
  ```js
  test('surge ranks by recentCitations and excludes papers younger than 3 months', ...);
  test('emerging marks topic with zero prior papers as isNew', ...);
  test('journalFlow picks one most-cited paper per top journal', ...);
  test('fewer than 3 qualifying papers produces Korean note with count', () => {
    const { sections } = selectTrends(twoWorks, cfg, now);
    assert.match(sections.citationSurge.note, /2편뿐/);
  });
  test('paper in two sections gets both badges', ...);
  test('runSearch moves unverified papers to excluded with reason and backfills', async () => {
    // fake verify: 첫 후보 Crossref type 'proceedings-article'
    assert.equal(r.excluded[0].reason, 'Crossref 유형: proceedings-article');
    assert.equal(r.sections.citationSurge.papers.length, 5);
  });
  test('runSearch with zero OpenAlex results writes file with notes, no throw', ...);
  ```
- [ ] **Step 2: FAIL** → **Step 3: 구현** → **Step 4: PASS**
- [ ] **Step 5: 실제 확인(네트워크)**: `npm run search -- "AIOps"` → 저장 경로 출력, 파일의 모든 paper `verification.crossrefType === "journal-article"`. (OpenAlex 익명 요청이 429로 막히면 README대로 무료 API 키를 설정에 넣고 재실행.)
- [ ] **Step 6: Commit** `feat(search): trend selection and search CLI`

---

### Task 6: Zotero 등록 (Connector)

**Files:**
- Create: `src/zotero/local.mjs` (이 Task에서는 등록 부분), `src/zotero/register-cli.mjs`
- Test: `tests/zotero-register.test.mjs`

**Interfaces:**
- Consumes: `SearchResult` (Task 5 `runSearch` 반환·저장 형식), `SearchPaper` = 그 `papers[]` 원소.
- Produces: `zoteroRunning(cfg, opts?): Promise<boolean>` — `GET <baseUrl>/connector/ping` 200.
- Produces: `registerPaper(paper: SearchPaper, cfg, opts?): Promise<{ ok: boolean, pdfAttached: boolean, message: string }>` — `POST <baseUrl>/connector/saveItems`, body `{ sessionID: <uuid>, uri: "https://doi.org/<doi>", items: [{ itemType: "journalArticle", title, creators: [{firstName,lastName,creatorType:"author"}], publicationTitle: journal, date: publicationDate, DOI: doi, ISSN: issn.join(", "), url: "https://doi.org/<doi>", attachments: oaPdfUrl ? [{ title: "Full Text PDF", url: oaPdfUrl, mimeType: "application/pdf" }] : [] }] }`. 성공 201. PDF가 없으면 `message`: `"PDF 없음: 기관 구독으로 PDF를 받아 Zotero 항목에 넣어주세요."`.
  - (스펙은 "로컬 API로 등록"이라 했지만, 로컬 API로 PDF를 첨부하려면 파일 업로드 절차가 필요하다. Connector는 키 없이 Zotero가 PDF를 직접 내려받으므로 1단계는 Connector를 쓴다. 로컬 API 쓰기는 2단계 계획에서 메모용으로 도입.)
- CLI: `npm run register -- <검색파일명> <번호...>` → 각 번호마다 결과 한 줄. Zotero가 꺼져 있으면 `"Zotero가 실행 중이 아닙니다. Zotero를 켠 뒤 다시 실행하세요."` 출력 후 exit 1.

- [ ] **Step 1: 실패하는 테스트**: 요청 body 형식(creators 분해 "Yun-Song Zhou" → first "Yun-Song", last "Zhou"), OA PDF 유무별 attachments, Zotero 꺼짐 시 메시지.
- [ ] **Step 2: FAIL** → **Step 3: 구현** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(zotero): register selected papers via connector`

---

### Task 7: Zotero 항목 해석 (읽기)

**Files:**
- Modify: `src/zotero/local.mjs`
- Test: `tests/zotero-read.test.mjs`

**Interfaces:**
- Produces: `resolveItem(idOrKey: string, cfg, opts?): Promise<{ id: string, itemKey: string, attachmentKey: string, pdfPath: string, meta: {title,authors,journal,date,doi} }>`
  - `idOrKey`가 8자 대문자·숫자면 item key로 `GET /api/users/0/items/<key>`; 아니면 citekey로 보고 `GET /api/users/0/items?q=<citekey>&qmode=everything` 결과 중 `data.citationKey === citekey`.
  - `id` = `data.citationKey`가 있으면 그것, 없으면 itemKey.
  - 자식 중 `contentType === 'application/pdf'` 첫 번째 첨부 → `GET /api/users/0/items/<attKey>/file/view/url` 텍스트(file URL) → `fileUrlToLocalPath`.
  - 오류 메시지: 항목 없음 `"Zotero에서 '<id>' 항목을 찾지 못했습니다."`, PDF 없음 `"이 항목에 PDF 첨부가 없습니다. PDF를 Zotero에 넣은 뒤 다시 실행하세요."`, Zotero 꺼짐(연결 거부) `"Zotero가 실행 중이 아닙니다…"`.
- Produces: `fileUrlToLocalPath(url: string): string` — `node:url`의 `fileURLToPath` 사용, 결과를 NFC 정규화하지 **않는다**(디스크의 실제 바이트와 일치해야 함). 존재 확인은 호출자가.

- [ ] **Step 1: 실패하는 테스트**
  ```js
  test('decodes NFD Korean + spaces file URL exactly', () => {
    const p = fileUrlToLocalPath('file:///Users/x/%E1%84%82%E1%85%A2%20%E1%84%83%E1%85%B3/Chen%20%EB%93%B1%20-%202025.pdf');
    assert.equal(p, '/Users/x/내 드/Chen 등 - 2025.pdf');
  });
  test('resolves citekey to item and first PDF attachment', ...);   // fake fetch: items?q=, children, file/view/url
  test('8-char key path skips search', ...);
  test('no PDF attachment gives Korean guidance', ...);
  ```
- [ ] **Step 2: FAIL** → **Step 3: 구현** → **Step 4: PASS**
- [ ] **Step 5: 실제 확인**: `node -e "import('./src/zotero/local.mjs').then(async m=>console.log(await m.resolveItem('H9RA4VSE', await (await import('./src/config.mjs')).loadConfig())))"` → `pdfPath`가 실제로 존재(`fs.existsSync` true).
- [ ] **Step 6: Commit** `feat(zotero): resolve item, attachment and local PDF path`

---

### Task 8: PDF 추출기 (`source.json`)

**Files:**
- Create: `extract/extract_pdf.py`, `extract/requirements.txt`(`pymupdf`, `pytest`), `src/digest/extract-cli.mjs`
- Test: `tests/test_extract.py` (fixture PDF는 테스트 안에서 PyMuPDF로 생성), `tests/extract-cli.test.mjs`

**Interfaces:**
- Produces (Python): `extract(pdf_path: str) -> dict` (위 `source.json` 형식에서 `id`, `zotero`, `meta` 제외) 및 CLI `python extract/extract_pdf.py <pdf> <out.json>` (stdout 없음, 실패 시 stderr 한국어 메시지 + exit 2).
  - 블록: `page.get_text("dict")`의 text block. 2단 판정: 페이지 폭 중앙선 ±5% 영역을 가로지르지 않는 블록이 양쪽에 각각 3개 이상이면 2단 → 왼쪽 단(블록 x1 < 중앙) 전체를 y순, 그다음 오른쪽 단 y순. 가로지르는 블록(제목·전폭 그림)은 y 위치로 사이에 끼운다.
  - 블록 유형: 폰트 크기가 본문 최빈값 × 1.15 이상이거나 `^\d+(\.\d+)*\s+[A-Z]` → `heading`; `^(Fig\.?|Figure|Table)\s*\d+` → `caption`(figures에 추가, `label`은 `Figure N`/`Table N`으로 정규화); `References`/`Bibliography` 제목 이후 → `references`; 나머지 `paragraph`.
  - 하이픈 줄바꿈 결합(`-\n` + 소문자 → 이어 붙임).
  - 문장 분리: `(?<=[.!?])\s+(?=[A-Z0-9(\[“"])` 기준, 단 직전 토큰이 `et al.`, `e.g.`, `i.e.`, `Fig.`, `Eq.`, `Sec.`, `vs.`, `cf.`, `No.`, `approx.` 이거나 한 글자 대문자+마침표(이니셜)면 분리하지 않는다.
  - 문장 `rects`: 문장 문자 범위에 해당하는 span/char bbox를 줄 단위로 합친 사각형 목록(소수 1자리 반올림).
  - 전체 페이지 텍스트 합이 페이지당 평균 50자 미만이면 `ScannedPdfError("텍스트를 추출할 수 없습니다(스캔 PDF로 보입니다). OCR된 PDF로 바꿔주세요.")`.
- Produces (Node): `npm run extract -- <citekey|itemKey>` → `resolveItem` → `.venv/bin/python extract/extract_pdf.py <pdfPath> <tmp>` → `id`/`zotero`/`meta` 합쳐 `<outputDir>/<id>/source.json` 저장 → 문장 수·페이지 수·그림 수와 다음 안내 출력: `"이제 AI 도구에게 'prompts/digest.md 규칙으로 <id> 요약을 써줘'라고 요청하세요."` `.venv`가 없으면 설치 명령(`python3 -m venv .venv && .venv/bin/pip install -r extract/requirements.txt`) 안내 후 exit 1.

- [ ] **Step 1: `.venv` 생성·설치** `python3 -m venv .venv && .venv/bin/pip install -r extract/requirements.txt` → 성공 출력.
- [ ] **Step 2: 실패하는 테스트 (pytest)**
  ```python
  def test_ids_are_page_scoped_and_ordered(tmp_path):      # 2쪽 PDF → 'p1-s1','p1-s2',…,'p2-s1'
  def test_two_column_reads_left_column_first(tmp_path):    # 왼쪽 "Alpha one. Alpha two." / 오른쪽 "Beta one." → 순서 Alpha one, Alpha two, Beta one
  def test_et_al_and_fig_do_not_split(tmp_path):           # "Smith et al. showed X. See Fig. 2 for Y." → 2문장
  def test_caption_becomes_figure(tmp_path):                # "Figure 2: Overview" on p1 → figures[0] == {'label':'Figure 2','page':1,...}
  def test_rects_inside_page(tmp_path):                     # 모든 rect 0 ≤ x0 < x1 ≤ width
  def test_scanned_pdf_raises(tmp_path):                    # 이미지만 있는 PDF → ScannedPdfError
  def test_same_pdf_same_ids(tmp_path):                     # 두 번 추출 결과 sentences 키 동일
  ```
- [ ] **Step 3: `npm run test:py` → FAIL**
- [ ] **Step 4: 구현** → **Step 5: `npm run test:py` → PASS**
- [ ] **Step 6: Node 테스트** `extract-cli.test.mjs`: resolveItem·파이썬 호출을 주입해 저장 파일에 `id`, `zotero.attachmentKey`, `meta.title`이 합쳐지는지, `.venv` 없을 때 안내 메시지. FAIL → 구현 → PASS.
- [ ] **Step 7: 실제 확인**: `npm run extract -- H9RA4VSE` → `digests/<citekey>/source.json` 생성, 문장 수 > 300, `figures`에 `Figure 1` 포함.
- [ ] **Step 8: Commit** `feat(extract): PDF to sentence-addressed source.json`

---

### Task 9: 요약 검증과 AI 작성 규칙

**Files:**
- Create: `src/digest/validate.mjs`, `src/digest/check-cli.mjs`, `prompts/digest.md`
- Test: `tests/validate.test.mjs`

**Interfaces:**
- Produces: `validateDigest(digest: unknown, source: Source): { digest: Digest, problems: string[] }` — 예외를 던지지 않는다.
  - 최상위가 객체가 아니거나 `cards`가 배열이 아니면 `{ digest: { version:1, paperId: source.id, takeaway:null, cards:[], glossary:[] }, problems:["digest.json 형식이 올바르지 않습니다"] }`.
  - `claim` 항목: evidence가 비었거나 하나라도 `source.sentences`에 없으면 제거, problem `"<cardId>: 근거 없는 claim 제거 – <text 앞 30자>"`.
  - `opinion`: evidence가 있으면 존재하는 것만 남김.
  - `bigNumbers`: claim과 같은 규칙.
  - `takeaway.evidence` 무효 → `takeaway.text`는 남기고 problem 추가(화면에서 "근거 확인 필요" 표시).
  - `figures[].page`가 `1..pages.length` 밖이면 제거.
  - `section` 값이 9개 목록 밖이면 problem만 추가(카드 유지).
- CLI: `npm run check -- <id>` → `<outputDir>/<id>/digest.json` + `source.json` 검증, problems 출력, 있으면 exit 1, 없으면 `"검증 통과: 카드 N개, claim M개"` exit 0.
- `prompts/digest.md` 내용(정확히 담을 것):
  1. 입력: `<outputDir>/<id>/source.json` (+ 설정 `researchContextFile`이 있으면 그 파일).
  2. 출력: 같은 폴더 `digest.json`, 위 "데이터 형식"의 스키마 그대로(스키마 블록을 이 문서에 복사).
  3. 카드 순서와 의미: 스펙의 "요약의 흐름" 표(0 Takeaway ~ 9 시사점) — 표 복사. 논문에 따라 생략·분할 가능.
  4. 카드 형식: 질문형 `question` → 한두 문장 `answer` → `items`; `bridge`는 앞 카드와 잇는 한 문장("그래서…", "그런데…"), 새 사실 금지.
  5. 원문 사실은 반드시 `claim` + 실제 문장 ID. 해석·비판·시사점은 `opinion`. 원문에 없는 수치·주장 금지.
  6. 문장 길이: `answer` 80자 이내, `items[].text` 60자 이내, 카드당 items 2~5개.
  7. 결과 카드는 `bigNumbers` 우선, 그림·표는 `figures`(source.json `figures`의 page 사용).
  8. `glossary`: 처음 나오는 전문 용어 5~12개, 정의 40자 이내.
  9. `researchContextFile`이 없으면 `implications` 카드에 "내 연구와의 연결"을 쓰지 않는다.
  10. 다 쓰면 `npm run check -- <id>` 실행, 통과할 때까지 수정. 통과 후 `http://127.0.0.1:<port>/#/paper/<id>` 안내.

- [ ] **Step 1: 실패하는 테스트** — 위 규칙마다 하나(최소 7개), 예:
  ```js
  test('claim with unknown evidence id is removed and reported', () => {
    const { digest, problems } = validateDigest(d({ items:[{kind:'claim',text:'X',evidence:['p99-s1']}] }), source);
    assert.equal(digest.cards[0].items.length, 0);
    assert.match(problems[0], /c1: 근거 없는 claim 제거/);
  });
  test('garbage input returns empty digest with problem, no throw', () => { validateDigest('oops', source) ... });
  ```
- [ ] **Step 2: FAIL** → **Step 3: 구현 + `prompts/digest.md` 작성** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(digest): validator, check CLI and AI writing rules`

---

### Task 10: 읽기 앱 서버 API

**Files:**
- Create: `src/reader/store.mjs`, `src/reader/server.mjs`
- Test: `tests/server.test.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `validateDigest`, `registerPaper`, `zoteroRunning`.
- Produces: `createServer(cfg): http.Server` (listen은 CLI 부분에서 `127.0.0.1:<cfg.reader.port>`; 포트 사용 중이면 `"포트 <port>가 사용 중입니다. 설정 reader.port를 바꾸세요."`).
- 라우트 (모두 JSON, 오류는 `{error: "<한국어 메시지>"}` + 적절한 상태코드):
  - `GET /api/papers` → `[{ id, title, journal, date, hasDigest, cardsRead, cardsTotal }]` (`<outputDir>/*/source.json` 기준, `_search` 제외)
  - `GET /api/papers/:id` → `{ source, digest, problems, progress, links: { zoteroPdf: "zotero://open-pdf/library/items/<attachmentKey>", zoteroItem: "zotero://select/library/items/<itemKey>" } }` — digest 없으면 `digest:null, problems:[]`; digest.json이 JSON 파싱 실패면 `validateDigest`의 빈 결과 + `"digest.json을 읽을 수 없습니다: <msg>"`.
  - `PUT /api/papers/:id/progress` body `{ read: string[], mode: "3min"|"10min", focus: boolean }` → `progress.json` 저장, 204.
  - `GET /api/searches` → 파일명 목록(최신순), `GET /api/searches/:name` → 내용.
  - `POST /api/register` body `{ search: name, n: number }` → `registerPaper` 결과.
  - 그 외 → `src/reader/public/` 정적 파일, `/`는 `index.html`.
  - `:id`, `:name`은 `^[\w.\-]+$`만 허용(경로 탈출 방지), 아니면 400.

- [ ] **Step 1: 실패하는 테스트** (임시 outputDir에 fixture `source.json`·`digest.json`, 서버를 포트 0으로 띄워 실제 HTTP 호출)
  ```js
  test('lists papers with read progress', ...);
  test('paper endpoint returns validated digest and problems', ...);   // 무효 claim 1개 → problems.length === 1
  test('broken digest.json still returns 200 with problem', ...);
  test('path traversal id is rejected with 400', ...);                  // GET /api/papers/..%2Fsecret
  test('progress round-trips', ...);
  test('serves index.html at /', ...);
  ```
- [ ] **Step 2: FAIL** → **Step 3: 구현** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(reader): local API server`

---

### Task 11: 읽기 앱 화면

**Files:**
- Create: `src/reader/public/index.html`, `app.js`(hash 라우터: `#/`, `#/search/<name>`, `#/paper/<id>`), `views/list.js`, `views/search.js`, `views/paper.js`, `styles.css`
- Test: `tests/views.test.mjs` (DOM 없이 테스트 가능한 순수 함수만), 수동 브라우저 확인

**Interfaces:**
- Consumes: Task 10 API.
- `views/*.js`는 `render(container, data, actions)` + 아래 순수 함수를 export:
  - `metricBadges(metrics): {label, unverified:boolean}[]` — `null`은 `"Q 미확인"`, `"SCIE 미확인"` 등으로.
  - `visibleItems(card, mode)` — `"3min"`이면 `[]`(question·answer만 표시), `"10min"`이면 전체 items.
  - `sentenceHtmlId(sentenceId)` → `"s-" + sentenceId`.
- 화면 요구(스펙 3단계):
  - **목록**: 논문 카드(제목·저널·진행률 막대·요약 유무), 검색 결과 목록 링크.
  - **검색 결과**: 세 섹션(🔥 인용 급증 / 🌱 새 주제 / 🏛 저널 흐름) + `note` 표시, 카드마다 번호·제목·`summaryKo`(없으면 "요약 대기")·저널·출판일·인용 수·배지(미확인은 회색 점선)·DOI 링크·[Zotero에 등록] 버튼(결과 메시지 토스트). 하단 "제외된 후보"(접힘, 사유).
  - **논문**: 상단 고정 바(Takeaway·진행 막대·3분/10분 토글·집중 모드 토글), 왼쪽 카드(번호·question·answer·items·bigNumbers·figures·읽음 체크·`bridge`는 카드 사이 작은 연결문), 오른쪽 원문(블록 순서대로, 문장마다 `id="s-p5-s12"` span, `heading` 강조, `references` 블록은 접힘).
  - claim의 🔗 클릭 → 원문 패널에서 evidence 첫 문장으로 `scrollIntoView({block:'center'})`, evidence 문장들 강조 2초 이상 유지(다음 클릭 전까지).
  - opinion에는 "💬 해석" 배지. figures → `links.zoteroPdf + "?page=N"` 링크 "Zotero에서 p.N 열기".
  - glossary 용어는 카드 텍스트에서 첫 등장만 `<abbr title>`로 감싼다.
  - 집중 모드: 현재 카드(마지막으로 클릭/스크롤된 카드)와 그 evidence 문장 외에는 opacity 0.35.
  - `problems`가 있으면 상단 노란 배너 "요약 일부를 확인하지 못했습니다(N건)" + 펼치기.
  - 읽음 체크·모드·집중은 `PUT progress`로 저장(실패해도 화면 동작 유지, 토스트만).
  - 레이아웃: 폭 ≥ 960px 2열, 그 미만은 원문이 하단 시트(🔗 클릭 시 열림). 라이트/다크(`prefers-color-scheme`) 모두, AIOpsLab 자료처럼 포인트 색 청록·라임, 큰 숫자.
  - 모든 텍스트는 `textContent`로 넣는다(`innerHTML`에 데이터 삽입 금지 — 논문 텍스트에 `<`가 흔함).

- [ ] **Step 1: 순수 함수 실패 테스트** (`metricBadges` null→미확인, `visibleItems` 모드별, `sentenceHtmlId`) → FAIL
- [ ] **Step 2: 구현** → `npm test` PASS
- [ ] **Step 3: 수동 확인** `npm run reader` 후 브라우저에서: Task 8에서 만든 논문에 임시 `digest.json`(카드 2개, claim 3개 중 1개는 잘못된 ID)을 두고 — ① 🔗 클릭 시 해당 문장 강조·스크롤 ② 배너에 1건 ③ 3분/10분 전환 ④ 새로고침 후 읽음 체크 유지 ⑤ 창 폭 700px에서 하단 시트 ⑥ Zotero 링크 클릭 시 Zotero가 해당 페이지로 열림.
- [ ] **Step 4: Commit** `feat(reader): list, search and paper views`

---

### Task 12: AI 도구 연결, README, 공개 예제, 전 과정 확인

**Files:**
- Create: `AGENTS.md`, `.claude/skills/paper-search/SKILL.md`, `.claude/skills/paper-digest/SKILL.md`, `README.md`, `examples/<citekey>/source.json`, `examples/<citekey>/digest.json`
- Modify: `src/reader/store.mjs` (outputDir에 없으면 `examples/`도 목록에 "예제"로 표시)
- Test: `tests/examples.test.mjs`

**Interfaces:**
- `AGENTS.md`와 두 SKILL.md는 절차만 담고 규칙은 `prompts/`를 가리킨다(내용 중복 금지):
  - paper-search: ① `npm run search -- "<키워드>"` ② `prompts/search-summary.md`대로 `summaryKo` 채우기 ③ 목록 보여주기 ④ 사용자가 번호를 말하면 `npm run register -- <파일> <번호…>`.
  - paper-digest: ① `npm run extract -- <id>` ② `prompts/digest.md`대로 `digest.json` 작성 ③ `npm run check -- <id>` 통과까지 ④ 읽기 앱 주소 안내(서버가 안 떠 있으면 `npm run reader` 안내).
- README: 요구사항(Node 22+, Python 3.10+, Zotero 7+ / 메모 쓰기는 2단계·Zotero 10+, 로컬 API 켜기: 설정 → 고급 → "이 컴퓨터의 다른 애플리케이션이 Zotero와 통신하도록 허용"), 설치(npm 의존성 없음 → `npm install` 불필요, Python은 `.venv` 명령), 설정 복사, OpenAlex 무료 API 키 권장(익명 요청 429 사례), SJR `npm run metrics:sjr`, MJL 파일 받는 곳(Clarivate Master Journal List, 로그인 필요)과 미설정 시 "미확인", 사용 흐름(Claude Code `/paper-search`, Codex 등은 AGENTS.md), 저작권 안내(산출물은 커밋되지 않음).
- 예제: CC BY 라이선스 저널 원저 1편(구현자가 선택, 선정 기준 충족 확인 — `runSearch` 결과에서 고르는 것을 권장). 그 PDF로 `source.json` 추출, AI가 `digest.json` 작성. 라이선스·출처를 `examples/<citekey>/README.md`에 명시.

- [ ] **Step 1: 실패하는 테스트** `examples.test.mjs`: 모든 예제가 `validateDigest` problems 0건, `source.json`에 `extractorVersion === 1`.
- [ ] **Step 2: 예제 생성·연결 파일·README 작성** → **Step 3: `npm test` PASS, `npm run test:py` PASS**
- [ ] **Step 4: 전 과정 확인(실제 환경)**: Claude Code에서 `/paper-search "LLM agent operations"` → 결과 목록 → 1편 `register` → Zotero에 항목 생성 확인 → (PDF 확보 후) `/paper-digest <citekey>` → `npm run check` 통과 → 읽기 앱에서 Task 11 Step 3의 ①~⑥ 재확인.
- [ ] **Step 5: 개인정보 점검**: `git grep -nE "loiskim|/Users/|@gmail|GoogleDrive"` → 결과 없음.
- [ ] **Step 6: Commit** `docs: AI tool wiring, README and CC BY example`
