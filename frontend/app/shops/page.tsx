"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";

type Shop = { name: string; addr: string; tel: string; lat: number; lon: number; sido: string; sgg: string; items: string; since: string; updated: string; tags: string[] };
type Meta = {
  generated: string; shown: number; nocoord: number; book_matched: number; book_only: number;
  sources: { name: string; url: string; rows: number; status?: Record<string, number>; printing?: number; fetched?: string }[];
};

const LIST_MAX = 100;
// 구글 지도 검색 링크(Maps URLs, api=1). 1인 사업장은 번지가 *로 가려져 있어 가려진 토큰과 괄호는 빼고 업체명+주소로 찾는다.
const mapsUrl = (s: Pick<Shop, "name" | "addr">) => {
  const addr = s.addr.replace(/\(.*?\)/g, " ").split(/[\s,]+/).filter((t) => t && !t.includes("*")).join(" ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(`${s.name} ${addr}`.trim());
};
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export default function Shops() {
  const el = useRef<HTMLDivElement>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState("");
  const [sido, setSido] = useState("전체"); // 처음에는 전국을 보여 준다
  const [q, setQ] = useState("");
  const [bookOnly, setBookOnly] = useState(false);
  const [dropped, setDropped] = useState(0); // 자리를 확인할 수 없어 뺀 수
  const [ready, setReady] = useState(false);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);

  useEffect(() => {
    fetch("/data/shops.json").then((r) => r.json()).then((d) => {
      setMeta(d);
      // 지도에서 찾을 수 없는 자리는 빼고 보여 준다 — 좌표를 도로 단위로 추정한 '도로위치'는
      // 실제 그 자리에 업체가 있다고 보장할 수 없고, 폐업·인허가 없음으로 확인된 곳도 섞여 있다.
      const rows = (d.rows as unknown[][])
        .map((r) => Object.fromEntries(d.cols.map((c: string, i: number) => [c, r[i]])) as Shop)
        .filter((s) => !s.tags.includes("도로위치"));
      setDropped(d.rows.length - rows.length);
      setShops(rows);
    }).catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    let dead = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (dead || !el.current || mapRef.current) return;
      // 지도는 대한민국 밖으로 나가지 않게 가둔다(타일은 세계 지도지만 보이는 범위를 남한 경계로 제한).
      const KOREA = L.latLngBounds([32.9, 124.4], [38.9, 131.1]);
      const map = L.map(el.current, { preferCanvas: true, maxBounds: KOREA, maxBoundsViscosity: 1, minZoom: 6 }).fitBounds(KOREA);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, bounds: KOREA, noWrap: true,
        attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      mapRef.current = map;
      layerRef.current = L.layerGroup().addTo(map);
      setReady(true);
    })();
    return () => { dead = true; mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  const sidos = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of shops) c.set(s.sido, (c.get(s.sido) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [shops]);

  const shown = useMemo(() => {
    const t = q.trim();
    return shops.filter((s) => (sido === "전체" || s.sido === sido) && (!bookOnly || s.tags.includes("출판도시"))
      && (!t || s.name.includes(t) || s.addr.includes(t) || s.items.includes(t)));
  }, [shops, sido, q, bookOnly]);

  useEffect(() => {
    (async () => {
      const L = (await import("leaflet")).default;
      const layer = layerRef.current, map = mapRef.current;
      if (!layer || !map) return;
      layer.clearLayers();
      const thema = token("--thema"), point = token("--purpleBright");
      for (const s of shown) {
        const book = s.tags.includes("출판도시");
        L.circleMarker([s.lat, s.lon], { radius: book ? 7 : 4, weight: 1, color: book ? point : thema, fillColor: book ? point : thema, fillOpacity: 0.7 })
          .bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.addr)}<br>${esc(s.tel || "전화번호 공개 안 됨")}${s.items ? `<br>품목: ${esc(s.items)}` : ""}`
            + `<br><small>인허가 데이터 좌표 · ${s.tags.filter((t) => t.startsWith("인허가:")).map(esc).join(" ") || "영업/정상"}</small>`
            + `<br><a href="${esc(mapsUrl(s))}" target="_blank" rel="noopener noreferrer">구글 지도에서 보기 ↗</a>`)
          .addTo(layer);
      }
      if (shown.length) map.fitBounds(L.latLngBounds(shown.map((s) => [s.lat, s.lon] as [number, number])).pad(0.05), { maxZoom: 16 });
    })();
  }, [shown, ready]);

  const src = meta?.sources[0];
  return (
    <main className="common_wrap">
      <header className="page_head">
      <h1>인쇄소 지도</h1>
      <p className="lead">
        행정안전부 전국 인쇄사 인허가 데이터에서 <b>영업/정상</b> 상태인 업체를 표시합니다
        {meta && <> ({shops.length.toLocaleString()}곳, 데이터 갱신 시점 기준)</>}. 보라색은 파주출판도시 입주기업협의회 목록에 있는 인쇄 업체입니다.
        인허가 상태는 지자체 신고 기준이라 실제 영업 여부와 다를 수 있으니 주문 전에 전화로 확인하세요.
        목록에서 업체를 누르면 구글 지도가 새 탭으로 열립니다.
      </p>
      </header>
      <div className="toolbar">
        <select value={sido} onChange={(e) => setSido(e.target.value)}>
          <option value="전체">전국 ({shops.length.toLocaleString()})</option>
          {sidos.map(([k, n]) => <option key={k} value={k}>{k} ({n.toLocaleString()})</option>)}
        </select>
        <div className="search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="업체명·주소·품목 검색" /></div>
        <label><input type="checkbox" checked={bookOnly} onChange={(e) => setBookOnly(e.target.checked)} /> 출판도시 입주 업체만</label>
        <span className="note">{shown.length.toLocaleString()}곳</span>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="mapwrap">
        <div ref={el} className="map" />
        <ul className="shoplist">
          {shown.slice(0, LIST_MAX).map((s, i) => (
            <li key={`${s.name}-${i}`}>
              <a href={mapsUrl(s)} target="_blank" rel="noopener noreferrer" title={`${s.name} — 구글 지도에서 열기`}>
                <div className="name"><span>{s.name}</span>
                  {s.tags.map((t) => <span key={t} className={`chip${t === "출판도시" ? " book" : ""}`}>{t}</span>)}</div>
                <div className="meta">{s.addr}</div>
                <div className="meta">{s.tel || "전화번호 공개 안 됨"}{s.items && ` · ${s.items}`}</div>
                <div className="go">구글 지도에서 보기 ↗</div>
              </a>
            </li>
          ))}
          {shown.length > LIST_MAX && <li className="more">목록은 앞의 {LIST_MAX}곳만 보입니다. 지역을 고르거나 검색하세요.</li>}
        </ul>
      </div>
      <div className="disclaimer">
        출처: {src ? <>{src.name}, 전체 {src.rows.toLocaleString()}건 중 영업/정상 {src.status?.["영업/정상"]?.toLocaleString()}건, 좌표가 없거나 국외로 나온 {meta?.nocoord}건 제외</> : "불러오는 중"}.
        좌표는 EPSG:5174를 WGS84로 바꾼 값이며, 표본 80곳을 역지오코딩해 80곳 모두 주소와 같은 시군구에 찍히는 것을 확인했습니다.
        1인 사업장은 개인정보 보호로 주소 번지가 *로 가려져 있습니다. 파주출판도시 협의회 목록(인쇄 업종 {meta?.sources[1]?.printing}곳) 중 {meta?.book_matched}곳은 인허가 데이터와 이름·도로명이 맞아 그 좌표로 표시합니다.
        좌표를 도로 단위로 추정했던 {dropped}곳은 실제 그 자리에 업체가 있는지 확인할 수 없어(폐업·인허가 없음으로 확인된 곳 포함) 지도에서 뺐습니다.
        지도 타일 © OpenStreetMap contributors.
      </div>
    </main>
  );
}
