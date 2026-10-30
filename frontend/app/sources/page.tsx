// 출처 탭 — 이 앱이 쓴 자료를 전부 적는다. 데이터·프로파일·모델·라이브러리·근거 문헌, 그리고 직접 만든 것까지.
// 링크가 없는 항목은 유료 규격이거나 원문이 사라진 것이며, 그 사실을 그대로 적는다.

import Toc from "../toc";

type Item = { name: string; use: string; url?: string; note?: string };
type Group = { id: string; title: string; lead: string; items: Item[] };

const GROUPS: Group[] = [
  {
    id: "knowledge",
    title: "1. 인쇄 지식과 불량 원인 — 가이드 문서의 근거",
    lead: "앱이 검색해서 보여 주는 인쇄 가이드(public/kb/print_guide.md)는 제가 정리해 쓴 글이고 불량 원인처럼 사실 확인이 필요한 대목에는 아래 자료를 원문으로 확인해 각 절에 출처를 적어 두었습니다. 위험도 점수표의 '방향'도 여기서 가져왔습니다.",
    items: [
      { name: "Sappi, Printer Tech Tips — Sheetfed Ink Setoff", use: "뒷묻음(세팅오프)의 원인: 건조 지연, 잉크막 두께, 쌓은 높이, 분말 부족, 높은 습도", url: "https://www.sappi.com" },
      { name: "Bernd Schwegmann, WIRBELWIND 분말 기술자료", use: "코팅지·비코팅지의 건조 시간 차이와 종이 평량에 맞춘 분말 입자 크기", url: "https://www.schwegmannnet.de/PDF/merkblaetter/druck/EN/WIRBELWIND_EN_TDS.pdf" },
      { name: "임원석·김창근·이용규, 「백판지의 제함적성에 관한 연구(제2보)」, 한국펄프종이공학회지 40(4), 2008", use: "코팅 판지를 괘선(오시)으로 눌러 접을 때 생기는 흰 줄 갈라짐과 괘선 압력", url: "https://www.koreascience.or.kr/article/JAKO200804748553344.pdf" },
      { name: "이학래, 「Print Mottle: Causes and Solutions from Paper Coating Industry Perspective」, 한국펄프종이공학회지 40(5), 2008", use: "얼룩(mottle)이 주로 코팅지에서 나타나고 비코팅지에서는 드물다는 점", url: "https://koreascience.kr/article/JAKO200804748553284.pdf" },
      { name: "Lee 외, 「Back-trap Mottle: A Review of Mechanisms and Possible Solutions」, BioResources 16(3), 2021, 6426–6447", use: "백트랩 얼룩이 종이 표면의 잉크 흡수성 불균일에서 생긴다는 설명", url: "https://bioresources.cnr.ncsu.edu/wp-content/uploads/2021/06/BioRes_16_3_6426_Review_Lee_YHC_Backtrap_Mottle_Mechanisms_18684.pdf" },
      { name: "하영백·오성상·이의수·유건룡·구철회·윤종태, 「도공지 물성 변화와 인쇄조건이 인쇄 모틀에 미치는 영향(Ⅰ)」, 한국인쇄학회지 25(2), 2007, 85–93", use: "코팅지(도공지) 오프셋 인쇄에서 얼룩이 잉크의 불균일한 침투와 바인더 이동에서 생긴다는 국내 연구", url: "https://www.earticle.net/Article/A137381" },
      { name: "구철회·하영백, 「도공액 조성변화와 잉크 물성변화가 인쇄품질에 미치는 영향」, 펄프·종이기술 46(5), 2014, 1–8", use: "도공액 조성과 잉크 점도·유화 정도가 얼룩을 좌우한다는 측정(저점도·강유화 잉크일수록 얼룩이 쉽게 생긴다)", url: "https://scienceon.kisti.re.kr/srch/selectPORSrchArticle.do?cn=JAKO201433752159485&dbt=NART" },
      { name: "하영백·오성상·강형곤, 「국내 교과서용 용지의 사용 현황과 인쇄용지 품질에 관한 연구 Ⅱ」, 한국인쇄학회지 36(1), 2021, 17–28", use: "종이 백색도와 인쇄 농도·건조 후 농도 저하(dry down)·뒤비침의 관계", url: "https://www.earticle.net/Article/A416539" },
      { name: "Pacher 외, 「Evaluation of misregister on multiple coated fine papers in sheet fed offset printing」, JPMTR 4(1), 2015", use: "색판 어긋남이 축임물 양·블랭킷 평활도·섬유 배향·충전재에 따라 달라진다는 측정", url: "https://jpmtr.org/index.php/journal/article/view/131" },
      { name: "Valente 외, 「Print Defect Mapping with Semantic Segmentation」, WACV 2020", use: "줄무늬(banding)가 인쇄 장치 쪽 원인(잉크젯 노즐 손상, 레이저 감광 드럼 속도)이라는 근거 — 그래서 PDF만으로는 예측하지 않습니다", url: "https://openaccess.thecvf.com/content_WACV_2020/papers/Valente_Print_Defect_Mapping_with_Semantic_Segmentation_WACV_2020_paper.pdf" },
      { name: "미국 특허 US6253678", use: "인쇄 중 종이가 결의 직각 방향으로 늘어나 어긋남이 생긴다는 설명(롤지 윤전 기준)", url: "https://patents.google.com/patent/US6253678" },
      { name: "미국 특허 US4962705", use: "오프셋 인쇄기의 기어 유격이 기어 줄무늬를 만든다는 설명", url: "https://patents.google.com/patent/US4962705" },
      { name: "Wikipedia, Trap (printing)", use: "색판 어긋남의 일반적인 원인과 검정 오버프린트로 피하는 방법", url: "https://en.wikipedia.org/wiki/Trap_(printing)" },
    ],
  },
  {
    id: "color",
    title: "2. 색 — 프로파일과 계산 규격",
    lead: "인쇄 색 차이(ΔE)는 공개된 ICC 프로파일로 직접 변환해 계산합니다. 프로파일은 재배포가 금지되어 저장소에 넣지 않고 아래 배포처에서 직접 받아 frontend/public/icc/에 둡니다.",
    items: [
      { name: "ECI (European Color Initiative) 오프셋 프로파일", use: "PSOcoated_v3, PSOuncoated_v3_FOGRA52, ISOcoated_v2_eci, ISOuncoatedyellowish, PSO_LWC_Improved/Standard, PSO_MFC_Paper, PSO_SNP_Paper, PSO_INP_Paper — 코팅·비코팅·신문·초미색 등 종이 등급별 변환", url: "https://www.eci.org" },
      { name: "ICC 프로파일 레지스트리", use: "PSOsc-b_paper_v3_FOGRA54, APTEC_PC10_CardBoard_2023_v1(판지), JapanColor2011Coated", url: "https://www.color.org/registry/index.xalter" },
      { name: "Sharma, Wu, Dalal, 「The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test Data, and Mathematical Observations」, Color Research & Application 30(1), 2005", use: "CIEDE2000 색 차이 공식의 구현(lib/color.ts의 ΔE00 계산)", url: "https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/" },
      { name: "ICC.1 규격 (International Color Consortium)", use: "프로파일 구조와 렌더링 의도(지각적·상대 비색·채도)의 정의", url: "https://www.color.org" },
      { name: "김주정·오성상·조가람·이재수, 「옥내외 광고용 디지털 인쇄의 색 관리 방안에 관한 연구」, 한국인쇄학회지 31(1), 2013, 15–37", use: "장치 선형화 → G7 보정 → ICC 프로파일 적용 순서의 색 관리 절차", url: "https://scienceon.kisti.re.kr/srch/selectPORSrchArticle.do?cn=JAKO201334460141769&dbt=NART" },
      { name: "차재영·조가람·구철회, 「인쇄 공정의 최적화를 위한 하드카피 프루프 프로파일링」, 한국인쇄학회지 28(1), 2010, 25–42", use: "장치마다 다른 색 재현 특성을 ICC 프로파일에 담아 변환한다는 설명", url: "https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART001474484" },
      { name: "차재영·조가람·구철회, 「소프트 프루핑에서 최적의 Profiling을 이용한 컬러 관리에 관한 연구」, 한국인쇄학회지 27(1), 2009, 1–14", use: "입력 장치와 출력 장치의 색역이 달라 화면과 인쇄물의 색이 어긋난다는 점(소프트 프루핑의 전제)", url: "https://www.koreascience.or.kr/article/JAKO200926239076118.page?lang=ko" },
      { name: "이원규·조가람·구철회, 「국내 오프셋 인쇄물 평가를 위한 최적의 Proofing 조건에 관한 연구」, 한국인쇄학회지 29(1), 2011, 1–21", use: "교정쇄로 최종 인쇄 색을 예측할 때 ΔE를 최소화하는 기준과 ISO 12647-7", url: "https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART001556385" },
      { name: "조가람·강형곤, 「패키지용 도포지의 인쇄 시 그레이 밸런스 적용에 따른 컬러 재현성에 관한 연구」, 한국인쇄학회지 34(1), 2019, 37–54", use: "같은 코팅지라도 물성이 다르면 색 재현이 달라진다는 측정(판지·패키지 용지 기준)", url: "https://www.earticle.net/Article/A376208" },
      { name: "Little CMS (lcms-wasm)", use: "브라우저에서 ICC 변환을 실제로 수행하는 엔진", url: "https://www.littlecms.com" },
      { name: "Kodak Lossless True Color Image Suite (kodim03·07·08·13·15·20·22·23)", use: "종이별 색 차이와 색 엔진 대조에 쓴 공개 테스트 사진 8장", url: "https://r0k.us/graphics/kodak/" },
    ],
  },
  {
    id: "paper",
    title: "3. 종이 데이터 (489종)",
    lead: "종이 종류와 브랜드 목록, 평량·용도 설명의 출처입니다. 두성종이·삼원페이퍼는 유통사 카탈로그라 제조사가 적혀 있지 않고, 국내 제지사 종이는 제조사 공식 제품 페이지에서 확인했습니다. 공식 페이지에서 찾지 못한 2종(아이리스·몽블랑)은 뺐습니다. 브랜드 종이의 색을 직접 측정한 자료는 공개된 것이 없어 같은 등급의 공개 프로파일로 근사하고 화면에 ‘근사’라고 표시합니다.",
    items: [
      { name: "한국제지연합회 「종이의 분류」", use: "종이 대분류와 등급 체계", url: "http://paper.or.kr/sub_3/3_3.php" },
      { name: "독립출판 종이 가이드 (brunch.co.kr/@chochoya/118)", use: "아트지·스노우지·모조지·랑데뷰지의 쓰임과 평량 기준", url: "https://brunch.co.kr/@chochoya/118" },
      { name: "두성종이 제품 목록", use: "브랜드 종이 282종의 이름·제조사·표면", url: "https://www.doosungpaper.co.kr/goods/goods_list.php?cateCd=001", note: "2026-10-14 수집" },
      { name: "삼원페이퍼 제품 목록", use: "브랜드 종이 160종", url: "https://www.samwonpaper.com/product/packageBook/list", note: "2026-10-14 수집" },
      { name: "삼화페이퍼(삼화제지) 제품 페이지", use: "랑데뷰·밍크·색지·레자크·스타라이트 5종의 제조사와 설명", url: "https://samwhapaper.com/product/samwhapaper/premium/31", note: "2026-10-30 확인" },
      { name: "한솔제지 제품 페이지 (인쇄용지·INSPER)", use: "앙상블(앙상블E클래스)·매직쉐도우·매직매칭·오로 4종", url: "https://www.hansolpaper.co.kr/product/paper1", note: "2026-10-30 확인. INSPER 쪽은 제품명과 분류 설명만 있고 개별 상세 페이지가 없습니다" },
      { name: "전주페이퍼 출판용지 제품 페이지", use: "이라이트(E-Light)·그린라이트·만화용지·중질만화 4종과 하이벌크 설명", url: "https://www.jeonjupaper.com/publicationpaper", note: "2026-10-30 확인" },
      { name: "한국제지 주요제품 페이지", use: "아르떼(ARTE) 1종", url: "https://www.hankukpaper.com/ko/product/mainProduct02.do", note: "2026-10-30 확인" },
    ],
  },
  {
    id: "shops",
    title: "4. 인쇄소 지도",
    lead: "지도에 찍히는 인쇄소는 공공 인허가 데이터이고 좌표는 EPSG:5174를 WGS84로 바꾼 값입니다. 인허가 ‘영업/정상’은 신고 기준이라 실제 영업 여부와 다를 수 있습니다.",
    items: [
      { name: "행정안전부 LOCALDATA 「기타_인쇄사」 (공공데이터포털 15045057)", use: "전체 24,090건 중 영업/정상 18,014건을 표시(좌표 없는 건 제외)", url: "https://www.data.go.kr/data/15045057/fileData.do", note: "공공누리 제1유형(출처표시). 내려받은 곳은 LOCALDATA이고 여기 링크는 같은 자료의 공공데이터포털 쪽 페이지입니다" },
      { name: "파주출판도시 입주기업협의회 입주기업 게시판", use: "출판도시 입주 인쇄 업체 표시(인쇄 업종 21곳)", url: "https://www.bookcity.or.kr/bbs/board.php?bo_table=tenant", note: "2026-10-14 수집" },
      { name: "OpenStreetMap 타일", use: "지도 배경 (© OpenStreetMap contributors)", url: "https://www.openstreetmap.org/copyright" },
      { name: "Leaflet", use: "지도 표시 라이브러리", url: "https://leafletjs.com" },
      { name: "Google Maps URLs (api=1)", use: "업체를 누르면 열리는 길찾기·검색 링크", url: "https://developers.google.com/maps/documentation/urls/get-started" },
    ],
  },
  {
    id: "models",
    title: "5. 모델",
    lead: "이 앱은 모델을 직접 학습시키지 않았습니다. 공개된 모델을 그대로 쓰고 어느 것을 쓸지만 직접 재서 골랐습니다(평가 측정표 참고).",
    items: [
      { name: "intfloat/multilingual-e5-small", use: "가이드 검색 임베딩 — 앱이 실제로 쓰는 모델(Xenova의 int8 ONNX 변환본을 브라우저에서 실행)", url: "https://huggingface.co/intfloat/multilingual-e5-small" },
      { name: "Xenova/multilingual-e5-small (ONNX)", use: "위 모델의 브라우저용 변환본(약 118MB)", url: "https://huggingface.co/Xenova/multilingual-e5-small" },
      { name: "jhgan/ko-sroberta-multitask", use: "검색 모델 비교에만 사용", url: "https://huggingface.co/jhgan/ko-sroberta-multitask" },
      { name: "BAAI/bge-m3", use: "검색 모델 비교에만 사용", url: "https://huggingface.co/BAAI/bge-m3" },
      { name: "nlpai-lab/KURE-v1", use: "검색 모델 비교에만 사용", url: "https://huggingface.co/nlpai-lab/KURE-v1" },
      { name: "Kiwi (kiwipiepy)", use: "오탈자·띄어쓰기 제안의 형태소 분석", url: "https://github.com/bab2min/kiwipiepy" },
      { name: "Google Gemini API (gemini-3.5-flash-lite)", use: "선택 기능인 LLM 교정 제안 — 사용자가 키를 직접 넣을 때만 켜집니다(기본 꺼짐)", url: "https://aistudio.google.com/apikey" },
      { name: "Okapi BM25", use: "단어 검색 점수(2-gram 토큰). 임베딩 점수와 z-정규화해 0.5:0.5로 섞습니다", url: "https://en.wikipedia.org/wiki/Okapi_BM25" },
    ],
  },
  {
    id: "software",
    title: "6. 소프트웨어",
    lead: "앱과 에이전트를 만든 라이브러리입니다. 버전은 frontend/package.json과 agents/requirements.txt에 적혀 있습니다.",
    items: [
      { name: "Next.js 16 · React 19", use: "앱 화면", url: "https://nextjs.org" },
      { name: "PDF.js (pdfjs-dist)", use: "PDF 해석과 쪽 그리기", url: "https://mozilla.github.io/pdf.js/" },
      { name: "pdf-lib", use: "평가용 샘플 PDF 만들기", url: "https://pdf-lib.js.org" },
      { name: "onnxruntime-web", use: "브라우저에서 임베딩 모델 실행", url: "https://onnxruntime.ai" },
      { name: "@huggingface/transformers (Transformers.js)", use: "토크나이저와 모델 불러오기", url: "https://huggingface.co/docs/transformers.js" },
      { name: "Pretendard", use: "화면 글꼴", url: "https://github.com/orioncactus/pretendard" },
      { name: "FastAPI · Uvicorn · httpx · Pydantic", use: "로컬 에이전트 서버와 에이전트 간 호출 계약", url: "https://fastapi.tiangolo.com" },
      { name: "PyMuPDF", use: "교정 에이전트의 쪽별 글과 위치 추출", url: "https://pymupdf.readthedocs.io" },
      { name: "sentence-transformers · NumPy", use: "가이드 에이전트의 임베딩·점수 계산", url: "https://www.sbert.net" },
      { name: "Model Context Protocol (MCP)", use: "외부 LLM 도구가 이 앱의 조회·요청 기능을 쓰게 하는 서버", url: "https://modelcontextprotocol.io" },
      { name: "LangSmith", use: "선택 기능인 추적 내보내기 — 사용자가 키를 직접 넣을 때만 켜집니다", url: "https://smith.langchain.com" },
      { name: "SQLite", use: "공통 로그와 안전 관문 기록 저장", url: "https://www.sqlite.org" },
    ],
  },
  {
    id: "mine",
    title: "7. 개발자가 만든 것",
    lead: "밖에서 가져오지 않고 개발자가 쓰거나 만든 것들입니다. 출처가 개발자 자신이라 치우쳤을 수 있다는 점은 평가 측정표의 ‘주의’에 함께 적어 두었습니다.",
    items: [
      { name: "인쇄 가이드 문서 (public/kb/print_guide.md)", use: "검색이 보여 주는 원문. 위 1·2번 자료와 일반적인 인쇄 상식을 정리해 개발자가 썼습니다" },
      { name: "검색 평가 질문 92개 (eval/questions.json)", use: "청킹·모델·가중치 비교. 가이드를 쓴 개발자가 만든 질문이라 단어가 겹쳐 쉬운 편입니다" },
      { name: "교정 평가셋 (문서 60개·오류 360개)", use: "규칙·Kiwi·LLM 비교. 오류를 규칙으로 넣고 규칙으로 찾는 부분은 순환이라 실력이 아닙니다" },
      { name: "종이 흰색 보정식 (lib/substrate.ts)", use: "규격을 보고 옮긴 식이 아니라, 실제로 측정해 만든 공개 프로파일 12쌍(종이 흰색이 서로 다른 같은 등급 쌍)으로 보정 없음·비례·선형을 비교해 고른 식입니다. 12쌍 중 9쌍에서 선형이 가장 가까웠고 보정 없음보다 나빠진 쌍은 없었습니다. 비교표는 평가 측정표에 있고, 실물 인쇄를 측색해 검증한 것은 아닙니다" },
      { name: "인쇄 불량 점검 규칙 (lib/risk.ts)", use: "위험 점수를 매기지 않습니다. 1번 자료에서 확인한 불량 원인이 이 파일·이 종이에 해당하는지만 보고, 해당하면 근거와 함께 ‘확인 필요’로 적습니다. 실제 불량 사례로 맞춰 본 적이 없어 확률이나 등급은 내지 않습니다" },
      { name: "측정 산출물 (public/data/eval_summary.json, proofread_eval.json)", use: "평가 측정표 화면이 그대로 읽는 수치" },
    ],
  },
];

export default function SourcesPage() {
  return (
    <main className="common_wrap">
      <header className="page_head">
        <h1>출처</h1>
        <p className="lead">이 앱이 쓴 자료를 전부 적었습니다 — 가이드의 근거 문헌, 색 프로파일과 계산 규격, 종이·인쇄소 데이터, 모델, 라이브러리, 개발자가 만든 것까지. 원문을 확인하지 못한 것은 그렇게 적었습니다.<b> 이 앱은 모델을 직접 학습시키지 않았습니다.</b>공개 모델을 그대로 쓰고 무엇을 쓸지는 재서 골랐습니다(<a href="/help#eval">평가 측정표</a>).</p>
      </header>

      <Toc items={GROUPS.map((g) => ({ id: g.id, label: g.title.replace(/^\d+\.\s*/, "") }))} />

      {GROUPS.map((g) => (
        <section key={g.id} id={g.id} className="ev_sec panel">
          <h2>{g.title}</h2>
          <p className="lead">{g.lead}</p>
          <ul className="sources_list">
            {g.items.map((it) => (
              <li key={it.name}>
                <span className="src_name">
                  {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.name} ↗</a>
                    : <>{it.name}{g.id !== "mine" && <span className="src_nolink">링크 없음</span>}</>}
                </span>
                <span className="src_use">{it.use}{it.note && <em className="note"> — {it.note}</em>}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="disclaimer">링크는 자료를 받은 곳입니다. ICC 프로파일은 재배포가 금지되어 저장소에 넣지 않았고 공공 데이터는 공공누리 제1유형(출처표시) 조건으로 썼습니다. 빠진 출처를 발견하면 알려 주세요.</div>
    </main>
  );
}
