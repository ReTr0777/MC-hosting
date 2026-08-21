'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Mono, Notice } from '@/components/ui';

/**
 * Turning your own PC into a node, without an administrator in the loop.
 *
 * The old path needed one: an admin invented a daemon key, created the node by hand and
 * emailed a config file containing that key in plaintext. That is fine for a fleet the
 * operator owns and impossible for a customer who wants to run a world on the machine
 * under their desk.
 *
 * So this asks the panel for a short code and shows it. The desktop app takes the code,
 * registers the machine itself with a key it generated locally, and the node appears —
 * owned by this account, invisible to everyone else. The dialog polls until that happens
 * so the last step is confirmed here rather than guessed at from the node list.
 */

const RELEASES_URL = 'https://github.com/ReTr0777/MC-hosting/releases/latest';
const POLL_MS = 3000;

interface ClaimedNode {
  id: string;
  name: string;
  host: string;
  port: number;
  isOnline: boolean;
}

interface Issued {
  code: string;
  enrollmentId: string;
  expiresAt: string;
  panelUrl: string;
}

/** mm:ss left, or null once there is nothing left. */
function countdown(expiresAt: string, now: number): string | null {
  const left = new Date(expiresAt).getTime() - now;
  if (left <= 0) return null;
  const total = Math.floor(left / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function ConnectMachineModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  /** Lets the page refresh its node list once a machine has actually joined. */
  onConnected?: () => void;
}) {
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<Issued | null>(null);
  const [claimed, setClaimed] = useState<ClaimedNode | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Kept in a ref as well so the poll below does not have to be torn down and rebuilt
  // every second just because the countdown re-rendered.
  const enrollmentId = issued?.enrollmentId ?? null;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const request = useCallback(async () => {
    setBusy(true);
    setError(null);
    setExpired(false);
    setClaimed(null);
    try {
      const res = await fetch('/api/nodes/enroll/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not get a setup code.');
      setIssued(data);
      setNow(Date.now());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [name]);

  // One ticker for the countdown. Cheap, and it stops as soon as the code is spent.
  useEffect(() => {
    if (!issued || claimed || expired) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [issued, claimed, expired]);

  useEffect(() => {
    if (!enrollmentId || claimed || expired) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch(`/api/nodes/enroll/code?id=${enrollmentId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.claimed && data.node) {
          setClaimed(data.node);
          onConnectedRef.current?.();
        } else if (data.expired) {
          setExpired(true);
        }
      } catch {
        // A poll that fails changes nothing: the code is still valid and the next one
        // is three seconds away. Showing an error here would bury the code itself.
      }
    };

    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enrollmentId, claimed, expired]);

  const remaining = issued && !claimed ? countdown(issued.expiresAt, now) : null;
  useEffect(() => {
    if (issued && !claimed && remaining === null) setExpired(true);
  }, [issued, claimed, remaining]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused outright; the value is on screen to be read.
    }
  };

  return (
    <Modal title="Connect a machine of your own" onClose={onClose} width={560}>
      {claimed ? (
        <div style={{ display: 'grid', gap: '14px' }}>
          <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--accent)' }}>
            {claimed.name} is connected.
          </div>
          <Notice>
            The panel reaches it at <Mono>{`${claimed.host}:${claimed.port}`}</Mono>. It may show as
            offline for a few seconds while the node app restarts its agent — that is the last step
            of joining, not a fault. After that you can create servers on it, or move an existing
            server across from the server page.
          </Notice>
          <button className="cc-btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : !issued ? (
        <div style={{ display: 'grid', gap: '14px' }}>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.65, margin: 0 }}>
            Run your servers on your own PC. You install the node app on that machine, type in a
            setup code, and it joins your account as a private node — nobody else can see it or
            place anything on it.
          </p>
          <Notice tone="warning">
            The machine needs <strong>Docker Desktop</strong> installed, and has to stay switched on
            for your servers to be reachable.
          </Notice>
          <div>
            <label
              htmlFor="machine-name"
              style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}
            >
              What should it be called? (optional)
            </label>
            <input
              id="machine-name"
              className="cc-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Living room PC"
              maxLength={60}
            />
          </div>
          {error && (
            <div style={{ fontSize: '0.75rem', color: 'var(--danger)', background: 'rgba(248,81,73,0.08)', padding: '10px 12px', borderRadius: '6px' }}>
              {error}
            </div>
          )}
          <button className="cc-btn-primary" onClick={request} disabled={busy}>
            {busy ? 'Getting a code…' : 'Get a setup code'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '14px' }}>
          <div
            style={{
              textAlign: 'center',
              padding: '16px',
              borderRadius: '10px',
              border: '1px dashed var(--border-2)',
              background: 'var(--surface)',
              opacity: expired ? 0.45 : 1,
            }}
          >
            <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
              Setup code
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.75rem', fontWeight: 800, letterSpacing: '0.12em', color: 'var(--text-primary)', margin: '6px 0' }}>
              {issued.code}
            </div>
            <div style={{ fontSize: '0.72rem', color: expired ? 'var(--danger)' : 'var(--text-muted)' }}>
              {expired ? 'This code has expired.' : `Expires in ${remaining}`}
            </div>
          </div>

          {expired ? (
            <button className="cc-btn-primary" onClick={request} disabled={busy}>
              {busy ? 'Getting a code…' : 'Get a new code'}
            </button>
          ) : (
            <>
              <ol style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.8, paddingLeft: '18px', margin: 0 }}>
                <li>
                  On that machine, install{' '}
                  <a href={RELEASES_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                    MC Hosting Node
                  </a>
                  {' '}and Docker Desktop.
                </li>
                <li>
                  Open the node app and go to <strong>Connection → Connect to a panel</strong>.
                </li>
                <li>
                  Enter this panel&apos;s address and the code above, then press Connect.
                </li>
              </ol>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>Panel address</span>
                <Mono>{issued.panelUrl}</Mono>
                <button
                  className="cc-btn"
                  style={{ fontSize: '0.7rem', padding: '4px 10px' }}
                  onClick={() => copy(issued.panelUrl)}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>

              <Notice>
                Waiting for the machine to check in… leave this open and it will say so the moment
                it does. Nothing here is a secret worth guarding for long: the code works once and
                only in the next few minutes.
              </Notice>
            </>
          )}

          {error && (
            <div style={{ fontSize: '0.75rem', color: 'var(--danger)', background: 'rgba(248,81,73,0.08)', padding: '10px 12px', borderRadius: '6px' }}>
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
