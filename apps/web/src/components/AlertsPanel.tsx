'use client';

import React, { useState } from 'react';
import { useConfirm } from '@/context/ConfirmContext';
import { useToast } from '@/context/ToastContext';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { Chip, InlineError, LoadingLine, PanelHeader } from '@/components/ui';

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

interface AlertsData {
  channels: Channel[];
  deliveries: Delivery[];
}

const EVENT_LABELS: Record<string, string> = {
  SERVER_CRASHED: 'Server crashed',
  SERVER_STARTED: 'Server started',
  SERVER_STOPPED: 'Server stopped',
  NODE_OFFLINE: 'Node offline',
  NODE_ONLINE: 'Node back online',
  BACKUP_COMPLETED: 'Backup completed',
  BACKUP_FAILED: 'Backup failed',
};

// TEST is delivery-only; it is never something you subscribe to.
const SUBSCRIBABLE = Object.keys(EVENT_LABELS);

const EMPTY: AlertsData = { channels: [], deliveries: [] };

export default function AlertsPanel() {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [type, setType] = useState<'DISCORD' | 'GENERIC'>('DISCORD');
  const [events, setEvents] = useState<string[]>([]);

  const { data, loading, error, refresh } = usePolledResource<AlertsData>('/api/notifications', EMPTY, {
    select: (raw) => ({ channels: raw?.channels ?? [], deliveries: raw?.deliveries ?? [] }),
  });

  const { channels, deliveries } = data;

  const toggleEvent = (evt: string) =>
    setEvents((prev) => (prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt]));

  /** Catches the most common paste mistake before the request is made. */
  const urlLooksValid = (value: string) => {
    try {
      const parsed = new URL(value.trim());
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlLooksValid(url)) {
      toast.error('That webhook URL looks wrong', 'Paste the full https:// URL from Discord.');
      return;
    }

    setBusy('create');
    try {
      await apiPost('/api/notifications', { name: name.trim(), url: url.trim(), type, events });
      toast.success(`Channel “${name.trim()}” added`);
      setName('');
      setUrl('');
      setEvents([]);
      await refresh();
    } catch (err) {
      toast.error('Could not add the channel', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async (channelId?: string) => {
    setBusy(`test-${channelId || 'new'}`);
    try {
      const result = await apiPost('/api/notifications/test', channelId ? { channelId } : { url: url.trim(), type });
      toast.success(result?.message || 'Test notification sent');
      if (channelId) await refresh();
    } catch (err) {
      toast.error('Test notification failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleToggle = async (channel: Channel) => {
    setBusy(`toggle-${channel.id}`);
    try {
      await apiRequest(`/api/notifications/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !channel.enabled }),
      });
      toast.success(channel.enabled ? `Paused “${channel.name}”` : `Resumed “${channel.name}”`);
      await refresh();
    } catch (err) {
      // The old version ignored the response entirely, so a failed toggle looked like it worked.
      toast.error('Could not update the channel', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (channel: Channel) => {
    const ok = await confirm({
      title: 'Delete this alert channel?',
      message: (
        <>
          <strong style={{ color: 'var(--text-primary)' }}>{channel.name}</strong> will stop receiving notifications, and its
          delivery history is removed with it.
        </>
      ),
      confirmLabel: 'Delete channel',
      danger: true,
    });
    if (!ok) return;

    setBusy(`delete-${channel.id}`);
    try {
      await apiRequest(`/api/notifications/${channel.id}`, { method: 'DELETE' });
      toast.success(`Deleted “${channel.name}”`);
      await refresh();
    } catch (err) {
      toast.error('Could not delete the channel', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <LoadingLine>Loading alert channels…</LoadingLine>;

  return (
    <div className="cc-panel" style={{ display: 'grid', gap: '20px' }}>
      <PanelHeader
        title="Alerts & Webhooks"
        chips={channels.length > 0 ? <Chip>{channels.length} channel{channels.length === 1 ? '' : 's'}</Chip> : undefined}
        description="Get notified in Discord when a server crashes, a node drops, or a backup fails. The panel polls every node in the background and fires these on state changes."
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      {channels.length > 0 && (
        <div style={{ display: 'grid', gap: '8px' }}>
          {channels.map((c) => (
            <div key={c.id} className="cc-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span className="cc-row-title">{c.name}</span>
                  <Chip>{c.type}</Chip>
                  <Chip tone={c.enabled ? 'accent' : 'default'}>{c.enabled ? 'Active' : 'Paused'}</Chip>
                </div>
                <div className="cc-row-sub" style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.urlPreview}
                </div>
                <div className="cc-row-sub">
                  {c.events.length === 0 ? 'All events' : c.events.map((e) => EVENT_LABELS[e] || e).join(' · ')}
                </div>
              </div>

              <div className="cc-row-actions">
                <button onClick={() => handleTest(c.id)} disabled={!!busy} className="cc-btn-ghost" style={{ padding: '4px 10px' }}>
                  {busy === `test-${c.id}` ? 'Sending…' : 'Test'}
                </button>
                <button onClick={() => handleToggle(c)} disabled={!!busy} className="cc-btn-ghost" style={{ padding: '4px 10px' }}>
                  {c.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  onClick={() => handleDelete(c)}
                  disabled={!!busy}
                  aria-label={`Delete ${c.name}`}
                  className="cc-btn-danger"
                  style={{ padding: '4px 10px' }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <form onSubmit={handleCreate} style={{ display: 'grid', gap: '14px', background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '18px' }}>
        <div className="cc-section-title">Add a channel</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(240px, 2fr)', gap: '10px' }}>
          <div>
            <label className="cc-label" htmlFor="alert-name">Name</label>
            <input
              id="alert-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Admin Discord"
              className="cc-input"
            />
          </div>
          <div>
            <label className="cc-label" htmlFor="alert-url">Webhook URL</label>
            <input
              id="alert-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              className="cc-input"
            />
          </div>
        </div>

        <div>
          <label className="cc-label" htmlFor="alert-format">Payload format</label>
          <select
            id="alert-format"
            value={type}
            onChange={(e) => setType(e.target.value as 'DISCORD' | 'GENERIC')}
            className="cc-input"
            style={{ maxWidth: '220px' }}
          >
            <option value="DISCORD">Discord embed</option>
            <option value="GENERIC">Generic JSON</option>
          </select>
        </div>

        <div>
          <span className="cc-label">Events</span>
          <p className="cc-help" style={{ margin: '0 0 10px' }}>
            Leave everything unchecked to receive <strong style={{ color: 'var(--text-primary)' }}>all</strong> events.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {SUBSCRIBABLE.map((evt) => {
              const on = events.includes(evt);
              return (
                <button
                  key={evt}
                  type="button"
                  onClick={() => toggleEvent(evt)}
                  aria-pressed={on}
                  className="cc-btn-ghost"
                  style={on ? { background: 'var(--accent-dim)', color: 'var(--accent)', borderColor: 'var(--accent-border)', fontWeight: 700 } : undefined}
                >
                  {EVENT_LABELS[evt]}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button type="submit" disabled={!!busy || !name.trim() || !url.trim()} className="cc-btn-primary">
            {busy === 'create' ? 'Adding…' : 'Add channel'}
          </button>
          <button type="button" onClick={() => handleTest()} disabled={!!busy || !url.trim()} className="cc-btn-ghost">
            {busy === 'test-new' ? 'Sending…' : 'Test before saving'}
          </button>
        </div>
      </form>

      {/* Delivery history */}
      <div>
        <div className="cc-section-title" style={{ marginBottom: '10px' }}>Recent deliveries</div>
        {deliveries.length === 0 ? (
          <p className="cc-help" style={{ margin: 0 }}>Nothing sent yet. Add a channel and hit Test to confirm it works.</p>
        ) : (
          <div style={{ display: 'grid', gap: '6px', maxHeight: '18rem', overflowY: 'auto' }}>
            {deliveries.map((d) => {
              const failed = d.status !== 'SUCCESS';
              return (
                <div
                  key={d.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px 12px',
                  }}
                >
                  <div style={{ minWidth: 0, fontSize: '0.75rem' }}>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{d.title}</span>
                    {d.detail && <span style={{ color: 'var(--danger)', marginLeft: '8px' }}>— {d.detail}</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                    <Chip tone={failed ? 'danger' : 'accent'}>{d.status}</Chip>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {formatRelative(d.createdAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
