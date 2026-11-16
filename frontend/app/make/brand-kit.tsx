"use client";

// 브랜드 키트 — 로고·색·글꼴을 한 번 등록해 두는 칸.
//
// 명함·포스터·리플렛을 만들 때마다 "주색은 C100 M80…, 글꼴은…"을 다시 말하게 하지 않으려고 만들었다.
// 여기 등록하면 클로드가 MCP로 부탁할 때(compose) 오케스트레이터가 키트를 찾아 같이 넘기고,
// 명령을 짜는 쪽이 그 색 이름·값·글꼴·로고 그대로 짠다.
//
// 색은 **CMYK로만** 받는다. 화면에 보이는 네모는 어림한 색일 뿐이다 — #rrggbb로 받으면 그 값이
// 그대로 문서에 들어가 인쇄 검사에서 RGB로 걸린다(이 저장소에서 실제로 났던 일이다).
//
// 글꼴은 **이 PC에 깔린, 한글이 들어 있는 글꼴** 목록에서만 고른다. 없는 이름을 적으면 엔진이
// 한글 없는 기본 글꼴로 바꿔 찍고, PDF에서 글자가 통째로 사라진다.

import { useCallback, useEffect, useState } from "react";

import {
  brandFonts, brandLogoBlob, deleteBrand, getBrand, saveBrand, uploadBrandLogo,
  type BrandColor, type BrandKit,
} from "@/lib/agentClient";

const MAX_COLORS = 6;
const EMPTY: BrandKit = { name: "", colors: [], title_font: "", body_font: "", logo: null };
const PREVIEWABLE = /\.(png|jpe?g|svg)$/i;

/** 화면용 어림 색. 인쇄 색과 같지 않다 — 그래서 값 칸 옆에만 작게 둔다. */
const approx = (c: BrandColor) => {
  const ch = (v: number) => Math.round(255 * (1 - v / 100) * (1 - c.k / 100));
  return `rgb(${ch(c.c)}, ${ch(c.m)}, ${ch(c.y)})`;
};
const clamp = (v: string) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

export default function BrandKitPanel() {
  const [kit, setKit] = useState<BrandKit>(EMPTY);
  const [saved, setSaved] = useState<BrandKit | null>(null);
  const [fonts, setFonts] = useState<string[]>([]);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>("불러오는 중…");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 지우기는 되돌릴 수 없다. 한 번 더 눌러야 지운다(브라우저 확인 창은 쓰지 않는다).
  const [sure, setSure] = useState(false);
  // 등록해 둔 키트는 **요약으로 접어** 보여 준다. 늘 펼쳐 두면 칸이 길어 아래 '에이전트가 하는 일'을
  // 밀어내고, 정작 무엇이 등록돼 있는지는 입력 칸 사이에 묻힌다. 고칠 때만 펼친다.
  const [editing, setEditing] = useState(false);

  const showLogo = useCallback((k: BrandKit | null) => {
    setLogoUrl((old) => { if (old) URL.revokeObjectURL(old); return null; });
    if (k?.logo && PREVIEWABLE.test(k.logo.name)) {
      brandLogoBlob().then(setLogoUrl, () => undefined);
    }
  }, []);

  useEffect(() => {
    Promise.all([getBrand(), brandFonts().catch(() => [] as string[])])
      .then(([k, f]) => { setFonts(f); setSaved(k); setKit(k ?? EMPTY); showLogo(k); },
        (e: unknown) => setMsg({ ok: false, text: `키트를 불러오지 못했습니다 — ${e instanceof Error ? e.message : String(e)}` }))
      .finally(() => setBusy(null));
  }, [showLogo]);

  const setColor = (i: number, patch: Partial<BrandColor>) =>
    setKit((k) => ({ ...k, colors: k.colors.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const addColor = () =>
    setKit((k) => ({ ...k, colors: [...k.colors, { name: k.colors.length ? `보조${k.colors.length}` : "주색", c: 0, m: 0, y: 0, k: 0 }] }));
  const dropColor = (i: number) => setKit((k) => ({ ...k, colors: k.colors.filter((_, j) => j !== i) }));

  const run = async (label: string, job: () => Promise<void>) => {
    setBusy(label); setMsg(null);
    try { await job(); } catch (e) {
      setMsg({ ok: false, text: (e instanceof Error ? e.message : String(e)).replace(/^\d{3}\s*/, "").replace(/^\{"detail":"(.*)"\}$/, "$1") });
    } finally { setBusy(null); }
  };

  const save = () => run("저장 중…", async () => {
    const k = await saveBrand({ name: kit.name, colors: kit.colors, title_font: kit.title_font, body_font: kit.body_font });
    setSaved(k); setKit(k); setEditing(false);
    setMsg({ ok: true, text: "저장했습니다. 이제 클로드에게 만들게 하면 이 키트로 짭니다." });
  });
  const logo = (f: File) => run("로고 올리는 중…", async () => {
    const k = await uploadBrandLogo(f);
    setSaved(k); setKit((cur) => ({ ...cur, logo: k.logo })); showLogo(k);
    setEditing(true);              // 처음 등록하는 중에 로고부터 올려도 칸이 접히지 않게
    setMsg({ ok: true, text: `로고를 등록했습니다 — ${f.name}` });
  });
  const wipe = () => run("지우는 중…", async () => {
    setSure(false);
    await deleteBrand();
    setSaved(null); setKit(EMPTY); showLogo(null); setEditing(false);
    setMsg({ ok: true, text: "키트를 지웠습니다." });
  });

  const dirty = JSON.stringify({ ...kit, logo: null }) !== JSON.stringify({ ...(saved ?? EMPTY), logo: null });
  const form = !saved || editing;
  const cancel = () => { setKit(saved ?? EMPTY); setEditing(false); setMsg(null); };
  const fontOpts = (cur: string) => (cur && !fonts.includes(cur) ? [cur, ...fonts] : fonts);

  return (
    <section className="panel bk">
      <div className="dc_head">
        <strong>브랜드 키트</strong>
        <span className={`badge ${saved ? "ok" : "off"}`}>{saved ? "등록됨" : "없음"}</span>
        {dirty && <span className="chip">저장 안 한 변경</span>}
      </div>
      <p className="note">
        로고·색·글꼴을 한 번 적어 두면, 클로드·커서에게 &ldquo;명함 만들어 줘&rdquo;라고만 해도 이 브랜드로 만듭니다.
        부탁에 다른 색이나 글꼴을 적으면 그쪽을 따릅니다.
      </p>

      {saved && !editing && (
        <div className="bk_sum">
          {logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logoUrl} alt="등록한 로고" className="bk_logo_img" />
            : <span className="bk_logo_none">{saved.logo ? saved.logo.name : "로고 없음"}</span>}
          <div className="bk_sum_body">
            <b className="bk_sum_name">{saved.name || "이름 없는 브랜드"}</b>
            <span className="note">제목 {saved.title_font || "맑은 고딕(기본)"} · 본문 {saved.body_font || "맑은 고딕(기본)"}</span>
            <div className="bk_sum_colors">
              {saved.colors.map((c) => (
                <span className="bk_chip" key={c.name}>
                  <span className="bk_swatch" style={{ background: approx(c) }} />
                  {c.name} <small>C{c.c} M{c.m} Y{c.y} K{c.k}</small>
                </span>
              ))}
              {saved.colors.length === 0 && <span className="note">등록한 색 없음</span>}
            </div>
          </div>
        </div>
      )}

      {form && (<>
      <div className="bk_grid">
        <label className="bk_field">
          <b>브랜드 이름</b>
          <input value={kit.name} maxLength={40} placeholder="예: 여백 출판사"
            onChange={(e) => setKit({ ...kit, name: e.target.value })} />
        </label>
        <label className="bk_field">
          <b>제목 글꼴</b>
          <select value={kit.title_font} onChange={(e) => setKit({ ...kit, title_font: e.target.value })}>
            <option value="">기본(맑은 고딕)</option>
            {fontOpts(kit.title_font).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="bk_field">
          <b>본문 글꼴</b>
          <select value={kit.body_font} onChange={(e) => setKit({ ...kit, body_font: e.target.value })}>
            <option value="">기본(맑은 고딕)</option>
            {fontOpts(kit.body_font).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
      </div>
      {fonts.length > 0 && (
        <p className="note">이 PC에 깔린 한글 글꼴 {fonts.length}개 중에서 고릅니다. 한글이 없는 글꼴은 목록에 넣지 않았습니다.</p>
      )}

      <div className="bk_colors">
        <b>색 <span className="note">(CMYK · 0~100 · 첫 색이 주된 색)</span></b>
        {kit.colors.length === 0 && <p className="note">아직 등록한 색이 없습니다.</p>}
        {kit.colors.map((c, i) => (
          // 이름 줄과 CMYK 줄을 나눠 둔다. 넓은 화면에서는 두 묶음이 한 줄로 이어지고(display: contents),
          // 폰에서는 이름·빼기 한 줄, C·M·Y·K 한 줄로 갈린다 — 안 나누면 K만 다음 줄로 떨어졌다.
          <div className="bk_color" key={i}>
            <div className="bk_chead">
              <span className="bk_swatch" style={{ background: approx(c) }} title="화면용 어림 색입니다" />
              <input className="bk_cname" value={c.name} maxLength={20} aria-label="색 이름"
                onChange={(e) => setColor(i, { name: e.target.value })} />
              <button type="button" className="ghost small bk_drop" onClick={() => dropColor(i)}>빼기</button>
            </div>
            <div className="bk_chs">
              {(["c", "m", "y", "k"] as const).map((ch) => (
                <label className="bk_ch" key={ch}>
                  <span>{ch.toUpperCase()}</span>
                  <input type="number" min={0} max={100} value={c[ch]}
                    onChange={(e) => setColor(i, { [ch]: clamp(e.target.value) } as Partial<BrandColor>)} />
                </label>
              ))}
            </div>
          </div>
        ))}
        {kit.colors.length < MAX_COLORS && (
          <button type="button" className="ghost small" onClick={addColor}>색 더하기</button>
        )}
      </div>

      <div className="bk_logo">
        <b>로고</b>
        <div className="bk_logo_row">
          {logoUrl
            // blob 주소라 next/image가 줄여 줄 것이 없다(서버를 거치지 않은 이 브라우저 안의 그림이다)
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logoUrl} alt="등록한 로고" className="bk_logo_img" />
            : <span className="bk_logo_none">{kit.logo ? kit.logo.name : "없음"}</span>}
          <input type="file" accept=".png,.jpg,.jpeg,.tif,.tiff,.pdf,.eps,.ai,.svg,.psd"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void logo(f); e.target.value = ""; }} />
        </div>
        <p className="note">인쇄용이면 벡터(AI·EPS·PDF·SVG)나 300ppi 이상 그림을 올려 주세요. 문서를 만들 때 그 문서 폴더로 복사해 넣습니다.</p>
      </div>
      </>)}

      <div className="bk_go">
        {form && (
          <button type="button" disabled={!!busy || (!dirty && !!saved)} onClick={() => void save()}>
            {busy ?? (saved ? "저장" : "키트 등록")}
          </button>
        )}
        {saved && editing && <button type="button" className="ghost" disabled={!!busy} onClick={cancel}>닫기</button>}
        {saved && !editing && <button type="button" disabled={!!busy} onClick={() => { setEditing(true); setMsg(null); }}>수정</button>}
        {saved && !sure && <button type="button" className="ghost" disabled={!!busy} onClick={() => setSure(true)}>키트 지우기</button>}
        {saved && sure && (
          <>
            <button type="button" className="bk_danger" disabled={!!busy} onClick={() => void wipe()}>정말 지우기 — 되돌릴 수 없습니다</button>
            <button type="button" className="ghost" onClick={() => setSure(false)}>그만두기</button>
          </>
        )}
        {msg && <span className={msg.ok ? "bk_ok" : "err"}>{msg.text}</span>}
      </div>
    </section>
  );
}
