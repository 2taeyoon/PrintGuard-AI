// 검수 결과 ↔ 교정 목록. 화면 1에서 만들고(복사), 화면 2에서 다시 읽는다(붙여넣기).
// 두 화면이 같은 파일을 쓴다 — 형식이 갈리면 붙여넣기가 조용히 깨진다.
//
// 사람이 눈으로 읽고 손으로 고칠 수 있어야 해서 JSON이 아니라 줄 단위로 둔다.
//   3 | 넓이 | 너비
// `#`로 시작하는 줄과 빈 줄은 설명이라 건너뛴다. 본문에 `|`가 들어가면 `\|`로 적는다.

import type { Issue } from "./analyze";

export type Fix = { page: number | null; original: string; suggestion: string; key?: string };

const ESC = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();

/** `\|`는 글자 그대로의 `|`다. 그 자리에서 풀어야 칸 나누기와 안 헷갈린다. */
function splitCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length && (line[i + 1] === "|" || line[i + 1] === "\\")) {
      cur += line[++i];
    } else if (c === "|") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** 검수 결과 → 붙여넣기용 글. 고칠 수 있는 것과 사람이 봐야 하는 것을 나눠 적는다. */
export function buildFixText(issues: Issue[], opts: { filename?: string; mode?: string } = {}): string {
  const editable = issues.filter((i) => i.edit?.original && i.edit.suggestion);
  const manual = issues.filter((i) => !(i.edit?.original && i.edit.suggestion));
  const when = new Date().toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
  const L = [
    "# PrintGuard 검수 결과",
    `# ${opts.filename ?? "(파일명 없음)"} · ${when}${opts.mode ? ` · ${opts.mode}` : ""}`,
    "# 아래 '쪽 | 원래 내용 | 수정할 내용' 줄을 인디자인 원본 수정 화면에 그대로 붙여 넣으세요.",
    "",
  ];
  if (editable.length) {
    for (const i of editable) L.push(`${i.page || ""} | ${ESC(i.edit!.original)} | ${ESC(i.edit!.suggestion)}`);
  } else {
    L.push("# (자동으로 고칠 수 있는 항목이 없습니다)");
  }
  if (manual.length) {
    L.push("", `# ─── 사람이 보고 판단할 항목 ${manual.length}건 (자동으로 못 고칩니다) ───`);
    for (const i of manual) {
      const sev = { high: "높음", medium: "보통", low: "낮음" }[i.severity] ?? i.severity;
      L.push(`# ${i.page ? `${i.page}쪽 ` : ""}[${sev}] ${i.title.replace(/[\r\n]+/g, " ")}`);
    }
  }
  return L.join("\n") + "\n";
}

const SEV_KO: Record<string, string> = { high: "인쇄 위험", medium: "수정 권장", low: "확인 필요" };
const SRC_KO: Record<string, string> = { rule: "규칙", heuristic: "휴리스틱", proofread: "교정" };

/** 검수 카드를 사람이 읽을 글로. 메일이나 메모에 그대로 붙여 쓰라고 만든다.
 *  기계용 교정 목록(buildFixText)과 쓰임이 다르다 — 이쪽은 설명과 수정 제안까지 다 담는다. */
export function buildReportText(
  issues: Issue[],
  opts: { filename?: string; pages?: number; mode?: string } = {},
): string {
  const when = new Date().toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
  const n = (s: string) => issues.filter((i) => i.severity === s).length;
  const L = [
    `[PrintGuard 인쇄 검수] ${opts.filename ?? "(파일명 없음)"}${opts.pages ? ` · ${opts.pages}쪽` : ""}`,
    `${when}${opts.mode ? ` · ${opts.mode}` : ""}`,
    `인쇄 위험 ${n("high")} · 수정 권장 ${n("medium")} · 확인 필요 ${n("low")} (모두 ${issues.length}건)`,
    "",
  ];
  if (!issues.length) L.push("발견된 항목이 없습니다.");
  issues.forEach((i, k) => {
    L.push(`${k + 1}. [${SEV_KO[i.severity] ?? i.severity}] ${i.page ? `${i.page}쪽 · ` : ""}${i.title}`
      + (i.source ? `  (${SRC_KO[i.source] ?? i.source})` : ""));
    if (i.detail) L.push(`   ${i.detail}`);
    if (i.fix) L.push(`   → ${i.fix}`);
    L.push("");
  });
  L.push("이 결과는 인쇄소의 최종 승인과 사람의 교정을 대체하지 않습니다.");
  return L.join("\n") + "\n";
}

/** 붙여넣은 글 → 교정 목록. 설명 줄은 버리고, 칸이 안 맞는 줄은 이유와 함께 돌려준다. */
export function parseFixText(text: string): { fixes: Fix[]; skipped: { line: number; text: string; why: string }[] } {
  const fixes: Fix[] = [];
  const skipped: { line: number; text: string; why: string }[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const cells = splitCells(line);
    if (cells.length < 3) {
      skipped.push({ line: idx + 1, text: line, why: "칸이 셋(쪽 | 원래 내용 | 수정할 내용)이 아닙니다" });
      return;
    }
    if (cells.length > 3) {
      skipped.push({ line: idx + 1, text: line, why: "칸이 셋보다 많습니다. 내용 안의 | 는 \\| 로 적으세요" });
      return;
    }
    const [p, original, suggestion] = cells;
    if (!original) {
      skipped.push({ line: idx + 1, text: line, why: "원래 내용이 비어 있습니다" });
      return;
    }
    if (!suggestion) {
      skipped.push({ line: idx + 1, text: line, why: "수정할 내용이 비어 있습니다" });
      return;
    }
    if (original === suggestion) {
      skipped.push({ line: idx + 1, text: line, why: "원래 내용과 수정할 내용이 같습니다" });
      return;
    }
    const page = p === "" ? null : Number(p);
    if (page !== null && (!Number.isInteger(page) || page < 1)) {
      skipped.push({ line: idx + 1, text: line, why: `쪽은 1 이상의 정수여야 합니다('${p}')` });
      return;
    }
    fixes.push({ page, original, suggestion, key: `l${idx + 1}` });
  });
  return { fixes, skipped };
}
