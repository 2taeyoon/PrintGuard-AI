"use client";

// 헤더 오른쪽에 서는 로그인 조각. 상태는 전부 lib/auth.ts가 들고 있고 여기서는 그리기만 한다.
//
// **로그인은 선택이다.** 하지 않아도 검사는 다 된다. 다만 그때 기록은 이 브라우저에만 남고,
// 로그인하면 그때까지 한 일이 구글 계정으로 옮겨 가 다른 기기에서도 보인다.
import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mcpStatus, orchestratorUp } from "@/lib/agentClient";
import {
  clearMoved, mountButton, sessionServerSnapshot, sessionSnapshot, signOut, silentSignIn,
  subscribeSession, type Session,
} from "@/lib/auth";

export function useSession(): Session {
  return useSyncExternalStore(subscribeSession, sessionSnapshot, sessionServerSnapshot);
}

/** 켜짐·꺼짐·확인 중 셋을 가린다. '아직 모른다'를 '꺼졌다'로 적으면 멀쩡한데 꺼진 것처럼 보인다. */
function Stat({ what, on, title }: { what: string; on: boolean | null; title?: string }) {
  const word = on === null ? "확인 중" : on ? (what.startsWith("DesignCraft") ? "연결됨" : "켜짐") : (what.startsWith("DesignCraft") ? "연결 안 됨" : "꺼짐");
  return <span className={`hstat ${on === null ? "wait" : on ? "on" : "off"}`} title={title}>{what} {word}</span>;
}

/** 헤더에 다는 상태 두 개 — 에이전트 검사와 DesignCraft MCP.
 *  에이전트는 /health 한 번이라 자주 물어도 되지만, DesignCraft는 MCP를 깨워 손을 맞추는 일이라
 *  비싸다. 그래서 주기를 따로 둔다(10초 / 60초). 에이전트가 꺼져 있으면 아예 묻지 않는다. */
function AgentStatus({ note }: { note?: string }) {
  const [up, setUp] = useState<boolean | null>(null);
  const [asked, setAsked] = useState<boolean | null>(null);
  // 에이전트가 꺼져 있으면 DesignCraft에게 물어볼 상대도 없다. 물어본 값 대신 '연결 안 됨'으로 읽는다
  // (효과 안에서 바로 상태를 바꾸면 렌더가 연쇄된다 — 그래서 상태가 아니라 계산으로 푼다)
  const dc = up === null ? null : up ? asked : false;

  useEffect(() => {
    let alive = true;
    const ping = () => orchestratorUp().then((ok) => { if (alive) setUp(ok); });
    void ping();
    const t = setInterval(ping, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!up) return;
    let alive = true;
    const ask = () => mcpStatus().then(
      (m) => { if (alive) setAsked(!!m.available); },
      () => { if (alive) setAsked(false); });
    ask();
    const t = setInterval(ask, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [up]);

  return (
    <>
      <Stat what="에이전트 검사" on={up} title={up ? note : undefined} />
      <Stat what="DesignCraft MCP" on={dc} />
    </>
  );
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

  // 상태 뱃지는 로그인과 상관없이 늘 보인다 — 에이전트가 켜져 있는지는 로그인하지 않은 사람도 알아야
  // 검사를 맡길 수 있는지 안다. 그 오른쪽에만 로그인 단추나 계정이 바뀌어 선다.
  return (
    <span className="acct" title={account ? account.email : (error || "로그인하면 지금까지 한 검수가 구글 계정으로 옮겨 가, 다른 기기에서도 보입니다")}>
      {moved > 0 && <span className="acct_moved">검수 {moved}건을 이 계정으로 옮겼습니다</span>}
      {/* 에이전트가 켜져 있는데도 계정에 못 붙었다면(설정 누락 같은) 그 사유를 이 뱃지에 달아 둔다 */}
      <AgentStatus note={!account || tied ? undefined : error || "로그인은 됐지만 의뢰를 계정에 묶지 못했습니다"} />
      {busy ? <span className="note">로그인 중…</span>
        : !account ? (ready ? <GoogleButton /> : <span className="note">확인 중…</span>)
          : (
            <>
              {account.picture
                ? <Image className="acct_pic" src={account.picture} alt="" width={28} height={28} unoptimized />
                : <span className="acct_no" aria-hidden>{(account.name || account.email || "?").slice(0, 1)}</span>}
              <b>{account.name || account.email}</b>
              <button type="button" className="ghost small" onClick={signOut}>로그아웃</button>
            </>
          )}
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
