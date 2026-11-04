"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import SignIn from "./sign-in";

const TABS = [
  { href: "/", label: "인쇄 검수" },
  { href: "/fix", label: "원본 수정" },
  { href: "/papers", label: "종이 안내" },
  { href: "/shops", label: "인쇄소 지도" },
  { href: "/help", label: "도움말·평가 측정표" },
  { href: "/sources", label: "출처" },
];

// 상단 헤더 셸. 768px 이하에서는 메뉴 버튼으로 메뉴를 펼친다.
export default function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className={`RouteApp${open ? " open" : ""}`}>
      <header className="topbar">
        <div className="topbar_inner">
          <Link href="/" className="brand" onClick={() => setOpen(false)}>
            <Image src="/logo.png" alt="" width={32} height={32} priority />
            PrintGuard-AI
          </Link>
          <nav className="topmenu" aria-label="메뉴">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} className={path === t.href ? "on" : ""} onClick={() => setOpen(false)}>{t.label}</Link>
            ))}
          </nav>
          {/* 오른쪽 칸: 구글 로그인. 로그인은 선택이고, 하면 지금까지 한 검수가 계정으로 옮겨 간다 */}
          <div className="topright"><SignIn /></div>
          <button type="button" className="icon_btn menu_btn" aria-label={open ? "메뉴 닫기" : "메뉴 열기"} aria-expanded={open}
            onClick={() => setOpen((o) => !o)}>{open ? "✕" : "☰"}</button>
        </div>
      </header>
      <div className="content">{children}</div>
      {/* 구글 동의 화면이 가리키는 두 쪽. 메뉴에 넣으면 검수와 같은 무게로 보여서 아래에 둔다 */}
      <footer className="sitefoot">
        <Link href="/privacy">개인정보처리방침</Link>
        <Link href="/terms">이용약관</Link>
        <a href="https://github.com/2taeyoon/PrintGuard-AI" target="_blank" rel="noreferrer">GitHub</a>
      </footer>
    </div>
  );
}
