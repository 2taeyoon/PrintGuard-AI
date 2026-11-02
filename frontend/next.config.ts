import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // 개발 중 화면 왼쪽 아래에 뜨는 Next 표시(‘Cache disabled’ 배지 포함)를 띄우지 않는다.
  // 그 배지는 앱의 문제가 아니라 브라우저 개발자도구의 ‘Disable cache’가 켜져 있어
  // 요청에 cache-control: no-cache가 붙으면 dev 서버가 캐시를 건너뛴다는 알림이다. 빌드 결과에는 영향이 없다.
  devIndicators: false,
  // dev 서버는 기본적으로 자기 호스트 이름이 아닌 출처에서 오는 /_next/* 요청을 막는다.
  // 그래서 localhost:8752로 띄운 것을 127.0.0.1:8752로 열면 클라이언트 번들이 통째로 차단돼
  // 화면은 그려지지만 버튼이 하나도 안 눌리는 상태가 된다(콘솔에 오류도 남지 않는다).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
