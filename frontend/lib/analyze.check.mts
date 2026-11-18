// 인쇄 사고 검사(잉크·선·별색·PDF/X)와 표기 통일 시험.
//   cd frontend && npx tsx lib/analyze.check.mts
// 사고 하나마다 그 사고만 든 PDF를 직접 만들어 넣고, **잡아야 할 것만 잡는지** 본다.
// 깨끗한 샘플(samples/clean_a5_bleed.pdf)에서 새 검사가 아무것도 내지 않는지도 본다 — 헛경보가 늘면
// 사람은 경고를 안 읽게 되고, 그러면 진짜 사고도 같이 묻힌다.
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  PDFDict, PDFDocument, PDFName, PDFNumber, PDFOperator, StandardFonts, cmyk, rgb,
  fill, popGraphicsState, pushGraphicsState, rectangle, setFillingCmykColor, setGraphicsState,
} from "pdf-lib";
import { analyze, checkText, type Issue } from "./analyze";
import { inspectInk } from "./inkcheck";
import { DEFAULT_SPEC } from "./printspec";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  if (cond) console.log(`✓ ${name}`);
  else { console.log(`✗ ${name}${got !== undefined ? `\n   받음: ${JSON.stringify(got)}` : ""}`); fail++; }
};
const MM = 72 / 25.4;
const A5: [number, number] = [148 * MM, 210 * MM];
const kinds = (xs: Issue[]) => xs.map((i) => i.kind);
const NEW_KINDS = ["richblack", "rgbblack", "tac", "overprint", "registration", "hairline", "rgbvector", "spot", "pdfx", "transparency"];

async function run(build: (doc: PDFDocument) => Promise<void> | void, spec = {}) {
  const doc = await PDFDocument.create();
  await build(doc);
  const bytes = await doc.save();
  return (await analyze(bytes, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 0, misuse: false, spec })).issues;
}
const op = (name: string, ...args: unknown[]) => PDFOperator.of(name as never, args as never);

function colorSpaces(doc: PDFDocument, page: ReturnType<PDFDocument["addPage"]>) {
  const res = page.node.Resources()!;
  let csd = res.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  if (!csd) { csd = doc.context.obj({}); res.set(PDFName.of("ColorSpace"), csd); }
  return csd;
}
function separation(doc: PDFDocument, name: string) {
  const fn = doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 1, 0], N: 1 });
  return doc.context.obj([PDFName.of("Separation"), PDFName.of(name), PDFName.of("DeviceCMYK"), doc.context.register(fn)]);
}

/** 아주 작은 RGB PNG(w×h, 회색). 사진 해상도 시험용 — 외부 파일 없이 만든다. */
function png(w: number, h: number): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 128); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

// ---------- 1. 작은 리치 블랙 글자 / K100 글자 ----------
{
  const xs = await run(async (doc) => {
    const f = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage(A5);
    p.drawText("Rich black body text", { x: 40, y: 400, size: 8, font: f, color: cmyk(0.6, 0.5, 0.5, 1) });
    p.drawText("Plain black body text", { x: 40, y: 380, size: 8, font: f, color: cmyk(0, 0, 0, 1) });
    p.drawText("BIG TITLE", { x: 40, y: 300, size: 36, font: f, color: cmyk(0.6, 0.5, 0.5, 1) }); // 큰 제목의 리치 블랙은 일부러 쓴 것
  });
  const rb = xs.filter((i) => i.kind === "richblack");
  ok("작은 리치 블랙 글자를 잡는다(한 쪽 한 항목)", rb.length === 1, kinds(xs));
  ok("…큰 제목은 세지 않는다(1곳)", !!rb[0] && rb[0].detail.includes("1곳"), rb[0]?.detail);
  ok("…글자 크기와 색 값을 제목에 적는다", !!rb[0] && rb[0].title.includes("8.0pt") && rb[0].title.includes("C60 M50 Y50 K100"), rb[0]?.title);
  ok("…자리를 쪽 위에 표시한다(큰 제목은 네모에 들지 않는다)", !!rb[0]?.rect && rb[0].rect[1] > 0 && rb[0].rect[3] < A5[1] - 380, rb[0]?.rect);
  ok("리치 블랙 글자 210%는 잉크량 한도(300%) 안이다", !xs.some((i) => i.kind === "tac"), kinds(xs));
}

// ---------- 2. RGB 검정 작은 글자 ----------
{
  const xs = await run(async (doc) => {
    const f = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage(A5).drawText("rgb black", { x: 40, y: 400, size: 9, font: f, color: rgb(0, 0, 0) });
  });
  ok("RGB 검정 작은 글자를 잡는다", kinds(xs).includes("rgbblack"), kinds(xs));
  ok("…규격이 X-1a가 아니면 'RGB 면' 경고는 내지 않는다", !kinds(xs).includes("rgbvector"), kinds(xs));
  const x1a = await run(async (doc) => {
    const f = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage(A5).drawText("rgb black", { x: 40, y: 400, size: 9, font: f, color: rgb(0, 0, 0) });
  }, { pdfx: "X-1a" });
  ok("X-1a 규격이면 RGB로 칠한 글자를 막힘으로 본다", x1a.some((i) => i.kind === "rgbvector" && i.severity === "high"), kinds(x1a));
  ok("X-1a 규격인데 PDF/X로 내보내지 않았으면 알린다", x1a.some((i) => i.kind === "pdfx"), kinds(x1a));
}

// ---------- 3. 면 잉크량 초과 ----------
{
  const xs = await run((doc) => { doc.addPage(A5).drawRectangle({ x: 20, y: 20, width: 200, height: 100, color: cmyk(1, 1, 1, 1) }); });
  const t = xs.find((i) => i.kind === "tac");
  ok("400% 면을 잡는다", !!t, kinds(xs));
  ok("…한도보다 20%p 넘게 넘으면 '높음'", t?.severity === "high", t?.severity);
  ok("…최대 잉크량을 제목에 적는다", !!t && t.title.includes("400%"), t?.title);
  const lim = await run((doc) => { doc.addPage(A5).drawRectangle({ x: 20, y: 20, width: 200, height: 100, color: cmyk(1, 1, 1, 1) }); }, { tacLimit: 400 });
  ok("규격의 한도를 따른다(한도 400%면 통과)", !lim.some((i) => i.kind === "tac"), kinds(lim));
}

// ---------- 4. 흰색 오버프린트 ----------
{
  const xs = await run((doc) => {
    const p = doc.addPage(A5);
    p.drawRectangle({ x: 20, y: 20, width: 300, height: 300, color: cmyk(0, 1, 0, 0) });
    const gs = p.node.newExtGState("GS", doc.context.register(doc.context.obj({ Type: "ExtGState", OP: true, op: true, OPM: 1 })));
    p.pushOperators(pushGraphicsState(), setGraphicsState(gs), setFillingCmykColor(0, 0, 0, 0), rectangle(50, 50, 100, 30), fill(), popGraphicsState());
  });
  const o = xs.find((i) => i.kind === "overprint");
  ok("흰색 오버프린트를 잡는다", !!o && o.severity === "high", kinds(xs));
  const plain = await run((doc) => {
    const p = doc.addPage(A5);
    p.drawRectangle({ x: 20, y: 20, width: 300, height: 300, color: cmyk(0, 1, 0, 0) });
    p.drawRectangle({ x: 50, y: 50, width: 100, height: 30, color: cmyk(0, 0, 0, 0) }); // 오버프린트 없는 흰 면은 정상
  });
  ok("오버프린트 없는 흰 면은 잡지 않는다", !plain.some((i) => i.kind === "overprint"), kinds(plain));
}

// ---------- 5. 가는 선 ----------
{
  const xs = await run((doc) => {
    const p = doc.addPage(A5);
    p.drawLine({ start: { x: 20, y: 100 }, end: { x: 300, y: 100 }, thickness: 0.1, color: cmyk(0, 0, 0, 1) });
    p.drawLine({ start: { x: 20, y: 200 }, end: { x: 300, y: 200 }, thickness: 1, color: cmyk(0, 0, 0, 1) });
  });
  const h = xs.filter((i) => i.kind === "hairline");
  ok("0.25pt보다 가는 선을 잡는다(굵은 선은 빼고)", h.length === 1 && h[0].title.includes("0.10pt") && h[0].detail.includes("1곳"), h.map((i) => [i.title, i.detail]));
  const zero = await run((doc) => {
    const p = doc.addPage(A5);
    p.pushOperators(op("w", PDFNumber.of(0)), setFillingCmykColor(0, 0, 0, 1), op("K", PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(1)),
      op("m", PDFNumber.of(20), PDFNumber.of(50)), op("l", PDFNumber.of(300), PDFNumber.of(50)), op("S"));
  });
  ok("두께 0인 선은 따로 말한다", zero.some((i) => i.kind === "hairline" && i.title === "두께 0인 선" && i.severity === "medium"), zero.map((i) => i.title));
}

// ---------- 6. 레지스트레이션 색, 별색 이름 중복 ----------
{
  const xs = await run((doc) => {
    const p = doc.addPage(A5);
    const csd = colorSpaces(doc, p);
    csd.set(PDFName.of("CSall"), separation(doc, "All"));
    csd.set(PDFName.of("CSa"), separation(doc, "PANTONE 185 C"));
    csd.set(PDFName.of("CSb"), separation(doc, "Pantone 185 C"));
    p.pushOperators(op("cs", PDFName.of("CSall")), op("scn", PDFNumber.of(1)), rectangle(30, 30, 50, 50), fill(),
      op("cs", PDFName.of("CSa")), op("scn", PDFNumber.of(1)), rectangle(100, 30, 50, 50), fill());
  });
  ok("레지스트레이션 색을 잡는다", xs.some((i) => i.kind === "registration" && i.severity === "high"), kinds(xs));
  const sp = xs.find((i) => i.kind === "spot");
  ok("대소문자만 다른 별색 이름을 하나로 묶어 알린다", !!sp && sp.title.includes("PANTONE 185 C") && sp.title.includes("Pantone 185 C"), sp?.title);
  ok("레지스트레이션 'All'은 별색 목록에 넣지 않는다", !!sp && !sp.title.includes("'All'"), sp?.title);
}

// ---------- 7. 안 보이는 글자(스캔 PDF의 OCR 층) ----------
{
  const xs = await run(async (doc) => {
    const f = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage(A5);
    p.pushOperators(op("Tr", PDFNumber.of(3)));
    p.drawText("invisible ocr layer", { x: 40, y: 400, size: 8, font: f, color: cmyk(0.6, 0.5, 0.5, 1) });
  });
  ok("안 보이는 글자(Tr 3)는 잉크가 없으므로 세지 않는다", !xs.some((i) => i.kind === "richblack"), kinds(xs));
}

// ---------- 8. 저해상도 사진: 고치지 않고 숫자를 준다 ----------
{
  const xs = await run(async (doc) => {
    const im = await doc.embedPng(png(120, 80));
    doc.addPage(A5).drawImage(im, { x: 20, y: 300, width: 100 * MM, height: (100 * 80 / 120) * MM });
  });
  const r = xs.find((i) => i.kind === "resolution");
  ok("저해상도 사진을 잡는다", !!r, kinds(xs));
  ok("…자리 크기와 유효 해상도를 적는다(100mm에 120px ≈ 30ppi)", !!r && r.detail.includes("100×67mm") && r.title.includes("30ppi"), [r?.title, r?.detail]);
  const need = r?.advice?.find((a) => a.label.includes("필요한 원본"))?.value;
  ok("…이 자리에 필요한 원본 px를 준다(300ppi면 1182×788px)", need === "1182×788px 이상", r?.advice);
  const max = r?.advice?.find((a) => a.label.includes("키울 수 있는"))?.value;
  ok("…지금 사진으로 키울 수 있는 크기를 준다(120px → 300ppi 10mm, 150ppi 20mm)", max === "권장 10mm · 최소 기준 20mm까지", r?.advice);
  ok("…줄여서 맞추라고 하지 않는다", !!r && !r.fix.includes("크기를 줄이세요"), r?.fix);
  const big = await run(async (doc) => {
    const im = await doc.embedPng(png(120, 80));
    doc.addPage(A5).drawImage(im, { x: 20, y: 300, width: 100 * MM, height: 67 * MM });
  }, { minPpi: 20, goodPpi: 30 });
  ok("규격의 최소 해상도를 따른다(대형 출력처럼 기준이 낮으면 통과)", !big.some((i) => i.kind === "resolution"), kinds(big));
  const x1a = await run(async (doc) => {
    const im = await doc.embedPng(png(120, 80));
    doc.addPage(A5).drawImage(im, { x: 20, y: 300, width: 100 * MM, height: 67 * MM });
  }, { pdfx: "X-1a" });
  ok("X-1a 규격이면 RGB 사진을 막힘으로 본다", x1a.some((i) => i.kind === "pdfx" && i.severity === "high" && i.title.includes("RGB 사진")), x1a.map((i) => i.title));
}

// ---------- 8-1. 글자 문제의 자리: 글꼴 폭 표로 잰다 ----------
{
  // 기준은 화면이 실제로 그리는 pdf.js의 글줄 폭이다. pdf-lib의 widthOfTextAtSize는 커닝을 넣어 재지만
  // drawText가 쓰는 Tj에는 커닝이 없어서, 그것과 대면 0.6pt가 어긋난다(처음에 그렇게 잘못 쟀다).
  const d0 = await PDFDocument.create();
  const f0 = await d0.embedFont(StandardFonts.Helvetica);
  d0.addPage(A5).drawText("Rich black body text", { x: 40, y: 400, size: 8, font: f0, color: cmyk(0.6, 0.5, 0.5, 1) });
  const bytes = await d0.save();
  const tc = await (await (await pdfjs.getDocument({ data: bytes.slice() }).promise).getPage(1)).getTextContent();
  const want = (tc.items as { width: number }[])[0].width;
  const r = (await analyze(bytes, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 0, misuse: false })).issues.find((i) => i.kind === "richblack")?.rect;
  ok(`표준 글꼴: 네모의 왼쪽이 글줄 시작(40pt)이다`, !!r && Math.abs(r[0] - 40) < 0.01, r);
  ok(`표준 글꼴: 네모의 폭이 글줄 폭(${want.toFixed(1)}pt)과 같다`, !!r && Math.abs(r[2] - r[0] - want) < 0.05, r && r[2] - r[0]);

  // 2바이트 글꼴(Type0, 한글 글꼴 대부분): 폭은 자손 글꼴의 /W와 /DW에서 온다. 글꼴 파일 없이 사전만 만들어 잰다
  async function type0(ops: string) {
    const doc = await PDFDocument.create();
    const p = doc.addPage(A5);
    const cid = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: "Test", DW: 1000, W: [1, [1000, 500]] }));
    const f0 = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "Test", Encoding: "Identity-H", DescendantFonts: [cid] }));
    const res = p.node.Resources()!;
    res.set(PDFName.of("Font"), doc.context.obj({ F1: f0 }));
    p.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(`BT 0.6 0.5 0.5 1 k /F1 10 Tf ${ops} ET`)));
    const back = await PDFDocument.load(await doc.save());
    const rb = inspectInk(back, { tacLimit: 300, minLinePt: 0.25, richBlackMaxPt: 12 }).findings.find((x) => x.kind === "richblack");
    return rb ? rb.rect[2] - rb.rect[0] : NaN;
  }
  ok("Type0: 두 글자(폭 1000·500) 10pt = 15pt", Math.abs(await type0("1 0 0 1 100 100 Tm <00010002> Tj") - 15) < 0.01);
  ok("Type0: 표에 없는 글자는 기본 폭(DW 1000)으로 = 10pt", Math.abs(await type0("1 0 0 1 100 100 Tm <0009> Tj") - 10) < 0.01);
  ok("글자 간격(Tc 2)·가로 비율(Tz 50)을 반영한다 = (10+2)×0.5 + (5+2)×0.5 = 9.5pt",
    Math.abs(await type0("2 Tc 50 Tz 1 0 0 1 100 100 Tm <00010002> Tj") - 9.5) < 0.01);
  ok("TJ의 조정값(-500 = 글자 크기의 절반만큼 띄움)을 반영한다 = 10 + 5 + 5 = 20pt",
    Math.abs(await type0("1 0 0 1 100 100 Tm [<0001> -500 <0002>] TJ") - 20) < 0.01);
  ok("q/Q는 글자 상태도 되돌린다(q 안의 Tc 5는 Q 뒤에 사라져 15pt)",
    Math.abs(await type0("q 5 Tc Q 1 0 0 1 100 100 Tm <00010002> Tj") - 15) < 0.01);
  ok("이어 찍은 글자는 앞 글자 끝에서 시작한다(한 네모로 묶여 15+15 = 30pt)",
    Math.abs(await type0("1 0 0 1 100 100 Tm <00010002> Tj <00010002> Tj") - 30) < 0.01);
}

// ---------- 9. 깨끗한 샘플: 새 검사가 헛경보를 내지 않는다 ----------
for (const f of ["clean_a5_bleed", "typo_a5"]) {
  const data = new Uint8Array(readFileSync(`../samples/${f}.pdf`));
  const r = await analyze(data, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 3, misuse: false });
  const extra = r.issues.filter((i) => NEW_KINDS.includes(i.kind));
  ok(`${f}.pdf: 새 인쇄 검사 헛경보 0건`, extra.length === 0, extra.map((i) => i.title));
}
{
  const data = new Uint8Array(readFileSync("../samples/defective_a5.pdf"));
  const r = await analyze(data, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 3, misuse: false });
  console.log("  (참고) defective_a5.pdf 새 검사:", r.issues.filter((i) => NEW_KINDS.includes(i.kind)).map((i) => i.title));
  const base = await analyze(data, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 3, misuse: false, spec: DEFAULT_SPEC });
  ok("기본 규격을 넘겨도 넘기지 않은 것과 결과가 같다", JSON.stringify(base.issues.map((i) => i.title)) === JSON.stringify(r.issues.map((i) => i.title)));
}

// ---------- 10. 표기 통일 ----------
{
  const t = (pages: string[], terms?: { wrong: string; right: string }[]) => checkText(pages, { terms });
  const sp = t(["웹사이트를 열고 회원 가입을 합니다.", "웹 사이트를 닫습니다. 웹사이트에서 받은 파일"]).filter((i) => i.kind === "consistency");
  ok("붙여 쓴 '웹사이트'와 띄어 쓴 '웹 사이트'를 같은 말로 묶는다", sp.some((i) => i.title.includes("'웹사이트' 2번") && i.title.includes("'웹 사이트' 1번")), sp.map((i) => i.title));
  ok("…띄어 쓴 쪽이 있는 쪽을 가리킨다", sp.find((i) => i.title.includes("웹사이트"))?.page === 2, sp.map((i) => [i.title, i.page]));
  ok("…자동 수정하지 않는다(어느 쪽이 맞는지는 사람이 정한다)", sp.every((i) => !i.edit), sp);
  const un = t(["무게 10kg, 두께 3 mm, 폭 5mm, 할인 10% 와 20 %"]).filter((i) => i.kind === "consistency");
  ok("숫자·단위 사이 띄어쓰기가 섞이면 단위마다 알린다(mm, %)", un.length === 2 && un.some((i) => i.title.includes("mm")) && un.some((i) => i.title.includes("%")), un.map((i) => i.title));
  const en = t(["InDesign으로 열고 Indesign을 닫는다. Print와 print는 문장 첫 글자 차이"]).filter((i) => i.kind === "consistency");
  ok("영문 대소문자가 섞이면 알리되 첫 글자만 다른 것은 뺀다", en.length === 1 && en[0].title.includes("InDesign") && en[0].title.includes("Indesign"), en.map((i) => i.title));
  ok("섞이지 않은 문서는 조용하다", t(["웹사이트를 열고 웹사이트를 닫는다. 10mm와 20mm."]).filter((i) => i.kind === "consistency").length === 0);
  const house = t(["우리 어플로 주문하세요. 어플 설치"], [{ wrong: "어플", right: "앱" }]).filter((i) => i.title.includes("브랜드 키트"));
  ok("브랜드 키트 표기는 찾아 바꿀 짝까지 만든다", house.length === 1 && house[0].edit?.original === "어플" && house[0].edit?.suggestion === "앱" && house[0].detail.includes("2번"), house);
  const inside = t(["웹사이트와 사이트"], [{ wrong: "사이트", right: "웹사이트" }]).filter((i) => i.title.includes("브랜드 키트"));
  ok("이미 맞게 쓴 곳('웹사이트' 안의 '사이트')은 세지 않는다", inside.length === 1 && !inside[0].detail.includes("번)"), inside.map((i) => i.detail));
  ok("에이전트 검사(misuse 끔)에서는 브랜드 표기를 두 번 내지 않는다(교정 에이전트가 맡는다)",
    checkText(["어플"], { misuse: false, terms: [{ wrong: "어플", right: "앱" }] }).every((i) => !i.title.includes("브랜드 키트")));
}

console.log(fail ? `\n실패 ${fail}건` : "\n모두 통과");
process.exit(fail ? 1 : 0);
