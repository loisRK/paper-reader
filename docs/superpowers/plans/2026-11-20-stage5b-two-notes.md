# 5단계 보강: 논문 노트와 요약 노트 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Obsidian으로 보내기"가 논문당 노트 두 개를 쓴다. 논문 노트에는 내가 남긴 것만, 요약 노트에는 AI가 만든 것(핵심·카드 요약·연구 연결 메모)과 키워드 링크를 담는다.

## 사용자 결정 (2026-11-20)

- Zotero Integration 플러그인을 쓰지 않는다. 앱이 논문 노트를 쓴다(앱은 Zotero에서 단 주석도 이미 가져온다).
- 논문 노트에는 **내가 하이라이트 친 것과 메모만**: 하이라이트(앱·Zotero, 원문·쪽·🔴🟡🟢), 하이라이트 메모, 카드 메모, `## 내 생각`. 머리말: 제목·저자·연도·DOI·인용 키·Zotero 링크·요약 노트 링크.
- 카드 요약은 **별도 요약 노트**, 논문 노트에 링크. 요약 노트 맨 위에 **키워드 링크**(`[[AIOps]]` 등 — 같은 키워드의 논문이 모여 보이게, 방식 1).
- **연구 연결 메모는 요약 노트**에 둔다(AI가 만든 것은 요약 노트, 내가 쓴 것은 논문 노트).
- vault 구조: `Papers/`(논문 노트), `Summaries/`(요약 노트), `Research/`(연구 주제 노트), `References/`·`.pandoc/`(Pandoc 인용, 유지). 사용자가 정리 완료, 설정 folder=`Papers`, researchNote=`Research/연구 주제 - AI Agent 기반 Kubernetes와 GPU 인프라 운영.md`.

## Global Constraints

- 논문 노트 파일: `<vault>/<folder>/@<citekey>.md` (Zotero 없는 논문: `<id>.md`). 요약 노트: `<vault>/<summaryFolder>/@<citekey> 요약.md`. 설정에 `summaryFolder`(기본 `Summaries`) 추가, 같은 vault 경로 검사.
- 두 파일 모두 `%% begin paper-reader %%`~`%% end paper-reader %%` 사이만 앱이 관리. 논문 노트는 처음 만들 때 표시 아래 `## 내 생각` 빈 칸을 만들고 이후 보존. 요약 노트도 표시 밖은 보존(처음엔 표시만).
- 논문 노트 프런트매터: `citekey`, `title`, `authors`, `year`, `doi`, `zotero`(zotero://select 링크, Zotero 논문만), `summary: "[[@<citekey> 요약]]"`, `tags: [paper]`. 요약 노트 프런트매터: `citekey`, `paper: "[[@<citekey>]]"`, `keywords: [...]`, `tags: [paper-summary]`.
- 논문 노트 본문(표시 안): 제목, info 콜아웃(저자·연도·DOI·인용 `[@citekey]`·Zotero 열기·`요약 보기 [[@<citekey> 요약]]`·쪽 번호는 PDF 쪽 기준), `## 하이라이트`(문장 순서 = 원문 순서, 콜아웃 `[!paper-red|yellow|green]`, `> **내 메모:** …`, Zotero에서 단 것은 끝에 `(Zotero)`), `## 카드에 단 메모`(카드 질문 — 메모; 이전 요약의 메모 포함). 하이라이트·메모가 없으면 각 절에 `아직 없습니다.` 한 줄. 요약 내용(핵심·카드)은 넣지 않는다.
- 요약 노트 본문(표시 안): 제목 `<제목> — 요약`, `키워드: [[k1]] · [[k2]] …`, `논문 노트: [[@<citekey>]] · 인용 [@citekey]`, `> [!info] AI가 논문 내용으로 정리한 요약입니다. 연구 연결 메모는 AI가 쓴 연결점이며 논문 내용이 아닙니다. 쪽 번호는 PDF 쪽 기준.`, `## 핵심`, `## 카드 요약`(기존 형식: 답·해설·claim+인용+근거 원문, 연속 문장만 이어 붙임), `## 연구 연결 메모 (AI가 쓴 연결점 · 논문 내용 아님)`(기존 `AI 연결점` 콜아웃). 요약이 없으면 요약 노트를 만들지 않고 논문 노트의 요약 링크 자리에 `요약 없음`.
- **키워드**: digest.json에 `keywords: string[]`(3~6개, 각 1~40자, 논문에 실제로 나오는 용어 — 영어 원어 그대로 또는 논문에 쓰인 표기; 검증: 개수·길이·`[]|#^` 금지 문자; 대소문자 무시 중복 제거). prompts/digest.md·agent-digest.md에 규칙 추가("논문의 핵심 용어, 용어집(glossary)에 있으면 그 용어를 우선, 일반어(method, results 등) 금지"). 키워드 없는 예전 요약은 glossary의 앞 3~6개 term을 대신 쓴다(없으면 키워드 줄 생략). 키워드는 위키 링크용으로 안전화.
- 예전 짝 노트 형식(`… 읽기 노트.md`)은 더 이상 만들지 않는다(사용자가 이미 지움). 코드·테스트에서 단일 노트 경로를 두 노트 경로로 바꾼다.
- 응답 `{ paperNote: relPath, summaryNote: relPath|null }`. 토스트: `Obsidian에 저장했습니다: <paperNote>` (+ ` · <summaryNote>`).
- 기존 안전 규칙(쓰기 경로 제한, 원자적 쓰기, `%%` 중화, 표시 깨지면 덮어쓰지 않음, 오류 시 아무 파일도 안 씀 — 두 파일 중 하나라도 표시가 깨져 있으면 둘 다 쓰지 않음) 유지.
- 사이드 Obsidian 칸에 `요약 노트 폴더` 입력 추가(기본 Summaries). 연구 노트 목록에서 Papers·Summaries 폴더는 제외.
- 실제 vault에는 시험 중 쓰지 않는다.

## Review Focus

1. 같은 키워드를 쓴 두 논문 → 요약 노트 키워드 링크가 같은 `[[키워드]]`로 모인다(대소문자·공백 정규화 일관).
2. 요약 다시 만들기 후 보내기 → 요약 노트의 표시 안만 새로, 논문 노트의 `## 내 생각` 보존.
3. 요약 없는 논문 → 논문 노트만, 요약 링크 자리 `요약 없음`.
4. 두 파일 중 하나의 표시가 깨짐 → 둘 다 안 쓰고 어느 파일인지 안내.
5. 예제 논문 요약도 키워드 검증 통과(예제 digest에 keywords 추가, 논문에 나오는 용어로).

### Task 1: 키워드 (규칙·검증·예제)
Files: src/digest/validate.mjs, prompts/digest.md, prompts/agent-digest.md, examples/NguyenEtAlMeCoLog2026/digest.json, tests. Commit `feat(digest): paper keywords`.

### Task 2: 두 노트 빌더·쓰기·API·설정
Files: src/obsidian/note.mjs(buildPaperNote, buildSummaryNote), write.mjs, settings(summaryFolder), server.mjs exportToObsidian, tests. Commit `feat(obsidian): separate paper and summary notes`.

### Task 3: 화면
Files: list.js(요약 노트 폴더 입력), paper.js(토스트), obsidian notes 목록 제외, tests, 스크래치 vault 화면 확인. Commit `feat(reader): two-note Obsidian export UI`.
