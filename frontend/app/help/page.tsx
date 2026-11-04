"use client";
import { MODEL_FILE_MB } from "@/lib/guide";

// 도움말·평가 탭 — 각 기능을 왜 그렇게 만들었는지, 무엇을 쟀는지, 그래서 무엇을 주의해야 하는지.
// 질문(Q)은 모두 접힌 채로 시작하고, 누른 것만 펼쳐진다. 아래쪽에 측정표 전체(평가)가 이어 붙는다.
// 교정 비교 수치는 하드코딩하지 않고 평가 결과 파일(public/data/proofread_eval.json)을 읽는다. 다시 재면 이 화면도 바뀐다.
import Image from "next/image";
import { useEffect, useState } from "react";
import EvalReport from "../eval-report";

type Method = {
  methods: string[]; recall: number; recall_ci: [number, number]; precision: number; precision_ci: [number, number];
  f1: number; suggestions: number; recall_by_kind: Record<string, number>;
};
type Eval = { n_docs: number; n_errors: number; llm: string; methods: Record<string, Method>;
  clean_fp: Record<string, { suggestions: number; per_1000_chars: number; examples: string[] }> };

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const KIND: [string, string][] = [["known_misuse", "사전에 있는 오용"], ["unseen_misuse", "사전에 없는 오용"], ["typo", "무작위 오타"],
  ["spacing", "띄어쓰기"], ["rate", "율/률"]];
const LOCAL = "규칙+Kiwi 오타";          // 앱 기본값(기기 안에서만)
const WITH_LLM = "규칙+Kiwi 오타+LLM";   // 키를 넣고 켤 때

/** 질문 하나. 처음에는 접혀 있고(질문만 보인다), 누르면 '왜 → 어떻게 → 결과 → 주의' 순서로 펼쳐진다 */
function QA({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="qa">
      <summary><span>{q}</span></summary>
      <div className="qa_body">{children}</div>
    </details>
  );
}
/* 뱃지와 글을 한 줄에 세운다. 글은 한 덩어리로 감싸야 한다 — 그러지 않으면 안쪽 <b>·<code>가
   저마다 flex 항목이 되어 줄바꿈 없이 옆으로 늘어선다. */
const Tagged = ({ tag, ok, children }: { tag: string; ok?: boolean; children: React.ReactNode }) => (
  <p className="qa_p"><b className={`qa_tag${ok ? " ok" : ""}`}>{tag}</b><span>{children}</span></p>
);
const Why = ({ children }: { children: React.ReactNode }) => <Tagged tag="왜">{children}</Tagged>;
const How = ({ children }: { children: React.ReactNode }) => <Tagged tag="어떻게">{children}</Tagged>;
const Result = ({ children }: { children: React.ReactNode }) => <Tagged tag="결과" ok>{children}</Tagged>;
const Care = ({ children }: { children: React.ReactNode }) => <div className="warn"><b>주의</b> {children}</div>;

/** 실제 화면 캡처. 글로만 설명하면 와닿지 않는 부분에만 붙인다 */
function Shot({ src, alt, caption, w, h }: { src: string; alt: string; caption: string; w: number; h: number }) {
  return (
    <figure className="qa_shot">
      <a href={src} target="_blank" rel="noreferrer">
        <Image src={src} alt={alt} width={w} height={h} sizes="(max-width: 900px) 100vw, 900px" style={{ width: "100%", height: "auto" }} />
      </a>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export default function WhyPage() {
  const [ev, setEv] = useState<Eval | null>(null);
  const [evErr, setEvErr] = useState("");

  useEffect(() => {
    fetch("/data/proofread_eval.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setEv).catch((e) => setEvErr(String(e)));
  }, []);

  const loc = ev?.methods[LOCAL], llm = ev?.methods[WITH_LLM], only = ev?.methods["LLM"];
  const model = ev?.llm.startsWith("실시") ? ev.llm.replace("실시: ", "").split(",")[0] : null;
  const rows = Object.entries(ev?.methods ?? {});
  const bestF1 = Math.max(...rows.map(([, m]) => m.f1), 0);

  return (
    <main className="common_wrap">
      <header className="page_head">
        <h1>도움말 · 평가 측정표</h1>
        <p className="lead">기능마다 왜 그 방법을 골랐는지, 무엇을 재서 그렇게 정했는지, 그래서 어떤 한계를 안고 읽어야 하는지 적었습니다. 질문을 누르면 답이 펼쳐집니다. 숫자는 모두 이 저장소의 평가 스크립트로 직접 잰 값입니다. 재지 않은 것은 ‘재지 않았다’고 적었습니다. 측정표 전체는<a href="#eval">이 페이지 아래쪽</a>에 이어집니다.</p>
      </header>

      <section className="panel qa_intro">
        <h2>세 줄 요약</h2>
        <ul>
          <li><b>검사는 전부 이 기기 안에서</b> 합니다. 파일을 서버로 올리지 않습니다(교정에 LLM을 직접 켤 때만 본문이 외부로 나갑니다).</li>
          <li><b>지어내지 않습니다.</b> 가이드는 검색해서 원문을 보여 줍니다. 색 차이는 ICC 프로파일로 계산합니다. 불량 점검은 자료에서 확인한 원인이 해당하는지만 봅니다.</li>
          <li><b>예측과 측정은 다릅니다.</b> ΔE는 프로파일 기준 계산값이고 실물 측색값이 아닙니다. 불량 점검은 확률이 아닙니다.</li>
        </ul>
      </section>

      <h2 className="qa_group">검사·검색</h2>

      <QA q="가이드 검색에 왜 LLM이 아니라 임베딩 모델을 썼나요?">
        <Why>인쇄 가이드는 틀리면 비용이 드는 정보입니다(도련 3mm, 잉크량 한도 같은 값). LLM이 문장을 새로 만들면 그럴듯하지만 틀린 값이 섞일 수 있어서,
          <b> 답을 만들지 않고 가이드 원문 절을 찾아 그대로 보여 주는 쪽</b>을 택했습니다. 대신 사용자가 가이드와 다른 단어로 물어도 찾아야 하니 단어 일치만으로는 부족했습니다.</Why>
        <How>자르기(청킹) 4종 × 임베딩 모델 4종을 질문 92개로 비교하고 임베딩(dense)과 단어 검색(2-gram BM25)을 각각 z-정규화해<b>0.5 : 0.5</b>로 섞었습니다.
          브라우저에서 돌리려고 multilingual-e5-small의 int8 ONNX(약 {MODEL_FILE_MB}MB)를 씁니다.</How>
        <Result>섞어 쓰기(하이브리드)가 MRR@10 0.98 수준으로 가장 좋았습니다. 2.3GB짜리 큰 모델(bge-m3·KURE-v1)과의 차이는 95% 구간이 겹쳐 구분되지 않았습니다. 그래서<b>브라우저에 올릴 수 있는 작은 모델</b>로 정했습니다.</Result>
        <Shot w={1568} h={705} src="/shots/guide-search.jpg" alt="인쇄 검수 화면 위쪽의 가이드 검색 결과"
          caption="인쇄 검수 화면 맨 위에서 바로 찾습니다. 답을 새로 쓰지 않고 가이드 원문 절을 그대로 보여 줍니다. 검색에 걸린 구간(연한 배경)과 질문 단어(진한 표시)는 원문 위에 표시합니다." />
        <Shot w={1568} h={705} src="/shots/eval-search.jpg" alt="자르기 × 임베딩 모델 비교표"
          caption="고른 근거: 자르기 4종 × 모델 4종의 1위 적중률 비교(이 페이지 아래 측정표). 2.3GB짜리 큰 모델과는 구간이 겹쳤습니다. 그래서 브라우저에 올릴 수 있는 작은 모델을 택했습니다." />
        <Care>평가 질문 92개는 가이드를 쓴 사람이 직접 만들었습니다. 질문과 정답 문장이 같은 단어를 쓰니 BM25에 유리합니다. 대부분 설정이 90% 안팎 천장에 붙습니다. 모델 사이 몇 %p 차이는 질문 한두 개로 뒤집힙니다. 외부 사람이 쓴 질문으로 다시 재야 합니다.</Care>
      </QA>

      <QA q="인쇄 색 차이(ΔE)는 어떻게 계산하나요? 실제 인쇄와 같나요?">
        <Why>화면의 RGB는 인쇄 CMYK보다 넓은 색을 표현합니다. 어떤 색이 인쇄에서 얼마나 달라질지 <b>찍기 전에</b> 보여 주려면 변환을 직접 계산해야 합니다.</Why>
        <How>PDF 안 이미지 픽셀을 sRGB로 봅니다. 그다음 종이에 맞는 CMYK ICC 프로파일로 변환(LittleCMS wasm)한 뒤 다시 Lab으로 읽어 원본과 ΔE2000을 잽니다. 이미지가 인쇄 면적에서 차지하는 비율로 가중해 문서 전체 값도 냅니다. 종이 등급별 공개 프로파일 12개(ECI·ICC 레지스트리)를 씁니다.</How>
        <Result>같은 계산을 Python(Pillow의 LittleCMS)에서 따로 돌려 대조했고 값이 일치했습니다. 공개 테스트 사진 8장으로는 종이별 차이를 쟀습니다 (코팅지 평균 ΔE 4.48, 비코팅지 9.71, 판지 2.79 — 종이 색을 포함한 절대 비색 기준).</Result>
        <Care>이 값은 <b>지정한 프로파일 기준의 계산값</b>입니다. 실제로 찍어서 측색한 값이 아닙니다. 인쇄기 상태·잉크·습도는 들어 있지 않습니다. 벡터 도형 색과 이미 CMYK인 이미지는 계산에서 빠집니다(전부 sRGB로 가정). ΔE 2 이하/5 초과 같은 기준선도 경험값입니다.</Care>
      </QA>

      <QA q="종이가 489종인데 프로파일은 12개뿐입니다. 브랜드 종이는 어떻게 하나요?">
        <Why>브랜드 종이를 직접 측정한 공개 프로파일이 없습니다. 없는 데이터를 있는 것처럼 쓰지 않으려고, 같은 등급의 공개 프로파일로 근사하고 <b>근사했다고 화면에 표시</b>합니다.</Why>
        <How>분광측색기로 잰 종이 흰색(Lab)을 입력하면, 프로파일이 가정한 종이 흰색에서 그 종이로 인쇄 색을 옮겨 ΔE를 다시 잽니다.
          보정식은 측정 프로파일 12쌍을 비교해 골랐습니다(선형 방식이 9쌍에서 가장 좋음).</How>
        <Result>검증 스크립트에서 종이 흰색은 입력한 측정값으로 정확히 옮겨졌습니다. 가장 진한 색은 ΔE 0.1 안에서 그대로 남았습니다.</Result>
        <Care>보정하는 것은 <b>흰색뿐</b>입니다. 잉크가 번지는 정도·잉크량 한도는 여전히 등급 프로파일 값입니다.
          측정값을 넣지 않으면 보정 없이 근사 경고만 그대로 띄웁니다. 광택 차이(아트지 대 스노우지)는 같은 프로파일을 쓰기 때문에 결과에 드러나지 않습니다.</Care>
      </QA>

      <QA q="인쇄 불량 점검은 AI 모델인가요?">
        <Why>아닙니다. 학습하려면 “이 PDF를 이 종이에 찍었더니 이런 불량이 났다”는 정답 데이터가 필요합니다. 그런데 공개 데이터셋을 찾지 못했습니다
          (검색에 걸린 것은 3D 프린팅·PCB·직물 결함이었고 인쇄 결함 논문은 데이터를 공개하지 않았습니다).</Why>
        <How>그래서 <b>근거 원문을 직접 확인한 점수표</b>로 만들었습니다. 뒷묻음과 눌림, 색판 어긋남, 농도 얼룩이 점수 대상입니다. 점수는 PDF에서 읽은 값(최대 잉크량, 이미지 면적)과 사용자가 고른 종이·평량·후가공으로 매기고 이유마다 출처를 붙입니다.</How>
        <Result>원문과 대조하면서 근거가 틀린 규칙을 뺐습니다(예: ‘제본+코팅지’ 가점 — 원문은 오히려 코팅이 갈라짐을 줄인다고 했습니다).
          줄무늬는 인쇄기 쪽 원인이라 <b>예측하지 않습니다</b>. 후가공은 PDF에 정보가 없어서 모를 때는 ‘판단 불가’로 둡니다.</Result>
        <Care>각 요인의 방향은 원문으로 확인했습니다. 다만 <b>어느 쪽이 얼마나 더 위험한지는 재 본 적이 없어</b> 점수도 등급도 매기지 않습니다 — 해당하면 ‘확인 필요’, 아니면 ‘해당 없음’뿐입니다.
          실제 불량 사례가 모이면 그때 세기를 재서 등급을 붙일 수 있습니다.</Care>
      </QA>

      <h2 className="qa_group">교정 — 왜 기본은 규칙이고 LLM은 선택인가</h2>

      <QA q="오탈자 교정에 어떤 방법을 쓰고, 왜 그렇게 정했나요?">
        <Why>맞춤법 교정은 <b>틀린 지적 하나가 신뢰를 깎습니다</b>. 그래서 많이 찾는 쪽(재현율)보다 지적이 맞는 쪽(정밀도)을 먼저 봤고 원고를 자동으로 고치지 않고 제안만 합니다.</Why>
        <Result><b>두 검사 방식이 같은 사전을 봅니다.</b> 오용·외래어 표기 사전은 <code>public/data/korean-misuse.json</code> 하나이고, 브라우저의 ‘바로 검사’와 교정 에이전트가 그 파일을 함께 읽습니다. 한쪽에만 낱말을 더하면 두 방식의 결과가 갈리기 때문입니다. 에이전트 검사에서는 여기에 Kiwi 오타 모델이, 키를 넣으면 LLM 교정이 더해집니다.</Result>
        <How>정답을 아는 평가셋을 만들어 비교했습니다 — 가이드 문단을 묶은 문서 {ev?.n_docs ?? "60"}개에 오류 {ev?.n_errors ?? "360"}개를 일부러 넣고
          (사전에 있는 오용/없는 오용/무작위 오타/띄어쓰기/율·률), 규칙·Kiwi 형태소 모델·LLM의 조합 {rows.length || 7}가지를 쟀습니다.
          지표는 오류 단위 재현율과 제안 단위 정밀도, 괄호는 문서 단위 부트스트랩 95% 구간입니다.</How>

        {evErr && <div className="warn">평가 결과 파일을 읽지 못했습니다({evErr}). <code>python eval/proofread/eval_proofread.py</code>로 다시 만들 수 있습니다.</div>}
        {ev && (
          <>
            <div className="scroll">
              <table className="qa_table">
                <thead><tr><th>방법</th><th className="n">재현율 (95% 구간)</th><th className="n">정밀도</th><th className="n">F1</th><th className="n">정상 글 오탐 /1,000자</th><th>본문 외부 전송</th></tr></thead>
                <tbody>
                  {rows.map(([name, m]) => (
                    <tr key={name} className={name === LOCAL ? "is-default" : ""}>
                      <td>{name}{name === LOCAL && <span className="ev_mark">✓ 기본값</span>}{m.f1 === bestF1 && <span className="chip best">최고 F1</span>}</td>
                      <td className="n">{pct(m.recall)} <span className="note">({pct(m.recall_ci[0])}~{pct(m.recall_ci[1])})</span></td>
                      <td className="n">{pct(m.precision)}</td>
                      <td className="n">{m.f1.toFixed(3)}</td>
                      <td className="n">{ev.clean_fp[name]?.per_1000_chars ?? "—"}</td>
                      <td>{m.methods.includes("llm") ? "예" : "아니오"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 순환이 없는 두 칸만 막대로 비교한다(한 계열·한 색·직접 라벨). 나머지 칸은 위 표에서 본다 */}
            {loc && llm && (
              <>
                <h3>규칙이 미리 알 수 없는 오류에서 보인 재현율</h3>
                <p className="note">띄어쓰기·율/률·사전에 있는 오용은 같은 규칙으로 넣고 같은 규칙으로 찾습니다(순환). 그래서 비교에서 뺐습니다.</p>
                <ul className="qa_bars">
                  {(["typo", "unseen_misuse"] as const).map((k) => (
                    <li key={k}>
                      <span className="b_label">{KIND.find(([id]) => id === k)![1]}</span>
                      <span className="b_rows">
                        {[[LOCAL, loc], [WITH_LLM, llm]].map(([n, m]) => (
                          <span key={n as string} className="b_row">
                            <span className="b_name">{n as string}</span>
                            <span className="b_track"><span className="b_fill" style={{ width: `${(m as Method).recall_by_kind[k] * 100}%` }} /></span>
                            <span className="b_val">{pct((m as Method).recall_by_kind[k])}</span>
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <Result>
              기본 조합(규칙+Kiwi 오타)은 재현율 {loc && pct(loc.recall)}·정밀도 {loc && pct(loc.precision)}입니다.
              여기에 LLM{model && <> (<code>{model}</code>)</>}을 더하면 재현율 {llm && pct(llm.recall)}·정밀도 {llm && pct(llm.precision)}로 가장 좋았고,
              LLM만 써도 {only && pct(only.recall)}·{only && pct(only.precision)}였습니다.
              Kiwi 띄어쓰기 모델은 재현율은 올리지만 인쇄 용어를 띄우라고 해서(‘안쪽으로 → 안 쪽으로’) 정상 글에서도 1,000자당 {ev.clean_fp["Kiwi 띄어쓰기"]?.per_1000_chars}건을 잘못 지적해 기본에서 뺐습니다.
            </Result>
            <p><b className="qa_tag">그런데 기본은 로컬</b>성능이 아니라 조건 때문입니다. LLM을 켜면 ① PDF에서 꺼낸 <b>본문이 외부 API로 나가고</b>
              (이 앱의 나머지 계산은 모두 기기 안에서 합니다) ② API 키가 필요하고 ③ 무료 등급 분당 한도 때문에 문서 {ev.n_docs}개 평가에 몇 분이 걸립니다.
              그래서 켜는 것은 사용자가 환경변수(<code>PG_PROOF_METHODS</code>)로 직접 고르게 했습니다.</p>
            <Care>
              평가셋은 합성 문서입니다. 규칙 기반 방법의 띄어쓰기·율/률·사전에 있는 오용 100%는 <b>순환이라 실력이 아닙니다</b>. LLM은 그 틀을 모르고 쟀습니다. 다만 문장 틀이 반복돼 실제 원고보다 쉬울 수 있고 모델을 바꾸면 숫자도 바뀝니다. 실제 원고·실제 오탈자로 다시 재야 합니다. LLM 제안 중<b>글에 실제로 없는 원문</b>을 가리키는 것은 버립니다(지어낸 지적 방지).
            </Care>
          </>
        )}
      </QA>

      <QA q="LLM 모델은 왜 하필 그걸 쓰나요?">
        <Why>교정은 문서마다 한 번 부르는 작업이라 <b>무료 등급으로 끝까지 돌 수 있는지</b>가 중요했습니다. 품질이 가장 높은 모델이 목표가 아니었습니다.</Why>
        <How>무료 등급이 있는 Flash-Lite 계열을 기본값으로 두고 모델 이름은<code>PG_LLM_MODEL</code>로 바꿀 수 있게 했습니다.</How>
        <Result>처음 적어 둔 <code>gemini-2.5-flash-lite</code>는 신규 키에서 404(“no longer available to new users”)였고, 실제 호출로 확인해
          {model ? <> 지금 쓰는 <code>{model}</code></> : <> 현재 세대 Flash-Lite</>}로 바꿨습니다. 분당 한도(429)에 걸리면 기다렸다 다시 부릅니다.</Result>
        <Care>모델이 바뀌면 교정 품질과 위 표의 숫자가 함께 바뀝니다. 비교를 다시 하려면 평가를 같은 모델로 다시 돌려야 합니다.</Care>
      </QA>

      <h2 className="qa_group">에이전트 모드</h2>

      <QA q="왜 검사를 에이전트 여러 개로 쪼갰나요?">
        <Why>한 덩어리로 다 하면 ‘무엇을 근거로 그렇게 판단했는지’가 섞입니다. 부서를 나누면 각자 할 수 있는 일(skill)과 등급이 공개됩니다. 주고받은 요청·결과도 기록에 남습니다.</Why>
        <How>총괄(오케스트레이터) 아래 사전 검사·색·종이·가이드·교정·보고서·원본 수정·안전 관문 9개가 각자 포트에서 돕니다. 주고받는 것은 정해진 계약(A2A)뿐입니다. 에이전트는 서로를 부를 때 자기 이름이 든 경로를 붙여<b>순환 호출과 홉 수</b>를 막고, 모든 요청·결과는 공통 로그에 남습니다(입력 본문은 남기지 않습니다).</How>
        <Result>같은 검사를 ‘바로 검사’와 ‘에이전트 검사’ 두 방식으로 할 수 있습니다. 화면은 같습니다. 인쇄 검수에서 ‘에이전트 검사’를 고르면 바로 아래에서 의뢰별 구간 막대(워터폴)를 볼 수 있습니다. 누가 언제 몇 ms 걸렸는지 나옵니다.</Result>
        <Shot w={1568} h={705} src="/shots/agents-tab.jpg" alt="왼쪽 에이전트 목록과 오른쪽 의뢰 추적 구간 막대"
          caption="에이전트 검사 모드에서 펼쳐지는 화면. 왼쪽 목록은 이 검수에 참여하는 에이전트와 다른 화면에서 쓰는 에이전트로 갈라져 있고, 누르면 그 에이전트가 할 수 있는 일(skill)과 등급, 부를 수 있는 쪽이 펼쳐집니다. 오른쪽 구간 막대와 소통 기록은 어떤 에이전트가 언제 몇 초 걸렸는지 공통 로그로 그립니다." />
        <Result><b>켜져 있는 에이전트가 모두 이 검수에 참여하는 것은 아닙니다.</b> 원본 수정(<code>designcraft</code>)은 원본 수정 탭이 씁니다.
          같은 A2A 계약으로 돌지만 PDF 검수 흐름에서는 한 번도 불리지 않아서, 목록을 <b>‘이 검수에 참여’와
          ‘이 검수에 참여하지 않는 에이전트’로 갈라</b> 두었습니다. 섞어 두면 ‘켜짐’만 보고 이 검사가 쓰는 줄로 읽힙니다.</Result>
        <Care>에이전트 모드는 로컬에서 직접 켜야 합니다(<code>python run_agents.py</code>). 의뢰 목록은 메모리에만 있어 재시작하면 사라집니다
          (안전 관문 기록과 공통 로그는 파일에 남습니다).</Care>
      </QA>

      <QA q="검수에서 찾은 오탈자를 원본 파일에 자동으로 반영할 수 있나요?">
        <Why>검수는 PDF로 하는데 <b>PDF는 고칠 수 없습니다.</b> 인디자인이 만든 PDF에서 글자를 집어 바꾸는 길이 없어서,
          결국 사람이 원본을 열고 하나씩 다시 찾아 고쳐야 했습니다. 항목이 수십 개면 그 과정에서 빠뜨립니다.</Why>
        <How>검수 결과를 ‘쪽 | 원래 내용 | 수정할 내용’ 줄로 복사해 <b>원본 수정</b> 화면에 붙여 넣고 편집 파일(IDML)을 올리면,
          DesignCraft를 MCP로 불러 그 글자를 찾아 바꾸고 PDF로 다시 내보냅니다. 교정 한 건마다 <b>다시 찾습니다</b> —
          한글은 글자당 3바이트라 앞을 고치면 뒤 위치가 전부 밀리는데, 다시 찾으면 밀린 자리가 따라옵니다.</How>
        <Result>바뀐 쪽의 <b>수정 전·후를 나란히</b> 보여 주고, 어떤 항목이 반영됐고 무엇이 왜 실패했는지 줄마다 적습니다.
          고친 뒤 원본 검사를 한 번 더 돌립니다 — 한글을 라틴 글꼴 자리에 넣으면 글자가 없고(글리프), 글이 길어지면 넘치기 때문입니다.</Result>
        <Care><b>같은 문구가 여러 군데면 일부러 고치지 않습니다.</b> 어느 것인지 가릴 수 없는데 찍어서 고치면 조용히 틀립니다 — 쪽 번호를 적어 주면 그 쪽에서만 찾습니다.
          <b>INDD는 받지 않습니다</b> — 엔진이 읽을 수는 있지만 고친 결과를 INDD로 돌려드릴 수 없어서입니다. 반쪽만 되는 것을 되는 것처럼 두면 올려 보고 나서야 알게 됩니다. InDesign에서 파일 → 다른 이름으로 저장 → InDesign Markup(IDML)으로 내보내 올려 주세요. 원본이 쓰는 글꼴이 그 PC에 없으면 대체 글꼴로 열려
          줄바꿈과 넘침이 달라집니다 — 화면에 경고로 띄웁니다. 표 안의 글자는 아직 건드리지 않습니다.
          쓰려면 에이전트를 돌리는 PC에 <code>designcraft-cli</code>가 있어야 합니다 — 원본 수정 화면 맨 위에 설치 명령이 복사 버튼과 함께 있습니다.</Care>
        <Result><b>파일 하나보다 폴더째 올리는 편이 좋습니다.</b> IDML은 사진을 링크로만 들고 있어서, 파일 하나만 올리면
          인쇄용 사진이 따라오지 않습니다(화면에 보이는 그림은 IDML이 품은 저해상 미리보기라 인쇄에는 못 씁니다).
          InDesign에서 <b>파일 → 패키지</b>로 만든 폴더를 통째로 올리면 옆의 <code>Links</code> 사진과
          <code>Document fonts</code> 글꼴까지 같이 올라가 그대로 열립니다. 글자 교정만 하고 고친 IDML만 받을 거면 파일 하나로도 됩니다.</Result>
        <Shot w={1568} h={705} src="/shots/fix-compare.jpg" alt="교정을 반영한 뒤의 전후 비교 화면"
          caption="붙여 넣은 교정을 편집 파일에 반영한 뒤. 반영·실패 건수와 내려받기 단추가 위에 있고, 아래로 바뀐 쪽마다 수정 전·후를 나란히 보여 줍니다(1쪽의 ‘깨끗히’가 ‘깨끗이’로 바뀐 자리)." />
      </QA>

      <QA q="파일을 쓰는 것처럼 되돌리기 어려운 행동은 어떻게 막나요?">
        <Why>상태를 바꾸는 행동은 모델이 잘못 판단하면 되돌리기 어렵습니다. 그래서 <b>판단하는 쪽과 실행을 허가하는 쪽을 분리</b>했습니다.</Why>
        <How>행동마다 등급을 둡니다 — <b>조회</b>는 관문 없음, <b>A</b>는 바로 실행, <b>B</b>는 다른 에이전트가 교차 검증해야 실행, <b>C</b>는 사람이 승인해야 실행.
          안전 관문은 등급을 요청이 아니라 <b>행동 주인의 공개 카드에서 읽습니다</b>. 요청에 ‘등급 A’라고 적어 보내도 무시합니다. 하루 누적 한도가 있습니다. 무엇이든 확인되지 않으면 거절합니다(fail-closed).</How>
        <Result>지금 이 앱에서 상태를 바꾸는 행동은 <b>검수 보고서 파일 쓰기(A)</b>와 <b>원본 수정 반영(A)</b> 둘입니다. 그 보고서의 ΔE도 색 에이전트가 다시 계산해 일치할 때만 그대로 적힙니다.
          B·C 동작(교차 검증, 사람 승인, 승인 기한 만료, 하루 한도)은 코드와 테스트로 남아 있습니다 — 돈이 오가는 행동을 이 앱에 두지 않았기 때문입니다.</Result>
        <Care>사람 승인 토큰은 흉내 모드(목) 값(<code>human:&lt;이름&gt;</code>)이며 실제 로그인이 아닙니다. 쓸 일이 생기면 진짜 로그인으로 바꿔야 합니다.</Care>
      </QA>

      <h2 className="qa_group">내 파일은 어디로 가나</h2>

      <QA q="올린 파일이 서버로 가나요? 외부로 나가는 것이 있나요?">
        <Result><b>바로 검사 — 아무 데도 가지 않습니다.</b> PDF 해석·색 변환·검색 모델이 모두 <b>보시는 분의 브라우저 안</b>에서 돕니다. 종이·인쇄소 데이터도 이 앱이 들고 있는 파일이라 받아 갈 것이 없습니다.</Result>
        <Result><b>에이전트 검사 — 만든 사람의 PC로 갑니다.</b> 에이전트는 서버를 빌리지 않고 <b>개발자 PC에서</b> 돕니다(<code>127.0.0.1</code>에서만 듣고, 바깥에는 Cloudflare 터널로 창구 하나만 엽니다).
          올린 파일은 <b>그 PC의 폴더</b>에 저장되고, 에이전트끼리는 파일 내용 대신 해시(<code>pdf_ref</code>)만 주고받습니다. 서버가 다시 뜨면 의뢰 목록은 지워집니다.</Result>
        <Result><b>원본 수정에 올린 편집 파일도 같은 PC입니다.</b> 폴더째 올려도 그 PC의 작업 폴더에만 풀립니다. DesignCraft는 <b>그 폴더 밖을 읽지도 쓰지도 못하게</b> 가둬 놓고 띄웁니다(<code>--automation-read-root</code>·<code>--write-root</code>). 고친 PDF와 편집 파일도 같은 폴더에 생기고, 받아 가는 것은 그 브라우저의 열쇠를 가진 사람뿐입니다.</Result>
        <Result>선택 기능 두 개만 밖으로 나갑니다 — <b>LLM 교정</b>을 켜면 교정할 본문이 Gemini API로 가고(기본 꺼짐),
          <b>LangSmith 추적</b>을 켜면 에이전트·소요 시간·관문 결정만 갑니다(본문·입력값은 공통 로그에 애초에 남기지 않아 나갈 것이 없습니다).</Result>
        <Shot w={1273} h={869} src="/shots/langsmith-trace.png" alt="LangSmith에 올라간 의뢰 추적 화면"
          caption="LangSmith로 내보냈을 때 올라가는 것 전부 — 에이전트·skill 이름과 걸린 시간, 관문 결정 수, 로그 줄 수뿐입니다. 입력에는 의뢰 번호(context_id)만 있고 파일 본문이나 검사 입력값은 없습니다. 이 캡처는 앞선 판에서 찍은 것이라 지금은 없는 인쇄소(shop) 에이전트가 보입니다 — 나가는 항목의 종류는 그대로입니다." />
      </QA>

      {/* 측정표 전체(옛 '평가' 탭)를 같은 화면에 이어 붙인다 */}
      <EvalReport />

    </main>
  );
}
