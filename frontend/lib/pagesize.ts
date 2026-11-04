// 고른 PDF에서 완성 크기와 도련을 바로 읽는다. 검사를 시작하기 전, 파일을 고른 순간에 돈다.
//
// 왜 — 가로·세로·도련은 전부 사람이 손으로 적는 칸이었다. 그런데 그 값은 이미 파일 안에 있다.
// 손으로 적으면 오타 한 번에 "페이지 크기가 설정과 다름"이 모든 쪽에 뜨고, 사람은 파일을 의심한다.
//
// 어디서 읽나 — TrimBox가 **재단 후 완성 크기**다. 있으면 그것을 쓰고, 도련은 MediaBox와
// TrimBox 사이에 남은 폭에서 가장 좁은 쪽으로 잡는다(사방이 다르게 들어간 파일도 있다).
// TrimBox가 없으면 MediaBox를 완성 크기로 보고 도련은 모른다고 답한다 — 이때 MediaBox에
// 도련이 섞여 있으면 완성 크기가 사방 3mm씩 커 보이는데, 그 사실을 화면에 적어 사람이 고치게 한다.
//
// 라이브러리는 pdf-lib만 쓴다. pdf.js는 worker를 띄워야 하는데, 파일을 고를 때마다 그 비용을
// 치를 이유가 없다(검사 때는 어차피 둘 다 쓴다).
import { PDFDocument } from "pdf-lib";

const MM = 72 / 25.4;
const round = (pt: number) => Math.round((pt / MM) * 10) / 10;

export type Measured = {
  widthMm: number;        // 완성 크기 가로(파일에 적힌 그대로. 가로로 누운 파일이면 긴 쪽이 가로다)
  heightMm: number;
  bleedMm: number | null; // TrimBox가 없으면 null(모른다)
  from: "TrimBox" | "MediaBox";
  pages: number;
  mixed: boolean;         // 쪽마다 크기가 다른가(표지와 본문이 한 파일에 섞인 경우)
};

/** 1쪽을 기준으로 완성 크기·도련을 읽는다. PDF가 아니거나 열 수 없으면 null(조용히 포기하고 손 입력으로 둔다). */
export async function measure(file: File): Promise<Measured | null> {
  try {
    const doc = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()),
      { ignoreEncryption: true, updateMetadata: false });
    const pages = doc.getPages();
    if (!pages.length) return null;
    const p = pages[0];
    const media = p.getMediaBox();
    const trim = p.node.TrimBox()?.asRectangle() ?? null;
    const box = trim ?? media;
    // 쪽마다 완성 크기가 다르면 1쪽 값을 전체에 적용하는 것이 틀릴 수 있다. 숨기지 않고 알린다
    const sizeOf = (i: number) => {
      const q = pages[i];
      const r = q.node.TrimBox()?.asRectangle() ?? q.getMediaBox();
      return `${round(r.width)}x${round(r.height)}`;
    };
    const first = sizeOf(0);
    const mixed = pages.some((_, i) => sizeOf(i) !== first);
    let bleedMm: number | null = null;
    if (trim) {
      const gap = Math.min(trim.x - media.x, trim.y - media.y,
        media.x + media.width - (trim.x + trim.width),
        media.y + media.height - (trim.y + trim.height));
      bleedMm = Math.max(0, Math.round((gap / MM) * 10) / 10);
    }
    return { widthMm: round(box.width), heightMm: round(box.height), bleedMm,
      from: trim ? "TrimBox" : "MediaBox", pages: pages.length, mixed };
  } catch {
    return null; // 암호가 걸렸거나 깨진 파일. 검사 단계에서 제대로 된 오류를 낸다
  }
}
