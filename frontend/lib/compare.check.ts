// 회차 비교 계산 시험.  cd frontend && npx tsx lib/compare.check.ts
// 프런트에는 테스트 러너가 없어서 tsx로 바로 도는 스크립트로 둔다(fixlist.check.ts와 같은 방식).

import { changedRegions, checkRequests, diffWords, groupChanges, parseRequests, visualOnly, wordsFromItems, type Word } from "./compare";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.log(`✗ ${name}\n   받음: ${a}\n   기대: ${b}`); fail++; } else console.log(`✓ ${name}`);
};
const W = (s: string): Word[] => s.split(" ").map((x, i) => ({ s: x, box: [i * 10, 0, i * 10 + 8, 10] }));
const changes = (a: string, b: string) => {
  const A = W(a), B = W(b);
  return groupChanges(diffWords(A.map((w) => w.s), B.map((w) => w.s)), A, B).map((c) => [c.kind, c.before, c.after]);
};

// ---- 글자
eq("같으면 바뀐 것이 없다", changes("인쇄 파일은 미리 본다", "인쇄 파일은 미리 본다"), []);
eq("한 낱말을 바꾸면 '바꿈' 하나", changes("손을 깨끗히 씻는다", "손을 깨끗이 씻는다"), [["rep", "깨끗히", "깨끗이"]]);
eq("지우기", changes("가 나 다 라", "가 다 라"), [["del", "나", ""]]);
eq("넣기", changes("가 다", "가 나 다"), [["ins", "", "나"]]);
eq("떨어진 두 곳은 두 덩어리", changes("가 나 다 라 마", "가 X 다 라 Y"), [["rep", "나", "X"], ["rep", "마", "Y"]]);

// ---- 낱말 자리: 글 조각 하나를 낱말로 나누고, 위쪽 원점으로 바꾼다
const words = wordsFromItems([{ str: "안전 산업", transform: [10, 0, 0, 10, 100, 700], width: 50, height: 10 }], [0, 0], 800);
eq("조각을 낱말로 나눈다", words.map((w) => w.s), ["안전", "산업"]);
eq("위쪽 원점으로 바꾼다(y)", words[0].box.map(Math.round), [100, 90, 120, 100]);

// ---- 그림
const w = 40, h = 40;
const a = new Uint8ClampedArray(w * h * 4).fill(255), b = a.slice();
for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) { const k = (y * w + x) * 4; b[k] = b[k + 1] = b[k + 2] = 0; }
const reg = changedRegions(a, b, w, h, 10, 22);
eq("바뀐 네모 하나를 찾는다", reg, [[10, 10, 30, 30]]);
eq("같은 그림이면 바뀐 자리가 없다", changedRegions(a, a.slice(), w, h), []);
eq("글자 변경과 겹치는 그림 변화는 뺀다",
  visualOnly([[10, 10, 30, 30], [100, 100, 120, 120]], [{ kind: "rep", before: "a", after: "b", oldBoxes: [], newBoxes: [[12, 12, 20, 20]] }]),
  [[100, 100, 120, 120]]);

// ---- 요청 대조
eq("화살표 여러 꼴을 읽는다", parseRequests("깨끗히 → 깨끗이\n- 몇일 -> 며칠\n3) '컨텐츠' => '콘텐츠'\n화살표 없는 줄"),
  [{ from: "깨끗히", to: "깨끗이" }, { from: "몇일", to: "며칠" }, { from: "컨텐츠", to: "콘텐츠" }]);
const old = ["손을 깨끗히 씻는다. 몇일 뒤에 본다.", "컨텐츠 컨텐츠"];
const neu = ["손을 깨끗이 씻는다. 몇일 뒤에 본다.", "콘텐츠 컨텐츠"];
eq("반영·누락·일부만", checkRequests(parseRequests("깨끗히 → 깨끗이\n몇일 → 며칠\n컨텐츠 → 콘텐츠\n없는말 → 있는말"), old, neu).map((r) => [r.status, r.page]),
  [["반영", 1], ["누락", 1], ["확인 필요", 2], ["확인 필요", undefined]]);
eq("고칠 글이 고친 글 안에 들어 있어도 세지 않는다(Inc → Inc.)",
  checkRequests([{ from: "Inc", to: "Inc." }], ["Acme Inc 2026"], ["Acme Inc. 2026"]).map((r) => r.status), ["반영"]);

if (fail) { console.log(`\n${fail}개 실패`); process.exit(1); }
console.log("\n모두 통과");
