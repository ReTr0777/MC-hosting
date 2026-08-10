'use client';

import React, { useEffect, useState } from 'react';

interface SleepConfig {
  sleepEnabled: boolean;
  sleepAfterMinutes: number;
}

interface DaemonSleep {
  sleeping: boolean;
  state: 'sleeping' | 'waking' | null;
  port: number | null;
  sleptAt?: string | null;
  lastWakeError?: string | null;
}

interface SleepSnapshot {
  config: SleepConfig;
  status: string;
  sleepEmptySince: string | null;
  lastSleptAt: string | null;
  lastWokeAt: string | null;
  daemon: DaemonSleep | null;
  daemonError: string | null;
}

const PRESETS = [5, 10, 15, 30, 60, 120];

function relative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function SleepTab({
  serverId,
  serverStatus,
  canManage,
  onChanged,
}: {
  serverId: string;
  serverStatus: string;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const [snap, setSnap] = useState<SleepSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(15);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/sleep`);
      const data = await res.json();
      if (res.ok) {
        setSnap(data);
        setMinutes(data.config.sleepAfterMinutes);
      } else {
        setMessage({ kind: 'err', text: data.error || 'Failed to load sleep settings' });
      }
    } catch {
      setMessage({ kind: 'err', text: 'Network error loading sleep settings' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [serverId]);

  const saveConfig = async (patch: Partial<SleepConfig>) => {
    setBusy('config');
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/sleep`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: 'Sleep settings saved' });
        await load();
      } else {
        setMessage({ kind: 'err', text: data.details || data.error || 'Save failed' });
      }
    } catch {
      setMessage({ kind: 'err', text: 'Network error saving settings' });
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: 'sleep' | 'wake' | 'cancel') => {
    setBusy(kind);
    setMessage(null);
    try {
      const url = kind === 'wake' ? `/api/servers/${serverId}/wake` : `/api/servers/${serverId}/sleep`;
      const method = kind === 'cancel' ? 'DELETE' : 'POST';
      const res = await fetch(url, { method });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: data.message || 'Done' });
        await load();
        onChanged?.();
      } else {
        setMessage({ kind: 'err', text: data.details || data.error || 'Action failed' });
      }
    } catch {
      setMessage({ kind: 'err', text: 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="text-slate-500 text-sm p-6">Loading sleep settings…</div>;
  }

  const config = snap?.config || { sleepEnabled: false, sleepAfterMinutes: 15 };
  const sleeping = snap?.status === 'SLEEPING' || snap?.daemon?.sleeping;
  const running = serverStatus === 'RUNNING';

  const emptyForMins = snap?.sleepEmptySince
    ? Math.floor((Date.now() - new Date(snap.sleepEmptySince).getTime()) / 60000)
    : null;
  const remaining =
    emptyForMins !== null ? Math.max(0, config.sleepAfterMinutes - emptyForMins) : null;

  return (
    <div className="animate-fadeIn space-y-4">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-white font-bold text-lg">
            {sleeping ? '🌙 Sleeping' : running ? '☀️ Awake' : '⏸️ Offline'}
          </h2>
          <p className="text-slate-400 text-xs mt-1 max-w-xl leading-relaxed">
            When nobody is online, the server can stop itself to free memory and CPU. It stays visible in the
            multiplayer list the whole time — the moment someone tries to join, it starts back up.
          </p>
        </div>

        {canManage && (
          <div className="flex items-center gap-2">
            {sleeping ? (
              <>
                <button
                  onClick={() => act('wake')}
                  disabled={busy !== null}
                  className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs rounded-xl px-4 py-2.5"
                >
                  {busy === 'wake' ? 'Waking…' : '☀️ Wake now'}
                </button>
                <button
                  onClick={() => act('cancel')}
                  disabled={busy !== null}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-semibold text-xs rounded-xl px-4 py-2.5 border border-slate-700"
                >
                  Stop holding port
                </button>
              </>
            ) : (
              <button
                onClick={() => act('sleep')}
                disabled={busy !== null || !running}
                title={running ? '' : 'The server must be running before it can be put to sleep'}
                className="bg-indigo-500/15 hover:bg-indigo-500/25 disabled:opacity-40 text-indigo-300 font-bold text-xs rounded-xl px-4 py-2.5 border border-indigo-500/30"
              >
                {busy === 'sleep' ? 'Sleeping…' : '🌙 Sleep now'}
              </button>
            )}
          </div>
        )}
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

      {snap?.daemonError && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-xs text-amber-300">
          ⚠️ Could not read live sleep state from the node: {snap.daemonError}
        </div>
      )}

      {sleeping && (
        <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 text-xs text-indigo-200 leading-relaxed">
          The node is holding port <strong>{snap?.daemon?.port ?? '—'}</strong> for this server. Players see it as
          online with a &quot;sleeping&quot; message, and joining wakes it automatically — they will be asked to
          reconnect once after about 30 seconds.
          {snap?.daemon?.lastWakeError && (
            <div className="mt-2 text-red-300">Last wake attempt failed: {snap.daemon.lastWakeError}</div>
          )}
        </div>
      )}

      {/* Countdown */}
      {!sleeping && running && config.sleepEnabled && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          {emptyForMins === null ? (
            <p className="text-xs text-slate-400">
              Players are online (or the server has not been polled yet). The idle timer starts once the server is
              empty.
            </p>
          ) : (
            <p className="text-xs text-slate-300">
              Empty for <strong className="text-white">{emptyForMins} min</strong> — sleeping in{' '}
              <strong className="text-emerald-400">{remaining} min</strong> unless somebody joins.
            </p>
          )}
        </div>
      )}

      {/* Settings */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-5">
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <span>
            <span className="text-white font-semibold text-sm">Sleep when empty</span>
            <span className="block text-slate-500 text-xs mt-0.5">
              Automatically stop the server after a period with no players.
            </span>
          </span>
          <input
            type="checkbox"
            checked={config.sleepEnabled}
            disabled={!canManage || busy !== null}
            onChange={(e) => saveConfig({ sleepEnabled: e.target.checked })}
            className="w-11 h-6 accent-emerald-500 cursor-pointer"
          />
        </label>

        <div className={config.sleepEnabled ? '' : 'opacity-40 pointer-events-none'}>
          <span className="text-white font-semibold text-sm">Idle time before sleeping</span>
          <div className="flex items-center gap-2 flex-wrap mt-3">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setMinutes(preset);
                  saveConfig({ sleepAfterMinutes: preset });
                }}
                disabled={!canManage || busy !== null}
                className={`text-xs font-semibold rounded-xl px-3 py-2 border ${
                  config.sleepAfterMinutes === preset
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                    : 'bg-slate-950 text-slate-400 border-slate-700 hover:border-slate-600'
                }`}
              >
                {preset < 60 ? `${preset} min` : `${preset / 60} hr`}
              </button>
            ))}

            <div className="flex items-center gap-2 ml-auto">
              <input
                type="number"
                min={1}
                max={1440}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                disabled={!canManage}
                className="w-24 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/60"
              />
              <button
                onClick={() => saveConfig({ sleepAfterMinutes: minutes })}
                disabled={!canManage || busy !== null || minutes === config.sleepAfterMinutes}
                className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-semibold text-xs rounded-xl px-4 py-2 border border-slate-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* History */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-slate-500 text-[0.65rem] uppercase tracking-wider font-bold">Last slept</div>
          <div className="text-white font-bold mt-1 text-sm">{relative(snap?.lastSleptAt)}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-slate-500 text-[0.65rem] uppercase tracking-wider font-bold">Last woke</div>
          <div className="text-white font-bold mt-1 text-sm">{relative(snap?.lastWokeAt)}</div>
        </div>
      </div>

      <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
        <strong className="text-slate-300">Worth knowing:</strong> waking takes as long as a normal start — usually
        20&ndash;60 seconds, longer for big modpacks. The first player to knock gets disconnected with a
        &quot;waking up&quot; message and needs to reconnect. Everyone joining after that connects normally.
      </div>
    </div>
  );
}
