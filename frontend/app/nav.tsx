"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

const TABS = [
  { href: "/", label: "인쇄 검수" },
  { href: "/papers", label: "종이 안내" },
  { href: "/shops", label: "인쇄소 지도" },
  { href: "/help", label: "도움말·평가 측정표" },
];

// 상단 헤더 셸. 768px 이하에서는 메뉴 버튼으로 메뉴를 펼친다.
export default function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className={`RouteApp${open ? " open" : ""}`}>
      <header className="topbar">
        <div className="topbar_inner">
          <Link href="/" className="brand" onClick={() => setOpen(false)}>PrintGuard AI</Link>
          <nav className="topmenu" aria-label="메뉴">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} className={path === t.href ? "on" : ""} onClick={() => setOpen(false)}>{t.label}</Link>
            ))}
          </nav>
          <span className="topbar_desc">서버 없이 이 브라우저 안에서만 처리</span>
          <button type="button" className="icon_btn menu_btn" aria-label={open ? "메뉴 닫기" : "메뉴 열기"} aria-expanded={open}
            onClick={() => setOpen((o) => !o)}>{open ? "✕" : "☰"}</button>
        </div>
      </header>
      <div className="content">{children}</div>
    </div>
  );
}
