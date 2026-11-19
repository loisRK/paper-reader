# 0단계: 디자인 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 읽기 앱의 색·글꼴·모양을 Apple 웹사이트 디자인 원칙(단일 파란 강조색, SF 글꼴, 알약 버튼, 그림자 없음)으로 바꾼다. 화면 구조와 기능은 그대로.

**Architecture:** `src/reader/public/styles.css`의 디자인 토큰(`:root` 변수)과 컴포넌트 스타일을 바꾼다. 새 토큰 대비는 Node 시험으로 검사한다.

**Tech Stack:** CSS(커스텀 속성, `color-mix`, `backdrop-filter`), Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-19-pdf-view-and-colleague-app-design.md` — "0단계: 디자인 정리". 참고값: `docs/design/DESIGN-apple.md`.

## Global Constraints

- 바꾸는 파일: `src/reader/public/styles.css`, 새 시험 `tests/design-tokens.test.mjs`. JS·HTML의 클래스 이름과 구조는 바꾸지 않는다(`views/*.js`는 수정 금지).
- 라이트 토큰: 글자 `#1d1d1f`, 바탕 `#f5f5f7`(페이지)·`#ffffff`(카드·패널), 구분선 `#e0e0e0`, 강조(누를 수 있는 것) `#0066cc`, 포커스 `#0071e3`, 보조 글자 `#6e6e73`.
- 다크 토큰: 바탕 `#000000`(페이지)·`#1d1d1f`(카드·패널)·`#272729`(보조 면), 글자 `#f5f5f7`, 보조 글자 `#a1a1a6`, 구분선 `#38383a`, 강조 `#2997ff`, 포커스 `#2997ff`.
- 강조색 바탕 위 글자(`--on-accent`): 라이트 `#ffffff`, 다크 `#000000`(`#2997ff` 위 흰 글자는 대비 약 3:1로 부족).
- 강조색은 파란색 하나. 청록(`#0f766e` 계열)·라임(`#4d7c0f`, `#84cc16` 계열)과 그라데이션은 남기지 않는다. 진행 막대 채움도 파란색 단색.
- 근거 문장 강조(`--hl`): 옅은 노란 형광펜. 라이트 `#fff3b0`, 테두리 `--hl-ring` `#e6c200`; 다크 `#5c4d00`, 테두리 `#d4b000`.
- 글꼴: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", system-ui, sans-serif`. 본문 17px(`1.0625rem`)·줄 간격 1.47, 원문 본문 줄 간격은 읽기용으로 1.7 유지. 제목 굵기 600(650·700·750은 600으로). 1.2rem 이상 제목은 `letter-spacing: -0.01em`.
- 모양: 주요 버튼 = 파란 바탕 흰 글자 알약(`border-radius: 999px`), 보조 버튼(`.btn-quiet`) = 투명 바탕 + 얇은 선 알약, 카드·타일 = `18px` 모서리 + `1px` 구분선, 그림자 없음(`--shadow: none`). 단, 떠 있는 요소(`.note-pop`, `.sel-toolbar`, `.toast`, 모바일 시트)는 겹침 구분이 필요하므로 `0 8px 30px rgb(0 0 0 / .16)` 하나만 허용.
- 상단 막대(`.topbar`)·시트 막대: 반투명 바탕 + `backdrop-filter: saturate(180%) blur(20px)`.
- 버튼 누름: `:active { transform: scale(0.95) }`(`prefers-reduced-motion`이면 없음).
- 하이라이트 8색(`--mark`, `--sw`)과 `.sent.mark-mine`의 색 계산은 바꾸지 않는다.
- 대비: 아래 쌍이 WCAG AA 이상(일반 글자 4.5:1, 큰 글자·UI 3:1).

## Review Focus

1. **다크 모드에서 파란 버튼 글자 대비** → `--on-accent`가 다크에서 `#000000`인지 대비 시험으로 고정.
2. **청록·라임이 남은 곳**(`.tag-ok`, `.st-connected`, `.read-check`, `.bignum-value`, `.card.is-read`) → 파란색 또는 회색 계열로 바뀌었는지 시험이 hex를 검색.
3. **카드 현재 표시(`.card.current`)**가 그림자 없이도 보이는지 → 파란 2px 테두리.
4. **원문 강조와 내 하이라이트가 겹칠 때** 구분되는지 → `.sent.hl`은 노랑 + 테두리, 내 하이라이트는 색 배경만.
5. **`.src-figure img`** 흰 배경 유지(다크 모드에서 그림 가독성).

---

### Task 1: 디자인 토큰과 컴포넌트 스타일 교체

**Files:**
- Modify: `src/reader/public/styles.css`
- Create: `tests/design-tokens.test.mjs`

**Interfaces:**
- Produces: `:root` 변수 이름은 지금 것을 유지(`--bg --surface --surface-2 --text --muted --line --accent --accent-strong --accent-soft --hl --hl-ring --warn-* --focus --shadow --radius --font`)하고 값만 바꾼다. 쓰지 않게 되는 `--lime`, `--lime-soft`는 지운다(다른 곳에서 참조하지 않게 정리). 새 변수 `--radius-sm: 8px`, `--float-shadow` 추가 가능.

- [ ] **Step 1: 실패 시험 작성** — `tests/design-tokens.test.mjs`: styles.css를 읽어 라이트 `:root {…}`와 `@media (prefers-color-scheme: dark) { :root {…} }` 블록의 변수를 파싱.

```js
test('light tokens match the Apple palette', ...)   // --text #1d1d1f, --bg #f5f5f7, --surface #ffffff, --accent #0066cc, --line #e0e0e0
test('dark tokens', ...)                             // --bg #000000, --surface #1d1d1f, --text #f5f5f7, --accent #2997ff
test('contrast AA', ...)  // contrast(text,bg)>=4.5, (text,surface)>=4.5, (muted,surface)>=4.5, (accent,surface)>=4.5,
                          // (button text on accent)>=4.5 in both modes, (text,hl)>=4.5 in both modes
test('no teal/lime/gradient left', ...)  // css has none of /#0f766e|#115e59|#4d7c0f|#84cc16|#a3e635|#2dd4bf|linear-gradient|--lime/i
test('no shadows on cards and tiles', ...) // --shadow value is `none`
```
대비 계산은 시험 파일 안에 WCAG 상대 휘도 공식으로 직접 구현(의존성 없음). 버튼 글자색은 `.btn` 규칙이 쓰는 변수(`--on-accent`)를 같은 방식으로 읽는다.

- [ ] **Step 2: 실패 확인** — `node --test tests/design-tokens.test.mjs` → FAIL
- [ ] **Step 3: 구현** — Global Constraints의 값으로 토큰과 컴포넌트 규칙을 바꾼다. `.btn` = 파란 알약(`--accent` 바탕, `--on-accent` 글자), `.btn-quiet` = 선 알약, `.toggle[aria-pressed=true]` = 파란 바탕. `.tag-ok`·`.st-connected` = 옅은 파랑 바탕 + 파란 글자(`--accent-soft`/`--accent-strong`). `.read-check input { accent-color: var(--accent) }`.
- [ ] **Step 4: 통과 확인** — `npm test` → 전부 PASS
- [ ] **Step 5: 화면 확인 자료** — 서버(`npm run reader`, 이미 떠 있으면 그대로) 기준으로 헤드리스 Chrome으로 라이트·다크 각각 목록 화면과 논문 화면 캡처를 저장해 보고에 경로를 적는다:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --window-size=1400,900 --screenshot=<path> "http://127.0.0.1:5173/#/paper/<id>"` (다크는 `--force-dark-mode` 또는 `--blink-settings=preferredColorScheme=0`). 캡처는 스크래치 폴더에 둔다, 저장소에 넣지 않는다.
- [ ] **Step 6: Commit** — `style(reader): Apple-style design tokens and components`
