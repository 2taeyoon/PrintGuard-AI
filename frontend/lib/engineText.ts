// 엔진 명령을 사람이 읽는 말로 옮긴다.
//
// `swatch.create`·`type.char`는 인디자인을 아는 사람에게도 화면에서는 암호다. 그래서 **하는 일**로
// 적는다. 명령 이름은 지우지 않고 작게 옆에 남긴다 — 실제로 무엇이 돌았는지 보고 싶은 사람이 있고,
// 숨기면 '알 수 없는 다섯 가지'가 된다.
//
// 한 가지 더: 엔진에서 **글 하나를 넣는 일은 명령 세 개**다(상자 만들기 → 글자 모양 → 글 넣기).
// 그것을 세 줄로 적으면 '5가지'가 '글 하나 + 색 둘'이라는 것이 안 보인다. 그래서 한 묶음으로
// 합쳐 센다. 엔진에 보내는 명령 자체는 그대로다(합치는 것은 화면뿐이다).
//
// 이 자리에 따로 두는 이유. 만드는 화면과 지켜보는 화면이 같은 말로 적어야 한다 — 한쪽에서는
// '글 넣기'이고 다른 쪽에서는 `text.insert`이면, 같은 일을 두 번 배워야 한다.

import type { EngineStep } from "./agentClient";

const MM = 72 / 25.4;
const mm = (v: unknown) => (typeof v === "number" ? Math.round(v / MM) : null);

/** 어디에 놓는지. 엔진은 pt로 말하지만 쓰는 사람은 mm로 센다. */
const place = (p: Record<string, unknown>) => {
  const r = Array.isArray(p.rect) ? (p.rect as number[]).map((v) => Math.round(v / MM)) : null;
  const pg = typeof p.spread === "number" ? `${p.spread + 1}쪽` : null;
  const at = r && r.length === 4 ? `왼쪽에서 ${r[0]}mm, 위에서 ${r[1]}mm 자리에 ${r[2] - r[0]}×${r[3] - r[1]}mm`
    : typeof p.x === "number" ? `왼쪽에서 ${mm(p.x)}mm, 위에서 ${mm(p.y)}mm 자리에` : null;
  return [pg, at].filter(Boolean).join(" · ");
};

const font = (p: Record<string, unknown>) => {
  const a = (p.attrs ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof a.fontFamily === "string") bits.push(String(a.fontFamily));
  if (typeof a.size === "number") bits.push(`${a.size}pt`);
  if (a.fontStyle === "Bold" || a.fontStyle === "bold") bits.push("굵게");
  if (typeof a.fill === "string") bits.push(`${a.fill} 색`);
  return bits.join(" ");
};

const quote = (t: unknown, n = 30) =>
  typeof t === "string" && t ? `“${t.replace(/\n/g, " ").slice(0, n)}${t.length > n ? "…" : ""}”` : "";

/** 화면에 보여 줄 한 줄. `cmds`에는 합쳐진 명령 이름들이, `idx`에는 **합쳐진 명령이 원래 몇
 *  번째였는지**가 들어간다. 뒤쪽(엔진이 돌려준 결과)을 그 줄에 다시 붙이려면 그게 필요하다. */
export type Row = { what: string; detail: string; cmds: string[]; idx: number[] };

const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

/** 엔진 명령 묶음을 사람이 읽는 줄로. 글 하나를 넣는 세 명령은 한 줄로 합친다. */
export function readable(steps: EngineStep[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < steps.length; i++) {
    const c = steps[i];
    const i0 = i;
    const p = (c.params ?? {}) as Record<string, unknown>;

    // 글상자 + 글자 모양 + 글 넣기 → 한 줄
    if (c.command === "frame.create" && p.content === "text") {
      const cmds = [c.command];
      let look = "", text = "";
      while (i + 1 < steps.length && (steps[i + 1].command === "type.char" || steps[i + 1].command === "text.insert"
        || steps[i + 1].command === "type.para")) {
        const nx = steps[++i];
        cmds.push(nx.command);
        const np = (nx.params ?? {}) as Record<string, unknown>;
        if (nx.command === "type.char") look = font(np);
        if (nx.command === "text.insert") text = String(np.text ?? "");
      }
      rows.push({
        what: text ? `글 넣기 ${quote(text)}` : "글상자 놓기",
        detail: [place(p), look].filter(Boolean).join(" · "),
        cmds, idx: span(i0, i),
      });
      continue;
    }

    // 도형 + 색 채우기 + 테두리 → 한 줄
    if (c.command === "frame.create") {
      const cmds = [c.command];
      const shape = p.shape === "ellipse" ? "동그라미" : p.shape === "polygon" ? "다각형" : "사각형";
      let fill = "";
      while (i + 1 < steps.length && (steps[i + 1].command === "object.fill" || steps[i + 1].command === "object.stroke")) {
        const nx = steps[++i];
        cmds.push(nx.command);
        const np = (nx.params ?? {}) as Record<string, unknown>;
        if (nx.command === "object.fill" && typeof np.swatch === "string") fill = `${np.swatch} 색으로 채우기`;
        if (nx.command === "object.stroke") fill = fill ? `${fill} · 테두리` : "테두리 넣기";
      }
      const what = p.content === "graphic" ? "사진 자리 비우기" : `${shape} 그리기`;
      rows.push({ what, detail: [place(p), fill].filter(Boolean).join(" · "), cmds, idx: span(i0, i) });
      continue;
    }

    const one = (what: string, detail = "") => rows.push({ what, detail, cmds: [c.command], idx: [i0] });
    switch (c.command) {
      case "swatch.create": one("색 준비", String(p.name ?? "")); break;
      case "file.place": one("사진 넣기", [place(p), typeof p.width === "number" ? `폭 ${mm(p.width)}mm` : ""].filter(Boolean).join(" · ")); break;
      case "line.create": one("선 그리기", typeof p.spread === "number" ? `${p.spread + 1}쪽` : ""); break;
      case "table.insert": one("표 넣기", `${p.rows ?? "?"}줄 ${p.cols ?? p.columns ?? "?"}칸`); break;
      case "layout.pages.insert": one("쪽 늘리기", `${p.count ?? 1}쪽`); break;
      case "layout.marginsAndColumns": one("여백·단 바꾸기", p.columns ? `${p.columns}단` : ""); break;
      case "object.qrCode": one("QR 코드 넣기", place(p)); break;
      case "style.paragraph.create": one("글 모양 모음 만들기", String(p.name ?? "")); break;
      case "style.paragraph.apply": one("글 모양 모음 입히기", String(p.name ?? "")); break;
      case "style.character.create": one("글자 모양 모음 만들기", String(p.name ?? "")); break;
      case "type.char": one("글자 모양 정하기", font(p)); break;
      case "type.para": one("문단 모양 정하기"); break;
      case "text.insert": one("글 넣기", quote(p.text)); break;
      case "object.fill": one("색 채우기", String(p.swatch ?? "")); break;
      case "object.stroke": one("테두리 넣기"); break;
      case "type.fillWithPlaceholder": one("임시 글로 채우기"); break;
      case "text.thread": one("글상자 잇기"); break;
      case "toc.generate": one("목차 만들기"); break;
      case "variables.define": one("자동 글 만들기", String(p.name ?? "")); break;
      case "variables.insert": one("자동 글 넣기", String(p.name ?? "")); break;
      case "layer.new": one("층 만들기", String(p.name ?? "")); break;
      case "transform.move": one("옮기기"); break;
      case "transform.scale": one("크기 바꾸기"); break;
      case "transform.rotate": one("돌리기"); break;
      case "object.arrange": one("앞뒤 순서 바꾸기"); break;
      case "table.setCell": one("표 칸 꾸미기"); break;
      default: one(c.command); break;
    }
  }
  return rows;
}
