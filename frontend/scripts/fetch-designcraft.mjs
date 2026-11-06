// DesignCraft 웹 빌드를 GitHub 릴리스에서 받아 `public/designcraft/`에 푼다.
//
// 저장소에 넣지 않는 이유는 용량이다 — wasm 하나가 62MB다. 그래서 `public/models`·`public/ort`와
// 같은 방식으로 **빌드할 때 받아 온다**(`prebuild`). 로컬에서도 배포에서도 같은 것이 깔린다.
//
// **받지 못해도 빌드를 멈추지 않는다.** 인터넷이 막힌 곳에서도 앱은 떠야 한다 — 편집기 자리에는
// "아직 받지 않았습니다"가 뜨고 나머지는 그대로 돈다.
//
// 받은 것을 그대로 믿지 않는다. 같은 릴리스의 `SHA256SUMS.txt`와 대조하고, 다르면 버린다.
// 푸는 것도 경로를 하나씩 확인한다 — zip 안의 `../`는 바깥 폴더에 파일을 쓰는 오래된 수법이다.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const VERSION = "0.17.2";                      // 올릴 때 여기만 바꾼다
const REPO = "storytold/designcraft";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "public", "designcraft");
const STAMP = join(OUT, ".version");
const base = `https://github.com/${REPO}/releases/download/v${VERSION}`;

const say = (s) => process.stdout.write(`[designcraft] ${s}\n`);

async function get(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

/** zip 하나를 푼다. 저장(0)과 디플레이트(8)만 다룬다 — 릴리스 zip이 그 둘만 쓴다. */
function unzip(buf, dest) {
  // 끝에서 중앙 디렉터리 자리를 찾는다(주석이 붙을 수 있어 뒤에서 훑는다)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip 끝을 찾지 못했습니다");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 목록이 깨졌습니다");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    files.push({ name, method, csize, local });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  let wrote = 0;
  const jobs = [];
  for (const f of files) {
    if (f.name.endsWith("/")) continue;
    // 꾸러미 안의 맨 위 폴더(designcraft-web-0.17.2/)는 벗겨 낸다
    const rel = f.name.replace(/^[^/]+\//, "");
    const target = resolve(dest, rel);
    if (relative(dest, target).startsWith("..")) throw new Error(`zip 안의 경로가 폴더 밖을 가리킵니다: ${f.name}`);
    const lnLen = buf.readUInt16LE(f.local + 26);
    const leLen = buf.readUInt16LE(f.local + 28);
    const start = f.local + 30 + lnLen + leLen;
    const raw = buf.subarray(start, start + f.csize);
    const data = f.method === 0 ? raw : inflateRawSync(raw);
    jobs.push({ target, data });
    wrote++;
  }
  return { jobs, wrote };
}

async function main() {
  if (existsSync(STAMP) && (await readFile(STAMP, "utf8")).trim() === VERSION) {
    say(`이미 ${VERSION}이 깔려 있습니다 — 건너뜁니다`);
    return;
  }
  const zipName = `designcraft-web-${VERSION}.zip`;
  say(`받습니다: ${zipName} (26MB쯤)`);
  const [zip, sums] = await Promise.all([get(`${base}/${zipName}`), get(`${base}/SHA256SUMS.txt`)]);

  const want = sums.toString("utf8").split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((c) => c[1]?.replace(/^\*/, "") === zipName)?.[0]?.toLowerCase();
  const got = createHash("sha256").update(zip).digest("hex");
  if (!want) throw new Error("SHA256SUMS.txt에 그 파일이 없습니다");
  if (want !== got) throw new Error(`해시가 다릅니다 — 적힌값 ${want}, 받은값 ${got}`);
  say("해시 일치");

  await rm(OUT, { recursive: true, force: true });
  const { jobs, wrote } = unzip(zip, OUT);
  for (const j of jobs) {
    await mkdir(dirname(j.target), { recursive: true });
    await writeFile(j.target, j.data);
  }
  await writeFile(STAMP, `${VERSION}\n`, "utf8");
  say(`${wrote}개를 public/designcraft/에 풀었습니다`);
}

main().catch((e) => {
  // 멈추지 않는다. 편집기 자리에 안내가 뜨고 나머지는 그대로 돈다.
  say(`받지 못했습니다 — ${e.message}`);
  say("편집기 없이 갑니다. 나중에 `npm run fetch:designcraft`로 다시 받을 수 있습니다.");
});
