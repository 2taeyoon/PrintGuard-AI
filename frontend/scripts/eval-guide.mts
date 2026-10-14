// 앱이 실제로 쓰는 검색(lib/guide.ts: e5-small int8 ONNX + 2-gram BM25, dense 0.5)을 Python 평가와 같은 92문제·같은 KB(31항목)로 잰다.
// 판정은 run_eval.py와 같다: 반환된 절(공백 제거)에 정답 문구가 들어 있으면 적중. 결과: eval/browser_int8_result.json
import { readFileSync, writeFileSync } from "node:fs";
import { loadGuide } from "../lib/guide";

const device = process.argv[2] ?? "cpu";
const md = readFileSync("../eval/kb/print_guide.md", "utf8");
const Q: [string, string][] = JSON.parse(readFileSync("../eval/questions.json", "utf8"));
const norm = (t: string) => t.replace(/\s+/g, "");
const t0 = performance.now();
const g = await loadGuide(() => {}, { md, localModelPath: "./public/models/", wasmPaths: null, device });
const loadMs = performance.now() - t0;
const rows: { hit1: number; mrr: number; hit3: number }[] = [];
const t1 = performance.now();
for (const [q, a] of Q) {
  const hits = await g.search(q, 10);
  const rank = hits.findIndex((h) => norm(h.section.text).includes(norm(a))) + 1;
  rows.push({ hit1: rank === 1 ? 1 : 0, mrr: rank ? 1 / rank : 0, hit3: rank && rank <= 3 ? 1 : 0 });
}
const qMs = (performance.now() - t1) / Q.length;
const mean = (k: "hit1" | "mrr" | "hit3", idx?: number[]) => {
  const r = idx ? idx.map((i) => rows[i]) : rows;
  return r.reduce((s, x) => s + x[k], 0) / r.length;
};
const dev = Q.map((_, i) => i).filter((i) => i % 2 === 0), val = Q.map((_, i) => i).filter((i) => i % 2 === 1);
const out = {
  device, sections: g.sections.length, children: g.children, n: Q.length, load_ms: loadMs, query_ms: qMs,
  all: { hit1: mean("hit1"), mrr: mean("mrr"), hit3: mean("hit3") }, dev: { hit1: mean("hit1", dev), mrr: mean("mrr", dev) }, val: { hit1: mean("hit1", val), mrr: mean("mrr", val) },
  hit1_raw: rows.map((r) => r.hit1),
};
console.log(JSON.stringify({ ...out, hit1_raw: undefined }));
writeFileSync(`../eval/browser_int8_result_${device}.json`, JSON.stringify(out));
