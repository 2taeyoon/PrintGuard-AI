"""실제 에이전트를 띄운 상태에서 샘플 PDF 의뢰를 끝까지 돌려 본다(수동 확인용).
python e2e_check.py [pdf 경로] [옵션 JSON]"""
import json
import sys
import time

import httpx

sys.stdout.reconfigure(encoding="utf-8")
BASE = "http://127.0.0.1:8700"
pdf = sys.argv[1] if len(sys.argv) > 1 else "../samples/defective_a5.pdf"
opts = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {"paper_id": "art", "finish": "none"}
with open(pdf, "rb") as f:
    r = httpx.post(f"{BASE}/jobs", files={"file": ("sample.pdf", f.read(), "application/pdf")}, data={"options": json.dumps(opts)}, timeout=30).json()["data"]
ctx = r["context_id"]
print("의뢰", ctx, "중복" if r.get("duplicate") else "")
t0 = time.time()
while True:
    j = httpx.get(f"{BASE}/jobs/{ctx}", timeout=10).json()["data"]
    if j["status"] not in ("working",):
        break
    if time.time() - t0 > 300:
        break
    time.sleep(0.5)
print("상태", j["status"], f"{time.time() - t0:.1f}s")
for s in j["steps"]:
    print(f"  {s['agent']:9s} {s['skill']:22s} {s['status']:10s} {s['outcome'] or '':16s} {s['ms']}ms")
res = j["results"]
print("구조 이슈", len(res.get("preflight", {}).get("issues", [])), "| 색 이슈", len(res.get("color", {}).get("issues", [])),
      "| 위험도", [(x["id"], x["level"]) for x in res.get("risk", {}).get("risks", [])])
print("가이드 근거", {k: [h["title"] for h in v][:1] for k, v in list(res.get("guide", {}).get("hits", {}).items())[:4]})
if j.get("question"):
    print("질문", j["question"])
logs = httpx.get(f"{BASE}/logs", params={"context_id": ctx}).json()["data"]
print("공통 로그", len(logs), "줄:", [f"{x['source']}:{x['kind']}" for x in logs][:12])

# 보고서(A 등급: safety 관문을 거치고 ΔE는 report가 color로 다시 계산해 대조한다)
if j["status"] == "completed" and "--report" in sys.argv:
    rp = httpx.post(f"{BASE}/jobs/{ctx}/report", timeout=120).json()["data"]
    print("보고서", rp["status"], rp["output"].get("verified"), rp["output"].get("path"))
    print(rp["output"].get("markdown", "")[:900])
    logs = httpx.get(f"{BASE}/logs", params={"context_id": ctx}).json()["data"]
    print("관문 기록", [(x["skill"], x["status"], x["grade"]) for x in logs if x["kind"] in ("safety_decision", "human_review")])
