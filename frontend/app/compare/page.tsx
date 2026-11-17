// 옛 주소. 회차 비교는 인쇄 검수 화면 안의 '교정 회차 비교' 칸으로 옮겼다 — 북마크가 깨지지 않게 그리로 보낸다.
import { redirect } from "next/navigation";

export default function CompareMoved() {
  redirect("/#compare");
}
