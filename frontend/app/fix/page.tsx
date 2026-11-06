// 옛 '원본 수정' 주소. 이 화면이 하던 일은 둘로 나뉘었다.
//
// - **고치는 일**은 인쇄 검수 안으로 들어갔다. 편집 파일(IDML)로 검수를 맡기면 검수가 끝난 자리에서
//   designcraft가 "원본에 반영할까요?"를 묻는다. 검수 결과를 복사해 다른 화면에 붙여 넣던 다리는
//   사람이 하던 일이지 기계가 못 할 일이 아니었다.
// - **만드는 일**은 /make('작업 만들기')가 되었다.
//
// 주소를 지우지 않고 옮겨 준다 — 도움말·북마크에 이 주소가 남아 있다.
import { redirect } from "next/navigation";

export default function FixMoved() {
  redirect("/make");
}
