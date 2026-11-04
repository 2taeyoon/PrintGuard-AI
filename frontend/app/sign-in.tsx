"use client";

// 구글 로그인 화면 조각. 상태는 전부 lib/auth.ts가 들고 있고 여기서는 그리기만 한다.
import Image from "next/image";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { mountButton, sessionServerSnapshot, sessionSnapshot, signOut, silentSignIn, subscribeSession, type Session } from "@/lib/auth";

export function useSession(): Session {
  return useSyncExternalStore(subscribeSession, sessionSnapshot, sessionServerSnapshot);
}

/** 화면이 열릴 때 한 번, 조용히 로그인을 시도한다. 구글 쪽 로그인이 살아 있으면 아무 일도 일어나지 않는다. */
export function SessionBoot() {
  useEffect(() => { void silentSignIn(); }, []);
  return null;
}

/** 구글이 그린 단추를 이 자리에 붙인다. 모양을 직접 그리면 구글 약관에 걸린다. */
export function GoogleButton() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) void mountButton(el).catch(() => undefined); // 실패 사유는 패널의 오류 줄이 보여 준다
  }, []);
  return <div className="gbtn" ref={box} />;
}

/** 상단 막대에 다는 계정 표시. 로그인하지 않았으면 아무것도 그리지 않는다
 *  (로그인 단추는 그것이 필요한 화면에만 둔다 — 종이 안내·인쇄소 지도에는 필요가 없다). */
export function AccountChip() {
  const { account } = useSession();
  if (!account) return null;
  return (
    <span className="acct" title={account.email}>
      {account.picture
        ? <Image src={account.picture} alt="" width={24} height={24} unoptimized />
        : <span className="acct_no" aria-hidden>{(account.name || account.email || "?").slice(0, 1)}</span>}
      <b>{account.name || account.email}</b>
      <button type="button" className="ghost small" onClick={signOut}>로그아웃</button>
    </span>
  );
}

/** 로그인해야 쓸 수 있는 화면 앞에 세우는 안내. 왜 필요한지까지 적는다 —
 *  "로그인하세요"만 있으면 파일을 올리지도 않았는데 왜 계정을 내놓아야 하는지 알 수 없다. */
export function SignInPanel({ what }: { what: string }) {
  const { busy, error, ready } = useSession();
  return (
    <section className="panel signin">
      <b>{what}에는 구글 로그인이 필요합니다</b>
      <p className="note">
        이 기능은 파일을 <b>에이전트를 돌리는 PC</b>로 보냅니다. 그 PC는 한 대인데 주소는 누구에게나 열려 있어서,
        주인을 가리지 않으면 남의 파일 이름과 소통 기록이 그대로 보입니다. 로그인한 계정이 그 주인이 됩니다.
      </p>
      <p className="note">
        받아 두는 것은 <b>구글이 알려 주는 계정 번호와 이름·이메일·프로필 사진</b>뿐이고, 비밀번호는 지나가지도 않습니다.{" "}
        <b>파일 안을 검사하는 데는 쓰지 않습니다.</b> 로그인 없이 쓰려면 위에서 <b>바로 검사</b>를 고르세요 —
        그쪽은 계산이 전부 이 브라우저 안에서 끝나므로 보낼 곳도, 가릴 주인도 없습니다.
      </p>
      {busy ? <span className="note">로그인 중…</span> : ready ? <GoogleButton /> : <span className="note">로그인 상태를 확인하는 중…</span>}
      {error && <div className="warn">{error}</div>}
    </section>
  );
}
