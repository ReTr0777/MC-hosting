'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The Discord link control in the header.
 *
 * It shows state rather than only an action: once an account is linked the button lights up
 * and says so, which is the only place in the panel that answers "did that actually work?".
 * Before, the button read "Link Discord" forever — identical whether you had linked five
 * minutes ago or never — so the only way to check was to go and try a command in Discord.
 */

/** How often the open modal asks whether the code has been used yet. */
const POLL_MS = 3000;
/** Matches the code TTL in /api/account/discord-link-code. */
const CODE_TTL_MS = 10 * 60_000;

export default function DiscordLinkButton() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** null while unknown, so the button never claims "not linked" before it has looked. */
  const [linked, setLinked] = useState<boolean | null>(null);
  const [discordUserId, setDiscordUserId] = useState<string | null>(null);
  const [justLinked, setJustLinked] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/account/discord', { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();
      setLinked(Boolean(data.linked));
      setDiscordUserId(data.discordUserId ?? null);
      return Boolean(data.linked);
    } catch {
      /*
       * Left as-is on a network error rather than reset to "not linked". Flipping a linked
       * badge off because one request failed would read as having been unlinked.
       */
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * While a code is on screen, poll. The link happens in Discord, in another window, and the
   * panel has no way to hear about it — without this the modal sits showing a code that has
   * already been used, and the person closes it not knowing whether it worked.
   */
  const pollingSince = useRef(0);
  useEffect(() => {
    if (!open || !code || linked) return;
    pollingSince.current = Date.now();
    const id = setInterval(async () => {
      if (Date.now() - pollingSince.current > CODE_TTL_MS) {
        clearInterval(id);
        return;
      }
      if (await refresh()) {
        setJustLinked(true);
        clearInterval(id);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [open, code, linked, refresh]);

  const generate = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/account/discord-link-code', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setCode(data.code);
      } else {
        setError(data.error || 'Failed to generate code');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const openModal = async () => {
    setOpen(true);
    setCode('');
    setError('');
    setJustLinked(false);
    // Checked again on open: the link may have been made from Discord since the page loaded,
    // and generating a code for an already-linked account would be busywork.
    const already = await refresh();
    if (!already) await generate();
  };

  const unlink = async () => {
    setUnlinking(true);
    setError('');
    try {
      const res = await fetch('/api/account/discord', { method: 'DELETE' });
      if (!res.ok) {
        setError('Failed to unlink');
        return;
      }
      setLinked(false);
      setDiscordUserId(null);
      setJustLinked(false);
      // Straight into the link flow: unlinking to re-link with a different Discord account
      // is the common reason to do it at all.
      await generate();
    } catch {
      setError('Network error');
    } finally {
      setUnlinking(false);
    }
  };

  const isLinked = linked === true;

  return (
    <>
      <button
        onClick={openModal}
        className="cc-btn-ghost"
        title={
          isLinked
            ? 'Discord is linked — click to manage'
            : 'Link your Discord account to control servers from Discord'
        }
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          ...(isLinked
            ? {
                background: 'var(--accent-dim)',
                borderColor: 'var(--accent-border)',
                color: 'var(--accent)',
                fontWeight: 600,
              }
            : {}),
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            // Unlit until the state is known, so a slow request never shows a false green dot.
            background: isLinked ? 'var(--accent)' : 'var(--text-muted)',
            opacity: linked === null ? 0.4 : 1,
            boxShadow: isLinked ? '0 0 6px var(--accent)' : 'none',
          }}
        />
        {isLinked ? 'Discord linked' : 'Link Discord'}
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(13,17,23,0.85)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 60 }}
        >
          <div onClick={(e) => e.stopPropagation()} className="cc-card" style={{ width: '100%', maxWidth: '380px', padding: '24px' }}>
            {isLinked ? (
              <>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: 'var(--accent)', textShadow: '0 0 8px var(--accent)' }}>●</span>
                  {justLinked ? 'Discord linked' : 'Discord is linked'}
                </h3>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.6 }}>
                  Run <code style={{ color: 'var(--accent)' }}>/servers</code> in Discord to manage your servers. Commands respect your existing panel permissions.
                </p>

                {discordUserId && (
                  <div style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                    background: 'var(--accent-dim)',
                    border: '1px solid var(--accent-border)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    color: 'var(--accent)',
                    marginBottom: '10px',
                    wordBreak: 'break-all',
                  }}>
                    Discord ID {discordUserId}
                  </div>
                )}
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                  Unlinking stops every Discord command for this account immediately. You can link again at any time.
                </p>

                {error && <div style={{ fontSize: '0.8125rem', color: 'var(--danger)', marginBottom: '10px' }}>{error}</div>}

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={unlink} disabled={unlinking} className="cc-btn-danger" style={{ flex: 1 }}>
                    {unlinking ? 'Unlinking...' : 'Unlink'}
                  </button>
                  <button onClick={() => setOpen(false)} className="cc-btn-ghost" style={{ flex: 1 }}>Close</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Link Discord Account</h3>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.6 }}>
                  In the CraftControl Discord bot, run <code style={{ color: 'var(--accent)' }}>/link</code> with this code to control your servers from Discord:
                </p>

                {loading && <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Generating code...</div>}
                {error && <div style={{ fontSize: '0.8125rem', color: 'var(--danger)' }}>{error}</div>}
                {code && (
                  <div style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '1.5rem',
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    textAlign: 'center',
                    background: 'var(--accent-dim)',
                    border: '1px solid var(--accent-border)',
                    borderRadius: '8px',
                    padding: '14px',
                    color: 'var(--accent)',
                    marginBottom: '10px',
                  }}>
                    {code}
                  </div>
                )}
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                  Expires in 10 minutes. This window updates by itself once you have run the command.
                </p>

                <button onClick={() => setOpen(false)} className="cc-btn-ghost" style={{ width: '100%' }}>Close</button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
