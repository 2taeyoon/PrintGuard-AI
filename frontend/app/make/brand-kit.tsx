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
// 색 칸 왼쪽의 네모를 누르면 색 고르기 창이 뜬다. 고른 화면 색은 CMYK로 **어림 변환**해 숫자 칸에
// 채운다 — 화면 색과 인쇄 색은 같은 수로 옮겨지지 않으므로, 인쇄 색은 숫자로 확정한다.
//
// 글꼴은 **이 PC에 깔린 글꼴**이나 **키트에 올린 글꼴 파일**에서만 고른다. 없는 이름을 적으면 엔진이
// 한글 없는 기본 글꼴로 바꿔 찍고, PDF에서 글자가 통째로 사라진다. 아무것도 고르지 않으면 맑은 고딕이다.
// 영문 전용 글꼴도 고를 수 있다(영문 로고타입·영문 제목). 이름 옆에 지원 언어를 붙이고, 엔진에는 그 글꼴을
// 영문·숫자로만 된 글에만 쓰고 한글이 든 상자는 한글 글꼴로 짜라고 일러 준다(agents brand.prompt_block).

import { useCallback, useEffect, useRef, useState } from "react";
import type { InstalledFont } from "@/lib/agentClient";
import { WINDOWS_FONTS } from "@/lib/windows-fonts";
import type { BrandFont } from "@/lib/agentClient";

import {
  brandFonts, brandLogoBlob, deleteBrand, deleteBrandFont, getBrand, saveBrand, uploadBrandFont, uploadBrandLogo,
  type BrandColor, type BrandKit,
} from "@/lib/agentClient";

const MAX_COLORS = 6;
const EMPTY: BrandKit = { name: "", colors: [], title_font: "", body_font: "", logo: null, fonts: [] };
const PREVIEWABLE = /\.(png|jpe?g|svg)$/i;

/** 화면용 어림 색. 인쇄 색과 같지 않다 — 그래서 값 칸 옆에만 작게 둔다. */
const approx = (c: BrandColor) => {
  const ch = (v: number) => Math.round(255 * (1 - v / 100) * (1 - c.k / 100));
  return `rgb(${ch(c.c)}, ${ch(c.m)}, ${ch(c.y)})`;
};
const clamp = (v: string) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

/** 색 고르기 창에 넣을 #rrggbb(위 어림 색과 같은 식). */
const toHex = (c: BrandColor) => {
  const ch = (v: number) => Math.round(255 * (1 - v / 100) * (1 - c.k / 100)).toString(16).padStart(2, "0");
  return `#${ch(c.c)}${ch(c.m)}${ch(c.y)}`;
};
/** 고른 화면 색 → CMYK 어림값(검정을 K로 먼저 빼는 단순 변환). ICC 변환이 아니라서 인쇄 색과 다를 수 있다. */
const fromHex = (hex: string): Pick<BrandColor, "c" | "m" | "y" | "k"> => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  const p = (v: number) => Math.round(((1 - v - k) / (1 - k)) * 100);
  return { c: p(r), m: p(g), y: p(b), k: Math.round(k * 100) };
};
/** 브라우저가 읽어 주는 내 컴퓨터 글꼴 하나(Local Font Access). 크롬·엣지에만 있다. */
type LocalFont = { family: string; style: string; fullName: string; postscriptName: string; blob: () => Promise<Blob> };
/** 글꼴 파일 머리 4바이트로 확장자를 정한다 — 서버는 확장자로 형식을 가린다. */
async function fontFile(f: LocalFont): Promise<File> {
  const blob = await f.blob();
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const tag = String.fromCharCode(...head);
  const ext = tag === "OTTO" ? ".otf" : tag === "ttcf" ? ".ttc" : ".ttf";
  return new File([blob], `${f.postscriptName || f.fullName}${ext}`, { type: "font/" + ext.slice(1) });
}
/** 아무것도 고르지 않았을 때 엔진이 쓰는 글꼴. 키트에는 ""로 남기고 화면에는 이 이름으로 보인다 —
 *  '기본(맑은 고딕)'과 'Malgun Gothic'이 따로 떠서 다른 글꼴처럼 보이던 것을 하나로 묶었다. */
const DEFAULT_FONT = "Malgun Gothic";
/** 글꼴 하나를 키트에 올릴 때 가져갈 굵기 — 보통과 굵게. 둘 다 없으면 첫 굵기 하나. */
const pickFaces = (faces: LocalFont[]) => {
  const want = faces.filter((f) => /^(regular|normal|book|roman|bold)$/i.test(f.style));
  return want.length ? want : faces.slice(0, 1);
};
/** 글꼴 이름 옆에 붙일 지원 언어. 예전에 올린 글꼴은 언어 기록이 없다 — 그때는 한글 글꼴만 받았다. */
const langsOf = (f: { langs?: string[]; hangul?: boolean }) =>
  f.langs?.length ? f.langs.join("·") : f.hangul === false ? "영문" : f.langs ? "기호" : "한글";
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

export default function BrandKitPanel() {
  const [kit, setKit] = useState<BrandKit>(EMPTY);
  const [saved, setSaved] = useState<BrandKit | null>(null);
  const [fonts, setFonts] = useState<InstalledFont[]>([]);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>("불러오는 중…");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 지우기는 되돌릴 수 없다. 한 번 더 눌러야 지운다(브라우저 확인 창은 쓰지 않는다).
  const [sure, setSure] = useState(false);
  // 등록해 둔 키트는 **요약으로 접어** 보여 준다. 늘 펼쳐 두면 칸이 길어 아래 '에이전트가 하는 일'을
  // 밀어내고, 정작 무엇이 등록돼 있는지는 입력 칸 사이에 묻힌다. 고칠 때만 펼친다.
  const [editing, setEditing] = useState(false);

  // 미리보기 요청에 번호를 붙인다. 올리고 바로 지우는 식으로 연달아 부르면, 먼저 보낸 요청의 답이
  // 늦게 와서 지운 로고를 다시 띄웠다. 마지막 번호가 아닌 답은 버리고 그 blob 주소도 놓아 준다.
  const logoSeq = useRef(0);
  const logoRef = useRef<string | null>(null);
  const putLogo = useCallback((url: string | null) => {
    if (logoRef.current) URL.revokeObjectURL(logoRef.current);
    logoRef.current = url;
    setLogoUrl(url);
  }, []);
  const showLogo = useCallback((k: BrandKit | null) => {
    const seq = ++logoSeq.current;
    putLogo(null);
    if (k?.logo && PREVIEWABLE.test(k.logo.name)) {
      brandLogoBlob().then((url) => {
        if (seq === logoSeq.current) putLogo(url);
        else URL.revokeObjectURL(url);
      }, () => undefined);
    }
  }, [putLogo]);
  // 화면을 떠날 때 남은 blob 주소를 놓아 준다. 늦게 오는 답도 버려지게 번호를 올려 둔다.
  useEffect(() => () => {
    logoSeq.current++;
    if (logoRef.current) URL.revokeObjectURL(logoRef.current);
  }, []);

  useEffect(() => {
    Promise.all([getBrand(), brandFonts().catch(() => [] as InstalledFont[])])
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
    // 이 컴퓨터에만 있는 글꼴(서버가 아직 모르는 것)을 골랐으면 그 파일(보통·굵게)을 먼저 올린다.
    // 서버가 파일에서 읽은 패밀리 이름이 다르면 그 이름으로 바꿔 저장한다 — 엔진은 그 이름으로 찾는다.
    let draft = { ...kit };
    for (const slot of ["title_font", "body_font"] as const) {
      const fam = draft[slot];
      if (!fam || !local?.has(fam) || fonts.some((f) => f.family === fam) || (draft.fonts ?? []).some((f) => f.family === fam)) continue;
      let got = fam;
      for (const face of pickFaces(local.get(fam)!)) {
        setBusy(`${face.fullName} 올리는 중…`);
        const k = await uploadBrandFont(await fontFile(face));
        draft = { ...draft, fonts: k.fonts };
        got = k.fonts?.[k.fonts.length - 1]?.family ?? fam;
      }
      draft = { ...draft, [slot]: got };
    }
    setBusy("저장 중…");
    const k = await saveBrand({ name: draft.name, colors: draft.colors, title_font: draft.title_font, body_font: draft.body_font });
    setSaved(k); setKit(k); setEditing(false);
    setMsg({ ok: true, text: "저장했습니다. 이제 클로드에게 만들게 하면 이 키트로 짭니다." });
  });
  const logo = (f: File) => run("로고 올리는 중…", async () => {
    const k = await uploadBrandLogo(f);
    setSaved(k); setKit((cur) => ({ ...cur, logo: k.logo })); showLogo(k);
    setEditing(true);              // 처음 등록하는 중에 로고부터 올려도 칸이 접히지 않게
    setMsg({ ok: true, text: `로고를 등록했습니다 — ${f.name}` });
  });
  // 글꼴 파일은 올리는 즉시 서버 키트에 들어간다(로고와 같다). 고르는 칸의 다른 값은 그대로 둔다.
  const addFont = (f: File) => run("글꼴 올리는 중…", async () => {
    const k = await uploadBrandFont(f);
    setSaved((s) => ({ ...(s ?? k), fonts: k.fonts })); setKit((cur) => ({ ...cur, fonts: k.fonts }));
    setEditing(true);
    const got = k.fonts?.[k.fonts.length - 1];        // 서버는 새로 올린 것을 끝에 붙인다
    setMsg({ ok: true, text: `글꼴을 올렸습니다 — ${got ? `${got.family} ${got.style}` : f.name}. 위 글꼴 칸에서 고르세요.`
      + (got && got.hangul === false ? " 한글이 없는 영문 전용 글꼴이라 영문·숫자로 된 글에만 쓰고, 한글은 다른 글꼴로 짭니다." : "") });
  });
  // 내 컴퓨터 글꼴(Local Font Access, 크롬·엣지). 한 번 허용하면 화면을 열 때마다 **저절로** 읽어
  // 제목·본문 select에 넣는다 — 목록을 따로 저장하지 않아도 새로고침 뒤에 그대로 있다. 보고 있는 사람의
  // 컴퓨터 글꼴이라 공개 사이트에서도 된다. 고른 글꼴은 **저장할 때** 그 파일을 키트에 올린다.
  const [local, setLocal] = useState<Map<string, LocalFont[]> | null>(null);
  const [localState, setLocalState] = useState<"unsupported" | "prompt" | "granted" | "denied">("prompt");
  const readLocal = useCallback(async () => {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts;
    if (!q) { setLocalState("unsupported"); return 0; }
    const all = await q.call(window);
    const byFamily = new Map<string, LocalFont[]>();
    for (const f of all) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
    setLocal(byFamily); setLocalState("granted");
    return byFamily.size;
  }, []);
  useEffect(() => {
    if (!("queryLocalFonts" in window)) { void Promise.resolve().then(() => setLocalState("unsupported")); return; }
    navigator.permissions.query({ name: "local-fonts" as PermissionName })
      .then((st) => {
        if (st.state === "granted") return readLocal();
        setLocalState(st.state === "denied" ? "denied" : "prompt");
      })
      .catch(() => undefined);              // 권한 이름을 모르는 브라우저 — 단추로 물어본다
  }, [readLocal]);
  // 글꼴을 새로 깔았을 때. 에이전트 PC의 목록은 서버가 다시 읽고, 이 컴퓨터 글꼴은 브라우저가 다시 읽는다.
  // 크롬은 켤 때 글꼴 목록을 읽어 두므로, 방금 깐 글꼴이 이 컴퓨터 목록에 안 보이면 크롬을 다시 켜야 한다.
  const refreshFonts = () => run("글꼴 목록 새로 불러오는 중…", async () => {
    const f = await brandFonts(true);
    setFonts(f);
    const n = localState === "granted" ? await readLocal() : 0;
    setMsg({ ok: true, text: `글꼴 목록을 새로 불러왔습니다 — 이 PC 글꼴 ${f.length}개${n ? ` · 이 컴퓨터 글꼴 ${n}종` : ""}. `
      + "방금 깐 글꼴이 안 보이면 크롬을 껐다 켜 주세요(크롬은 켤 때 글꼴 목록을 읽습니다)." });
  });
  const loadLocal = () => run("이 컴퓨터 글꼴 읽는 중…", async () => {
    const n = await readLocal();
    if (!n) throw new Error("이 브라우저는 내 컴퓨터 글꼴을 읽지 못합니다(크롬·엣지에서 됩니다). 아래에서 글꼴 파일을 올려 주세요.");
    setMsg({ ok: true, text: `이 컴퓨터 글꼴 ${n}종을 제목·본문 글꼴 칸에 넣었습니다. 고르고 저장하면 그 글꼴을 키트에 올립니다.` });
  });
  const dropFont = (name: string) => run("글꼴 빼는 중…", async () => {
    const k = await deleteBrandFont(name);
    setSaved(k); setKit((cur) => ({ ...cur, fonts: k.fonts, title_font: k.title_font, body_font: k.body_font }));
    setMsg({ ok: true, text: "글꼴을 뺐습니다." });
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
  // 고를 수 있는 글꼴 — 겹치지 않게 한 번씩만:
  //   기본(Malgun Gothic) / 키트에 올린 글꼴 / 이 PC에 설치한 글꼴 / 윈도우 기본 글꼴 / 내 컴퓨터에만 있는 글꼴.
  // 한글·영문으로 묶음을 나누지 않는다 — 이름 옆에 지원 언어를 붙인다('Batang (한글·영문·한자)', 'Arial (영문)').
  // 한글이 없는 글꼴을 골라도 문서는 망가지지 않는다: 엔진이 그 글꼴을 영문·숫자에만 쓴다(brand.prompt_block).
  const uploaded = [...new Set((kit.fonts ?? []).map((f) => f.family))].filter((f) => f !== DEFAULT_FONT);
  const pcFonts = fonts.filter((f) => f.family !== DEFAULT_FONT && !uploaded.includes(f.family));
  // 한 패밀리를 굵기별로 여러 번 올렸으면 언어를 합쳐 본다
  const kitLangs = (fam: string) => {
    const fs: BrandFont[] = (kit.fonts ?? []).filter((f) => f.family === fam);
    const set = [...new Set(fs.flatMap((f) => langsOf(f).split("·")))];
    return set.join("·");
  };
  // 사람이 직접 깐 글꼴 — 사용자 폴더에 깔렸거나(user) 윈도우 기본 글꼴 이름이 아닌 것(lib/windows-fonts.ts)
  const mine = (f: InstalledFont) => f.user || !WINDOWS_FONTS.has(f.family);
  const installed = pcFonts.filter(mine);
  const builtin = pcFonts.filter((f) => !mine(f));
  const known = new Set([DEFAULT_FONT, ...uploaded, ...pcFonts.map((f) => f.family)]);
  const others = local ? [...local.keys()].filter((f) => !known.has(f)).sort((a, b) => a.localeCompare(b, "ko")) : [];
  const opt = (f: InstalledFont) => <option key={f.family} value={f.family}>{f.family} ({langsOf(f)})</option>;
  const defaultLangs = langsOf(fonts.find((f) => f.family === DEFAULT_FONT) ?? { langs: ["한글", "영문"] });
  const fontSelect = (slot: "title_font" | "body_font") => {
    const cur = kit[slot] || DEFAULT_FONT;
    return (
      <select value={cur} onChange={(e) => setKit({ ...kit, [slot]: e.target.value === DEFAULT_FONT ? "" : e.target.value })}>
        <option value={DEFAULT_FONT}>{DEFAULT_FONT} (기본 · {defaultLangs})</option>
        {!known.has(cur) && !others.includes(cur) && <option value={cur}>{cur}</option>}
        {uploaded.length > 0 && (
          <optgroup label="키트에 올린 글꼴">
            {uploaded.map((f) => <option key={f} value={f}>{f} ({kitLangs(f)})</option>)}
          </optgroup>
        )}
        {installed.length > 0 && <optgroup label="이 PC에 설치한 글꼴">{installed.map(opt)}</optgroup>}
        {builtin.length > 0 && <optgroup label="윈도우 기본 글꼴">{builtin.map(opt)}</optgroup>}
        {others.length > 0 && (
          <optgroup label="내 컴퓨터에만 있는 글꼴 — 저장할 때 키트로 올림(가변 글꼴이면 거절)">
            {others.map((f) => <option key={f} value={f}>{f}</option>)}
          </optgroup>
        )}
      </select>
    );
  };

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
            <span className="note">제목 {saved.title_font || `${DEFAULT_FONT} (기본)`} · 본문 {saved.body_font || `${DEFAULT_FONT} (기본)`}</span>
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
          {fontSelect("title_font")}
        </label>
        <label className="bk_field">
          <b>본문 글꼴</b>
          {fontSelect("body_font")}
        </label>
      </div>
      <div className="bk_fonts">
        <b>글꼴 파일 올리기 <span className="note">(.ttf · .otf · .ttc — 한글·영문 글꼴 모두)</span></b>
        {(kit.fonts ?? []).length > 0 && (
          <ul className="bk_font_list">
            {(kit.fonts ?? []).map((f) => (
              <li key={f.name}>
                <b>{f.family}</b>{" "}
                <span className="note">{f.style} · {langsOf(f)} · {f.name} · {kb(f.bytes)}</span>
                <button type="button" className="ghost small" disabled={!!busy} onClick={() => void dropFont(f.name)}>빼기</button>
              </li>
            ))}
          </ul>
        )}
        <div className="bk_local">
          <button type="button" className="ghost small" disabled={!!busy} onClick={() => void refreshFonts()}>
            글꼴 목록 새로 불러오기
          </button>
          {localState === "prompt" && (
            <button type="button" className="ghost small" disabled={!!busy} onClick={() => void loadLocal()}>
              이 컴퓨터 글꼴 불러오기
            </button>
          )}
          {localState === "denied" && (
            <span className="note">이 컴퓨터 글꼴을 읽는 권한이 막혀 있습니다. 주소창 왼쪽 자물쇠 → 사이트 설정 → 글꼴에서 허용하면 불러옵니다.</span>
          )}
          {localState === "unsupported" && (
            <span className="note">이 브라우저는 내 컴퓨터 글꼴을 읽지 못합니다(크롬·엣지에서 됩니다). 글꼴 파일을 올려 주세요.</span>
          )}
        </div>
        <input type="file" accept=".ttf,.otf,.ttc"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void addFont(f); e.target.value = ""; }} />
        <p className="note">
          올린 글꼴은 이 PC에 깔지 않고, 문서를 만들 때 그 문서 옆 <code>Document Fonts</code> 폴더에만 둡니다.
          굵기마다 파일이 따로라 굵게 쓸 거면 Bold 파일도 올려 주세요. 가변 글꼴(굵기가 한 파일에 든 것)은 받지 않습니다.
          글꼴 이름 옆 괄호는 그 글꼴이 그리는 글자입니다. 한글이 없는 글꼴은 영문·숫자로 된 글(영문 제목·전화번호·이메일 등)에만 쓰고, 한글은 다른 글꼴로 짭니다.
          아무것도 고르지 않으면 맑은 고딕으로 만듭니다.
        </p>
      </div>

      <div className="bk_colors">
        <b>색 <span className="note">(CMYK · 0~100 · 첫 색이 주된 색 · 네모를 누르면 색 고르기 창)</span></b>
        {kit.colors.length === 0 && <p className="note">아직 등록한 색이 없습니다.</p>}
        {kit.colors[0] && kit.colors[0].c + kit.colors[0].m + kit.colors[0].y + kit.colors[0].k === 0 && (
          <p className="err">첫 색(주된 색)이 C0 M0 Y0 K0, 곧 흰색입니다. 주된 색은 제목·띠·강조에 쓰여서 흰 종이에서는 보이지 않습니다.</p>
        )}
        {kit.colors.map((c, i) => (
          // 이름 줄과 CMYK 줄을 나눠 둔다. 넓은 화면에서는 두 묶음이 한 줄로 이어지고(display: contents),
          // 폰에서는 이름·빼기 한 줄, C·M·Y·K 한 줄로 갈린다 — 안 나누면 K만 다음 줄로 떨어졌다.
          <div className="bk_color" key={i}>
            <div className="bk_chead">
              <input type="color" className="bk_picker" value={toHex(c)} aria-label={`${c.name} 색 고르기`}
                title="눌러서 화면 색으로 고르기 — CMYK로 어림 변환합니다"
                onChange={(e) => setColor(i, fromHex(e.target.value))} />
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
          <button type="button" className="ghost small" onClick={addColor}>색 등록하기</button>
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
