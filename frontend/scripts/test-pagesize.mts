// 파일에서 완성 크기·도련을 읽는 것(lib/pagesize.ts)과 판형 되찾기(lib/formats.ts)를 확인한다.
//   npx tsx scripts/test-pagesize.mts        (frontend 폴더에서)
//
// 브라우저에서 사람이 눌러 봐야만 알 수 있던 것을 여기서 잰다 — 이 값이 틀리면 검사 전체가
// "페이지 크기가 설정과 다름"으로 뒤덮이는데, 틀린 것은 파일이 아니라 읽는 쪽이다.
import { readFileSync } from "node:fs";
import { ALL, match } from "../lib/formats";
import { measure } from "../lib/pagesize";

const file = (p: string) => new File([new Uint8Array(readFileSync(p))], p.split(/[\\/]/).pop()!);
let bad = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${cond ? "" : ` — ${JSON.stringify(got)}`}`);
  if (!cond) bad++;
};

// ---------- 판형 되찾기 ----------
ok("A5를 정확히 맞히다", match(148, 210)?.format.label === "A5 · 국판 (148×210)");
ok("0.6mm 어긋나도 같은 판형", match(148.6, 210.4)?.format.label === "A5 · 국판 (148×210)");
ok("2mm 어긋나면 판형이 아니다", match(150, 212) === null);
ok("가로로 누우면 rotated", match(210, 148)?.rotated === true);
ok("크라운판과 B5를 가르다(2mm 차이)",
  match(176, 248)?.format.label === "크라운판 (176×248)" && match(176, 250)?.format.label === "B5 (176×250)");
ok("명함", match(90, 50)?.format.label === "명함 (90×50)");
ok("목록에 없는 크기는 null", match(137, 199) === null);
ok("판형 라벨이 겹치지 않는다", new Set(ALL.map((f) => f.label)).size === ALL.length);
// 같은 치수가 둘이면 자동 선택이 둘 중 하나를 임의로 고르게 된다(A5=국판처럼 한 줄로 합쳐 둔 이유)
ok("같은 치수가 둘 있지 않다", new Set(ALL.map((f) => `${f.w}x${f.h}`)).size === ALL.length);

// ---------- 파일에서 읽기 ----------
const bleed = await measure(file("../samples/clean_a5_bleed.pdf"));
ok("도련 있는 A5: 완성 크기", bleed?.widthMm === 148 && bleed?.heightMm === 210, bleed);
ok("도련 있는 A5: TrimBox에서 읽는다", bleed?.from === "TrimBox", bleed?.from);
ok("도련 있는 A5: 도련 3mm", bleed?.bleedMm === 3, bleed?.bleedMm);
ok("도련 있는 A5: 판형이 A5로 잡힌다", match(bleed!.widthMm, bleed!.heightMm)?.format.label === "A5 · 국판 (148×210)");

const typo = await measure(file("../samples/typo_a5.pdf"));
ok("도련 없는 A5: 용지 크기를 쓴다", typo?.from === "MediaBox" && typo?.bleedMm === null, typo);
ok("도련 없는 A5: 148×210", typo?.widthMm === 148 && typo?.heightMm === 210, typo);

const notPdf = await measure(new File([new Uint8Array([1, 2, 3])], "x.pdf"));
ok("PDF가 아니면 null(조용히 손 입력으로 둔다)", notPdf === null, notPdf);

console.log(bad ? `\n${bad}개 실패` : "\n전부 통과");
process.exit(bad ? 1 : 0);
