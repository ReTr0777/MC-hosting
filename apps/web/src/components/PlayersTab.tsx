'use client';

import React, { useState } from 'react';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { Chip, EmptyState, InlineError, PanelHeader, PlayerAvatar, SkeletonRows } from '@/components/ui';

interface Player {
  username: string;
  isOp: boolean;
  avatarUrl: string;
}

type Action = 'op' | 'deop' | 'kick' | 'ban';

const ACTION_LABEL: Record<Action, string> = {
  op: 'Granted operator',
  deop: 'Removed operator',
  kick: 'Kicked',
  ban: 'Banned',
};

export default function PlayersTab({ serverId, canManage = true }: { serverId: string; canManage?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, error, refresh } = usePolledResource<Player[]>(
    `/api/servers/${serverId}/players`,
    [],
    { intervalMs: 5000, select: (raw) => raw?.players ?? [] }
  );

  const handleAction = async (username: string, action: Action) => {
    // Kicking and banning are disruptive and were previously one misclick away.
    if (action === 'kick' || action === 'ban') {
      const ok = await confirm({
        title: action === 'ban' ? `Ban ${username}?` : `Kick ${username}?`,
        message:
          action === 'ban'
            ? `${username} will be disconnected and blocked from rejoining until you unban them from the Ban List tab.`
            : `${username} will be disconnected immediately. They can rejoin straight away unless you also ban them.`,
        confirmLabel: action === 'ban' ? 'Ban player' : 'Kick player',
        danger: true,
      });
      if (!ok) return;
    }

    setBusy(`${username}-${action}`);
    try {
      await apiPost(`/api/servers/${serverId}/players`, { username, action });
      toast.success(`${ACTION_LABEL[action]} ${username}`);
      await refresh();
    } catch (err) {
      toast.error(`Could not ${action} ${username}`, errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const players = data;

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader
        title="Online Players"
        chips={<Chip tone={players.length > 0 ? 'accent' : 'default'}>{players.length} online</Chip>}
        description="Live roster of connected players, with operator and moderation controls."
        actions={
          <button onClick={refresh} className="cc-btn-ghost" disabled={loading}>
            Refresh
          </button>
        }
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      {loading ? (
        <SkeletonRows rows={3} />
      ) : players.length === 0 ? (
        <EmptyState
          title="No players online"
          description="When someone joins this server they'll appear here, along with controls to op, kick or ban them."
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '10px' }}>
          {players.map((player) => (
            <div key={player.username} className="cc-row">
              <div className="cc-row-main">
                <PlayerAvatar src={player.avatarUrl} name={player.username} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className="cc-row-title">{player.username}</span>
                    {player.isOp && <Chip tone="warning" title="Server operator">OP</Chip>}
                  </div>
                  <span className="cc-row-sub" style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--accent)' }}>
                    <span
                      className="pulse-dot"
                      style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }}
                    />
                    Connected
                  </span>
                </div>
              </div>

              {canManage && (
                <div className="cc-row-actions">
                  <button
                    onClick={() => handleAction(player.username, player.isOp ? 'deop' : 'op')}
                    disabled={!!busy}
                    title={player.isOp ? 'Revoke operator privileges' : 'Grant operator privileges'}
                    className={player.isOp ? 'cc-btn-warning' : 'cc-btn-ghost'}
                    style={{ padding: '5px 10px' }}
                  >
                    {player.isOp ? 'De-OP' : 'OP'}
                  </button>
                  <button
                    onClick={() => handleAction(player.username, 'kick')}
                    disabled={!!busy}
                    title="Disconnect this player"
                    className="cc-btn-ghost"
                    style={{ padding: '5px 10px' }}
                  >
                    Kick
                  </button>
                  <button
                    onClick={() => handleAction(player.username, 'ban')}
                    disabled={!!busy}
                    title="Disconnect and block this player"
                    className="cc-btn-danger"
                    style={{ padding: '5px 10px' }}
                  >
                    Ban
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
