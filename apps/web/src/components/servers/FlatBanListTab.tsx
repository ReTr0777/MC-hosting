'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { EmptyState, InlineError, LoadingLine, Mono, Notice, PanelHeader } from '@/components/ui';

/**
 * Ban list for games that keep one as a flat text file (Terraria's `banlist.txt`).
 *
 * A sibling of `BanListTab`, which handles Minecraft's structured
 * `banned-players.json` / `banned-ips.json` pair and is left untouched.
 *
 * Shows the file as the server actually wrote it rather than imposing a schema
 * on it: entries are a `//name` comment plus the identifier lines beneath, and
 * anything that does not fit that shape is still listed and still removable.
 */

interface BanEntry {
  name: string | null;
  identifiers: string[];
  lines: number[];
}

export default function FlatBanListTab({
  serverId,
  canManage = true,
}: { serverId: string; canManage?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [entries, setEntries] = useState<BanEntry[]>([]);
  const [fileName, setFileName] = useState('banlist.txt');
  const [raw, setRaw] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest(`/api/servers/${serverId}/banlist`);
      if (!mounted.current) return;
      setEntries(data?.entries || []);
      setRaw(data?.raw || '');
      if (data?.file) setFileName(data.file);
      setLoadError(null);
    } catch (err) {
      if (mounted.current) setLoadError(errorMessage(err, 'Could not load the ban list'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [serverId]);

  useEffect(() => { load(); }, [load]);

  const handleUnban = async (entry: BanEntry) => {
    const label = entry.name || entry.identifiers[0];
    const ok = await confirm({
      title: `Unban ${label}?`,
      message: `This removes the entry from ${fileName}. The server reads that file when it starts, so restart for it to take effect.`,
      confirmLabel: 'Unban',
    });
    if (!ok) return;

    setBusy(entry.identifiers[0]);
    try {
      const res = await apiPost(`/api/servers/${serverId}/banlist`, { unban: entry.identifiers[0] });
      toast.success(res?.message || `Unbanned ${label}`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove that ban'));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  if (loading) return <LoadingLine>Loading ban list…</LoadingLine>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader
        title="Bans"
        description={<>Kept in <Mono>{fileName}</Mono>, read by the server when it starts.</>}
        actions={
          <>
            <button onClick={() => setShowRaw((v) => !v)} className="cc-btn-ghost">
              {showRaw ? 'Hide file' : 'View file'}
            </button>
            <button onClick={load} className="cc-btn-ghost">Refresh</button>
          </>
        }
      />

      {loadError && <InlineError message={loadError} onRetry={load} />}

      {entries.length === 0 ? (
        <EmptyState
          title="Nobody is banned"
          description={<>Ban a player from the Players tab while they are connected, and they will appear here.</>}
        />
      ) : (
        <section className="cc-panel">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {entries.map((entry) => (
              <div
                key={entry.identifiers.join('|')}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                  padding: '12px 14px', background: 'var(--bg)', border: '1px solid var(--border-2)',
                  borderRadius: '8px',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {entry.name || <span style={{ color: 'var(--text-muted)' }}>Unnamed ban</span>}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-muted)',
                      marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                    title={entry.identifiers.join(', ')}
                  >
                    {entry.identifiers.join(', ')}
                  </div>
                </div>
                {canManage && (
                  <button
                    onClick={() => handleUnban(entry)}
                    disabled={busy === entry.identifiers[0]}
                    className="cc-btn-ghost"
                    style={{ padding: '5px 10px', flexShrink: 0 }}
                  >
                    {busy === entry.identifiers[0] ? 'Removing…' : 'Unban'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {showRaw && (
        <section className="cc-panel">
          <h3 className="cc-section-title" style={{ marginBottom: '10px' }}>{fileName}</h3>
          <Notice>
            Shown exactly as the server wrote it. Anything the list above does not recognise is
            still here.
          </Notice>
          <pre
            style={{
              marginTop: '12px', marginBottom: 0, padding: '12px', background: 'var(--bg)',
              border: '1px solid var(--border-2)', borderRadius: '8px',
              fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-primary)',
              overflowX: 'auto', whiteSpace: 'pre',
            }}
          >
            {raw || '(empty)'}
          </pre>
        </section>
      )}
    </div>
  );
}
