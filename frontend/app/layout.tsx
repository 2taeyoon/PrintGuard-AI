import type { Metadata } from "next";
import "pretendard/dist/web/static/pretendard-dynamic-subset.css";
import "./globals.css";
import "./globals.reaction.css";
import Shell from "./nav";

export const metadata: Metadata = {
  title: "PrintGuard AI",
  description: "인쇄 전 품질 검수 에이전트",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body><Shell>{children}</Shell></body>
    </html>
  );
}
