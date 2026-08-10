'use client';

import React, { useEffect, useState } from 'react';

interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  events: string[];
  urlPreview: string;
  createdAt: string;
}

interface Delivery {
  id: string;
  eventType: string;
  severity: string;
  title: string;
  status: string;
  detail: string | null;
  createdAt: string;
}

const EVENT_LABELS: Record<string, string> = {
  SERVER_CRASHED: '💥 Server crashed',
  SERVER_STARTED: '🟢 Server started',
  SERVER_STOPPED: '⏹️ Server stopped',
  NODE_OFFLINE: '🔴 Node offline',
  NODE_ONLINE: '🟩 Node back online',
  BACKUP_COMPLETED: '💾 Backup completed',
  BACKUP_FAILED: '⚠️ Backup failed',
};

// TEST is delivery-only; it is never something you subscribe to
const SUBSCRIBABLE = Object.keys(EVENT_LABELS);

export default function AlertsPanel() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [type, setType] = useState<'DISCORD' | 'GENERIC'>('DISCORD');
  const [events, setEvents] = useState<string[]>([]);

  const fetchData = async () => {
    try {
      const res = await fetch('/api/notifications');
      const data = await res.json();
      if (res.ok) {
        setChannels(data.channels || []);
        setDeliveries(data.deliveries || []);
      } else {
        setMessage({ kind: 'err', text: data.error || 'Failed to load alert settings' });
      }
    } catch {
      setMessage({ kind: 'err', text: 'Network error loading alert settings' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const toggleEvent = (evt: string) => {
    setEvents((prev) => (prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt]));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('create');
    setMessage(null);
    try {
      const res = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, type, events }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: `Channel "${name}" added.` });
        setName('');
        setUrl('');
        setEvents([]);
        await fetchData();
      } else {
        setMessage({ kind: 'err', text: data.error || 'Failed to add channel' });
      }
    } catch (err: any) {
      setMessage({ kind: 'err', text: err.message || 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async (channelId?: string) => {
    setBusy(`test-${channelId || 'new'}`);
    setMessage(null);
    try {
      const res = await fetch('/api/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(channelId ? { channelId } : { url, type }),
      });
      const data = await res.json();
      setMessage(res.ok ? { kind: 'ok', text: data.message } : { kind: 'err', text: data.error });
      if (res.ok && channelId) await fetchData();
    } catch (err: any) {
      setMessage({ kind: 'err', text: err.message || 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const handleToggle = async (channel: Channel) => {
    setBusy(`toggle-${channel.id}`);
    try {
      await fetch(`/api/notifications/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !channel.enabled }),
      });
      await fetchData();
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (channel: Channel) => {
    if (!confirm(`Delete alert channel "${channel.name}"? Its delivery history will be removed too.`)) return;
    setBusy(`delete-${channel.id}`);
    try {
      await fetch(`/api/notifications/${channel.id}`, { method: 'DELETE' });
      await fetchData();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="text-center py-10 text-slate-500 text-sm animate-pulse">Loading alert channels...</div>;
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h2 className="text-base font-bold text-sky-400 flex items-center space-x-2">
          <span>🔔 Alerts &amp; Webhooks</span>
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Get notified in Discord when a server crashes, a node drops, or a backup fails. The panel polls every node in
          the background and fires these on state changes.
        </p>
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

      {/* Existing channels */}
      {channels.length > 0 && (
        <div className="space-y-2">
          {channels.map((c) => (
            <div
              key={c.id}
              className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex items-start justify-between gap-4 flex-wrap"
            >
              <div className="min-w-0">
                <div className="flex items-center space-x-2">
                  <span className="font-bold text-white text-sm">{c.name}</span>
                  <span className="bg-slate-800 text-slate-400 text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-slate-700">
                    {c.type}
                  </span>
                  {c.enabled ? (
                    <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-emerald-500/30">
                      Active
                    </span>
                  ) : (
                    <span className="bg-slate-700/40 text-slate-400 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-slate-600/40">
                      Paused
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 font-mono mt-1 truncate">{c.urlPreview}</div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {c.events.length === 0
                    ? 'All events'
                    : c.events.map((e) => EVENT_LABELS[e] || e).join(' · ')}
                </div>
              </div>

              <div className="flex items-center space-x-2 flex-shrink-0">
                <button
                  onClick={() => handleTest(c.id)}
                  disabled={!!busy}
                  className="text-xs bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 px-3 py-1.5 rounded-lg border border-sky-500/20 font-bold transition disabled:opacity-40"
                >
                  {busy === `test-${c.id}` ? 'Sending...' : 'Test'}
                </button>
                <button
                  onClick={() => handleToggle(c)}
                  disabled={!!busy}
                  className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 transition disabled:opacity-40"
                >
                  {c.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  onClick={() => handleDelete(c)}
                  disabled={!!busy}
                  className="text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-1.5 rounded-lg border border-red-500/20 font-bold transition disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <form onSubmit={handleCreate} className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">Add a channel</div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Admin Discord)"
            className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/60"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://discord.com/api/webhooks/..."
            className="md:col-span-2 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/60"
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400">Format:</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as 'DISCORD' | 'GENERIC')}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
          >
            <option value="DISCORD">Discord embed</option>
            <option value="GENERIC">Generic JSON</option>
          </select>
        </div>

        <div>
          <div className="text-xs text-slate-400 mb-2">
            Events — leave all unchecked to receive <strong className="text-slate-200">everything</strong>.
          </div>
          <div className="flex flex-wrap gap-2">
            {SUBSCRIBABLE.map((evt) => (
              <button
                key={evt}
                type="button"
                onClick={() => toggleEvent(evt)}
                className={`text-[11px] px-3 py-1.5 rounded-lg border font-semibold transition ${
                  events.includes(evt)
                    ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                    : 'bg-slate-900 text-slate-400 border-slate-700 hover:border-slate-600'
                }`}
              >
                {EVENT_LABELS[evt]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!!busy || !name.trim() || !url.trim()}
            className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-sky-600/20 transition"
          >
            {busy === 'create' ? 'Adding...' : '＋ Add Channel'}
          </button>
          <button
            type="button"
            onClick={() => handleTest()}
            disabled={!!busy || !url.trim()}
            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2.5 rounded-xl border border-slate-700 transition disabled:opacity-40"
          >
            {busy === 'test-new' ? 'Sending...' : 'Test before saving'}
          </button>
        </div>
      </form>

      {/* Delivery history */}
      <div>
        <div className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">Recent deliveries</div>
        {deliveries.length === 0 ? (
          <div className="text-xs text-slate-500 py-4">
            Nothing sent yet. Add a channel and hit Test to confirm it works.
          </div>
        ) : (
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {deliveries.map((d) => (
              <div
                key={d.id}
                className="bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <span className="text-slate-200 font-semibold">{d.title}</span>
                  {d.detail && <span className="text-red-400 ml-2">— {d.detail}</span>}
                </div>
                <div className="flex items-center space-x-3 flex-shrink-0">
                  <span
                    className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border ${
                      d.status === 'SUCCESS'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'bg-red-500/10 text-red-400 border-red-500/20'
                    }`}
                  >
                    {d.status}
                  </span>
                  <span className="text-slate-600 text-[10px] font-mono">
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
