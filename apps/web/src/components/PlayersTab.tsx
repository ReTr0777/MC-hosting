'use client';

import React, { useState } from 'react';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { Chip, EmptyState, InlineError, PanelHeader, PlayerAvatar, SkeletonRows, StatTile } from '@/components/ui';

interface Player {
  username: string;
  isOp: boolean;
  avatarUrl: string;
  /** Seconds since this player connected. Absent on servers the presence tracker hasn't attached to. */
  onlineSeconds?: number;
}

interface KnownPlayer {
  id: string;
  username: string;
  uuid: string | null;
  avatarUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  playtimeSeconds: number;
  sessionCount: number;
}

interface PlayerHistory {
  players: KnownPlayer[];
  recentSessions: Array<{ id: string; username: string; joinedAt: string; leftAt: string; seconds: number }>;
  totals: { uniquePlayers: number; playtimeSeconds: number; sessions: number };
}

const EMPTY_HISTORY: PlayerHistory = {
  players: [],
  recentSessions: [],
  totals: { uniquePlayers: 0, playtimeSeconds: 0, sessions: 0 },
};

/** "3h 12m" / "12m" / "48s" — the shortest form that still reads unambiguously. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const elapsed = Math.round((Date.now() - then) / 1000);
  if (elapsed < 90) return 'just now';
  if (elapsed < 86400) return `${formatDuration(elapsed)} ago`;
  return new Date(iso).toLocaleDateString();
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

  const [view, setView] = useState<'online' | 'history'>('online');

  const { data, loading, error, refresh } = usePolledResource<Player[]>(
    `/api/servers/${serverId}/players`,
    [],
    { intervalMs: 5000, select: (raw) => raw?.players ?? [] }
  );

  // Only polled while the history view is open — it's a database read, not a liveness check, and
  // nothing in it changes faster than the monitor tick that writes it.
  const {
    data: history,
    loading: historyLoading,
    error: historyError,
    refresh: refreshHistory,
  } = usePolledResource<PlayerHistory>(`/api/servers/${serverId}/players/history`, EMPTY_HISTORY, {
    enabled: view === 'history',
    intervalMs: 60000,
    select: (raw) => ({ ...EMPTY_HISTORY, ...raw }),
  });

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
        title="Players"
        chips={
          <>
            <Chip tone={players.length > 0 ? 'accent' : 'default'}>{players.length} online</Chip>
            {history.totals.uniquePlayers > 0 && <Chip>{history.totals.uniquePlayers} known</Chip>}
          </>
        }
        description={
          view === 'online'
            ? 'Live roster of connected players, with operator and moderation controls.'
            : 'Everyone who has played here, ranked by total time on the server.'
        }
        actions={
          <>
            <button
              onClick={() => setView(view === 'online' ? 'history' : 'online')}
              className="cc-btn-ghost"
            >
              {view === 'online' ? 'Playtime' : 'Online now'}
            </button>
            <button
              onClick={() => (view === 'online' ? refresh() : refreshHistory())}
              className="cc-btn-ghost"
              disabled={view === 'online' ? loading : historyLoading}
            >
              Refresh
            </button>
          </>
        }
      />

      {view === 'history' ? (
        <PlayerHistoryView
          history={history}
          loading={historyLoading}
          error={historyError}
          onRetry={refreshHistory}
        />
      ) : (
        <>
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
                    {player.onlineSeconds !== undefined && player.onlineSeconds > 0
                      ? `Online for ${formatDuration(player.onlineSeconds)}`
                      : 'Connected'}
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
        </>
      )}
    </div>
  );
}

/**
 * Playtime leaderboard and recent visits.
 *
 * Split out rather than inlined because the online roster and the history answer different
 * questions — "who can I moderate right now" versus "who actually plays here" — and interleaving
 * them made both harder to read.
 */
function PlayerHistoryView({
  history,
  loading,
  error,
  onRetry,
}: {
  history: PlayerHistory;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [filter, setFilter] = useState('');

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? history.players.filter((p) => p.username.toLowerCase().includes(needle))
    : history.players;

  if (loading) return <SkeletonRows rows={4} />;

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      {error && <InlineError message={error} onRetry={onRetry} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
        <StatTile label="Unique players" value={history.totals.uniquePlayers} tone="accent" />
        <StatTile label="Total playtime" value={formatDuration(history.totals.playtimeSeconds)} />
        <StatTile label="Sessions" value={history.totals.sessions} />
      </div>

      {history.players.length === 0 ? (
        <EmptyState
          title="No playtime recorded yet"
          description="Sessions are recorded when a player disconnects, so this fills in after the first visit ends."
        />
      ) : (
        <div className="cc-panel" style={{ display: 'grid', gap: '12px' }}>
          {history.players.length > 8 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a player…"
              aria-label="Find a player"
              className="cc-input"
            />
          )}

          {visible.length === 0 ? (
            <EmptyState title="No matches" description={`Nobody matching "${filter.trim()}" has played here.`} />
          ) : (
            <div style={{ display: 'grid', gap: '8px' }}>
              {visible.map((player, index) => (
                <div key={player.id} className="cc-row">
                  <div className="cc-row-main">
                    <span
                      style={{
                        width: 22,
                        textAlign: 'right',
                        fontSize: '13px',
                        color: 'var(--text-secondary)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {needle ? '' : index + 1}
                    </span>
                    <PlayerAvatar src={player.avatarUrl} name={player.username} size={36} />
                    <div style={{ minWidth: 0 }}>
                      <span className="cc-row-title">{player.username}</span>
                      <span className="cc-row-sub">
                        {player.sessionCount} {player.sessionCount === 1 ? 'visit' : 'visits'} · first seen{' '}
                        {new Date(player.firstSeenAt).toLocaleDateString()} · last seen {formatWhen(player.lastSeenAt)}
                      </span>
                    </div>
                  </div>
                  <div className="cc-row-actions">
                    <Chip tone={index === 0 && !needle ? 'accent' : 'default'}>
                      {formatDuration(player.playtimeSeconds)}
                    </Chip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {history.recentSessions.length > 0 && (
        <div className="cc-panel" style={{ display: 'grid', gap: '10px' }}>
          <h3 style={{ margin: 0, fontSize: '15px' }}>Recent visits</h3>
          <div style={{ display: 'grid', gap: '6px' }}>
            {history.recentSessions.map((session) => (
              <div
                key={session.id}
                style={{
                  display: 'flex',
                  gap: '10px',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  fontSize: '13px',
                  color: 'var(--text-secondary)',
                }}
              >
                <strong style={{ color: 'var(--text-primary)', minWidth: '110px' }}>{session.username}</strong>
                <span>played {formatDuration(session.seconds)}</span>
                <span style={{ marginLeft: 'auto' }}>left {formatWhen(session.leftAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
