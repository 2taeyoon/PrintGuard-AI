import { readFileSync, writeFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyze } from "../lib/analyze";
import { ColorEngine } from "../lib/color";

const eng = await ColorEngine.create(new Uint8Array(readFileSync("../eval/icc/RSWOP.icm")), { intent: "relative", tacLimit: 300 });
for (const f of ["defective_a5", "clean_a5_bleed"]) {
  const data = new Uint8Array(readFileSync(`../samples/${f}.pdf`));
  const r = await analyze(data, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 3, color: eng });
  console.log("==", f, r.pages, JSON.stringify(r.colorSummary), JSON.stringify(r.colorReport));
  for (const i of r.issues) console.log(i.severity, i.page, i.title, i.rect ? i.rect.map((n) => n.toFixed(0)).join(",") : "");
  const c = r.issues.find((i) => i.metrics);
  if (c && f === "defective_a5") writeFileSync("../eval/color_check_pdf_js.json", JSON.stringify(c.metrics));
  if (c) console.log("metrics", JSON.stringify(c.metrics), "heat", c.heat?.w, c.heat?.h);
}
