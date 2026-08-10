'use client';

import React, { useState } from 'react';

export default function BroadcastBar({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  if (!canManage) return null;

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || sending) return;

    setSending(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus({ kind: 'ok', text: 'Broadcast sent' });
        setMessage('');
      } else {
        setStatus({ kind: 'err', text: data.error || 'Broadcast failed' });
      }
    } catch {
      setStatus({ kind: 'err', text: 'Network error sending broadcast' });
    } finally {
      setSending(false);
      setTimeout(() => setStatus(null), 4000);
    }
  };

  return (
    <form onSubmit={handleSend} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Broadcast a message to all players..."
        maxLength={256}
        style={{
          flex: 1,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '8px 12px',
          fontSize: '0.8125rem',
          color: 'var(--text-primary)',
        }}
      />
      <button
        type="submit"
        disabled={sending || !message.trim()}
        className="cc-btn-secondary"
        style={{ opacity: sending || !message.trim() ? 0.4 : 1, borderRadius: '6px', padding: '8px 16px', minHeight: '38px', flexShrink: 0 }}
      >
        {sending ? 'Sending...' : 'Broadcast'}
      </button>
      {status && (
        <span style={{ fontSize: '0.75rem', color: status.kind === 'ok' ? 'var(--accent)' : '#f87171', whiteSpace: 'nowrap' }}>
          {status.text}
        </span>
      )}
    </form>
  );
}
