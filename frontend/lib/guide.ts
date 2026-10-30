// 인쇄 가이드 RAG: 구조 기반 parent-child 청킹 + multilingual-e5-small(브라우저 ONNX) + 2-gram BM25 하이브리드.
// 평가에서 고른 설정이다. 근거는 모델 비교 아티팩트와 eval/results.json 참고. 서버 없이 브라우저에서만 돈다.

export type Section = { doc: string; title: string; text: string };
export type Hit = { section: Section; score: number; child: string };

const DENSE_WEIGHT = 0.5; // 개발용 질문에서 MRR이 가장 높았던 dense 비중
const MODEL = "Xenova/multilingual-e5-small";

type Child = { text: string; parent: number };

function parse(md: string): Section[] {
  const secs: { doc: string; title: string; body: string[] }[] = [];
  let doc = "";
  let cur: (typeof secs)[number] | null = null;
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith("# ")) doc = line.slice(2).trim();
    else if (line.startsWith("## ")) { cur = { doc, title: line.slice(3).trim(), body: [] }; secs.push(cur); }
    else if (cur && line.trim()) cur.body.push(line.trim());
  }
  return secs.map((s) => ({ doc: s.doc, title: s.title, text: `${s.title}\n${s.body.join("\n")}` }));
}

function fixed(text: string, size = 150, overlap = 25): string[] {
  const out: string[] = [];
  const step = size - overlap;
  for (let i = 0; i < Math.max(text.length - overlap, 1); i += step) out.push(text.slice(i, i + size));
  return out;
}

const bigrams = (t: string) => {
  const s = t.replace(/\s+/g, "");
  if (s.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
};

class BM25 {
  private tf: { m: Map<string, number>; len: number }[] = [];
  private idf = new Map<string, number>();
  private avg = 0;
  constructor(docs: string[], private k1 = 1.5, private b = 0.75) {
    const df = new Map<string, number>();
    for (const d of docs) {
      const toks = bigrams(d);
      const m = new Map<string, number>();
      toks.forEach((w) => m.set(w, (m.get(w) ?? 0) + 1));
      this.tf.push({ m, len: toks.length });
      this.avg += toks.length;
      for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    }
    this.avg /= docs.length;
    const n = docs.length;
    for (const [w, f] of df) this.idf.set(w, Math.log(1 + (n - f + 0.5) / (f + 0.5)));
  }
  scores(q: string): number[] {
    const qs = bigrams(q);
    return this.tf.map(({ m, len }) => {
      let s = 0;
      for (const w of qs) {
        const f = m.get(w);
        if (f) s += (this.idf.get(w) ?? 0) * f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + (this.b * len) / this.avg));
      }
      return s;
    });
  }
}

const z = (x: number[]) => {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / x.length);
  return x.map((v) => (sd > 1e-9 ? (v - mean) / sd : 0));
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = (t: string | string[], o: any) => Promise<{ data: Float32Array; dims: number[] }>;

export type Guide = {
  sections: Section[];
  children: number;
  search: (query: string, k?: number) => Promise<Hit[]>;
};

// opts는 Node 평가 스크립트(scripts/eval-guide.mts)에서 같은 코드로 점수를 재기 위한 것이다. 브라우저는 기본값을 쓴다.
export async function loadGuide(onStatus: (s: string) => void,
  opts: { md?: string; localModelPath?: string; wasmPaths?: string | null; device?: string } = {}): Promise<Guide> {
  onStatus("가이드 문서 읽는 중");
  const md = opts.md ?? await (await fetch("/kb/print_guide.md")).text();
  const sections = parse(md);
  const children: Child[] = [];
  sections.forEach((s, i) => fixed(s.text).forEach((c) => children.push({ text: c, parent: i })));

  onStatus("임베딩 모델 불러오는 중 (최초 1회, 약 118MB)");
  const tf = await import("@huggingface/transformers");
  // 모델 파일이 이 앱 안에 있으면 그것을 쓰고(로컬 실행), 없으면 Hugging Face에서 받는다(공개 배포).
  // 저장소에는 118MB짜리 모델을 넣지 않기 때문에, 배포본에서는 remote가 유일한 경로다.
  const local = opts.localModelPath ?? "/models/";
  const haveLocal = await fetch(`${local}${MODEL}/tokenizer.json`, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  tf.env.allowLocalModels = haveLocal;
  tf.env.allowRemoteModels = !haveLocal;
  tf.env.localModelPath = local;
  if (opts.wasmPaths !== null) {
    const ortPath = opts.wasmPaths ?? "/ort/";
    const haveOrt = await fetch(`${ortPath}ort-wasm-simd-threaded.jsep.mjs`, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (haveOrt) (tf.env.backends.onnx as any).wasm.wasmPaths = ortPath;   // 없으면 transformers.js 기본 CDN을 쓴다
  }
  if (!haveLocal) onStatus("임베딩 모델 불러오는 중 (최초 1회, 약 118MB — Hugging Face)");
  // 파일별 다운로드 진행률을 모아 하나의 %로 보여 준다(캐시돼 있으면 바로 끝난다)
  const prog = new Map<string, { loaded: number; total: number }>();
  const onProgress = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== "progress" || !p.file || !p.total) return;
    prog.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let a = 0, b = 0;
    for (const v of prog.values()) { a += v.loaded; b += v.total; }
    onStatus(`임베딩 모델 불러오는 중 ${Math.round((a / b) * 100)}% (${(a / 1048576).toFixed(0)}/${(b / 1048576).toFixed(0)}MB)`);
  };
  const extractor = (await tf.pipeline("feature-extraction", MODEL,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { dtype: "q8", device: (opts.device ?? "wasm") as any, progress_callback: onProgress as any })) as unknown as Extractor;

  async function embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8);
      const t = await extractor(batch, { pooling: "mean", normalize: true });
      const d = t.dims[1];
      for (let r = 0; r < batch.length; r++) out.push(Array.from(t.data.slice(r * d, (r + 1) * d)));
    }
    return out;
  }

  onStatus(`가이드 ${children.length}개 조각 임베딩 중`);
  const cvec = await embed(children.map((c) => "passage: " + c.text));
  const bm = new BM25(children.map((c) => c.text));
  onStatus("");

  return {
    sections,
    children: children.length,
    async search(query, k = 3) {
      const [qv] = await embed(["query: " + query]);
      const dense = cvec.map((v) => v.reduce((s, x, i) => s + x * qv[i], 0));
      const zd = z(dense), zb = z(bm.scores(query));
      const fused = zd.map((d, i) => DENSE_WEIGHT * d + (1 - DENSE_WEIGHT) * zb[i]);
      const best = new Map<number, { score: number; child: string }>();
      fused.forEach((s, i) => {
        const p = children[i].parent;
        if (!best.has(p) || best.get(p)!.score < s) best.set(p, { score: s, child: children[i].text });
      });
      return [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, k)
        .map(([p, v]) => ({ section: sections[p], score: v.score, child: v.child }));
    },
  };
}

// 탭을 오가도 모델을 한 번만 불러오도록 페이지들이 공유하는 로더. 상태 문구는 구독한 화면 모두에 전달한다.
let shared: Promise<Guide> | null = null;
let lastStatus = "가이드 검색 준비 중";
const listeners = new Set<(s: string) => void>();
const emit = (s: string) => { lastStatus = s; listeners.forEach((l) => l(s)); };

export function getGuide(onStatus: (s: string) => void): { guide: Promise<Guide>; unsubscribe: () => void } {
  listeners.add(onStatus);
  onStatus(lastStatus);
  shared ??= loadGuide(emit).then((g) => { emit(`가이드 검색 준비됨 (${g.sections.length}개 항목)`); return g; })
    .catch((e) => { shared = null; emit(`가이드 검색 사용 불가: ${e instanceof Error ? e.message : e}`); throw e; });
  return { guide: shared, unsubscribe: () => listeners.delete(onStatus) };
}
