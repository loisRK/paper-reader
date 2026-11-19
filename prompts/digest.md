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
    "question": "", "answer": "", "bridge": "",
    "items": [{ "kind": "claim|opinion", "text": "", "evidence": ["p3-s4"] }],
    "bigNumbers": [{ "value": "13.9%", "label": "", "evidence": ["p8-s2"] }],
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
- 논문 성격에 따라 섹션을 생략하거나 여러 카드로 나눌 수 있다. 카드 `id`는 `c1`, `c2`, … 순서대로 매긴다.

## 4. 카드 형식

- 질문형 `question` → 한두 문장 `answer` → 근거 bullet(`items`) 순서로 쓴다.
- `bridge`는 앞 카드와 잇는 한 문장이다("그래서…", "그런데…"). 새로운 사실을 담지 않는다. 첫 카드는 비워도 된다.

## 5. 근거 규칙

- 원문 사실은 반드시 `kind: "claim"`으로 쓰고 `evidence`에 `source.json`에 실제로 있는 문장 ID를 1개 이상 넣는다. 없는 ID가 하나라도 있으면 검증에서 제거된다.
- 해석·비판·시사점은 `kind: "opinion"`으로 쓴다(화면에 "💬 해석" 배지). 근거는 있으면 넣고 없어도 된다.
- 원문에 없는 수치·주장은 쓰지 않는다. 확신이 없으면 쓰지 않는다.

## 6. 문장 길이

- `answer`: 80자 이내.
- `items[].text`: 60자 이내.
- 카드당 `items`: 2~5개.

## 7. 결과 카드

- 핵심 수치는 `bigNumbers`를 우선 사용한다(`value`는 짧게, `label`은 무엇의 수치인지, `evidence` 필수).
- 그림·표는 `figures`에 넣는다. `page`는 `source.json`의 `figures`에 있는 page를 쓴다(1 ~ 총 페이지 수).

## 8. 용어집

- `glossary`에는 처음 나오는 전문 용어 5~12개를 넣는다. 정의는 40자 이내, 용어는 영문을 병기한다.

## 9. "내 연구" 맥락

- `researchContextFile`이 없으면 `implications` 카드에 "내 연구와의 연결"을 쓰지 않는다. 다음 질문과 원문에서 더 볼 곳만 쓴다.
- 있으면 "내 연구와의 연결"을 `opinion`으로 쓴다.

## 10. 마무리

1. 다 쓰면 `npm run check -- <id>`를 실행한다.
2. 문제가 보고되면 수정하고 통과할 때까지 반복한다.
3. 통과하면 사용자에게 읽기 앱 주소를 안내한다: `http://127.0.0.1:<port>/#/paper/<id>` (`<port>`는 설정의 `reader.port`).
