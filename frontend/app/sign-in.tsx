"use client";

// 헤더 오른쪽에 서는 로그인 조각. 상태는 전부 lib/auth.ts가 들고 있고 여기서는 그리기만 한다.
//
// **로그인은 선택이다.** 하지 않아도 검사는 다 된다. 다만 그때 기록은 이 브라우저에만 남고,
// 로그인하면 그때까지 한 일이 구글 계정으로 옮겨 가 다른 기기에서도 보인다.
import Image from "next/image";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  clearMoved, mountButton, sessionServerSnapshot, sessionSnapshot, signOut, silentSignIn,
  subscribeSession, type Session,
} from "@/lib/auth";

export function useSession(): Session {
  return useSyncExternalStore(subscribeSession, sessionSnapshot, sessionServerSnapshot);
}

/** 구글이 그린 단추를 이 자리에 붙인다. 모양을 직접 그리면 구글 약관에 걸린다. */
function GoogleButton() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) void mountButton(el).catch(() => undefined); // 실패 사유는 아래 제목(title)에 남는다
  }, []);
  return <div className="gbtn" ref={box} />;
}

/** 헤더 오른쪽. 로그인 전에는 구글 단추, 로그인한 뒤에는 계정과 로그아웃.
 *  화면이 열릴 때 조용한 로그인도 여기서 한 번 시도한다(앱 어디에 있든 한 번만 돈다). */
export default function SignIn() {
  const { account, busy, error, ready, moved, tied } = useSession();
  useEffect(() => { void silentSignIn(); }, []);
  // 옮겨 온 의뢰 알림은 한 번만 보여 주고 스스로 사라진다
  useEffect(() => {
    if (!moved) return;
    const t = setTimeout(clearMoved, 8000);
    return () => clearTimeout(t);
  }, [moved]);

  if (busy) return <span className="acct"><span className="note">로그인 중…</span></span>;
  if (!account) {
    return (
      <span className="acct" title={error || "로그인하면 지금까지 한 검수가 구글 계정으로 옮겨 가, 다른 기기에서도 보입니다"}>
        {ready ? <GoogleButton /> : <span className="note">확인 중…</span>}
      </span>
    );
  }
  // 로그인했다 = 프로필 사진과 이름. 단추는 사라진다.
  return (
    <span className="acct" title={account.email}>
      {moved > 0 && <span className="acct_moved">검수 {moved}건을 이 계정으로 옮겼습니다</span>}
      {/* 구글 로그인은 됐는데 에이전트가 꺼져 있으면 의뢰를 계정에 묶지 못한다. 그 사실만 조용히 알린다 */}
      {!tied && <span className="acct_off" title={error || "에이전트가 꺼져 있어 의뢰를 계정에 묶지 못합니다"}>에이전트 꺼짐</span>}
      {account.picture
        ? <Image className="acct_pic" src={account.picture} alt="" width={28} height={28} unoptimized />
        : <span className="acct_no" aria-hidden>{(account.name || account.email || "?").slice(0, 1)}</span>}
      <b>{account.name || account.email}</b>
      <button type="button" className="ghost small" onClick={signOut}>로그아웃</button>
    </span>
  );
}

/** 로그인이 무엇을 바꾸는지 한 줄로 알려 준다. 막지는 않는다 — 검사는 로그인 없이 그대로 된다. */
export function SignInNote() {
  const { account } = useSession();
  if (account) return null;
  return (
    <p className="note signin_note">
      로그인하지 않아도 검수는 전부 됩니다. 다만 의뢰 목록과 소통 기록이 <b>이 브라우저에만</b> 남습니다.
      오른쪽 위에서 구글로 로그인하면 지금까지 한 것이 그 계정으로 옮겨 가고, 다른 기기에서도 이어서 볼 수 있습니다.
    </p>
  );
}
