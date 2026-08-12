'use client';

import React, { useEffect, useState } from 'react';
import { useConfirm } from '@/context/ConfirmContext';

interface Share {
  id: string;
  token: string;
  label: string | null;
  enabled: boolean;
  expiresAt: string | null;
  hasPassword: boolean;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
}

interface MapState {
  supported: boolean | null;
  installed: boolean;
  platform?: string;
  jarName?: string | null;
  configuredPort?: number | null;
  bluemapPort: number | null;
  bluemapEnabled: boolean;
  isProcessMode: boolean;
  needsContainerRebuild: boolean;
  reason?: string;
  daemonError?: string;
  shares: Share[];
}

export default function MapTab({
  serverId,
  serverStatus,
  canManage,
}: {
  serverId: string;
  serverStatus: string;
  canManage: boolean;
}) {
  const confirm = useConfirm();
  const [state, setState] = useState<MapState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [expiry, setExpiry] = useState('0');
  const [diagnosis, setDiagnosis] = useState<{
    checks: Array<{ name: string; ok: boolean; detail: string }>;
    summary: string;
    healthy: boolean;
    crashLog?: string[];
    crashHint?: string | null;
  } | null>(null);

  const runDiagnose = async () => {
    setBusy('diagnose');
    setDiagnosis(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/bluemap/diagnose`);
      const data = await res.json();
      if (res.ok) setDiagnosis(data);
      else setMessage({ kind: 'err', text: data.error || 'Diagnosis failed' });
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const fetchState = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/bluemap`);
      const data = await res.json();
      if (res.ok) setState(data);
      else setMessage({ kind: 'err', text: data.error || 'Failed to load map status' });
    } catch {
      setMessage({ kind: 'err', text: 'Network error loading map status' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchState();
  }, [serverId]);

  const runAction = async (action: string) => {
    setBusy(action);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/bluemap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      setMessage(res.ok ? { kind: 'ok', text: data.message || 'Done.' } : { kind: 'err', text: data.error });
      await fetchState();
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const createShare = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('share');
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/bluemap/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, password, expiresInHours: Number(expiry) }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: 'Share link created.' });
        setLabel('');
        setPassword('');
        setExpiry('0');
        await fetchState();
      } else {
        setMessage({ kind: 'err', text: data.error });
      }
    } finally {
      setBusy(null);
    }
  };

  const updateShare = async (share: Share, body: Record<string, unknown>) => {
    setBusy(`share-${share.id}`);
    try {
      await fetch(`/api/servers/${serverId}/bluemap/shares/${share.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await fetchState();
    } finally {
      setBusy(null);
    }
  };

  const deleteShare = async (share: Share) => {
    const ok = await confirm({
      title: 'Delete this share link?',
      message: 'Anyone currently using the link loses access to the map immediately. You can always create a new link later.',
      confirmLabel: 'Delete link',
      danger: true,
    });
    if (!ok) return;
    setBusy(`share-${share.id}`);
    try {
      await fetch(`/api/servers/${serverId}/bluemap/shares/${share.id}`, { method: 'DELETE' });
      await fetchState();
    } finally {
      setBusy(null);
    }
  };

  const shareUrl = (token: string) =>
    typeof window !== 'undefined' ? `${window.location.origin}/map/${token}` : `/map/${token}`;

  const copy = (token: string) => {
    navigator.clipboard?.writeText(shareUrl(token));
    setMessage({ kind: 'ok', text: 'Link copied to clipboard.' });
  };

  if (loading) {
    return <div className="text-center py-12 text-slate-500 text-sm animate-pulse">Checking BlueMap status...</div>;
  }

  if (!state) return null;

  if (state.supported === false) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center">
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>No map yet</div>
        <h3 className="text-base font-bold text-white mb-1">BlueMap isn&apos;t available for this server</h3>
        <p className="text-xs text-slate-400 max-w-md mx-auto">{state.reason}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <span>Live World Map</span>
            {state.installed ? (
              <span className="bg-emerald-500/20 text-emerald-400 text-xs px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                Installed
              </span>
            ) : (
              <span className="bg-slate-700/40 text-slate-400 text-xs px-2.5 py-0.5 rounded-full border border-slate-600/40">
                Not installed
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            BlueMap renders your world as an explorable 3D map. Share it publicly without giving anyone panel access.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={runDiagnose}
            disabled={!!busy}
            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-xl border border-slate-700 transition disabled:opacity-40"
          >
            {busy === 'diagnose' ? 'Checking...' : 'Diagnose'}
          </button>
          {state.installed && state.bluemapPort && (
            <a
              href={`/map/preview-${serverId}`}
              onClick={(e) => {
                e.preventDefault();
                const first = state.shares.find((s) => s.enabled);
                if (first) window.open(shareUrl(first.token), '_blank');
                else setMessage({ kind: 'err', text: 'Create a share link below to open the map.' });
              }}
              className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-xl border border-slate-700 transition"
            >
              ↗ Open map
            </a>
          )}
          {canManage && (
            <button
              onClick={() => runAction(state.installed ? 'uninstall' : 'install')}
              disabled={!!busy}
              className={`text-xs px-4 py-2 rounded-xl border font-bold transition disabled:opacity-40 ${
                state.installed
                  ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/20'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500'
              }`}
            >
              {busy === 'install' ? 'Installing...' : busy === 'uninstall' ? 'Removing...' : state.installed ? 'Uninstall' : 'Install BlueMap'}
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

      {diagnosis && (
        <div
          className={`rounded-xl p-5 space-y-3 border ${
            diagnosis.healthy ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-slate-900 border-slate-800'
          }`}
        >
          <div className="text-sm font-bold text-white">
            {diagnosis.healthy ? 'Map pipeline looks healthy' : 'First problem found'}
          </div>
          {!diagnosis.healthy && <p className="text-xs text-amber-300 leading-relaxed">{diagnosis.summary}</p>}

          <div className="space-y-1">
            {diagnosis.checks.map((c) => (
              <div key={c.name} className="flex items-start gap-2 text-xs">
                <span className="flex-shrink-0 mt-0.5" style={{ color: c.ok ? 'var(--accent)' : 'var(--danger)', fontWeight: 700 }}>{c.ok ? '✓' : '✕'}</span>
                <div className="min-w-0">
                  <span className={c.ok ? 'text-slate-300' : 'text-white font-semibold'}>{c.name}</span>
                  <span className="text-slate-500"> — {c.detail}</span>
                </div>
              </div>
            ))}
          </div>

          {diagnosis.crashHint && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-200 leading-relaxed">
              <strong>Likely cause:</strong> {diagnosis.crashHint}
            </div>
          )}

          {diagnosis.crashLog && diagnosis.crashLog.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
                Show last {diagnosis.crashLog.length} console lines
              </summary>
              <pre className="mt-2 bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto text-[11px] text-slate-400 max-h-72 overflow-y-auto whitespace-pre-wrap">
                {diagnosis.crashLog.join('\n')}
              </pre>
            </details>
          )}
        </div>
      )}

      {state.daemonError && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-xs text-amber-300">
          Could not reach the daemon for map status: {state.daemonError}
        </div>
      )}

      {/* Container rebuild notice */}
      {state.needsContainerRebuild && canManage && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-5 space-y-3">
          <div className="text-sm font-bold text-amber-300">One-time container rebuild needed</div>
          <p className="text-xs text-amber-200/80 leading-relaxed">
            Docker can&apos;t add a port to a container that already exists, so this server&apos;s container has to be
            rebuilt once to publish the map port ({state.bluemapPort}). Your world is stored in a named volume and is
            pulled to the host first — <strong>world data is not affected</strong>. The server must be stopped.
          </p>
          <button
            onClick={() => runAction('rebuild-container')}
            disabled={!!busy || serverStatus === 'RUNNING' || serverStatus === 'STARTING'}
            className="text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 px-4 py-2 rounded-xl border border-amber-500/40 font-bold transition disabled:opacity-40"
          >
            {busy === 'rebuild-container'
              ? 'Rebuilding...'
              : serverStatus === 'RUNNING' || serverStatus === 'STARTING'
              ? 'Stop the server first'
              : 'Rebuild container'}
          </button>
        </div>
      )}

      {/* Status tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Platform" value={state.platform ? state.platform.toUpperCase() : '—'} />
        <Tile label="Map port" value={state.bluemapPort ? String(state.bluemapPort) : '—'} />
        <Tile label="Mode" value={state.isProcessMode ? 'Process' : 'Docker'} />
        <Tile label="Share links" value={String(state.shares.filter((s) => s.enabled).length)} />
      </div>

      {state.installed && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 text-xs text-slate-300">
          BlueMap renders in the background and can take a long time on a large world — often hours for the first
          full pass. The map is viewable while it renders; it just fills in progressively.
        </div>
      )}

      {/* Share links */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">Public share links</div>

        {state.shares.length === 0 ? (
          <p className="text-xs text-slate-500 py-2">
            No share links yet. Create one below to give people the map — and only the map.
          </p>
        ) : (
          <div className="space-y-2">
            {state.shares.map((s) => {
              const expired = s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
              return (
                <div
                  key={s.id}
                  className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex items-start justify-between gap-3 flex-wrap"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center space-x-2 flex-wrap gap-1">
                      <span className="font-bold text-white text-sm">{s.label || 'Untitled link'}</span>
                      {s.hasPassword && (
                        <span className="bg-sky-500/20 text-sky-300 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-sky-500/30">
                          Password
                        </span>
                      )}
                      {expired ? (
                        <span className="bg-red-500/20 text-red-300 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-red-500/30">
                          Expired
                        </span>
                      ) : s.enabled ? (
                        <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-emerald-500/30">
                          Active
                        </span>
                      ) : (
                        <span className="bg-slate-700/40 text-slate-400 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-slate-600/40">
                          Revoked
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono mt-1 truncate">{shareUrl(s.token)}</div>
                    <div className="text-[11px] text-slate-500 mt-1">
                      {s.viewCount} view{s.viewCount === 1 ? '' : 's'}
                      {s.expiresAt && !expired && ` · expires ${new Date(s.expiresAt).toLocaleString()}`}
                      {s.lastViewedAt && ` · last opened ${new Date(s.lastViewedAt).toLocaleString()}`}
                    </div>
                  </div>

                  {canManage && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => copy(s.token)}
                        className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 transition"
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => updateShare(s, { enabled: !s.enabled })}
                        disabled={!!busy}
                        className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 transition disabled:opacity-40"
                      >
                        {s.enabled ? 'Revoke' : 'Restore'}
                      </button>
                      <button
                        onClick={() => deleteShare(s)}
                        disabled={!!busy}
                        className="text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-1.5 rounded-lg border border-red-500/20 font-bold transition disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canManage && (
          <form onSubmit={createShare} className="border-t border-slate-800 pt-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (e.g. Discord friends)"
                className="bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/60"
              />
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password (optional)"
                className="bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/60"
              />
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none"
              >
                <option value="0">Never expires</option>
                <option value="24">Expires in 24 hours</option>
                <option value="168">Expires in 7 days</option>
                <option value="720">Expires in 30 days</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={!!busy}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-emerald-600/20 transition"
            >
              {busy === 'share' ? 'Creating...' : '＋ Create share link'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">{label}</div>
      <div className="text-lg font-extrabold mt-0.5 text-slate-200">{value}</div>
    </div>
  );
}
