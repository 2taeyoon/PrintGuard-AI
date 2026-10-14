// 실제 Chrome에서 앱의 검색(lib/guide.ts, e5-small int8 + wasm, 2-gram BM25, dense 0.5)을 92문제로 잰다.
// 개발 서버(127.0.0.1:3000)가 떠 있어야 한다. KB는 Python 평가와 같은 31항목판과 앱에 실린 37항목판 두 가지.
// 판정은 eval/run_eval.py와 같다. 결과: eval/browser_int8_result.json
// 실행: node scripts/eval-guide-browser.mjs  (playwright-core와 Chrome 경로가 필요)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(process.env.PW_DIR ? process.env.PW_DIR + "/" : import.meta.url);
const { chromium } = require("playwright-core");
const Q = JSON.parse(readFileSync("../eval/questions.json", "utf8"));
const kbs = { eval31: readFileSync("../eval/kb/print_guide.md", "utf8"), app37: readFileSync("public/kb/print_guide.md", "utf8") };
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const p = await b.newPage();
await p.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__loadGuide, null, { timeout: 120000 });
const out = { n: Q.length, ua: await p.evaluate(() => navigator.userAgent) };
for (const [name, md] of Object.entries(kbs)) {
  out[name] = await p.evaluate(async ({ md, Q }) => {
    const norm = (t) => t.replace(/\s+/g, "");
    const t0 = performance.now();
    const g = await window.__loadGuide(() => {}, { md });
    const load = performance.now() - t0;
    const rows = [];
    const t1 = performance.now();
    for (const [q, a] of Q) {
      const hits = await g.search(q, 10);
      const rank = hits.findIndex((h) => norm(h.section.text).includes(norm(a))) + 1;
      rows.push({ hit1: rank === 1 ? 1 : 0, mrr: rank ? 1 / rank : 0, hit3: rank && rank <= 3 ? 1 : 0, rank });
    }
    const qms = (performance.now() - t1) / Q.length;
    const m = (k, f = () => true) => { const r = rows.filter((_, i) => f(i)); return r.reduce((s, x) => s + x[k], 0) / r.length; };
    return { sections: g.sections.length, children: g.children, load_ms: load, query_ms: qms,
      all: { hit1: m("hit1"), mrr: m("mrr"), hit3: m("hit3") },
      dev: { hit1: m("hit1", (i) => i % 2 === 0), mrr: m("mrr", (i) => i % 2 === 0) },
      val: { hit1: m("hit1", (i) => i % 2 === 1), mrr: m("mrr", (i) => i % 2 === 1) },
      ranks: rows.map((r) => r.rank) };
  }, { md, Q });
  console.log(name, JSON.stringify({ ...out[name], ranks: undefined }));
}
writeFileSync("../eval/browser_int8_result.json", JSON.stringify(out));
await b.close();
