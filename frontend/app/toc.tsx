"use client";

// 차례: 주소에 #을 남기지 않고 그 자리로 부드럽게 굴러간다(헤더 높이만큼 띄워서 멈춘다).
const HEADER = 88;

export default function Toc({ items }: { items: { id: string; label: string }[] }) {
  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - HEADER;
    window.scrollTo({ top: y, behavior: "smooth" });
  };
  return (
    <nav className="ev_toc panel" aria-label="차례">
      {items.map((it) => (
        <a key={it.id} href={`#${it.id}`} onClick={go(it.id)}>{it.label}</a>
      ))}
    </nav>
  );
}
