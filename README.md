# Paper Reader

동료심사(peer-reviewed) 저널 논문을 찾고, Zotero에 있는 PDF를 **문장 단위로 주소가 붙은 텍스트**로 추출한 뒤, 어떤 AI 코딩 도구(Claude Code, Codex 등)로든 **근거 문장이 연결된 한국어 카드형 요약**을 만들어 로컬 읽기 앱에서 읽는 도구입니다.

긴 논문을 끝까지 붙잡고 있기 힘든 독자(예: ADHD)를 염두에 두고 만들었습니다.

- 🔎 **검색**: OpenAlex로 최근 논문을 찾아 세 갈래(🔥 인용 급증 / 🌱 새 주제 / 🏛 저널 흐름)로 골라 줍니다. preprint·학회 논문·리뷰·editorial 등은 제외하고 저널 원저만 남깁니다.
- 📄 **추출**: Zotero의 PDF를 `p{페이지}-s{번호}` 문장 ID가 붙은 `source.json`으로 바꿉니다.
- 🤖 **요약**: AI 도구가 `prompts/digest.md` 규칙에 따라 `digest.json`을 씁니다. 원문 사실(`claim`)에는 반드시 근거 문장 ID가 붙고, 해석(`opinion`)은 "💬 해석"으로 구분됩니다.
- 📖 **읽기**: 카드 하나씩 읽고, 근거 문장을 바로 확인하고, Zotero PDF의 해당 페이지로 이동합니다. 3분/10분 모드, 집중 모드, 읽은 카드 진행률을 지원합니다.

> 이 도구는 AI API를 직접 호출하지 않습니다. 요약은 여러분이 쓰는 AI 코딩 도구가 작성하고, 이 저장소는 규칙·검증·읽기 화면을 제공합니다.

## 요구사항

| 항목 | 버전 | 용도 |
|---|---|---|
| Node.js | 22 이상 | 검색·검증·읽기 앱 |
| Python | 3.10 이상 | PDF 추출(PyMuPDF) |
| Zotero | 7 이상 (메모를 Zotero로 보내려면 10 이상) | 논문 등록·PDF 보관, 메모 동기화 |
| AI 코딩 도구 | Claude Code, Codex 등 | 검색 결과 한 줄 요약, 논문 요약 작성 |
| 운영체제 | macOS, Linux | Windows는 지원하지 않습니다(추출기가 `.venv/bin/python` 경로를 씁니다) |

### Zotero 로컬 API 켜기

Zotero 7 이상에서 **설정(Settings) → 고급(Advanced) → "이 컴퓨터의 다른 애플리케이션이 Zotero와 통신하도록 허용"**(Allow other applications on this computer to communicate with Zotero)을 켜세요. 이 도구는 Zotero가 실행 중일 때 `http://127.0.0.1:23119`의 로컬 API로만 통신합니다. 이 설정이 꺼져 있으면 Zotero가 실행 중이어도 읽기 앱에는 `Zotero 연결 대기 중`과 함께 `Zotero 로컬 API가 응답하지 않습니다(HTTP 403)` 안내가 표시됩니다.

## 설치

npm 의존성이 없으므로 `npm install`은 필요 없습니다. Python 추출기만 저장소 안의 가상환경(`.venv`)에 설치합니다.

```bash
git clone <this-repo-url> paper-reader
cd paper-reader
python3 -m venv .venv && .venv/bin/pip install -r extract/requirements.txt
cp paper-reader.config.example.json paper-reader.config.json
```

`paper-reader.config.json`은 git에 올라가지 않습니다(개인 키·경로 보관용).

## 설정

`paper-reader.config.json`의 주요 항목입니다. 상대 경로는 설정 파일 위치 기준입니다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `outputDir` | `./digests` | 추출·요약·검색 결과가 저장되는 폴더 |
| `reader.port` | `5173` | 읽기 앱 포트 (`127.0.0.1`에만 열림) |
| `search.openalexApiKey` | `null` | OpenAlex 무료 API 키 (아래 참고) |
| `search.contactEmail` | `null` | (선택) OpenAlex 요청에 붙일 연락처 |
| `search.monthsBack` / `perTrend` / `emergingWindowMonths` / `topJournals` | 24 / 5 / 6 / 5 | 검색 기간, 트렌드별 편수, 새 주제 기간(개월), 저널 수 |
| `metrics.sjrCsv` | `./data/scimagojr.csv` | SCImago(SJR) CSV 경로 |
| `metrics.mjlCsv` | `null` | Clarivate Master Journal List CSV 경로 |
| `zotero.authFile` | `./data/zotero-auth.json` | Zotero 쓰기 허용 키 저장 위치 (git에 올라가지 않음) |
| `researchContextFile` | `null` | (선택) 내 연구 주제를 적은 Markdown. 있으면 요약에 "내 연구와의 연결"이 추가됩니다 |

### OpenAlex API 키 (권장)

<https://openalex.org/settings/api> 에서 무료 API 키를 받아 `search.openalexApiKey`에 넣으세요. 키 없는 익명 요청은 사용량이 제한되어 `401`/`429` 오류로 실패하는 경우가 실제로 있습니다. 이 경우 `npm run search`가 키 설정 방법을 안내합니다.

### 저널 지표 (선택)

- **SJR(Scopus·사분위)**: `npm run metrics:sjr`를 실행하면 SCImago CSV를 `./data/`에 받고, 설정에 넣을 경로를 출력합니다. 그 경로를 `metrics.sjrCsv`에 넣으세요.
- **Web of Science(SCIE/SSCI)**: Clarivate **Master Journal List**(<https://mjl.clarivate.com>, 로그인 필요)에서 저널 목록 CSV를 내려받아 `metrics.mjlCsv`에 경로를 넣으세요.
- 파일이 없거나 저널을 찾지 못한 지표는 화면에 **"미확인"**으로 표시됩니다(추측하지 않음).

## 사용법

### Claude Code

이 저장소에는 `.claude/skills/`에 두 스킬이 들어 있습니다. 저장소 폴더에서 Claude Code를 열고:

1. `/paper-search LLM agent operations` → 검색, 한 줄 요약, 섹션별 목록. 마음에 드는 번호를 말하면 Zotero에 등록됩니다.
2. Zotero에서 PDF를 확보해 항목에 첨부합니다(오픈 액세스가 아니면 기관 구독 등으로).
3. `/paper-digest <citekey>` → 추출, 요약 작성, 검증, 읽기 앱 주소 안내.

### Codex 및 기타 AI 도구

저장소 루트의 [`AGENTS.md`](AGENTS.md)에 같은 절차가 적혀 있습니다. 도구에게 "AGENTS.md대로 'LLM agent operations' 논문을 검색해줘", "AGENTS.md대로 `<citekey>` 논문을 요약해줘"처럼 요청하세요. 작성 규칙은 모든 도구가 `prompts/search-summary.md`, `prompts/digest.md`를 공통으로 따릅니다.

### 직접 실행하는 명령

```bash
npm run search -- "LLM agent operations"     # 검색 → <outputDir>/_search/<날짜>-<slug>.json
npm run register -- <검색파일명> 1 3          # 고른 번호를 Zotero에 등록
npm run extract -- <citekey|itemKey>          # Zotero PDF → <outputDir>/<id>/source.json
npm run check -- <citekey|itemKey>            # outputDir의 digest.json 검증 (근거 ID·section·그림 페이지)
npm run reader                                # 읽기 앱: http://127.0.0.1:5173
```

### `<citekey|itemKey>`는 어디서 찾나요?

`npm run extract`와 `/paper-digest`에는 Zotero 항목을 가리키는 값 하나를 넘깁니다. 다음 중 아무거나 쓸 수 있습니다.

1. **citekey**: [Better BibTeX](https://retorque.re/zotero-better-bibtex/) 플러그인을 쓰면 항목마다 citekey(예: `chen2025agent`)가 생깁니다. Zotero 7 이상은 항목 정보(Info) 창의 기본 **"Citation Key"** 필드도 인식합니다. citekey가 있으면 그것이 결과 폴더 이름(`<outputDir>/<citekey>/`)이 됩니다.
2. **itemKey**: citekey가 없으면 Zotero의 8자리 항목 key(예: `H9RA4VSE`)를 쓰세요. 항목을 오른쪽 클릭 → **"Copy Zotero URI"**(또는 Zotero 링크 복사)를 하면 `zotero://select/library/items/<KEY>` 형태가 복사되는데, 마지막 8자리가 itemKey입니다(Zotero 버전에 따라 메뉴 이름이 조금 다를 수 있습니다).
3. **DOI**: `10.`으로 시작하는 DOI(예: `10.1016/j.xxx.2025.1`)를 넘기면 Zotero에서 DOI 필드가 같은 항목을 찾습니다(대소문자 무시). 결과 폴더 이름은 citekey, 없으면 itemKey가 됩니다.

`npm run check`에는 추출 후 만들어진 폴더 이름(citekey 또는 itemKey)을 넘깁니다. 이 명령은 `outputDir` 안의 논문만 검사하며, 저장소의 `examples/`는 `npm test`가 검증합니다.

### 예제로 먼저 둘러보기

설치 직후 `npm run reader`를 실행하면 목록에 **"예제"** 배지가 붙은 공개 논문 1편이 보입니다. CC BY 4.0 라이선스 논문으로 만든 `source.json`·`digest.json`이 [`examples/`](examples/)에 들어 있습니다(출처·라이선스는 각 예제 폴더의 README 참고). 예제의 읽기 진행률은 `outputDir`에 저장되며 저장소 파일은 바뀌지 않습니다.

## Zotero에 메모 보내기

읽다가 남긴 하이라이트와 메모를 Zotero PDF에 그대로 보냅니다. **Zotero 10 이상**이 필요합니다. Zotero 7~9에서는 Zotero의 메모를 읽기만 하고, 내 메모는 이 컴퓨터에만 저장됩니다(`Zotero 10 이상에서만 메모를 Zotero로 보낼 수 있습니다. 메모는 이 컴퓨터에 저장됩니다.`).

### 처음 한 번: 쓰기 허용

1. 읽기 앱에서 **`Zotero 쓰기 허용`** 버튼을 누릅니다.
2. Zotero에 허용 창이 뜨면 **"Always Allow(항상 허용)"**를 고릅니다. "Allow"만 고르면 다음 쓰기 때 Zotero가 다시 묻습니다.
3. 허용을 취소하려면 Zotero **설정 → 고급 → "Clear Write Authorizations"**를 누르세요.

허용 키는 `data/zotero-auth.json`(git에 올라가지 않음, 파일 권한 600)에 저장됩니다. 위치는 설정의 `zotero.authFile`로 바꿀 수 있습니다.

### 쓰는 법

| 하고 싶은 일 | 방법 |
|---|---|
| 문장 하이라이트 | **원문** 패널에서 문장을 드래그 → `🖍 하이라이트` (키보드 `h`) |
| 하이라이트 + 메모 | 드래그 → `📝 메모` (키보드 `m`) |
| 색 고르기 | 8가지 색 중 선택 |
| 카드별 내 생각 | 카드의 `📝 내 메모` (10분 모드에서만 보입니다) |
| Zotero에서 만든 주석 보기 | 원문에 점선 밑줄 + 🟡로 표시 |

- 카드 메모는 Zotero 논문 아래 **`Paper Reader 메모`** 노트 하나에 모입니다.
- Zotero에서 고친 내용은 약 5초마다 읽기 앱에 반영됩니다.

### 안전장치

- 읽기 앱은 **자신이 만든 항목(태그 `paper-reader`)만** 고치거나 지웁니다. 내가 Zotero에서 직접 만든 주석은 건드리지 않습니다.
- Zotero가 꺼져 있어도 메모는 이 컴퓨터(`<outputDir>/<id>/notes.json`, 보낼 목록 `pending.json`)에 저장되고, 화면에 `Zotero 연결 대기 중`으로 표시됩니다. Zotero를 켠 뒤 그 논문을 읽기 앱에서 열어 두면 약 5초마다 자동으로 전송됩니다(논문을 열지 않으면 보내지 않습니다).
- 같은 항목을 양쪽에서 고쳤다면 **Zotero 내용이 우선**이며, 읽기 앱에는 내가 쓴 내용이 함께 표시됩니다. 노트는 충돌 안내가 뜨고 `내 메모로 덮어쓰기` / `Zotero 내용 유지` 중에 고릅니다.
- **예제 논문**에는 메모를 저장하지 않습니다.

### 예전에 추출한 논문

Zotero 하이라이트에는 PDF 위치(좌표)가, 원문 패널의 그림·표 이미지에는 새 추출기(extractorVersion 3)가 필요합니다. 이전에 추출한 논문은 한 번만 다시 추출하세요. 그림·표는 `<outputDir>/<id>/figures/fig-<쪽>-<n>.png`로 저장되고, 그림 속 글자 조각은 원문 패널에서 "그림 속 글자 보기"로 접힙니다. 그 뒤 `npm run check -- <citekey|itemKey>`로 요약이 여전히 맞는지 확인하세요.

```bash
npm run extract -- <citekey|itemKey>
```

## 저작권과 커밋되지 않는 것

- 여러분이 만든 산출물(`digests/` 등 `outputDir`의 `source.json`·`digest.json`·그림 이미지(`figures/*.png`)·검색 결과)에는 논문 원문 텍스트가 들어 있으므로 **git에 커밋되지 않습니다**(`.gitignore`). 공유하기 전에 각 논문의 라이선스를 확인하세요.
- `paper-reader.config.json`(API 키), `data/`(지표 CSV·Zotero 허용 키), `.venv/`도 커밋되지 않습니다.
- 저장소에 포함된 예제는 CC BY 논문만 사용하며, 출처를 표시합니다.

## 개발

```bash
npm test          # Node 테스트 (node --test)
npm run test:py   # Python 추출기 테스트 (pytest)
```

## 한계

- **Obsidian 내보내기**는 다음 단계에서 지원합니다.
- 하이라이트는 문장 단위입니다(단어 일부만 칠할 수 없음). 한 번에 한 페이지 안에서만 만들 수 있습니다.
- 메모를 Zotero로 보내려면 Zotero 10 이상이 필요하고, 실시간 반영은 Zotero가 실행 중일 때만 됩니다.
- PDF 추출은 블록·단·페이지 경계를 넘는 문장을 나눠 저장합니다. 그림·표는 캡션 기준으로 영역을 찾아 이미지로 보여 주며, 그림 요소를 찾지 못한 캡션은 글자로 남고 그 그림 안 텍스트는 본문 문장으로 섞일 수 있습니다. 스캔본(PDF 이미지)은 지원하지 않습니다.
- 검색 지표(SJR·MJL)는 사용자가 받은 파일에 의존하며, 확인하지 못한 값은 "미확인"으로 둡니다.

## 라이선스

[MIT](LICENSE)
