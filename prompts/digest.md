# 논문 요약(digest.json) 작성 규칙

이 규칙은 AI 도구에 관계없이 동일하게 적용된다.

## 1. 입력

- `<outputDir>/<id>/source.json` (`npm run extract -- <id>`로 생성). 문장은 `sentences`의 `p{페이지}-s{번호}` ID로 식별한다.
- 설정 `researchContextFile`이 지정되어 있으면 그 Markdown 파일(내 연구 주제)도 읽는다.

## 2. 출력

같은 폴더의 `<outputDir>/<id>/digest.json`. 아래 스키마를 그대로 따른다.

```json
{
  "version": 1,
  "paperId": "<id>",
  "takeaway": { "text": "", "evidence": ["p1-s2"], "why": "" },
  "cards": [{
    "id": "c1",
    "section": "motivation|gap|idea|method|setup|results|analysis|limits|implications",
    "question": "", "answer": "", "explain": "", "bridge": "",
    "items": [{ "kind": "claim|opinion", "label": "", "text": "", "evidence": ["p3-s4"] }],
    "bigNumbers": [{ "value": "13.9%", "label": "", "evidence": ["p8-s2"] }],
    "tables": [{ "title": "Table 3 재구성", "columns": ["Agent", "Acc."], "rows": [["A", "49%"]], "evidence": ["p8-s6"], "note": "" }],
    "figures": [{ "label": "Figure 2", "page": 4, "note": "" }]
  }],
  "glossary": [{ "term": "", "definition": "" }]
}
```

## 3. 카드 순서와 의미

| 순서 | 섹션 | 담는 내용 |
|---|---|---|
| 0 | Takeaway | 이 논문을 한 문장으로 + 왜 읽을 가치가 있는지 |
| 1 | 전제·배경 (Motivation) | 이 분야가 어떤 상황인지, 왜 중요한지 |
| 2 | 문제점 (The gap) | 기존 접근이 무엇을 못 하는지 |
| 3 | 핵심 아이디어 | 저자들의 해결 방향 한 줄 |
| 4 | 방법 (Method) | 구조·구성요소, 필요하면 여러 카드 |
| 5 | 실험 설정 | 무엇을, 어디서, 무엇과 비교해 시험했나 |
| 6 | 결과 | 핵심 수치(큰 숫자), 그림/표 → Zotero 페이지 링크 |
| 7 | 분석·실패 사례 | 결과가 왜 그렇게 나왔는지 |
| 8 | 한계·비판적 검토 | 저자 언급 한계 + AI의 해석(구분 표시) |
| 9 | 시사점·다음 질문 | 내 연구에 주는 의미, 원문에서 더 볼 곳 |

- 0은 `takeaway`, 1~9는 `cards`이며 `section` 값은 순서대로 `motivation, gap, idea, method, setup, results, analysis, limits, implications`다.
- 논문 성격에 따라 섹션을 생략하거나 여러 카드로 나눌 수 있다. 카드 `id`는 `c1`, `c2`, … 로 고유하게 순서대로 매긴다. 중복된 id는 `npm run check`가 "카드 id 중복"으로 보고한다.
- `section`은 `motivation|gap|idea|method|setup|results|analysis|limits|implications` 중 하나만 쓴다. 목록 밖의 값은 `npm run check`가 문제로 보고한다.

## 4. 분량과 범위 — 논문 전체를 담는다

요약은 "초록 다시 쓰기"가 아니다. 이 자료만 읽어도 논문의 흐름(전제 → 문제 → 방법 → 실험 → 결과 → 분석 → 한계)을 처음부터 끝까지 따라갈 수 있어야 한다.

- 카드는 **12~20장**을 기본으로 한다. 짧은 논문(4쪽 이하)만 8장까지 줄일 수 있다.
- 원문의 **모든 본문 절**(Introduction, 방법의 각 하위 절, 실험 설정, 각 결과 절, 분석·논의, 한계)을 최소 한 카드에서 다룬다. 방법·결과가 여러 하위 절이면 하위 절마다 카드를 나눈다.
- `source.json`의 `figures`에 있는 **주요 그림·표는 모두** 어느 카드의 `figures` 또는 `tables`에 연결한다.
- 결과 표는 `tables`로 **재구성**한다(핵심 행·열만 골라도 된다). 숫자는 원문 그대로 옮긴다.
- 분석 카드에는 저자가 설명한 실패 유형·원인을 **하나씩 `label`을 붙여** 나열한다.
- 한계 카드는 저자가 밝힌 한계(claim)와 AI의 비판적 검토(opinion)를 모두 담는다.
- 마지막 카드에는 토론·다음 질문 2~3개를 opinion으로 넣는다.

## 5. 카드 형식

- 질문형 `question` → 한두 문장 `answer` → 해설 `explain` → 근거 bullet(`items`) → 숫자·표·그림 순서로 쓴다.
- `explain`은 **모든 카드에** 쓰는 2~4문장의 해설이다. 옆에서 설명해 주듯 "왜 이게 중요한지, 앞뒤와 어떻게 이어지는지"를 쉬운 말로 쓴다. 원문에 없는 사실은 넣지 않는다.
- `items[].label`은 선택이다. 항목이 병렬 목록(구성요소, 실패 유형 등)일 때 2~4단어 소제목을 붙인다.
- `bridge`는 앞 카드와 잇는 한 문장이다("그래서…", "그런데…"). 새로운 사실을 담지 않는다. 첫 카드는 비워도 된다.

## 6. 근거 규칙

- 원문 사실은 반드시 `kind: "claim"`으로 쓰고 `evidence`에 `source.json`에 실제로 있는 문장 ID를 1개 이상 넣는다. 없는 ID가 하나라도 있으면 검증에서 제거된다.
- 해석·비판·시사점은 `kind: "opinion"`으로 쓴다(화면에 "💬 해석" 배지). 근거는 있으면 넣고 없어도 된다.
- `tables[].evidence`에는 표의 수치가 나오는 원문 문장 ID를 1개 이상 넣는다. 근거가 없거나, `rows`의 칸 수가 `columns`와 다르면 표가 제거된다.
- `takeaway.evidence`에는 실제 `source.json` 문장 ID를 1개 이상 반드시 넣는다. 비었거나 없는 ID가 있으면 `npm run check`가 "takeaway: 근거 확인 필요"로, `takeaway` 자체가 없으면 "takeaway: 없음"으로 보고하고 실패한다.
- 원문에 없는 수치·주장은 쓰지 않는다. 확신이 없으면 쓰지 않는다.

## 7. 문장 길이

길이 규칙은 권고이며 `npm run check`가 검사하지 않는다. 반면 `takeaway` 유무, evidence(claim·bigNumbers·tables·takeaway), 표 형식, 카드 `id` 중복, `section` 값, `figures[].page` 범위는 `npm run check`가 검사한다.

- `answer`: 120자 이내. 3분 모드에서는 질문과 answer만 보이므로 answer만 읽어도 흐름이 이어지게 쓴다.
- `explain`: 2~4문장.
- `items[].text`: 100자 이내.
- 카드당 `items`: 3~6개.

## 8. 결과 카드

- 핵심 수치는 `bigNumbers`를 우선 사용한다(`value`는 짧게, `label`은 무엇의 수치인지, `evidence` 필수).
- 그림·표는 `figures`에 넣는다. `page`는 `source.json`의 `figures`에 있는 page를 쓴다(1 ~ 총 페이지 수).

## 9. 용어집

- `glossary`에는 처음 나오는 전문 용어 5~12개를 넣는다. 정의는 40자 이내, 용어는 영문을 병기한다.

## 10. "내 연구" 맥락

- `researchContextFile`이 없으면 `implications` 카드에 "내 연구와의 연결"을 쓰지 않는다. 다음 질문과 원문에서 더 볼 곳만 쓴다.
- 있으면 "내 연구와의 연결"을 `opinion`으로 쓴다.

## 11. 마무리

1. 다 쓰면 `npm run check -- <id>`를 실행한다.
2. 문제가 보고되면 수정하고 통과할 때까지 반복한다.
3. 통과하면 사용자에게 읽기 앱 주소를 안내한다: `http://127.0.0.1:<port>/#/paper/<id>` (`<port>`는 설정의 `reader.port`).
