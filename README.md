# Paper Reader

동료심사(peer-reviewed) 저널 논문을 찾고, Zotero에 있는 PDF를 **문장 단위로 주소가 붙은 텍스트**로 추출한 뒤, 어떤 AI 코딩 도구(Claude Code, Codex 등)로든 **근거 문장이 연결된 한국어 카드형 요약**을 만들어 로컬 읽기 앱에서 읽는 도구입니다.

긴 논문을 끝까지 붙잡고 있기 힘든 독자(예: ADHD)를 염두에 두고 만들었습니다.

- 🔎 **검색**: OpenAlex로 최근 논문을 찾아 세 갈래(🔥 인용 급상승 / 🌱 신흥 주제 / 🏛 저널 흐름)로 골라 줍니다. preprint·학회 논문·리뷰·editorial 등은 제외하고 저널 원저만 남깁니다.
- 📄 **추출**: Zotero의 PDF를 `p{페이지}-s{번호}` 문장 ID가 붙은 `source.json`으로 바꿉니다.
- 🤖 **요약**: AI 도구가 `prompts/digest.md` 규칙에 따라 `digest.json`을 씁니다. 원문 사실(`claim`)에는 반드시 근거 문장 ID가 붙고, 해석(`opinion`)은 "💬 해석"으로 구분됩니다.
- 📖 **읽기**: 카드 하나씩 읽고, 근거 문장을 바로 확인하고, Zotero PDF의 해당 페이지로 이동합니다. 3분/10분 모드, 집중 모드, 읽은 카드 진행률을 지원합니다.

> 이 도구는 AI API를 직접 호출하지 않습니다. 요약은 여러분이 쓰는 AI 코딩 도구가 작성하고, 이 저장소는 규칙·검증·읽기 화면을 제공합니다.

## 요구사항

| 항목 | 버전 | 용도 |
|---|---|---|
| Node.js | 22 이상 | 검색·검증·읽기 앱 |
| Python | 3.10 이상 | PDF 추출(PyMuPDF) |
| Zotero | 7 이상 | 논문 등록·PDF 보관 (메모 쓰기는 2단계 기능이며 Zotero 10 이상 필요) |
| AI 코딩 도구 | Claude Code, Codex 등 | 검색 결과 한 줄 요약, 논문 요약 작성 |

### Zotero 로컬 API 켜기

Zotero 7 이상에서 **설정(Settings) → 고급(Advanced) → "이 컴퓨터의 다른 애플리케이션이 Zotero와 통신하도록 허용"**(Allow other applications on this computer to communicate with Zotero)을 켜세요. 이 도구는 Zotero가 실행 중일 때 `http://127.0.0.1:23119`의 로컬 API로만 통신합니다.

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
| `search.monthsBack` / `perTrend` / `emergingWindowMonths` / `topJournals` | 24 / 5 / 6 / 5 | 검색 기간, 트렌드별 편수, 신흥 주제 기간(개월), 저널 수 |
| `metrics.sjrCsv` | `./data/scimagojr.csv` | SCImago(SJR) CSV 경로 |
| `metrics.mjlCsv` | `null` | Clarivate Master Journal List CSV 경로 |
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
npm run check -- <citekey|itemKey>            # digest.json 검증 (근거 ID·section·그림 페이지)
npm run reader                                # 읽기 앱: http://127.0.0.1:5173
```

### 예제로 먼저 둘러보기

설치 직후 `npm run reader`를 실행하면 목록에 **"예제"** 배지가 붙은 공개 논문 1편이 보입니다. CC BY 4.0 라이선스 논문으로 만든 `source.json`·`digest.json`이 [`examples/`](examples/)에 들어 있습니다(출처·라이선스는 각 예제 폴더의 README 참고). 예제의 읽기 진행률은 `outputDir`에 저장되며 저장소 파일은 바뀌지 않습니다.

## 저작권과 커밋되지 않는 것

- 여러분이 만든 산출물(`digests/` 등 `outputDir`의 `source.json`·`digest.json`·검색 결과)에는 논문 원문 텍스트가 들어 있으므로 **git에 커밋되지 않습니다**(`.gitignore`). 공유하기 전에 각 논문의 라이선스를 확인하세요.
- `paper-reader.config.json`(API 키), `data/`(지표 CSV), `.venv/`도 커밋되지 않습니다.
- 저장소에 포함된 예제는 CC BY 논문만 사용하며, 출처를 표시합니다.

## 개발

```bash
npm test          # Node 테스트 (node --test)
npm run test:py   # Python 추출기 테스트 (pytest)
```

## 1단계의 한계

- 요약 메모를 Zotero에 되돌려 쓰는 **메모 동기화**와 **Obsidian 내보내기**는 다음 단계에서 지원합니다.
- PDF 추출은 블록·단·페이지 경계를 넘는 문장을 나눠 저장하고, 그림 안 텍스트가 본문 문장으로 섞일 수 있습니다. 스캔본(PDF 이미지)은 지원하지 않습니다.
- 검색 지표(SJR·MJL)는 사용자가 받은 파일에 의존하며, 확인하지 못한 값은 "미확인"으로 둡니다.

## 라이선스

[MIT](LICENSE)
