"use client";

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
      <p className="ev_lead">이 앱이 쓰는 설정(검색 모델·청킹·가중치, 색 변환, 종이 흰색 보정, 교정 탐지기)을 무엇과 비교해서 골랐는지 전부 수치로 적었습니다. 화면의 숫자는 저장소의 평가 스크립트가 남긴 산출물을 그대로 읽은 것이고 다시 재면 이 화면도 같이 바뀝니다.</p>

      <Toc items={[{ id: "search", label: "가이드 검색" }, { id: "color", label: "색 변환 검증" }, { id: "profiles", label: "종이별 색 차이" },
        { id: "substrate", label: "종이 흰색 보정" }, { id: "proof", label: "교정 탐지기" }, { id: "notread", label: "재지 않은 것" }]} />

      {s && (
        <Section id="search" title="1. 가이드 검색 — 어떤 청킹·어떤 모델·어떤 가중치인가"
          lead={`질문 ${s.n_questions}개로 비교했습니다(지식베이스 ${s.kb_chars.toLocaleString()}자). Hit@1은 1위 결과가 정답을 담은 비율, MRR은 정답 순위의 역수 평균입니다. 괄호는 95% 구간입니다.`}
          source={d.sources.search}>
          <Pick>
            <b>{PICKED_CHUNK}</b>로 자르고 <b>{PICKED_MODEL}</b>을 <b>하이브리드 {PICKED_W}</b>(2-gram 단어 검색 반 + 임베딩 반)로 씁니다.
            {topDense && topDense.m !== PICKED_MODEL && topDense.v && pickDense && (
              <> 같은 청킹에서 숫자가 가장 높은 것은 {topDense.m}({pct(topDense.v.hit1)})이지만 고른 모델({pct(pickDense.hit1)})과 95% 구간이
                {" "}({pct(topDense.v.hit1_ci[0], 0)}~{pct(topDense.v.hit1_ci[1], 0)} 대 {pct(pickDense.hit1_ci[0], 0)}~{pct(pickDense.hit1_ci[1], 0)}) 겹쳐 차이라고 읽을 수 없고,
                파일이 {s.models[topDense.m]?.MB.toLocaleString()}MB라 브라우저에 올릴 수 없습니다.</>
            )}
            {" "}고른 모델은 {s.models[PICKED_MODEL]?.MB.toLocaleString()}MB이고 int8로 줄이면 약 118MB라 브라우저에서 그대로 돕니다
            {d.browser && <> — 실제 Chrome에서 Hit@1 {pct(d.browser.hit1)}, 질문당 {num(d.browser.query_ms, 1)}ms</>}.
          </Pick>
          <h3>청킹 × 임베딩 모델 (임베딩만 썼을 때 Hit@1)</h3>
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
          <p className="note">파일 크기는 fp32 기준입니다. 앱은 이 중 multilingual-e5-small의 int8 ONNX(약 118MB)를 씁니다 — 바로 검사는 브라우저에서, 에이전트 검사는 서버에서 같은 파일을 돌립니다
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
          <p className="note">가로축은 MRR@10이고 0.85부터 그렸습니다(차이가 작아서). 가장 높은 값은 {bestW[0]}({num(bestW[1], 3)})이지만
            0.3~0.7 구간이 사실상 붙어 있어, 양쪽을 반씩 쓰는 0.5를 택했습니다. 개발용 질문으로 고른 가중치를 처음 보는 질문에 다시 재도
            (dev {num(s.hybrid[PICKED_W]?.dev_mrr, 3)} / val {num(s.hybrid[PICKED_W]?.val_mrr, 3)}) 무너지지 않았습니다.</p>

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
          <div className="warn"><b>주의</b> 질문 {s.n_questions}개를 지식베이스를 쓴 사람이 직접 만들었습니다. 질문과 정답 문장이 단어를 공유해 단어 검색에 유리하고,
            대부분 설정이 90% 안팎 천장에 붙습니다. 모델 사이 몇 %p 차이는 질문 한두 개로 뒤집히니, 구간이 겹치면 차이가 있다고 읽지 마세요.</div>
        </Section>
      )}

      {(d.color_crosscheck || d.quant) && (
        <Section id="color" title="2. 색 변환이 맞게 계산되는가" source={d.sources.color}
          lead="앱이 브라우저에서 하는 색 변환(lcms-wasm)을 같은 ICC 프로파일로 Python(Pillow의 LittleCMS)에서 다시 돌려 대조했습니다. 두 결과가 다르면 앱 계산을 믿을 수 없습니다.">
          {d.color_crosscheck && (
            <Pick>브라우저 색 변환을 그대로 씁니다. 두 구현의 평균 ΔE 차이가 {num(d.color_crosscheck.mean_abs_diff, 3)}로
              눈에 보이는 기준(ΔE 2)의 1/10도 안 되기 때문입니다. 그래서 색 계산을 서버로 보내지 않고 기기 안에서 합니다.</Pick>
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
          <div className="warn"><b>주의</b> 두 구현이 같다는 뜻이지 <b>실제 인쇄와 같다</b>는 뜻이 아닙니다. 실물 측색값과의 비교는 하지 않았습니다.</div>
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
          <div className="warn"><b>주의</b>‘종이 색 포함’은 눈이 종이 흰색에 적응하는 효과를 빼 놓은 값이라 실제로 느끼는 차이보다 큰 상한에 가깝습니다. 브랜드 종이 454종은 이 12개 중 같은 등급 프로파일로 근사하며 광택 차이(아트지·스노우지)는 같은 프로파일이라 반영되지 않습니다.</div>
        </Section>
      )}

      {d.substrate && (
        <Section id="substrate" title="4. 종이 흰색 보정 — 어떤 식을 쓸 것인가" source={d.sources.substrate}
          lead="같은 등급인데 종이 흰색이 다른 측정 프로파일 쌍에서, A의 인쇄 결과를 B의 종이 흰색으로 옮겼을 때 B의 실제 값에 얼마나 가까워지는지 쟀습니다. 숫자는 평균 ΔE(작을수록 좋음)입니다.">
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
          <div className="warn"><b>주의</b> 앞 다섯 방법의 띄어쓰기·율/률·사전에 있는 오용 100%는 <b>같은 규칙으로 넣고 같은 규칙으로 찾은 순환</b>이라 실력이 아닙니다. 방법끼리 비교할 수 있는 칸은 ‘사전에 없는 오용’과 ‘무작위 오타’입니다. LLM은 평가 틀을 모르고 쟀지만 합성 문장이라 실제 원고보다 쉬울 수 있고 모델을 바꾸면 숫자도 바뀝니다. 기본값을 로컬 조합으로 둔 이유는 성능이 아니라 본문이 외부로 나가기 때문입니다.</div>
        </Section>
      )}

      <Section id="notread" title="6. 재지 않은 것" lead="평가에 넣지 못한 것들입니다. 없는 것을 있는 것처럼 적지 않으려고 따로 모았습니다.">
        <ul className="ev_list">
          <li><b>실물 인쇄 측색</b> — 모든 색 수치는 프로파일 기준 계산값입니다. 실제로 찍어 재지 않았습니다.</li>
          <li><b>인쇄 불량 정답 데이터</b> — 공개 데이터셋을 찾지 못했습니다. 그래서 불량은 학습 모델로 예측하지 않고, 자료에서 확인한 원인이 해당하는지만 보여 줍니다. 어느 원인이 얼마나 더 위험한지는 재지 않았습니다.</li>
          <li><b>실제 사용자 질문·실제 원고</b> — 검색 질문과 교정 평가셋 모두 제가 만든 것이라 난이도가 실제와 다를 수 있습니다.</li>
          <li><b>브랜드 종이 측정 프로파일</b>— 454종은 등급 프로파일로 근사했고 종이 흰색을 측정해 넣을 때만 보정합니다.</li>
          <li><b>인쇄 비용</b> — 단가를 정할 근거가 없어 견적·주문 기능은 두지 않았습니다. 인쇄소 지도는 찾아 주기만 하고 연락은 사용자가 직접 합니다.</li>
        </ul>
      </Section>

    </>
  );
}
