---
name: paper-digest
description: Zotero에 있는 논문 PDF를 문장 ID가 붙은 source.json으로 추출하고, 근거 문장이 연결된 한국어 카드형 요약 digest.json을 작성·검증한 뒤 읽기 앱 주소를 안내한다. "/paper-digest <citekey>", "이 논문 요약해줘" 같은 요청에 사용한다.
---

# paper-digest

작성 규칙은 `prompts/digest.md`가 기준입니다. 이 스킬은 절차만 담습니다. 명령은 저장소 루트에서 실행합니다.

1. `npm run extract -- <id>`를 실행합니다(`<id>`: Zotero citekey 또는 itemKey). 결과는 `<outputDir>/<id>/source.json`입니다.
2. `prompts/digest.md`를 읽고 그대로 `<outputDir>/<id>/digest.json`을 작성합니다.
3. `npm run check -- <id>`가 통과할 때까지 보고된 문제를 고치고 다시 실행합니다.
4. 읽기 앱 주소 `http://127.0.0.1:<port>/#/paper/<id>`를 안내합니다(`<port>`: 설정 `reader.port`, 기본 5173). 서버가 떠 있지 않으면 `npm run reader`로 실행하라고 안내합니다.
