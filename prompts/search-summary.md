# 검색 결과 요약(summaryKo) 작성 규칙

대상: `<outputDir>/_search/<YYYY-MM-DD>-<slug>.json`

1. 파일의 `papers[]`를 순서대로 읽고, 각 paper의 `summaryKo`를 채운다.
2. 근거는 해당 paper의 `abstract`뿐이다. 제목·저널·외부 지식으로 내용을 보태지 않는다.
3. `summaryKo`는 한국어 한 문장, 60자 내외. 전문 용어는 영문을 병기한다(예: "이상 탐지(anomaly detection)").
4. `abstract`가 비어 있으면 `"초록 없음"`을 넣는다.
5. `summaryKo` 외의 필드는 절대 수정하지 않는다. JSON 구조·들여쓰기를 유지한다.
6. 다 쓰면 사용자에게 섹션별(🔥 인용 급증 / 🌱 새 주제 / 🏛 저널 흐름)로 번호·제목·`summaryKo`·배지·지표를 목록으로 보여준다. 값이 `null`인 지표는 "미확인"으로 표기한다.
7. 읽기 앱 주소를 안내한다: `http://127.0.0.1:<port>/#/search/<파일명>` (`<port>`는 설정의 `reader.port`).
