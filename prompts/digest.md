# 논문 요약(digest.json) 작성 규칙

이 규칙은 AI 도구에 관계없이 동일하게 적용된다.

**요약은 논문 내용만 정리한 카드다.** 카드뉴스처럼 핵심과 쟁점을 빠르게 파악하게 하고, 그 카드를 따라 원문 전체로 들어가 깊게 이해하게 하는 것이 목적이다. 모델의 해석·의견·평가·전망은 어디에도 넣지 않는다. 판단이 담긴 문장은 저자가 그렇게 말했을 때만, 저자의 말로("저자들은 …라고 본다") 쓴다.

## 1. 입력

- `<outputDir>/<id>/source.json` (`npm run extract -- <id>`로 생성). 문장은 `sentences`의 `p{페이지}-s{번호}` ID로 식별한다.
- 앱이 AI 도구를 직접 실행할 때는 `source.json` 대신 같은 내용의 `paper.txt`(한 줄에 `[문장ID] 문장`, `## p.<n>` 쪽 표시, `### ` 제목, `(caption) ` 캡션, `(figure text) ` 그림 안의 글, 참고문헌 제외)와 `figures.txt`(한 줄에 `라벨 | 쪽 | caption: 문장ID`)를 준다. 이 문서에서 `source.json`의 문장·`figures`라고 한 것은 그 두 파일의 것으로 읽는다.

## 2. 출력

같은 폴더의 `<outputDir>/<id>/digest.json`. 아래 스키마를 그대로 따른다.

```json
{
  "version": 1,
  "paperId": "<id>",
  "paperKind": "empirical",
  "takeaway": { "text": "", "evidence": ["p1-s2"], "why": "" },
  "cards": [{
    "id": "c1",
    "section": "motivation|gap|idea|method|setup|results|analysis|limits|implications",
    "question": "", "answer": "", "explain": "", "bridge": "",
    "items": [{ "kind": "claim", "label": "", "text": "", "evidence": ["p3-s4"] }],
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
| 0 | Takeaway | 이 논문을 한 문장으로 + 저자가 밝힌 기여·의의(`why`) |
| 1 | 전제·배경 (Motivation) | 저자가 설명한 이 분야의 상황과 문제의 배경 |
| 2 | 문제점 (The gap) | 기존 접근이 무엇을 못 하는지 |
| 3 | 핵심 아이디어 | 저자들의 해결 방향 한 줄 |
| 4 | 방법 (Method) | 구조·구성요소, 필요하면 여러 카드 |
| 5 | 실험 설정 | 무엇을, 어디서, 무엇과 비교해 시험했나 |
| 6 | 결과 | 핵심 수치(큰 숫자), 그림/표 → Zotero 페이지 링크 |
| 7 | 분석·실패 사례 | 결과가 왜 그렇게 나왔는지 |
| 8 | 한계 | 저자가 밝힌 한계·타당성 위협 요인 |
| 9 | 시사점 | 저자가 밝힌 향후 연구·적용 범위 + 원문에서 더 볼 곳 |

- 0은 `takeaway`, 1~9는 `cards`이며 `section` 값은 순서대로 `motivation, gap, idea, method, setup, results, analysis, limits, implications`다.
- 9개 섹션은 모두 최소 한 카드씩 쓴다(`non-empirical` 논문은 `setup`·`results`를 빼도 된다 — 아래 "논문 종류" 참고). 한 섹션을 여러 카드로 나눌 수 있다. 카드 `id`는 `c1`, `c2`, … 로 고유하게(`takeaway`는 쓸 수 없다) 순서대로 매긴다. 중복된 id는 `npm run check`가 "카드 id 중복"으로 보고한다.
- `section`은 `motivation|gap|idea|method|setup|results|analysis|limits|implications` 중 하나만 쓴다. 목록 밖의 값은 `npm run check`가 문제로 보고한다.

### 논문 종류(`paperKind`)

- 기본값은 `"empirical"`이다(생략하면 empirical). 실험·평가·측정 결과가 하나라도 있는 논문은 모두 empirical이다.
- `"non-empirical"`은 논문에 실험·평가·측정이 **전혀 없을 때만** 쓴다. 예: 이론·증명 논문, position paper, 정량 결과가 없는 survey, 정성 연구.
- non-empirical이면 `setup`·`results` 카드는 필수가 아니고, 결과 카드의 숫자·표 검사도 하지 않는다. 카드 수 기준과 나머지 7개 섹션은 그대로다. 저자가 정성적 결과·발견을 밝혔으면 `results` 카드에 claim으로 쓴다.
- 원문에 수치 결과가 있는데 숫자를 옮기기 싫어서 non-empirical로 표시하면 안 된다. 반대로 empirical 논문에서 숫자가 모자란다고 원문에 없는 수치나 결과가 아닌 숫자(쪽 수, 정리 번호 등)를 넣어서도 안 된다.

## 4. 분량과 범위 — 논문 전체를 담는다

요약은 "초록 다시 쓰기"가 아니다. 이 자료만 읽어도 논문의 흐름(전제 → 문제 → 방법 → 실험 → 결과 → 분석 → 한계)을 처음부터 끝까지 따라갈 수 있어야 한다.

- 카드는 **12~20장**을 기본으로 한다. 짧은 논문(6쪽 이하)만 8장까지 줄일 수 있다(그래도 9개 섹션은 모두 쓴다).
- 원문의 **모든 본문 절**(Introduction, 방법의 각 하위 절, 실험 설정, 각 결과 절, 분석·논의, 한계)을 최소 한 카드에서 다룬다. 방법·결과가 여러 하위 절이면 하위 절마다 카드를 나눈다.
- `source.json`의 `figures`에 있는 **주요 그림·표는 모두** 어느 카드의 `figures` 또는 `tables`에 연결한다.
- 결과 표는 `tables`로 **재구성**한다(핵심 행·열만 골라도 된다). 숫자는 원문 그대로 옮긴다.
- 분석 카드에는 저자가 설명한 실패 유형·원인을 **하나씩 `label`을 붙여** 나열한다.
- 결과(`results`) 카드 중 적어도 하나에는 `bigNumbers`나 `tables`로 원문 수치를 넣는다(`non-empirical` 논문은 예외).
- 한계(`limits`) 카드에는 저자가 밝힌 한계·위협 요인만 claim으로 쓴다. 모델이 찾아낸 약점이나 비판은 쓰지 않는다. 저자가 한계를 밝히지 않았으면 `items` 없이 `explain`에 "저자들은 한계를 따로 밝히지 않았다."와 그 카드가 앞뒤와 어떻게 이어지는지만 쓴다.
- 시사점(`implications`) 카드에는 저자가 밝힌 향후 연구·적용 범위를 claim으로 쓰고, "원문에서 더 볼 곳"(섹션·식·그림·표를 가리키는 안내)을 `label: "원문에서 더 볼 곳"`인 claim으로 넣는다. 안내도 그 내용이 나오는 문장 ID를 근거로 단다. 모델이 만든 토론 질문은 넣지 않는다.

## 5. 카드 형식

- 질문형 `question` → 한두 문장 `answer` → 해설 `explain` → 근거 bullet(`items`) → 숫자·표·그림 순서로 쓴다.
- `explain`은 **모든 카드에** 쓰는 2~4문장의 해설이다. 그 카드의 논문 내용을 쉬운 말로 다시 풀고, 앞뒤 카드와 어떻게 이어지는지 설명한다. 원문에 없는 사실, 평가("중요하다", "흥미롭다", "의미 있다"), 전망은 넣지 않는다. 저자가 그렇게 평가했으면 "저자들은 …라고 본다"처럼 저자의 말로 쓴다.
- `takeaway.why`에는 저자가 밝힌 기여·의의만 쓴다.
- `items[].label`은 선택이다. 항목이 병렬 목록(구성요소, 실패 유형 등)일 때 2~4단어 소제목을 붙인다.
- `bridge`는 앞 카드와 잇는 한 문장이다("그래서…", "그런데…"). 새로운 사실을 담지 않는다. 첫 카드는 비워도 된다.

## 6. 근거 규칙

- `items`는 모두 `kind: "claim"`이다. `evidence`에 `source.json`에 실제로 있는 문장 ID를 1개 이상 넣는다. 없는 ID가 하나라도 있으면 검증에서 제거된다.
- 해석·의견(`kind: "opinion"`)은 쓰지 않는다. 있으면 `npm run check`가 "해석·의견 항목은 쓰지 않습니다"로 보고하고 제거한다.
- 판단을 claim으로 위장하지 않는다. 예: "이 결과는 의미 있다", "비교가 다소 유리했을 수 있다"는 근거 문장이 그렇게 말하지 않으므로 쓰면 안 된다. 근거 문장이 실제로 그 내용을 말하는지 확인하고 쓴다(기계 검증은 ID 존재만 확인한다).
- `tables[].evidence`에는 표의 수치가 나오는 원문 문장 ID를 1개 이상 넣는다. 근거가 없거나, `rows`의 칸 수가 `columns`와 다르면 표가 제거된다.
- `takeaway.evidence`에는 실제 `source.json` 문장 ID를 1개 이상 반드시 넣는다. 비었거나 없는 ID가 있으면 `npm run check`가 "takeaway: 근거 확인 필요"로, `takeaway` 자체가 없으면 "takeaway: 없음"으로 보고하고 실패한다.
- 원문에 없는 수치·주장은 쓰지 않는다. 확신이 없으면 쓰지 않는다.

## 7. 문장 길이

`npm run check`가 검사하는 것: `takeaway` 유무, evidence(claim·bigNumbers·tables·takeaway), 표 형식, 카드 `id` 중복, `section` 값, `figures[].page` 범위, opinion 항목, 카드 수(12장, 6쪽 이하 논문은 8장 이상), 빠진 섹션, `paperKind` 값, 결과 카드의 숫자·표(empirical만), 카드 id `takeaway` 금지, `explain` 문장 수, claim 길이. 아래 길이 규칙 중 "검사:"가 붙은 것만 검사하고 나머지는 권고다.

- `answer`: 120자 이내. 3분 모드에서는 질문과 answer만 보이므로 answer만 읽어도 흐름이 이어지게 쓴다.
- `explain`: 2~4문장(검사: 2문장 미만이면 문제). 문장은 `.`·`!`·`?`(예: "…이다.")로 끝맺는다.
- `items[].text`: 100자 이내(검사: claim이 100자를 넘으면 "문장이 깁니다"). 길면 두 항목으로 나눈다.
- 카드당 `items`: 3~6개.

## 8. 결과 카드

- 결과 카드 중 적어도 하나에는 `bigNumbers`나 `tables`가 있어야 한다(검사: 없으면 "결과 카드에 숫자(bigNumbers)나 표(tables)가 없습니다"). `paperKind: "non-empirical"`이면 이 검사를 하지 않는다. 수치는 원문의 결과 수치만 쓴다.
- 핵심 수치는 `bigNumbers`를 우선 사용한다(`value`는 짧게, `label`은 무엇의 수치인지, `evidence` 필수).
- 그림·표는 `figures`에 넣는다. `page`는 `source.json`의 `figures`에 있는 page를 쓴다(1 ~ 총 페이지 수). 정수여야 한다(`figures.txt`의 `p.4`면 `4`).
- `figures[].label`은 `source.json`의 `figures[].label`을 그대로 쓴다(예: "Figure 2", "Table 1").

## 9. 용어집

- `glossary`에는 처음 나오는 전문 용어 5~12개를 넣는다. 정의는 40자 이내, 용어는 영문을 병기한다.

## 10. 마무리

1. 다 쓰면 `npm run check -- <id>`를 실행한다.
2. 문제가 보고되면 수정하고 통과할 때까지 반복한다.
3. 통과하면 사용자에게 읽기 앱 주소를 안내한다: `http://127.0.0.1:<port>/#/paper/<id>` (`<port>`는 설정의 `reader.port`).
