// 옛 주소. 회차 비교는 뺐다 — 따로 된 탭이었다가, 검수 화면 안의 칸이었다가, 검수 결과 아래에
// 붙었는데, 어느 쪽이든 검수 결과(쪽 그림 + 고칠 것 목록)와 겹쳤다. 지난 회차는 로그인하면 쌓이는
// 검수 기록에서 그 의뢰를 골라 본다. 북마크가 깨지지 않게 인쇄 검수로 보낸다.
import { redirect } from "next/navigation";

export default function CompareMoved() {
  redirect("/");
}
