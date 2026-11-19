# 예제: MeCoLog

이 폴더는 Paper Reader의 공개 예제입니다. `source.json`은 원문 PDF에서 `extract/extract_pdf.py`로 추출한 문장 데이터이고, `digest.json`은 AI 도구가 `prompts/digest.md` 규칙에 따라 작성한 한국어 요약입니다. PDF 파일은 포함하지 않습니다.

## 원문 정보

- **제목**: MeCoLog: Meta-contrastive learning for cross-system few-shot log-based anomaly detection
- **저자**: Manh Tuan Nguyen, Tuan Phong Tran, Le Dinh Trang Dang, Van Loi Cao
- **저널**: PLOS One 21(8): e0356907 (2026-08-27 게재)
- **유형**: 동료심사 저널 원저(Research Article, Crossref `journal-article`)
- **DOI**: [10.1371/journal.pone.0356907](https://doi.org/10.1371/journal.pone.0356907)

## 라이선스와 출처 표시

- 원문은 **크리에이티브 커먼즈 저작자표시 4.0 국제 라이선스(CC BY 4.0)** 로 배포됩니다: <https://creativecommons.org/licenses/by/4.0/>
- 출처: Nguyen MT, Tran TP, Dang LDT, Cao VL (2026) MeCoLog: Meta-contrastive learning for cross-system few-shot log-based anomaly detection. *PLOS One* 21(8): e0356907. https://doi.org/10.1371/journal.pone.0356907 — © 2026 Nguyen et al.
- 변경 사항: `source.json`은 원문 텍스트를 문장 단위로 나누고 위치 정보를 붙인 것입니다(추출 과정에서 일부 문장이 블록·페이지 경계에서 잘릴 수 있음). `digest.json`은 원문을 바탕으로 한 한국어 요약·해석이며, 저자들의 견해가 아닌 부분은 "💬 해석"(`opinion`)으로 구분되어 있습니다.
- 이 예제는 저자나 출판사의 보증을 받은 것이 아닙니다.
