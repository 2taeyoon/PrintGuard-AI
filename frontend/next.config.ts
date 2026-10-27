import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // 개발 중 화면 왼쪽 아래에 뜨는 Next 표시(‘Cache disabled’ 배지 포함)를 띄우지 않는다.
  // 그 배지는 앱의 문제가 아니라 브라우저 개발자도구의 ‘Disable cache’가 켜져 있어
  // 요청에 cache-control: no-cache가 붙으면 dev 서버가 캐시를 건너뛴다는 알림이다. 빌드 결과에는 영향이 없다.
  devIndicators: false,
};

export default nextConfig;
