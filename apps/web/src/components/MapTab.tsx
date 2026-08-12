'use client';

import React, { useState } from 'react';
import { useConfirm } from '@/context/ConfirmContext';
import { useToast } from '@/context/ToastContext';
import { usePolledResource } from '@/hooks/usePolledResource';
import { useClipboard } from '@/hooks/useClipboard';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { Chip, EmptyState, InlineError, LoadingLine, Notice, PanelHeader, StatTile } from '@/components/ui';

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

interface Diagnosis {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  summary: string;
  healthy: boolean;
  crashLog?: string[];
  crashHint?: string | null;
}

const EMPTY: MapState = {
  supported: null,
  installed: false,
  bluemapPort: null,
  bluemapEnabled: false,
  isProcessMode: false,
  needsContainerRebuild: false,
  shares: [],
};

const EXPIRY_OPTIONS = [
  { value: '0', label: 'Never expires' },
  { value: '24', label: 'Expires in 24 hours' },
  { value: '168', label: 'Expires in 7 days' },
  { value: '720', label: 'Expires in 30 days' },
];

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
  const toast = useToast();
  const { copy } = useClipboard();

  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [expiry, setExpiry] = useState('0');
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);

  const { data: state, loading, error, refresh } = usePolledResource<MapState>(
    `/api/servers/${serverId}/bluemap`,
    EMPTY,
    { select: (raw) => ({ ...EMPTY, ...raw, shares: raw?.shares ?? [] }) }
  );

  const shareUrl = (token: string) =>
    typeof window !== 'undefined' ? `${window.location.origin}/map/${token}` : `/map/${token}`;

  const handleCopy = async (token: string) => {
    if (await copy(shareUrl(token))) toast.success('Link copied to the clipboard');
    else toast.error('Could not copy the link', 'Select the URL and copy it manually.');
  };

  const runDiagnose = async () => {
    setBusy('diagnose');
    setDiagnosis(null);
    try {
      setDiagnosis(await apiRequest(`/api/servers/${serverId}/bluemap/diagnose`));
    } catch (err) {
      toast.error('Diagnosis failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (action: string) => {
    if (action === 'uninstall') {
      const ok = await confirm({
        title: 'Uninstall BlueMap?',
        message: 'The BlueMap mod and its rendered map tiles are removed from this server. Your world itself is untouched, but re-installing means rendering the whole map again from scratch.',
        confirmLabel: 'Uninstall',
        danger: true,
      });
      if (!ok) return;
    }
    if (action === 'rebuild-container') {
      const ok = await confirm({
        title: 'Rebuild this container?',
        message: 'The container is recreated so the map port can be published. Your world lives in a named volume and is preserved, but the server will be down while this runs.',
        confirmLabel: 'Rebuild container',
      });
      if (!ok) return;
    }

    setBusy(action);
    try {
      const data = await apiPost(`/api/servers/${serverId}/bluemap`, { action });
      toast.success(data?.message || 'Done');
      await refresh();
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const createShare = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('share');
    try {
      await apiPost(`/api/servers/${serverId}/bluemap/shares`, {
        label: label.trim(),
        password,
        expiresInHours: Number(expiry),
      });
      toast.success('Share link created');
      setLabel('');
      setPassword('');
      setExpiry('0');
      await refresh();
    } catch (err) {
      // Previously this had no catch at all, so a failure surfaced as an unhandled rejection.
      toast.error('Could not create the share link', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const updateShare = async (share: Share, body: Record<string, unknown>) => {
    setBusy(`share-${share.id}`);
    try {
      await apiRequest(`/api/servers/${serverId}/bluemap/shares/${share.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.success(share.enabled ? 'Link revoked' : 'Link restored');
      await refresh();
    } catch (err) {
      toast.error('Could not update the link', errorMessage(err));
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
      await apiRequest(`/api/servers/${serverId}/bluemap/shares/${share.id}`, { method: 'DELETE' });
      toast.success('Share link deleted');
      await refresh();
    } catch (err) {
      toast.error('Could not delete the link', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const openMap = () => {
    const first = state.shares.find((s) => s.enabled);
    if (first) window.open(shareUrl(first.token), '_blank', 'noopener,noreferrer');
    else toast.info('No active share link', 'Create one below to open the map.');
  };

  if (loading) return <LoadingLine>Checking BlueMap status…</LoadingLine>;

  if (state.supported === false) {
    return <EmptyState title="BlueMap isn't available for this server" description={state.reason} />;
  }

  const serverBusy = serverStatus === 'RUNNING' || serverStatus === 'STARTING';

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader
        title="Live World Map"
        chips={<Chip tone={state.installed ? 'accent' : 'default'}>{state.installed ? 'Installed' : 'Not installed'}</Chip>}
        description="BlueMap renders your world as an explorable 3D map. Share it publicly without giving anyone panel access."
        actions={
          <>
            <button onClick={runDiagnose} disabled={!!busy} className="cc-btn-ghost">
              {busy === 'diagnose' ? 'Checking…' : 'Diagnose'}
            </button>
            {state.installed && state.bluemapPort && (
              <button onClick={openMap} className="cc-btn-ghost">Open map</button>
            )}
            {canManage && (
              <button
                onClick={() => runAction(state.installed ? 'uninstall' : 'install')}
                disabled={!!busy}
                className={state.installed ? 'cc-btn-danger' : 'cc-btn-primary'}
              >
                {busy === 'install' ? 'Installing…' : busy === 'uninstall' ? 'Removing…' : state.installed ? 'Uninstall' : 'Install BlueMap'}
              </button>
            )}
          </>
        }
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      {diagnosis && (
        <div
          className="cc-panel"
          style={{ display: 'grid', gap: '12px', borderColor: diagnosis.healthy ? 'var(--accent-border)' : 'var(--border)' }}
        >
          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {diagnosis.healthy ? 'Map pipeline looks healthy' : 'First problem found'}
          </div>
          {!diagnosis.healthy && <p style={{ fontSize: '0.78rem', color: 'var(--warning)', margin: 0, lineHeight: 1.6 }}>{diagnosis.summary}</p>}

          <div style={{ display: 'grid', gap: '4px' }}>
            {diagnosis.checks.map((c) => (
              <div key={c.name} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '0.75rem' }}>
                <span style={{ color: c.ok ? 'var(--accent)' : 'var(--danger)', fontWeight: 700, flexShrink: 0 }}>{c.ok ? '✓' : '✕'}</span>
                <div style={{ minWidth: 0 }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: c.ok ? 400 : 600 }}>{c.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}> — {c.detail}</span>
                </div>
              </div>
            ))}
          </div>

          {diagnosis.crashHint && <Notice tone="warning"><strong>Likely cause:</strong> {diagnosis.crashHint}</Notice>}

          {diagnosis.crashLog && diagnosis.crashLog.length > 0 && (
            <details style={{ fontSize: '0.75rem' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
                Show last {diagnosis.crashLog.length} console lines
              </summary>
              <pre
                style={{
                  marginTop: '8px', background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '6px',
                  padding: '12px', fontSize: '0.7rem', color: 'var(--text-muted)', maxHeight: '18rem',
                  overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)',
                }}
              >
                {diagnosis.crashLog.join('\n')}
              </pre>
            </details>
          )}
        </div>
      )}

      {state.daemonError && <Notice tone="warning">Could not reach the daemon for map status: {state.daemonError}</Notice>}

      {state.needsContainerRebuild && canManage && (
        <div className="cc-panel" style={{ display: 'grid', gap: '12px', borderColor: 'rgba(240,136,62,0.3)' }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--warning)' }}>One-time container rebuild needed</div>
          <p className="cc-help" style={{ margin: 0 }}>
            Docker can&apos;t add a port to a container that already exists, so this server&apos;s container has to be rebuilt
            once to publish the map port ({state.bluemapPort}). Your world is stored in a named volume and is pulled to the
            host first — <strong style={{ color: 'var(--text-primary)' }}>world data is not affected</strong>. The server must
            be stopped.
          </p>
          <div>
            <button onClick={() => runAction('rebuild-container')} disabled={!!busy || serverBusy} className="cc-btn-warning">
              {busy === 'rebuild-container' ? 'Rebuilding…' : serverBusy ? 'Stop the server first' : 'Rebuild container'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
        <StatTile label="Platform" value={state.platform ? state.platform.toUpperCase() : '—'} />
        <StatTile label="Map port" value={state.bluemapPort ?? '—'} />
        <StatTile label="Mode" value={state.isProcessMode ? 'Process' : 'Docker'} />
        <StatTile label="Active links" value={state.shares.filter((s) => s.enabled).length} />
      </div>

      {state.installed && (
        <Notice>
          BlueMap renders in the background and can take a long time on a large world — often hours for the first full pass.
          The map is viewable while it renders; it just fills in progressively.
        </Notice>
      )}

      {/* Share links */}
      <div className="cc-panel" style={{ display: 'grid', gap: '14px' }}>
        <div className="cc-section-title">Public share links</div>

        {state.shares.length === 0 ? (
          <p className="cc-help" style={{ margin: 0 }}>
            No share links yet. Create one below to give people the map — and only the map.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {state.shares.map((s) => {
              const expired = Boolean(s.expiresAt && new Date(s.expiresAt).getTime() < Date.now());
              return (
                <div key={s.id} className="cc-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span className="cc-row-title">{s.label || 'Untitled link'}</span>
                      {s.hasPassword && <Chip>Password</Chip>}
                      <Chip tone={expired ? 'danger' : s.enabled ? 'accent' : 'default'}>
                        {expired ? 'Expired' : s.enabled ? 'Active' : 'Revoked'}
                      </Chip>
                    </div>
                    <div className="cc-row-sub" style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shareUrl(s.token)}
                    </div>
                    <div className="cc-row-sub">
                      {s.viewCount} view{s.viewCount === 1 ? '' : 's'}
                      {s.expiresAt && !expired && ` · expires ${formatDateTime(s.expiresAt)}`}
                      {s.lastViewedAt && ` · last opened ${formatRelative(s.lastViewedAt)}`}
                    </div>
                  </div>

                  {canManage && (
                    <div className="cc-row-actions">
                      <button onClick={() => handleCopy(s.token)} className="cc-btn-ghost" style={{ padding: '4px 10px' }}>Copy</button>
                      <button onClick={() => updateShare(s, { enabled: !s.enabled })} disabled={!!busy} className="cc-btn-ghost" style={{ padding: '4px 10px' }}>
                        {s.enabled ? 'Revoke' : 'Restore'}
                      </button>
                      <button onClick={() => deleteShare(s)} disabled={!!busy} aria-label="Delete link" className="cc-btn-danger" style={{ padding: '4px 10px' }}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canManage && (
          <form onSubmit={createShare} style={{ display: 'grid', gap: '12px', borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
              <div>
                <label className="cc-label" htmlFor="share-label">Label</label>
                <input id="share-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Discord friends" className="cc-input" />
              </div>
              <div>
                <label className="cc-label" htmlFor="share-pw">Password (optional)</label>
                <input id="share-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave blank for none" className="cc-input" autoComplete="new-password" />
              </div>
              <div>
                <label className="cc-label" htmlFor="share-expiry">Expiry</label>
                <select id="share-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="cc-input">
                  {EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <button type="submit" disabled={!!busy} className="cc-btn-primary">
                {busy === 'share' ? 'Creating…' : 'Create share link'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
