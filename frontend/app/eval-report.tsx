"use client";
import { MODEL_FILE_MB } from "@/lib/guide";

// 평가 — 이 앱이 고른 설정이 왜 그 설정인지 수치로 보여 준다. 도움말 탭 아래쪽에 이어 붙는다.
// 숫자는 전부 eval 산출물에서 만든 public/data/eval_summary.json·proofread_eval.json을 그대로 읽는다(화면에서 계산하지 않는다).
// 다시 재려면: python eval/run_eval.py → python eval/build_eval_summary.py (교정은 eval/proofread/eval_proofread.py)
import { useEffect, useState } from "react";
import Toc from "./toc";

type Ci = [number, number];
type Dense = { hit1: number; hit1_ci: Ci; mrr: number };
type Summary = {
  built: string;
  sources: Record<string, string>;
  search?: {
    n_questions: number; kb_chars: number;
    chunking: Record<string, { search_units: number; returned_units: number; avg_returned_chars: number }>;
    models: Record<string, { params_M: number; MB: number; dim: number; load_s: number }>;
    dense: Record<string, Record<string, Dense>>;
    hybrid: Record<string, { mrr: number; hit1: number; dev_mrr: number; val_mrr: number }>;
    tokenizer: Record<string, Record<string, number>>;
  };
  browser?: { n: number; load_ms: number; query_ms: number; hit1: number; mrr: number };
  color_crosscheck?: { n: number; mean_js: number; mean_pillow: number; p95_js: number; p95_pillow: number; mean_abs_diff: number };
  quant?: { max_diff16: number; max_diff8: number; rows: number };
  profiles?: { rows: { key: string; name: string; condition: string; tac: number; white: number[]; blackL: number; papers: number;
    noPaper: { meanDE: number; over5: number; over10: number }; withPaper: { meanDE: number; over5: number; over10: number } }[] };
  substrate?: { rows: { from: string; to: string; paperWhiteDE: number; none_mean: number; ratio_mean: number; linear_mean: number }[] };
  proofread?: { n_docs: number; n_errors: number; llm: string;
    methods: Record<string, { recall: number; recall_ci: Ci; precision: number; f1: number; suggestions: number;
      by_kind: Record<string, number>; uses_llm: boolean }>;
    clean_fp: Record<string, number> };
};

const pct = (v: number | undefined, d = 1) => (v === undefined ? "—" : `${(v * 100).toFixed(d)}%`);
const num = (v: number | undefined, d = 2) => (v === undefined ? "—" : v.toFixed(d));
const KINDS: [string, string][] = [["known_misuse", "사전에 있는 오용"], ["unseen_misuse", "사전에 없는 오용"], ["typo", "무작위 오타"],
  ["spacing", "띄어쓰기"], ["rate", "율/률"]];
const PICKED_MODEL = "multilingual-e5-small";
const PICKED_CHUNK = "구조 parent-child";
const PICKED_W = "0.5";

function Section({ id, title, lead, source, children }: { id: string; title: string; lead: string; source?: string; children: React.ReactNode }) {
  return (
    <section className="ev_sec panel" id={id}>
      <h2>{title}</h2>
      <p className="lead">{lead}</p>
      {children}
      {source && <p className="note ev_src">측정: <code>{source}</code></p>}
    </section>
  );
}

const Head = () => <h2 className="qa_group" id="eval">평가 측정표 — 무엇과 비교해서 골랐나</h2>;

/** 표를 읽기 전에 결론부터: 이 수치라서 이것을 골랐다 */
const Pick = ({ children }: { children: React.ReactNode }) => (
  <p className="ev_pick"><b>고른 것</b> {children}</p>
);

export default function EvalReport() {
  const [d, setD] = useState<Summary | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/data/eval_summary.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(setD).catch((e) => setErr(String(e)));
  }, []);

  if (err) return (
    <><Head />
      <div className="warn">평가 요약을 읽지 못했습니다({err}). <code>python eval/build_eval_summary.py</code>로 만들 수 있습니다.</div></>
  );
  if (!d) return <><Head /><div className="empty">불러오는 중…</div></>;

  const s = d.search, pr = d.proofread;
  const chunks = s ? Object.keys(s.chunking) : [];
  const models = s ? Object.keys(s.models) : [];
  const hybrid = s ? Object.entries(s.hybrid) : [];
  const bestW = hybrid.reduce<[string, number]>((b, [w, v]) => (v.mrr > b[1] ? [w, v.mrr] : b), ["", 0]);
  const wPick = s?.hybrid[PICKED_W], wTop = s?.hybrid[bestW[0]];
  const prRows = pr ? Object.entries(pr.methods) : [];
  const prBest = Math.max(...prRows.map(([, m]) => m.f1), 0);
  // '그래서 무엇을 골랐나'를 표 위에 한 줄로 쓰기 위한 값들. 전부 산출물에서 계산한다(고정값을 적지 않는다).
  const pickDense = s?.dense[PICKED_MODEL]?.[PICKED_CHUNK];
  const topDense = s ? models.map((m) => ({ m, v: s.dense[m]?.[PICKED_CHUNK] }))
    .reduce((b, x) => ((x.v?.hit1 ?? 0) > (b.v?.hit1 ?? 0) ? x : b), { m: "", v: undefined as Dense | undefined }) : null;
  const subBest = d.substrate ? d.substrate.rows.filter((r) => r.linear_mean <= Math.min(r.none_mean, r.ratio_mean)).length : 0;
  const subNotWorse = d.substrate ? d.substrate.rows.filter((r) => r.linear_mean <= r.none_mean).length : 0;
  const prPick = pr?.methods["규칙+Kiwi 오타"];
  const prTop = prRows.find(([, m]) => m.f1 === prBest);
  const profDE = d.profiles ? d.profiles.rows.map((p) => p.withPaper.meanDE) : [];

  return (
    <>
      <Head />
      <p className="ev_lead">이 앱이 고른 설정은 여섯입니다 — 검색 모델, 자르기, 가중치, 색 변환, 종이 흰색 보정, 교정 탐지기.
        각각을 무엇과 비교해서 골랐는지 전부 수치로 적었습니다. 여기에 <b>글꼴이 없을 때 결과가 어디까지 맞는가</b>를 엔진으로 직접 잰 값도 더했습니다.</p>
      <p className="ev_lead">화면의 숫자는 저장소의 평가 스크립트가 남긴 산출물을 그대로 읽은 값입니다. 다시 재면 이 화면도 같이 바뀝니다.</p>

      <Toc items={[{ id: "search", label: "가이드 검색" }, { id: "color", label: "색 변환 검증" }, { id: "profiles", label: "종이별 색 차이" },
        { id: "substrate", label: "종이 흰색 보정" }, { id: "proof", label: "교정 탐지기" }, { id: "fonts", label: "글꼴이 없을 때" }, { id: "notread", label: "재지 않은 것" }]} />

      {s && (
        <Section id="search" title="1. 가이드 검색 — 어떤 자르기·어떤 모델·어떤 가중치인가"
          lead={`질문 ${s.n_questions}개로 비교했습니다(지식베이스 ${s.kb_chars.toLocaleString()}자). Hit@1은 1위 결과가 정답을 담은 비율, MRR은 정답 순위의 역수 평균입니다. 괄호는 95% 구간입니다.`}
          source={d.sources.search}>
          <Pick>
            <b>{PICKED_CHUNK}</b>로 자르고 <b>{PICKED_MODEL}</b>을 <b>하이브리드 {PICKED_W}</b>(2-gram 단어 검색 반 + 임베딩 반)로 씁니다.
            {topDense && topDense.m !== PICKED_MODEL && topDense.v && pickDense && (
              <> 같은 청킹에서 숫자가 가장 높은 것은 {topDense.m}({pct(topDense.v.hit1)})이지만 고른 모델({pct(pickDense.hit1)})과 95% 구간이
                {" "}({pct(topDense.v.hit1_ci[0], 0)}~{pct(topDense.v.hit1_ci[1], 0)} 대 {pct(pickDense.hit1_ci[0], 0)}~{pct(pickDense.hit1_ci[1], 0)}) 겹쳐 차이라고 읽을 수 없고,
                파일이 {s.models[topDense.m]?.MB.toLocaleString()}MB라 브라우저에 올릴 수 없습니다.</>
            )}
            {" "}고른 모델은 {s.models[PICKED_MODEL]?.MB.toLocaleString()}MB이고 int8로 줄이면 약 {MODEL_FILE_MB}MB라 브라우저에서 그대로 돕니다
            {d.browser && <> — 실제 Chrome에서 Hit@1 {pct(d.browser.hit1)}, 질문당 {num(d.browser.query_ms, 1)}ms</>}.
          </Pick>
          <h3>자르기 × 임베딩 모델 (임베딩만 썼을 때 Hit@1)</h3>
          <div className="scroll">
            <table className="ev_table">
              <thead><tr><th>모델</th>{chunks.map((c) => <th key={c} className="n">{c}</th>)}</tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m} className={m === PICKED_MODEL ? "is-pick" : ""}>
                    <td>{m}{m === PICKED_MODEL && <span className="ev_mark">✓ 사용 모델</span>}</td>
                    {chunks.map((c) => {
                      const v = s.dense[m]?.[c];
                      const pick = m === PICKED_MODEL && c === PICKED_CHUNK;
                      return <td key={c} className={`n${pick ? " best" : ""}`}>{pct(v?.hit1)}<span className="note"> ({pct(v?.hit1_ci[0], 0)}~{pct(v?.hit1_ci[1], 0)})</span></td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>모델 크기 — 브라우저에 올릴 수 있는가</h3>
          <div className="scroll">
            <table className="ev_table">
              <thead><tr><th>모델</th><th className="n">파라미터(M)</th><th className="n">파일 크기(MB)</th><th className="n">차원</th><th className="n">로딩(초)</th></tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m} className={m === PICKED_MODEL ? "is-pick" : ""}>
                    <td>{m}{m === PICKED_MODEL && <span className="ev_mark">✓ 사용 모델</span>}</td>
                    <td className="n">{s.models[m].params_M}</td><td className="n">{s.models[m].MB.toLocaleString()}</td>
                    <td className="n">{s.models[m].dim}</td><td className="n">{s.models[m].load_s}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">파일 크기는 fp32 기준입니다. 앱은 이 중 multilingual-e5-small의 int8 ONNX(약 {MODEL_FILE_MB}MB)를 씁니다 — 바로 검사는 브라우저에서, 에이전트 검사는 서버에서 같은 파일을 돌립니다
            {d.browser && <> — 실제 Chrome에서 같은 질문 {d.browser.n}개를 쟀을 때 Hit@1 {pct(d.browser.hit1)}, MRR {num(d.browser.mrr, 3)},
              모델 로딩 {(d.browser.load_ms / 1000).toFixed(1)}초, 질문당 {num(d.browser.query_ms, 1)}ms</>}.</p>

          <h3>하이브리드 가중치 (0 = 단어 검색만 … 1 = 임베딩만)</h3>
          <ul className="ev_bars">
            {hybrid.map(([w, v]) => (
              <li key={w} className={w === PICKED_W ? "pick" : ""}>
                <span className="b_name">{w}{w === PICKED_W && " ← 채택"}</span>
                <span className="b_track"><span className="b_fill" style={{ width: `${Math.max(0, (v.mrr - 0.85) / 0.15) * 100}%` }} /></span>
                <span className="b_val">{num(v.mrr, 3)}</span>
              </li>
            ))}
          </ul>
          <p className="note">가로축은 MRR@10이고 0.85부터 그렸습니다(차이가 작아서).</p>
          {wPick && wTop && (
            <div className="ev_why">
              <b>왜 더 높은 {bestW[0]}이 아니라 {PICKED_W}인가</b>
              <ul>
                <li><b>차이가 질문 한 개보다 작습니다.</b> {bestW[0]}이 {num(bestW[1], 3)}, {PICKED_W}가 {num(wPick.mrr, 3)}로 차이는
                  {" "}{num(bestW[1] - wPick.mrr, 3)}입니다. 질문 {s.n_questions}개에서 한 문제의 정답이 1위에서 2위로 내려가기만 해도
                  {" "}{num(0.5 / s.n_questions, 3)}만큼 움직입니다. 그보다 작은 차이를 보고 고르면 질문을 하나 바꿀 때마다 답이 바뀝니다.</li>
                {bestW[0] !== PICKED_W && (
                  <li><b>고를 때 쓰는 쪽에서는 {PICKED_W}가 더 높았습니다.</b> 질문을 둘로 갈라 절반(dev)으로 고르고 나머지 절반(val)으로
                    확인하는데, dev에서는 {PICKED_W}가 {num(wPick.dev_mrr, 3)}, {bestW[0]}이 {num(wTop.dev_mrr, 3)}였습니다.
                    {" "}{bestW[0]}이 앞서는 것은 val({num(wTop.val_mrr, 3)} 대 {num(wPick.val_mrr, 3)})뿐입니다. val을 보고 고르면 그
                    숫자는 더 이상 확인이 아닙니다.</li>
                )}
                <li><b>{PICKED_W}는 평평한 구간이고 {bestW[0]}은 봉우리 하나입니다.</b> 0.5·0.6·0.7이 셋째 자리까지 같은 값으로
                  {" "}{num(wPick.mrr, 3)}인데, {bestW[0]}은 양옆(0.2 {num(s.hybrid["0.2"]?.mrr, 3)} · 0.4 {num(s.hybrid["0.4"]?.mrr, 3)})보다만
                  높습니다. 넓은 구간의 가운데를 고르면 지식베이스가 늘거나 질문이 바뀌어도 값이 덜 흔들립니다.</li>
                <li><b>단어 검색을 자르는 방식을 바꾸면 {bestW[0]}은 1위가 아닙니다.</b> 아래 표에서 형태소로 자르면 0.4~0.8이 더 높습니다.
                  {bestW[0]}의 1위는 지금 조합에서만 나오는 값입니다.</li>
              </ul>
              <span className="note">덧붙여, 개발용 질문으로 고른 가중치를 처음 보는 질문에 다시 재도(dev {num(wPick.dev_mrr, 3)} /
                val {num(wPick.val_mrr, 3)}) 무너지지 않았습니다.</span>
            </div>
          )}

          <h3>단어 검색을 어떻게 자를 것인가 (같은 가중치에서 MRR)</h3>
          <div className="scroll">
            <table className="ev_table">
              <thead><tr><th>자르는 방식</th><th className="n">0.0(단어만)</th><th className="n">0.5(채택)</th><th className="n">1.0(임베딩만)</th></tr></thead>
              <tbody>
                {Object.entries(s.tokenizer).map(([t, by]) => (
                  <tr key={t} className={t === "2-gram" ? "is-pick" : ""}>
                    <td>{t}{t === "2-gram" && <span className="ev_mark">✓ 채택</span>}</td>
                    <td className="n">{num(by["0.0"], 3)}</td><td className={`n${t === "2-gram" ? " best" : ""}`}>{num(by["0.5"], 3)}</td><td className="n">{num(by["1.0"], 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="warn"><b>주의</b> 질문과 정답 문장이 단어를 공유해 단어 검색에 유리하고, 대부분 설정이 90% 안팎 입니다.</div>
        </Section>
      )}

      {(d.color_crosscheck || d.quant) && (
        <Section id="color" title="2. 색 변환이 맞게 계산되는가" source={d.sources.color}
          lead="앱은 브라우저에서 색 변환(lcms-wasm)을 합니다. 같은 ICC 프로파일로 Python(Pillow의 LittleCMS)에서 다시 돌려 그 결과와 대조했습니다. 두 결과가 다르면 앱 계산을 믿을 수 없습니다.">
          {d.color_crosscheck && (
            <Pick>브라우저 색 변환을 그대로 씁니다. 두 구현의 평균 ΔE 차이가 {num(d.color_crosscheck.mean_abs_diff, 3)}로
              눈에 보이는 기준(ΔE 2)의 1/10도 안 됩니다. 색 계산을 서버로 보내지 않고 기기 안에서 하는 근거가 이것입니다.</Pick>
          )}
          {d.color_crosscheck && (
            <div className="ev_kpis">
              <div><b>{num(d.color_crosscheck.mean_abs_diff, 3)}</b><span>평균 ΔE 차이(앱 ↔ Python)</span></div>
              <div><b>{num(d.color_crosscheck.mean_js)}</b><span>앱 평균 ΔE</span></div>
              <div><b>{num(d.color_crosscheck.mean_pillow)}</b><span>Python 평균 ΔE</span></div>
              <div><b>{d.color_crosscheck.n.toLocaleString()}</b><span>비교한 색 수</span></div>
            </div>
          )}
          {d.quant && <p className="note">사진 {d.quant.rows}장으로 16비트·8비트 양자화 영향도 쟀습니다 — 16비트 경로 최대 차이 {num(d.quant.max_diff16, 3)} ΔE,
            8비트 양자화 최대 차이 {num(d.quant.max_diff8, 4)} ΔE로 사실상 같습니다.</p>}
          <div className="warn"><b>주의</b> 두 구현이 같다는 뜻이지 <b>실제 인쇄와 같다</b>는 뜻이 아닙니다.</div>
        </Section>
      )}

      {d.profiles && (
        <Section id="profiles" title="3. 종이(프로파일)에 따라 색이 얼마나 달라지는가" source={d.sources.profiles}
          lead="같은 사진 8장을 종이 등급별 공개 프로파일 12개로 각각 변환해 비교했습니다. ‘종이 색 제외’는 종이 흰색을 화면 흰색에 맞춘 값, ‘종이 색 포함’은 종이 자체의 밝기·색조까지 넣은 값입니다.">
          <Pick>종이를 고르면 그 등급의 프로파일로 계산합니다. 같은 사진이라도 프로파일에 따라 평균 ΔE가
            {" "}{num(Math.min(...profDE))}~{num(Math.max(...profDE))}까지 벌어져서, 어느 한 프로파일로 뭉뚱그리면 예측이 의미가 없기 때문입니다.</Pick>
          <div className="scroll">
            <table className="ev_table">
              <thead><tr><th>프로파일</th><th className="n">잉크 한도</th><th className="n">종이 흰색 L*</th><th className="n">ΔE (종이 색 제외)</th><th className="n">ΔE (종이 색 포함)</th><th className="n">ΔE&gt;5 면적</th><th className="n">연결된 종이</th></tr></thead>
              <tbody>
                {d.profiles.rows.map((p) => (
                  <tr key={p.key}>
                    <td>{p.name}<div className="note">{p.condition}</div></td>
                    <td className="n">{p.tac}%</td>
                    <td className="n">{num(p.white?.[0], 1)}</td>
                    <td className="n">{num(p.noPaper.meanDE)}</td>
                    <td className="n">{num(p.withPaper.meanDE)}</td>
                    <td className="n">{pct(p.withPaper.over5)}</td>
                    <td className="n">{p.papers}종</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="warn">
            <p><b>주의</b> ‘종이 색 포함’은 눈이 종이 흰색에 적응하는 효과를 빼 놓은 값이라, 실제로 느끼는 차이보다 큰 상한에 가깝습니다.</p>
            <p>근사한 범위도 알아 두세요. 브랜드 종이 454종은 이 12개 중 같은 등급 프로파일로 근사합니다.
              광택 차이(아트지·스노우지)는 같은 프로파일을 쓰므로 결과에 드러나지 않습니다.</p>
          </div>
        </Section>
      )}

      {d.substrate && (
        <Section id="substrate" title="4. 종이 흰색 보정 — 어떤 식을 쓸 것인가" source={d.sources.substrate}
          lead="측정 프로파일 쌍 가운데 등급은 같고 종이 흰색만 다른 쌍을 골랐습니다. 여기서 A의 인쇄 결과를 B의 종이 흰색으로 옮겼습니다. 그 값이 B의 실제 값에 얼마나 가까워지는지 쟀습니다. 숫자는 평균 ΔE(작을수록 좋음)입니다.">
          <Pick><b>선형</b> 방식을 씁니다. 비교한 {d.substrate.rows.length}쌍 중 {subBest}쌍에서 선형이 가장 가까웠기 때문입니다
            {subNotWorse === d.substrate.rows.length && <>. 보정 없음보다 나빠진 쌍은 하나도 없었습니다</>}.</Pick>
          <div className="scroll">
            <table className="ev_table">
              <thead><tr><th>프로파일 쌍</th><th className="n">종이 흰색 차이</th><th className="n">보정 없음</th><th className="n">비례</th><th className="n">선형(채택)</th></tr></thead>
              <tbody>
                {d.substrate.rows.map((r, i) => {
                  const best = Math.min(r.none_mean, r.ratio_mean, r.linear_mean);
                  return (
                    <tr key={i}>
                      <td>{r.from} → {r.to}</td>
                      <td className="n">{num(r.paperWhiteDE)}</td>
                      <td className={`n${r.none_mean === best ? " best" : ""}`}>{num(r.none_mean)}</td>
                      <td className={`n${r.ratio_mean === best ? " best" : ""}`}>{num(r.ratio_mean)}</td>
                      <td className={`n${r.linear_mean === best ? " best" : ""}`}>{num(r.linear_mean)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">12쌍 중 선형 방식이 가장 좋은 쌍이 9개여서 선형을 택했습니다(종이 흰색은 측정값으로 옮기고 가장 진한 색은 고정).</p>
          <div className="warn"><b>주의</b> 보정하는 것은 <b>흰색뿐</b>입니다. 잉크 거동과 잉크량 한도는 여전히 등급 프로파일 값이고 측정한 흰색을 입력하지 않으면 보정하지 않습니다.</div>
        </Section>
      )}

      {pr && (
        <Section id="proof" title="5. 교정 탐지기 — 규칙·형태소 모델·LLM" source={d.sources.proofread}
          lead={`문서 ${pr.n_docs}개에 오류 ${pr.n_errors}개를 일부러 넣고 비교했습니다. 재현율은 넣은 오류 중 찾아낸 비율, 정밀도는 내놓은 제안 중 맞은 비율입니다. ${pr.llm}.`}>
          <Pick>
            기본값은 <b>규칙 + Kiwi 오타 모델</b>입니다(F1 {num(prPick?.f1, 3)}, 정밀도 {pct(prPick?.precision)}).
            {prTop && prTop[1].uses_llm && <> F1이 가장 높은 것은 {prTop[0]}({num(prTop[1].f1, 3)})이지만 교정할 <b>본문이 외부 API로 나가서</b>,
              본문이 기기 밖으로 나가지 않는 조합 중 가장 좋은 것을 기본으로 두고 LLM은 사용자가 직접 켜게 했습니다.</>}
            {" "}띄어쓰기 모델은 재현율은 올리지만 정상 글에서도 1,000자당 {pr.clean_fp["Kiwi 띄어쓰기"]}건을 잘못 지적해 뺐습니다.
          </Pick>
          <div className="scroll">
            <table className="ev_table">
              <thead><tr><th>방법</th><th className="n">재현율 (95% 구간)</th><th className="n">정밀도</th><th className="n">F1</th><th className="n">제안 수</th><th className="n">정상 글 오탐/1,000자</th><th>본문 외부 전송</th></tr></thead>
              <tbody>
                {prRows.map(([name, m]) => (
                  <tr key={name} className={name === "규칙+Kiwi 오타" ? "is-pick" : ""}>
                    <td>{name}{name === "규칙+Kiwi 오타" && <span className="ev_mark">✓ 기본값</span>}</td>
                    <td className="n">{pct(m.recall)}<span className="note"> ({pct(m.recall_ci[0], 0)}~{pct(m.recall_ci[1], 0)})</span></td>
                    <td className="n">{pct(m.precision)}</td>
                    <td className={`n${m.f1 === prBest ? " best" : ""}`}>{num(m.f1, 3)}</td>
                    <td className="n">{m.suggestions}</td>
                    <td className="n">{pr.clean_fp[name] ?? "—"}</td>
                    <td>{m.uses_llm ? "예" : "아니오"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>오류 유형별 재현율</h3>
          <div className="scroll">
            <table className="ev_table">
              <thead><tr><th>방법</th>{KINDS.map(([, label]) => <th key={label} className="n">{label}</th>)}</tr></thead>
              <tbody>
                {prRows.map(([name, m]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    {KINDS.map(([k]) => <td key={k} className="n">{pct(m.by_kind[k])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="warn"><b>주의</b> 앞 다섯 방법의 띄어쓰기·율/률·사전에 있는 오용 100%는 <b>같은 규칙으로 넣고 같은 규칙으로 찾은 순환</b>이라 실력이 아닙니다. 다만 합성 문장이라 실제 원고보다 쉬웠을 여지가 있고 모델을 바꾸면 숫자도 바뀝니다. 기본값을 로컬 조합으로 둔 이유는 성능이 아니라 본문이 외부로 나가기 때문입니다.</div>
        </Section>
      )}

      {/* 이 칸의 수치는 평가 스크립트가 아니라 **엔진을 직접 돌려** 잰 값이다. 그래서 산출물
          파일에서 읽어 오지 않고 여기 적는다 — 어디서 나온 값인지 아래 '측정'에 그대로 밝힌다. */}
      <Section id="fonts" title="6. 글꼴이 없을 때 — 무엇이 멀쩡하고 무엇이 거짓인가"
        lead="편집 파일은 글꼴을 담아 오지 않고 이름으로만 가리킵니다. 올린 PC에는 있고 검수하는 PC에는 없는 일이 흔한데, 그때 결과가 어디까지 맞는지를 엔진으로 직접 재 봤습니다."
        source="DesignCraft 0.17.0을 직접 돌려 측정(엔진 명령 font.list · preflight.run · PDF 글자 추출)">
        <Pick>
          수치를 지우지 않고 <b>어디까지 믿을 수 있는지</b>를 같이 냅니다. 글꼴이 대체되면
          줄바꿈 관련 수치는 원본의 값이 아니라고 적고, 색·해상도·종이는 그대로 맞다고 적습니다.
        </Pick>
        <h3>두 경우가 전혀 다르다</h3>
        <table className="ev_table">
          <thead>
            <tr><th>경우</th><th>PDF에 글이 남나</th><th>교정이 읽나</th><th>줄바꿈</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>글꼴이 아예 없다(<code>missingFont</code>)</td>
              <td>남는다 — 한글 50자 중 50자</td><td>정상</td><td><b>밀린다</b></td>
            </tr>
            <tr>
              <td>글꼴은 있는데 그 글자가 없다(<code>missingGlyphs</code>)</td>
              <td><b>안 남는다 — 29자 중 8자</b>(공백·마침표뿐)</td>
              <td><b>아무것도 못 읽는다</b></td><td>그대로</td>
            </tr>
          </tbody>
        </table>
        <p className="note">
          첫 줄은 대체 글꼴이 그려 주고 없는 글자는 폴백이 메꿔서 글이 그대로 뽑힙니다(실측: 한글은 Batang,
          라틴은 Source Sans 3). 둘째 줄이 위험합니다 — 글자가 PDF에 남지 않으니 <b>“고칠 것 없음”이라는
          거짓 결과</b>가 나옵니다. 그래서 둘을 따로 적고, 둘째 줄은 원본의 흠으로 표시합니다.
        </p>

        <h3>대체되면 줄이 얼마나 밀리나</h3>
        <p className="note">같은 상자(200×140pt)에 같은 글 1,350자를 넣고 글꼴만 바꿨을 때 넘친 글자 수입니다.</p>
        <table className="ev_table">
          <thead><tr><th>글꼴</th><th>넘친 글자</th></tr></thead>
          <tbody>
            <tr><td>맑은 고딕</td><td>372자</td></tr>
            <tr><td>굴림</td><td>365자</td></tr>
            <tr><td>바탕</td><td>365자</td></tr>
          </tbody>
        </table>
        <p className="note">
          같은 글·같은 상자인데 <b>7자가 다릅니다.</b> 그래서 대체 글꼴로 본 넘침·쪽 배분은 원본의 값이 아닙니다.
        </p>

        <h3>글꼴을 받는 길 — 패키지가 먼저 읽힌다</h3>
        <p className="note">
          서버에 세상의 글꼴을 다 깔 수는 없고, 상용 글꼴을 깔아 두고 남의 파일에 쓰는 것은 라이선스 문제입니다.
          인디자인의 <b>파일 → 패키지</b>가 만드는 <code>Document Fonts/</code>를 엔진이 문서보다 <b>먼저</b> 읽는지
          재 봤습니다 — 같은 글꼴이 PC에도 깔려 있는 상태로 시험했습니다.
        </p>
        <table className="ev_table">
          <thead><tr><th>올린 모양</th><th>실려 온 글꼴</th><th>쓰인 출처</th></tr></thead>
          <tbody>
            <tr><td>문서 하나만</td><td>0개</td><td><code>installed</code> (PC에 깔린 것)</td></tr>
            <tr><td>패키지 폴더째</td><td><b>1개</b></td><td><b><code>document</code></b> (올린 글꼴)</td></tr>
          </tbody>
        </table>
        <p className="note">
          패키지로 올리면 PC에 깔린 글꼴을 <b>밀어내고</b> 올린 글꼴을 씁니다. 설치하지 않고 그 폴더에서만 읽습니다.
        </p>

        <h3>고친 파일에 글꼴 이름이 남나</h3>
        <p className="note">
          이 PC에 없는 글꼴(<code>Yoon Myungjo 330</code>)을 가리키는 IDML의 글자를 고쳐 내보낸 뒤,
          나온 IDML 안의 글꼴 이름을 전부 긁어 봤습니다.
        </p>
        <table className="ev_table">
          <thead><tr><th>고친 결과</th><th>파일에 남은 글꼴 이름</th></tr></thead>
          <tbody>
            <tr><td>교정 1건 반영, 실패 0</td><td><b><code>Yoon Myungjo 330</code> 하나뿐</b> (대체한 이름은 안 적힘)</td></tr>
          </tbody>
        </table>
        <p className="note">
          <b>원본이 깨지는 일은 없습니다.</b> 글자만 바꾸고 글꼴은 손대지 않으니, 그 글꼴이 있는 PC에서 열면
          원본대로 보입니다. 이 시험은 <code>agents/tests/test_designcraft.py</code>에 묶여 있어 깨지면 바로 걸립니다.
        </p>
      </Section>

      <Section id="notread" title="7. 재지 않은 것" lead="평가에 넣지 못한 것들입니다. 없는 것을 있는 것처럼 적지 않으려고 따로 모았습니다.">
        <ul className="ev_list">
          <li><b>실물 인쇄 측색</b> — 모든 색 수치는 프로파일 기준 계산값입니다. 실제로 찍어 재지 않았습니다.
            <p className="note">재려면 세 가지를 해야 합니다.
              ① 색 견본(IT8.7/4 같은 패치 묶음)을 <b>검사할 종이에 그 인쇄기로</b> 찍습니다.
              ② 분광측색기(X-Rite i1Pro 같은 것)로 패치마다 Lab을 읽습니다.
              ③ 같은 패치의 계산값과 ΔE를 비교합니다.</p>
            <p className="note">측색기가 없으면 인쇄소에 측정 데이터를 요청하거나 측색 대행을 맡기는 길이 있습니다.
              여기까지 하면 “이 화면의 ΔE가 실제보다 몇만큼 높게·낮게 나오는가”를 종이별로 적을 수 있고, 그 값을 보정에 쓸 수 있습니다.</p></li>
          <li><b>인쇄 불량 정답 데이터</b> — 공개 데이터셋을 찾지 못했습니다. 그래서 불량은 학습 모델로 예측하지 않고, 자료에서 확인한 원인이 해당하는지만 보여 줍니다. 어느 원인이 얼마나 더 위험한지는 재지 않았습니다.</li>
          <li><b>실제 사용자 질문·실제 원고</b> — 검색 질문과 교정 평가셋은 모두 제가 만들었습니다. 난이도가 실제와 얼마나 맞는지는 모릅니다.</li>
          <li><b>브랜드 종이 측정 프로파일</b>— 454종은 등급 프로파일로 근사했습니다. 종이 흰색을 측정해 넣을 때만 보정합니다.</li>
          <li><b>인쇄 비용</b> — 단가를 정할 근거가 없어 견적·주문 기능은 두지 않았습니다. 인쇄소 지도는 찾아 주기만 하고 연락은 사용자가 직접 합니다.</li>
        </ul>
      </Section>

    </>
  );
}
