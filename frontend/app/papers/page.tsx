"use client";

import { useEffect, useMemo, useState } from "react";
import { GROUPS, loadPapers, surface, type PaperDb } from "@/lib/papers";

const PAGE = 48;
const lab = (v: number[]) => `L* ${v[0].toFixed(1)} · a* ${v[1].toFixed(1)} · b* ${v[2].toFixed(1)}`;

export default function Papers() {
  const [db, setDb] = useState<PaperDb | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("전체");
  const [kind, setKind] = useState<"all" | "type" | "brand">("all");
  const [maker, setMaker] = useState("전체");
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => { loadPapers().then(setDb).catch((e) => setErr(String(e))); }, []);

  const makers = useMemo(() => ["전체", ...Array.from(new Set(db?.papers.filter((p) => p.maker).map((p) => p.maker) ?? []))], [db]);
  const shown = useMemo(() => {
    const t = q.trim();
    return (db?.papers ?? []).filter((p) => (group === "전체" || p.group === group) && (kind === "all" || p.kind === kind)
      && (maker === "전체" || p.maker === maker)
      && (!t || [p.name, p.maker, p.note, p.use, p.type].some((x) => x?.includes(t))));
  }, [db, q, group, kind, maker]);
  const count = (g: string) => db?.papers.filter((p) => g === "전체" || p.group === g).length ?? 0;
  const reset = () => setLimit(PAGE);

  return (
    <main className="common_wrap">
      <header className="page_head">
        <h1>종이 안내</h1>
        <p className="lead">
          종이마다 잉크가 앉는 방식과 종이 흰색이 달라 같은 PDF도 색과 위험이 달라집니다. 기본 종류 {db?.papers.filter((p) => p.kind === "type").length ?? "…"}종과
          제지·유통사 브랜드 종이 {db?.papers.filter((p) => p.kind === "brand").length ?? "…"}종을 모았습니다. 검수 화면에서 종이를 고르면 아래 프로파일로 색 차이를 다시 계산합니다.
        </p>
      </header>

      <div className="toolbar">
        <div className="search"><input value={q} onChange={(e) => { setQ(e.target.value); reset(); }} placeholder="종이 이름·제조사·특징 검색 (예: 러프그로스, 펄, 크라프트)" /></div>
        <select value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); reset(); }}>
          <option value="all">기본 종류 + 브랜드</option><option value="type">기본 종류만</option><option value="brand">브랜드만</option>
        </select>
        <select value={maker} onChange={(e) => { setMaker(e.target.value); reset(); }}>
          {makers.map((m) => <option key={m} value={m}>{m === "전체" ? "제조·유통사 전체" : m}</option>)}
        </select>
      </div>
      <div className="filters">
        {["전체", ...GROUPS].map((g) => (
          <button key={g} type="button" className={`pill${group === g ? " on" : ""}`} onClick={() => { setGroup(g); reset(); }}>
            {g}<span className="count">{count(g)}</span>
          </button>
        ))}
        <span className="note">{shown.length}종</span>
      </div>
      {err && <div className="err">{err}</div>}

      <div className="papers">
        {shown.slice(0, limit).map((p) => {
          const pr = db!.profiles[p.profile];
          return (
            <section key={p.id} className="pcard">
              <h3><span className="pname" title={p.name}>{p.name}</span>
                <span className="chip">{surface(p)}</span>
                {p.kind === "type" && <span className="chip type">기본 종류</span>}
              </h3>
              {p.maker && <div className="maker">{p.maker} · {p.group}</div>}
              {p.note && <p>{p.note}</p>}
              {p.warn && <div className="warn">{p.warn}</div>}
              <table>
                <tbody>
                  {p.gsm && <tr><th>평량</th><td>{p.gsm}</td></tr>}
                  {p.use && p.use !== "—" && <tr><th>용도</th><td>{p.use}</td></tr>}
                  <tr><th>색 변환 프로파일</th><td>{pr.name}{p.approx ? " (근사)" : ""}</td></tr>
                  <tr><th>잉크량 한도</th><td>{pr.tac}% <small>({pr.tacSource})</small></td></tr>
                  <tr><th>프로파일 종이 흰색</th><td>{lab(pr.white)}</td></tr>
                  <tr><th>가장 진한 검정</th><td>L* {pr.blackL.toFixed(1)} <small>낮을수록 진함</small></td></tr>
                  <tr><th>출처</th><td>{p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer">{p.src} ↗</a> : p.src}</td></tr>
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
      {shown.length > limit && (
        <div className="more_wrap"><button type="button" className="ghost" onClick={() => setLimit((l) => l + PAGE)}>더 보기 ({shown.length - limit}종 남음)</button></div>
      )}

      <div className="disclaimer">
        기본 종류의 정의는 한국제지연합회 「종이의 분류」와 독립출판 종이 가이드, 국내 브랜드 정보는 프린트올데이 「알아두면 쓸데있는 기본 종이 상식」(2020)에서 확인했습니다.
        브랜드 종이는 두성종이 전체 종이 리스트와 삼원페이퍼 제품 목록({db?.generated} 수집)이며, 각 회사가 매긴 분류·태그로 종류를 정했습니다.
        프로파일은 ECI·ICC 레지스트리의 공개 파일로, 사용은 허용되지만 배포할 수 없어 이 PC에서만 씁니다. 브랜드 종이를 직접 측정한 공개 프로파일은 없어 모두 근사입니다.
        실제 색은 인쇄소 샘플북으로 확인하세요.
      </div>
    </main>
  );
}
