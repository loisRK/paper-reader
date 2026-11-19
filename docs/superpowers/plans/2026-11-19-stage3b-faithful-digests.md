# 3단계 보강: 의견 없는 요약, 분량 검사, 가벼운 입력, Gemini Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 요약은 논문 내용만 정리한 카드가 된다(모델의 해석·의견 없음). 어떤 AI 도구를 써도 분량·범위의 바닥 수준이 같게 검증하고, AI 도구에는 문장 ID + 본문만 담은 가벼운 입력을 주며, Gemini CLI를 세 번째 도구로 지원한다.

**Architecture:** 규칙 문서(`prompts/digest.md`, `prompts/agent-digest.md`)와 검증기(`src/digest/validate.mjs`)를 함께 바꾼다. 검증기는 `opinion` 항목과 분량·범위 미달을 문제로 보고하고(요약 작업은 이 문제 목록으로 재시도), 읽기 화면은 예전 요약의 opinion을 표시하지 않는다. 작업 폴더에는 `paper.txt`를 넣는다. Gemini는 Task 1의 `agentCommand` 틀에 추가한다.

**Spec:** `docs/superpowers/specs/2026-11-19-pdf-view-and-colleague-app-design.md` "3단계" + 아래 사용자 결정(이 계획의 Task 1에서 두 설계 문서에 반영).

## 사용자 결정 (2026-11-19, 원문)

> 논문의 내용을 요약하고 정리해서 이해하기 좋은 카드를 만드는거지 모델이 논문에 대한 해석을 달거나 의견을 요약에 넣으면 안됨. 이 도구의 목적은 논문을 카드뉴스처럼 핵심과 쟁점을 빠르게 파악하게 함과 동시에 논문의 내용 전체를 그걸 토대로 타고 들어가서 깊게 이해하기 위함이니까.

## Global Constraints

- **의견 금지**: 요약의 모든 내용은 논문이 말한 것이다. `kind: "opinion"`, "💬 해석", AI의 비판적 검토, "내 연구와의 연결"(researchContextFile), 모델이 만든 토론 질문을 없앤다.
  - `explain`: 그 카드의 논문 내용을 쉬운 말로 다시 풀고 앞뒤 카드와 어떻게 이어지는지 설명한다. 논문에 없는 평가·전망·"중요하다" 같은 판단을 넣지 않는다(저자가 그렇게 말했으면 저자의 말로).
  - `takeaway.why`: 저자가 밝힌 기여·의의만.
  - 한계 카드(`limits`): 저자가 밝힌 한계·위협 요인만(claim, 근거 필수).
  - 시사점 카드(`implications`): 저자가 밝힌 향후 연구·적용 범위(claim) + "원문에서 더 볼 곳"(섹션·그림·표를 가리키는 안내, 근거 문장 ID 필수).
  - `bridge`: 다음 카드로 넘어가는 연결 문장(새 사실 없음).
- **검증 문제로 잡는 것**(문제 목록 → 재시도, 기존 형식 문제와 같은 방식, 한국어 문구):
  - `opinion` 항목: `<cardId>: 해석·의견 항목은 쓰지 않습니다 – <앞부분>` (항목 제거)
  - 카드 수 < 12: `카드가 n장입니다 – 논문 전체를 담도록 12장 이상 쓰세요`
  - 9개 섹션(`SECTIONS`) 중 빠진 섹션: `빠진 섹션: <목록>`
  - `results` 섹션 카드 중 `bigNumbers`나 `tables`가 하나도 없음: `결과 카드에 숫자(bigNumbers)나 표(tables)가 없습니다`
  - `explain`이 비었거나 2문장 미만인 카드: `<cardId>: explain(해설)을 2~4문장으로 쓰세요`
  - claim 항목 text가 120자 초과: `<cardId>: 문장이 깁니다(n자) – 나눠 쓰세요` (규칙 7절 기준을 그대로 쓰되, 값이 다르면 규칙 문서의 값을 따른다)
- 읽기 화면: 예전 요약에 opinion 항목이 있으면 표시하지 않는다(검증기가 제거하고 상단 배너에 문제로 보인다). "💬 해석" 배지 코드·CSS 제거.
- `researchContextFile` 설정과 관련 문구를 제거(README, AGENTS.md, `.claude/skills`, config 예시, 작업 폴더). 설정 파일에 값이 남아 있어도 무시(오류 아님).
- 예제 논문(`examples/NguyenEtAlMeCoLog2026/digest.json`, CC BY, 커밋됨)은 새 검증을 통과하도록 고친다: opinion 4개를 지우거나 근거 있는 claim으로 바꾸고(논문에 있는 내용일 때만), 부족한 분량은 원문 근거로 채운다.
- **가벼운 입력**: 작업 폴더에 `paper.txt`(한 줄에 `[<문장ID>] <문장>`, 쪽이 바뀌면 `## p.<n>` 줄, 블록 종류가 heading이면 `### ` 접두, 캡션은 `(caption) ` 접두, 참고문헌 블록은 제외) + `figures.txt`(그림·표 라벨·쪽·캡션 문장 ID 한 줄씩). `source.json`은 넣지 않는다. 검증은 서버가 원래 `source.json`으로 한다. 프롬프트·digest.md 사본에서 입력 설명을 `paper.txt`/`figures.txt`로 바꾼다(저장소의 `prompts/digest.md`는 사람이 AI 도구로 직접 요약할 때도 쓰므로 두 입력 형식을 모두 설명).
- **Gemini CLI**(설치 확인: 0.46.0): `gemini -p <prompt> --approval-mode auto_edit --output-format stream-json`을 작업 폴더에서 실행하고, 작업 폴더에 `.gemini/settings.json`으로 셸·웹 도구를 막는다(정확한 키는 설치된 버전의 `gemini --help`와 공식 문서 github.com/google-gemini/gemini-cli docs로 확인: tools exclude / policy engine). 확인한 설정으로 셸·네트워크·작업 폴더 밖 쓰기를 막을 수 없으면 Gemini는 감지 목록에 `available: false`, 이유 `안전하게 실행할 수 없는 버전입니다`로 둔다. 로그인 오류 감지 문구 추가.
- 기존 Global Constraints(1~3단계 계획): 127.0.0.1, 415 가드, 한국어, innerHTML 금지, 디자인 토큰, 런타임 의존성 0.

## Review Focus

1. **예전 요약(AIOpsLab, opinion 8개)을 열 때** → 화면이 깨지지 않고 opinion만 빠진 채 보이며 배너에 문제 표시.
2. **모델이 "이 결과는 의미 있다" 같은 판단을 claim으로 위장** → 근거 문장 필수라 원문에 없는 판단은 근거와 어긋남 — 기계 검증 한계이므로 규칙 문서에 예시로 명시.
3. **짧은 논문(4쪽 워크숍 논문)** → 12장 기준을 채우기 어려움: 쪽 수 ≤ 6이면 최소 8장으로 완화(문구에 기준 표시).
4. **paper.txt에서 문장 ID 형식이 깨지는 문장(줄바꿈 포함)** → 문장 안 줄바꿈은 공백으로.
5. **Gemini 설정 파일 키가 버전마다 다름** → 감지 때 `--version`으로 확인한 버전 범위 밖이면 사용 불가로.

---

### Task 1: 규칙과 검증 — 의견 금지, 분량·범위 검사

**Files:** `prompts/digest.md`, `prompts/agent-digest.md`, `src/digest/validate.mjs`, `src/reader/public/views/paper.js`, `src/reader/public/styles.css`, `examples/NguyenEtAlMeCoLog2026/digest.json`, README.md, AGENTS.md, `.claude/skills/*`, `paper-reader.config.example.json`, `src/config.mjs`, `src/agent/*`(researchContext 제거), 두 설계 문서(사용자 결정 반영), tests.
**Interfaces:** `validateDigest(digest, source)` — 반환 형식 동일, 문제 목록에 위 항목 추가, `opinion`은 결과 digest에서 제거. `minCards(source) => 12 | 8`(쪽 수 ≤ 6이면 8).
- [ ] 실패 시험 → RED → 구현 → GREEN(`npm test`, `npm run check -- <예제 id>`가 예제 폴더에서 통과하는지 — check-cli가 examples를 못 찾으면 시험으로) → Commit `feat(digest): paper-only cards and coverage checks`

### Task 2: 가벼운 입력 paper.txt / figures.txt

**Files:** `src/agent/run.mjs`(prepareWorkdir), `src/agent/digest-job.mjs`, `prompts/agent-digest.md`, tests.
**Interfaces:** `paperText(source) => string`, `figuresText(source) => string` (순수, 시험).
- [ ] 실패 시험(형식, 참고문헌 제외, 줄바꿈 정리, 작업 폴더에 source.json 없음) → RED → 구현 → GREEN → Commit `perf(agent): give the AI a compact paper text`

### Task 3: Gemini CLI

**Files:** `src/agent/detect.mjs`, `src/agent/commands.mjs`, `src/agent/run.mjs`(stream-json 요약·errorHint), list 화면 도구 목록(자동), README, tests.
- [ ] `gemini --help`로 플래그·설정 키 확인(프롬프트 실행 금지) → 실패 시험 → RED → 구현 → GREEN → Commit `feat(agent): support Gemini CLI`

### Task 4: 실제 확인 (컨트롤러, 사용자 동의 범위 안에서)

- [ ] 사용자가 앱에서 직접 실행한 요약 결과 확인. 권한 확인 짧은 실행은 사용자 동의 후.
