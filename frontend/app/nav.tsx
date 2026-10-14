"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

const TABS = [
  { href: "/", label: "PDF 검수" },
  { href: "/papers", label: "종이 안내" },
  { href: "/shops", label: "인쇄소 지도" },
];

// 디자인 시스템의 셸: 왼쪽 고정 사이드바(260px). 데스크톱에서는 접을 수 있고, 768px 이하에서는 상단 헤더의 메뉴 버튼으로 연다.
export default function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`RouteApp${open ? " open" : ""}${collapsed ? " collapsed" : ""}`}>
      <header className="header">
        <button type="button" className="icon_btn" aria-label="메뉴 열기" onClick={() => setOpen(true)}>☰</button>
        <span className="sidebar_brand">PrintGuard AI</span>
      </header>
      <aside className="sidebar" aria-label="메뉴">
        <div className="sidebar_head">
          <Link href="/" className="sidebar_brand">PrintGuard AI</Link>
          <button type="button" className="icon_btn" aria-label="메뉴 접기" onClick={() => { setCollapsed(true); setOpen(false); }}>‹</button>
        </div>
        <p className="sidebar_desc">인쇄 전 품질 검수 · 서버 없이 이 브라우저 안에서만 처리합니다.</p>
        <ul className="menu">
          {TABS.map((t) => (
            <li key={t.href}><Link href={t.href} className={path === t.href ? "on" : ""} onClick={() => setOpen(false)}>{t.label}</Link></li>
          ))}
        </ul>
      </aside>
      {collapsed && <button type="button" className="sidebar_reopen" aria-label="메뉴 펼치기" onClick={() => setCollapsed(false)}>›</button>}
      <div className="overlay" onClick={() => setOpen(false)} />
      <div className="content">{children}</div>
    </div>
  );
}
