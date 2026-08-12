'use client';

import React, { useState } from 'react';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, errorMessage, isValidUsername, USERNAME_HINT } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { Chip, EmptyState, InlineError, LoadingLine, Mono, PanelHeader, PlayerAvatar } from '@/components/ui';

interface BanEntry {
  uuid: string;
  name: string;
  reason: string;
  source: string;
  created: string | null;
  expires: string | null;
  avatarUrl: string;
}

interface BanSnapshot {
  live: boolean;
  count: number;
  entries: BanEntry[];
}

const EMPTY: BanSnapshot = { live: false, count: 0, entries: [] };

export default function BanListTab({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newReason, setNewReason] = useState('');
  const [filter, setFilter] = useState('');

  const { data: snapshot, loading, error, refresh } = usePolledResource<BanSnapshot>(
    `/api/servers/${serverId}/bans`,
    EMPTY,
    { intervalMs: 15000, select: (raw) => ({ ...EMPTY, ...raw }) }
  );

  const runAction = async (action: 'ban' | 'unban', username: string, reason?: string) => {
    setBusy(`${action}-${username}`);
    try {
      const data = await apiPost(`/api/servers/${serverId}/bans`, { action, username, reason });
      toast.success(data?.message || (action === 'ban' ? `Banned ${username}` : `Unbanned ${username}`));
      if (action === 'ban') {
        setNewName('');
        setNewReason('');
      }
      await refresh();
    } catch (err) {
      toast.error(action === 'ban' ? `Could not ban ${username}` : `Could not unban ${username}`, errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleBan = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (!isValidUsername(name)) {
      toast.error('That username looks wrong', USERNAME_HINT);
      return;
    }
    const ok = await confirm({
      title: `Ban ${name}?`,
      message: `${name} will be disconnected if online and blocked from rejoining until you unban them here.`,
      confirmLabel: 'Ban player',
      danger: true,
    });
    if (ok) runAction('ban', name, newReason.trim() || undefined);
  };

  const handleUnban = async (name: string) => {
    const ok = await confirm({
      title: `Unban ${name}?`,
      message: `${name} will be able to join this server again straight away.`,
      confirmLabel: 'Unban',
    });
    if (ok) runAction('unban', name);
  };

  const needle = filter.trim().toLowerCase();
  const visible = needle ? snapshot.entries.filter((e) => e.name.toLowerCase().includes(needle)) : snapshot.entries;

  if (loading) return <LoadingLine>Reading banned-players.json from the server…</LoadingLine>;

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader
        title="Ban List"
        chips={<Chip tone={snapshot.count > 0 ? 'danger' : 'default'}>{snapshot.count} banned</Chip>}
        description={<>Everyone currently banned, read live from <Mono>banned-players.json</Mono>.</>}
        actions={<button onClick={refresh} className="cc-btn-ghost">Refresh</button>}
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      <div className="cc-panel" style={{ display: 'grid', gap: '14px' }}>
        {canManage && (
          <form onSubmit={handleBan} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Minecraft username"
              aria-label="Minecraft username to ban"
              className="cc-input"
              style={{ flex: 1, minWidth: '160px' }}
            />
            <input
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              placeholder="Reason (optional)"
              aria-label="Ban reason"
              className="cc-input"
              style={{ flex: 1, minWidth: '160px' }}
            />
            <button type="submit" disabled={!!busy || !newName.trim()} className="cc-btn-danger" style={{ fontWeight: 700 }}>
              {busy?.startsWith('ban') ? 'Banning…' : 'Ban player'}
            </button>
          </form>
        )}

        {snapshot.count > 6 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter banned players…"
            aria-label="Filter banned players"
            className="cc-input"
          />
        )}

        {snapshot.count === 0 ? (
          <EmptyState
            title="No one is banned"
            description={canManage ? 'Ban a username above to block them from joining.' : 'No players are currently banned.'}
          />
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            No banned player matches “{filter}”.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px' }}>
            {visible.map((entry) => (
              <div key={entry.uuid || entry.name} className="cc-row">
                <div className="cc-row-main">
                  <PlayerAvatar src={entry.avatarUrl} name={entry.name} size={36} />
                  <div style={{ minWidth: 0 }}>
                    <span className="cc-row-title" style={{ display: 'block' }}>{entry.name}</span>
                    <span
                      className="cc-row-sub"
                      title={entry.reason}
                      style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {entry.reason || 'No reason recorded'}
                    </span>
                  </div>
                </div>

                {canManage && (
                  <button
                    onClick={() => handleUnban(entry.name)}
                    disabled={!!busy}
                    title={`Unban ${entry.name}`}
                    aria-label={`Unban ${entry.name}`}
                    className="cc-btn-ghost"
                    style={{ padding: '4px 10px', color: 'var(--accent)', borderColor: 'var(--accent-border)' }}
                  >
                    {busy === `unban-${entry.name}` ? '…' : 'Unban'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
        {snapshot.live
          ? 'Changes are sent as console commands and take effect immediately.'
          : 'The server is offline — changes are written to banned-players.json and apply on next start.'}
      </p>
    </div>
  );
}
