'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface SearchResults {
  servers: Array<{ id: string; name: string; description: string | null; status: string }>;
  players: Array<{ username: string; serverId: string; serverName: string }>;
  auditLogs: Array<{ id: string; action: string; details: string | null; createdAt: string }>;
}

const EMPTY: SearchResults = { servers: [], players: [], auditLogs: [] };

export default function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(EMPTY);
      setLoading(false);
      return;
    }

    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (res.ok) setResults(await res.json());
      } catch {
        // best-effort search — leave stale results on network error
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const hasResults = results.servers.length > 0 || results.players.length > 0 || results.auditLogs.length > 0;
  const showPanel = open && query.trim().length >= 2;

  const goTo = (path: string) => {
    setOpen(false);
    setQuery('');
    router.push(path);
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: '1 1 220px', maxWidth: '360px' }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Search servers, players, audit log..."
        className="cc-input"
        style={{ fontSize: '0.8125rem', padding: '6px 12px' }}
      />

      {showPanel && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            maxHeight: '400px',
            overflowY: 'auto',
            zIndex: 60,
          }}
        >
          {loading && (
            <div style={{ padding: '12px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>Searching...</div>
          )}

          {!loading && !hasResults && (
            <div style={{ padding: '12px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>No matches for &ldquo;{query}&rdquo;</div>
          )}

          {results.servers.length > 0 && (
            <div>
              <div style={{ padding: '8px 12px 4px', fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                Servers
              </div>
              {results.servers.map((s) => (
                <button
                  key={s.id}
                  onClick={() => goTo(`/dashboard/servers/${s.id}`)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.8125rem' }}
                >
                  {s.name} <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>({s.status})</span>
                </button>
              ))}
            </div>
          )}

          {results.players.length > 0 && (
            <div>
              <div style={{ padding: '8px 12px 4px', fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                Players
              </div>
              {results.players.map((p, i) => (
                <button
                  key={`${p.serverId}-${p.username}-${i}`}
                  onClick={() => goTo(`/dashboard/servers/${p.serverId}?tab=players`)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.8125rem' }}
                >
                  {p.username} <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>on {p.serverName}</span>
                </button>
              ))}
            </div>
          )}

          {results.auditLogs.length > 0 && (
            <div>
              <div style={{ padding: '8px 12px 4px', fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                Audit Log
              </div>
              {results.auditLogs.map((a) => (
                <div key={a.id} style={{ padding: '8px 12px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{a.action}</div>
                  {a.details && <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '2px' }}>{a.details.slice(0, 120)}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
