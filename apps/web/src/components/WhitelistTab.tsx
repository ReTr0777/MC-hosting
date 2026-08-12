'use client';

import React, { useEffect, useState } from 'react';

interface WhitelistEntry {
  uuid: string;
  name: string;
  isOp: boolean;
  opLevel: number | null;
  online: boolean;
  avatarUrl: string;
}

interface WhitelistSnapshot {
  enabled: boolean;
  enforce: boolean;
  onlineMode: boolean;
  live: boolean;
  count: number;
  entries: WhitelistEntry[];
  unlistedOps: string[];
}

const EMPTY: WhitelistSnapshot = {
  enabled: false,
  enforce: false,
  onlineMode: true,
  live: false,
  count: 0,
  entries: [],
  unlistedOps: [],
};

export default function WhitelistTab({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<WhitelistSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fetchWhitelist = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/whitelist`);
      const data = await res.json();
      if (res.ok) {
        setSnapshot({ ...EMPTY, ...data });
      } else {
        setMessage({ kind: 'err', text: data.error || 'Failed to load whitelist' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: 'Network error loading whitelist' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWhitelist();
    const interval = setInterval(fetchWhitelist, 15000);
    return () => clearInterval(interval);
  }, [serverId]);

  const runAction = async (action: 'add' | 'remove' | 'on' | 'off' | 'reload', username?: string) => {
    setBusy(`${action}-${username || ''}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/whitelist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, username }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: data.message });
        if (action === 'add') setNewName('');
        await fetchWhitelist();
      } else {
        setMessage({ kind: 'err', text: data.error || 'Whitelist action failed' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
      setMessage({ kind: 'err', text: 'Usernames must be 3-16 letters, digits or underscores.' });
      return;
    }
    runAction('add', name);
  };

  const visible = snapshot.entries.filter((e) =>
    e.name.toLowerCase().includes(filter.trim().toLowerCase())
  );
  const onlineCount = snapshot.entries.filter((e) => e.online).length;

  if (loading) {
    return <div className="text-center py-12 text-slate-500 text-sm animate-pulse">Reading whitelist.json from the server...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <span>Whitelist</span>
            <span className="bg-emerald-500/20 text-emerald-400 text-xs px-2.5 py-0.5 rounded-full border border-emerald-500/30">
              {snapshot.count} Allowed
            </span>
            {snapshot.enabled ? (
              <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-emerald-500/30">
                Enforcing
              </span>
            ) : (
              <span className="bg-slate-700/40 text-slate-400 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-slate-600/40">
                Not Enforcing
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Everyone permitted to join this server, read live from <code className="text-slate-300">whitelist.json</code>.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={fetchWhitelist}
            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-xl border border-slate-700 transition"
          >
            Refresh
          </button>
          {canManage && (
            <button
              onClick={() => runAction(snapshot.enabled ? 'off' : 'on')}
              disabled={!!busy}
              className={`text-xs px-4 py-2 rounded-xl border font-bold transition disabled:opacity-50 ${
                snapshot.enabled
                  ? 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border-amber-500/20'
                  : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/20'
              }`}
            >
              {snapshot.enabled ? 'Turn Whitelist Off' : 'Turn Whitelist On'}
            </button>
          )}
        </div>
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

      {/* Status strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Whitelisted" value={String(snapshot.count)} tone="slate" />
        <StatTile label="Online Now" value={String(onlineCount)} tone={onlineCount > 0 ? 'emerald' : 'slate'} />
        <StatTile
          label="Enforcement"
          value={snapshot.enabled ? 'ON' : 'OFF'}
          tone={snapshot.enabled ? 'emerald' : 'amber'}
        />
        <StatTile
          label="Server State"
          value={snapshot.live ? 'Live' : 'Offline'}
          tone={snapshot.live ? 'emerald' : 'slate'}
        />
      </div>

      {!snapshot.enabled && snapshot.count > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-xs text-amber-300">
          This list has {snapshot.count} {snapshot.count === 1 ? 'entry' : 'entries'} but{' '}
          <code className="text-amber-200">white-list=false</code> — anyone can currently join. Turn enforcement on to
          apply it.
        </div>
      )}

      {!snapshot.onlineMode && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 text-xs text-slate-300">
          This server runs in <strong>offline mode</strong>. Whitelist entries are matched by username rather than
          Mojang UUID, and new names can only be added while the server is running.
        </div>
      )}

      {snapshot.unlistedOps.length > 0 && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 text-xs text-slate-300">
          {snapshot.unlistedOps.length} operator{snapshot.unlistedOps.length === 1 ? '' : 's'} not on this list:{' '}
          <span className="text-white font-semibold">{snapshot.unlistedOps.join(', ')}</span>. Operators are still
          rejected by an enforced whitelist unless they are added here.
        </div>
      )}

      {/* Add + filter controls */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        {canManage && (
          <form onSubmit={handleAdd} className="flex items-center gap-2 flex-wrap">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Minecraft username"
              className="flex-1 min-w-[200px] bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/60"
            />
            <button
              type="submit"
              disabled={!!busy || !newName.trim()}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-emerald-600/20 transition"
            >
              {busy?.startsWith('add') ? 'Adding...' : '＋ Add to Whitelist'}
            </button>
            {snapshot.live && (
              <button
                type="button"
                onClick={() => runAction('reload')}
                disabled={!!busy}
                title="Re-read whitelist.json into the running server"
                className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2.5 rounded-xl border border-slate-700 transition disabled:opacity-40"
              >
                ↻ Reload
              </button>
            )}
          </form>
        )}

        {snapshot.count > 6 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter whitelisted players..."
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-slate-600"
          />
        )}

        {snapshot.count === 0 ? (
          <div className="text-center py-10">
            <h3 className="text-base font-bold text-white mb-1">Whitelist Is Empty</h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              No players are on the allow-list yet. {canManage
                ? 'Add a username above to let them through.'
                : 'Ask a server admin to add you.'}
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-500">No whitelisted player matches “{filter}”.</div>
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
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-white text-sm truncate">{entry.name}</span>
                      {entry.isOp && (
                        <span
                          title={entry.opLevel ? `Operator level ${entry.opLevel}` : 'Operator'}
                          className="bg-amber-500/20 text-amber-300 text-[10px] font-extrabold uppercase px-1.5 py-0.5 rounded border border-amber-500/30 flex-shrink-0"
                        >
                          OP
                        </span>
                      )}
                    </div>
                    {entry.online ? (
                      <span className="text-[11px] text-emerald-400 flex items-center space-x-1 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        <span>Online now</span>
                      </span>
                    ) : (
                      <span
                        title={entry.uuid || 'No UUID recorded'}
                        className="text-[10px] text-slate-600 font-mono block truncate mt-0.5"
                      >
                        {entry.uuid || 'no uuid'}
                      </span>
                    )}
                  </div>
                </div>

                {canManage && (
                  <button
                    onClick={() => runAction('remove', entry.name)}
                    disabled={!!busy}
                    title={`Remove ${entry.name} from the whitelist`}
                    className="p-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg border border-red-500/20 text-xs font-bold transition disabled:opacity-40 flex-shrink-0"
                  >
                    ✕
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
          : 'The server is offline — changes are written to whitelist.json and apply on next start.'}
      </p>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone: 'slate' | 'emerald' | 'amber' }) {
  const toneCls =
    tone === 'emerald' ? 'text-emerald-400' : tone === 'amber' ? 'text-amber-400' : 'text-slate-200';
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">{label}</div>
      <div className={`text-lg font-extrabold mt-0.5 ${toneCls}`}>{value}</div>
    </div>
  );
}
