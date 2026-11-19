# AGENTS.md — AI 도구용 작업 절차

이 저장소는 Codex, Claude Code 등 어떤 AI 코딩 도구로도 쓸 수 있습니다. 이 파일은 **절차만** 담습니다. 작성 규칙은 `prompts/` 폴더의 문서가 기준이며, 아래 단계에서 해당 문서를 반드시 읽고 그대로 따르세요.

- 모든 명령은 저장소 루트에서 실행합니다.
- 설정은 `paper-reader.config.json`(없으면 기본값)입니다. `<outputDir>`는 설정의 `outputDir`(기본 `./digests`), `<port>`는 `reader.port`(기본 5173)입니다.
- 사용자에게 보이는 문구는 한국어로 씁니다.

## 1. 논문 검색 (paper-search)

1. `npm run search -- "<키워드>"`를 실행합니다. 출력 마지막 줄 `저장: <경로>`가 검색 결과 파일입니다.
2. `prompts/search-summary.md`를 읽고 그 규칙대로 결과 파일의 `summaryKo`를 채웁니다.
3. `prompts/search-summary.md`의 안내대로 섹션별 목록을 사용자에게 보여 줍니다.
4. 사용자가 번호를 고르면 `npm run register -- <검색파일명> <번호…>`로 Zotero에 등록합니다. `<검색파일명>`은 `_search/` 안의 파일 이름(`.json` 생략 가능)입니다.

## 2. 논문 요약 (paper-digest)

1. `npm run extract -- <id>`를 실행합니다. `<id>`는 Zotero citekey 또는 itemKey이며(DOI도 가능), 결과는 `<outputDir>/<id>/source.json`입니다. DOI로 실행했다면 출력의 `저장:` 경로에 있는 폴더 이름(citekey 또는 itemKey)을 이후 단계의 `<id>`로 씁니다.
2. `prompts/digest.md`를 읽고 그 규칙대로 `<outputDir>/<id>/digest.json`을 작성합니다.
3. `npm run check -- <id>`를 실행하고, 문제가 보고되면 고쳐서 통과할 때까지 반복합니다.
4. 사용자에게 읽기 앱 주소 `http://127.0.0.1:<port>/#/paper/<id>`를 안내합니다. 서버가 떠 있지 않으면 `npm run reader`로 실행하라고 안내합니다.

- 이미 추출한 논문은 Zotero로 하이라이트를 보내려면 `npm run extract -- <id>`를 한 번 다시 실행해야 합니다(PDF 좌표 추가). 문장 ID 형식은 `p{페이지}-s{번호}`입니다. 재추출 후 `npm run check -- <id>`를 실행하고, 문제가 보고되면 인용한 문장이 여전히 맞는지 확인해 필요하면 digest를 다시 작성하세요. extractorVersion 3 미만으로 추출한 논문은 원문 패널에 그림·표 이미지가 없으므로, 그림을 보려면 같은 명령으로 재추출합니다(이미지는 `<outputDir>/<id>/figures/`).

## 개발 시 참고

- 테스트: `npm test`(Node), `npm run test:py`(Python 추출기).
- 런타임 npm 의존성은 0개입니다. Python 의존성은 `extract/requirements.txt`에만 두고 `.venv`에 설치합니다.
