---
name: paper-search
description: 키워드로 최근 동료심사 저널 논문을 검색하고(인용 급상승·신흥 주제·저널 흐름), 한국어 한 줄 요약을 채워 목록으로 보여 준 뒤, 사용자가 고른 번호를 Zotero에 등록한다. "논문 찾아줘", "/paper-search <키워드>" 같은 요청에 사용한다.
---

# paper-search

작성 규칙은 `prompts/search-summary.md`가 기준입니다. 이 스킬은 절차만 담습니다. 명령은 저장소 루트에서 실행합니다.

1. `npm run search -- "<키워드>"`를 실행합니다. 출력의 `저장: <경로>`가 검색 결과 파일입니다.
2. `prompts/search-summary.md`를 읽고 그대로 결과 파일의 `summaryKo`를 채웁니다.
3. 같은 문서의 안내대로 섹션별 목록과 읽기 앱 주소를 사용자에게 보여 줍니다.
4. 사용자가 번호를 말하면 `npm run register -- <검색파일명> <번호…>`로 Zotero에 등록하고 결과를 알려 줍니다.

오류가 나면 명령이 출력한 안내 문구(예: OpenAlex API 키, Zotero 실행 여부)를 그대로 사용자에게 전달합니다.
