// 교정 목록 형식의 왕복 시험. 화면 1이 만든 글을 화면 2가 그대로 읽을 수 있어야 한다.
//   cd frontend && npx tsx lib/fixlist.check.ts
// 프런트에는 테스트 러너가 없어서 tsx로 바로 도는 스크립트로 둔다(Node 에이전트와 같은 방식).

import { buildFixText, parseFixText } from "./fixlist";
import type { Issue } from "./analyze";

const mk = (p: number, title: string, edit?: { original: string; suggestion: string }): Issue =>
  ({ id: 0, kind: "typo", severity: "low", page: p, title, detail: "", fix: "", rect: null, source: "proofread", edit } as Issue);

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.log(`✗ ${name}\n   받음: ${a}\n   기대: ${b}`); fail++; } else console.log(`✓ ${name}`);
};

// 왕복
const issues = [
  mk(3, "맞춤법: '넓이' → '너비'", { original: "넓이", suggestion: "너비" }),
  mk(5, "띄어쓰기: '해야 겠다' → '해야겠다'", { original: "해야 겠다", suggestion: "해야겠다" }),
  mk(2, "재단선 안쪽 여백 부족"),
];
const text = buildFixText(issues, { filename: "a.pdf", mode: "에이전트 검사" });
const r1 = parseFixText(text);
eq("왕복: 고칠 수 있는 2건만 읽힌다", r1.fixes.map((f) => [f.page, f.original, f.suggestion]),
   [[3, "넓이", "너비"], [5, "해야 겠다", "해야겠다"]]);
eq("왕복: 버린 줄 없음", r1.skipped.length, 0);
eq("사람 판단 항목은 주석으로", text.includes("# 2쪽 [낮음] 재단선 안쪽 여백 부족"), true);

// 파이프 escape
const piped = buildFixText([mk(1, "t", { original: "a|b", suggestion: "c\d" })]);
const r2 = parseFixText(piped);
eq("| 와 \ 가 왕복한다", r2.fixes.map((f) => [f.original, f.suggestion]), [["a|b", "c\d"]]);

// 사람이 손으로 쓴 것
const hand = `
# 내가 적은 메모
3 | 넓이 | 너비
  | 공백쪽 | 비어도됨
4 | 같은말 | 같은말
5 | 원문만
6 | a | b | c
0 | 쪽0 | x
x | 쪽글자 | y
7 |  | 빈원문
`;
const r3 = parseFixText(hand);
eq("손으로 쓴 것: 유효한 2건", r3.fixes.map((f) => [f.page, f.original, f.suggestion]),
   [[3, "넓이", "너비"], [null, "공백쪽", "비어도됨"]]);
eq("버린 줄 6건", r3.skipped.length, 6);
eq("버린 이유 첫 줄", r3.skipped[0].why.includes("같습니다"), true);
eq("칸 부족", r3.skipped[1].why.includes("칸이 셋"), true);
eq("칸 초과", r3.skipped[2].why.includes("\|"), true);
eq("쪽 0 거절", r3.skipped[3].why.includes("1 이상"), true);
eq("쪽 글자 거절", r3.skipped[4].why.includes("1 이상"), true);
eq("빈 원문 거절", r3.skipped[5].why.includes("원래 내용이 비어"), true);

// 고칠 것이 하나도 없을 때
eq("빈 목록 안내", buildFixText([mk(1, "여백 부족")]).includes("자동으로 고칠 수 있는 항목이 없습니다"), true);

console.log(fail ? `\n${fail}건 실패` : "\n전부 통과");
process.exit(fail ? 1 : 0);
