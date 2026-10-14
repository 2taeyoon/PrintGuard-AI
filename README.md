# PrintGuard AI

인쇄 전 PDF 품질 검수 웹앱. 서버 없이 브라우저 안에서만 동작합니다.

- **PDF 검수**: 판형·도련·폰트 포함·이미지 해상도·색 공간·안전 여백·문구(반복 단어, 율/률, 같은 항목 다른 숫자)를 검사하고 페이지 위에 문제 위치를 표시합니다.
- **인쇄 색 차이 예측**: PDF 안 RGB 이미지를 종이별 CMYK ICC 프로파일로 변환해 ΔE2000과 총 잉크량을 계산하고 색 차이 지도를 그립니다(lcms-wasm).
- **종이 491종**: 한국제지연합회 분류 기반 기본 종류 35종 + 두성종이·삼원페이퍼·국내 제지사 브랜드 456종, 종이 등급별 공개 프로파일 13개.
- **인쇄 불량 위험도**: 뒷묻음·눌림·색판 어긋남·농도 얼룩·줄무늬를 원문으로 확인한 근거의 점수표 규칙으로 표시합니다(학습 모델 아님).
- **인쇄 가이드 검색(RAG)**: multilingual-e5-small(int8 ONNX) + 2-gram BM25 하이브리드.
- **인쇄소 지도**: 행정안전부 전국 인쇄사 인허가 데이터(영업/정상 17,082곳) + 파주출판도시 입주기업, 구글 지도 링크.

## 구조
```
frontend/   Next.js 16 앱 (app/, lib/, scripts/ 검증 스크립트, public/ 데이터)
eval/       평가·데이터 생성 (Python): 검색 모델 비교, 색 엔진 대조, 종이·인쇄소 데이터 수집
samples/    시험용 PDF
```

## 실행
```bash
cd frontend
npm install
# 아래 '저장소에 없는 파일'을 먼저 채운 뒤
npm run dev -- -H 127.0.0.1 -p 3000
```

## 저장소에 없는 파일
라이선스나 용량 때문에 올리지 않았습니다.

1. **임베딩 모델** → `frontend/public/models/Xenova/multilingual-e5-small/`
   Hugging Face `Xenova/multilingual-e5-small`에서 `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `sentencepiece.bpe.model`, `quant_config.json`, `onnx/model_quantized.onnx`를 받습니다.
2. **onnxruntime-web wasm** → `frontend/public/ort/`
   `npm install` 후 `node_modules/onnxruntime-web/dist/`의 `ort-wasm-simd-threaded*.{mjs,wasm}`를 복사합니다.
3. **ICC 프로파일** → `frontend/public/icc/` (재배포 금지라 직접 받아야 합니다)
   - ECI(eci.org 다운로드): `PSOcoated_v3.icc`, `PSOuncoated_v3_FOGRA52.icc`(ICC 레지스트리에도 있음), `eci_offset_2009.zip` 안의 `ISOcoated_v2_eci.icc`, `ISOuncoatedyellowish.icc`, `PSO_LWC_Improved_eci.icc`, `PSO_LWC_Standard_eci.icc`, `PSO_MFC_Paper_eci.icc`, `PSO_SNP_Paper_eci.icc`, `eci_offset_profiles_inp.zip` 안의 `PSO_INP_Paper_eci.icc`
   - ICC 프로파일 레지스트리(registry.color.org/profile-registry): `PSOsc-b_paper_v3_FOGRA54.icc`, `APTEC_PC10_CardBoard_2023_v1.icc`, `JapanColor2011Coated.icc`
   - Windows 내장: `C:\Windows\System32\spool\drivers\color\RSWOP.icm`

## 한계
- 색 차이는 프로파일 기준 계산값이며 실물 인쇄 측색값이 아닙니다. 브랜드 종이는 등급 프로파일로 근사합니다.
- 불량 위험도는 학습 모델이 아니라 점수표이며, 실제 불량 데이터로 보정하지 않았습니다.
- 인허가 '영업/정상'은 신고 기준이라 실제 영업 여부와 다를 수 있습니다.

## 데이터 출처
한국제지연합회 「종이의 분류」, 프린트올데이 「알아두면 쓸데있는 기본 종이 상식」, 두성종이·삼원페이퍼 제품 페이지, 행정안전부 LOCALDATA 기타_인쇄사(공공누리 출처표시), 파주출판도시 입주기업협의회, Kodak 공개 테스트 사진.
