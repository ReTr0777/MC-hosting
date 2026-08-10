'use client';

import React, { useEffect, useState } from 'react';

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

const EMPTY: BanSnapshot = {
  live: false,
  count: 0,
  entries: [],
};

export default function BanListTab({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<BanSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newReason, setNewReason] = useState('');
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fetchBans = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/bans`);
      const data = await res.json();
      if (res.ok) {
        setSnapshot({ ...EMPTY, ...data });
      } else {
        setMessage({ kind: 'err', text: data.error || 'Failed to load ban list' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: 'Network error loading ban list' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBans();
    const interval = setInterval(fetchBans, 15000);
    return () => clearInterval(interval);
  }, [serverId]);

  const runAction = async (action: 'ban' | 'unban', username: string, reason?: string) => {
    setBusy(`${action}-${username}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/bans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, username, reason }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: data.message });
        if (action === 'ban') {
          setNewName('');
          setNewReason('');
        }
        await fetchBans();
      } else {
        setMessage({ kind: 'err', text: data.error || 'Ban action failed' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const handleBan = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
      setMessage({ kind: 'err', text: 'Usernames must be 3-16 letters, digits or underscores.' });
      return;
    }
    runAction('ban', name, newReason.trim() || undefined);
  };

  const visible = snapshot.entries.filter((e) =>
    e.name.toLowerCase().includes(filter.trim().toLowerCase())
  );

  if (loading) {
    return <div className="text-center py-12 text-slate-500 text-sm animate-pulse">Reading banned-players.json from the server...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <span>🔨 Ban List</span>
            <span className="bg-red-500/20 text-red-400 text-xs px-2.5 py-0.5 rounded-full border border-red-500/30">
              {snapshot.count} Banned
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Everyone currently banned from this server, read live from <code className="text-slate-300">banned-players.json</code>.
          </p>
        </div>

        <button
          onClick={fetchBans}
          className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-xl border border-slate-700 transition"
        >
          🔄 Refresh
        </button>
      </div>

      {message && (
        <div
          className={`p-4 rounded-xl text-xs font-semibold ${
            message.kind === 'err'
              ? 'bg-red-500/10 text-red-400 border border-red-500/20'
              : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Add + filter controls */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        {canManage && (
          <form onSubmit={handleBan} className="flex items-center gap-2 flex-wrap">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Minecraft username"
              className="flex-1 min-w-[160px] bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-red-500/60"
            />
            <input
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              placeholder="Reason (optional)"
              className="flex-1 min-w-[160px] bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-red-500/60"
            />
            <button
              type="submit"
              disabled={!!busy || !newName.trim()}
              className="bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-red-600/20 transition"
            >
              {busy?.startsWith('ban') ? 'Banning...' : '🔨 Ban Player'}
            </button>
          </form>
        )}

        {snapshot.count > 6 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter banned players..."
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-slate-600"
          />
        )}

        {snapshot.count === 0 ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-3">✅</div>
            <h3 className="text-base font-bold text-white mb-1">No One Is Banned</h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              {canManage ? 'Ban a username above to block them from joining.' : 'No players are currently banned.'}
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-500">No banned player matches “{filter}”.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {visible.map((entry) => (
              <div
                key={entry.uuid || entry.name}
                className="bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl p-4 flex items-center justify-between gap-3 transition"
              >
                <div className="flex items-center space-x-3 min-w-0">
                  <img
                    src={entry.avatarUrl}
                    alt={entry.name}
                    className="w-10 h-10 rounded-lg bg-slate-900 border border-slate-800 flex-shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = 'https://mc-heads.net/avatar/MHF_Steve/64';
                    }}
                  />
                  <div className="min-w-0">
                    <span className="font-bold text-white text-sm truncate block">{entry.name}</span>
                    <span title={entry.reason} className="text-[11px] text-slate-500 truncate block mt-0.5">
                      {entry.reason}
                    </span>
                  </div>
                </div>

                {canManage && (
                  <button
                    onClick={() => runAction('unban', entry.name)}
                    disabled={!!busy}
                    title={`Unban ${entry.name}`}
                    className="p-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-lg border border-emerald-500/20 text-xs font-bold transition disabled:opacity-40 flex-shrink-0"
                  >
                    {busy === `unban-${entry.name}` ? '...' : 'Unban'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-600">
        {snapshot.live
          ? 'Changes are sent as console commands and take effect immediately.'
          : 'The server is offline — changes are written to banned-players.json and apply on next start.'}
      </p>
    </div>
  );
}
