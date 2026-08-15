'use client';

import React, { useState } from 'react';

export default function DiscordLinkButton() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  const openModal = () => {
    setOpen(true);
    setCode('');
    generate();
  };

  return (
    <>
      <button
        onClick={openModal}
        className="cc-btn-ghost"
      >
        Link Discord
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(13,17,23,0.85)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 60 }}
        >
          <div onClick={(e) => e.stopPropagation()} className="cc-card" style={{ width: '100%', maxWidth: '380px', padding: '24px' }}>
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
              Expires in 10 minutes. Server commands respect your existing panel permissions.
            </p>

            <button onClick={() => setOpen(false)} className="cc-btn-ghost" style={{ width: '100%' }}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
