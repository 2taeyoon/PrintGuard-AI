// 옛 주소. 회차 비교는 따로 된 화면이 아니라, 같은 문서를 다시 검수하면 그 결과 아래에 저절로 붙는다
// (app/compare-panel.tsx). 북마크가 깨지지 않게 인쇄 검수로 보낸다.
import { redirect } from "next/navigation";

export default function CompareMoved() {
  redirect("/");
}
