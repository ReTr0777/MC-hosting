'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useConfirm } from '@/context/ConfirmContext';
import { useToast } from '@/context/ToastContext';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { Chip, EmptyState, InlineError, PanelHeader, SkeletonRows } from '@/components/ui';

interface Backup {
  name: string;
  sizeBytes: number;
  createdAt: string;
  location?: 'local' | 'remote' | 'both';
}

interface Retention {
  count: number | null;
  days: number | null;
  maxTotalMb: number | null;
}

interface BackupsPayload {
  backups: Backup[];
  retention: Retention;
}

/** Module-level so the polling hook's fallback identity is stable between renders. */
const EMPTY_PAYLOAD: BackupsPayload = { backups: [], retention: { count: null, days: null, maxTotalMb: null } };

type RetentionForm = { count: string; days: string; maxTotalMb: string };

const LOCATION_LABEL: Record<string, { text: string; tone: 'default' | 'accent' }> = {
  remote: { text: 'Off-site only', tone: 'default' },
  both: { text: 'Local + off-site', tone: 'accent' },
  local: { text: 'Local only', tone: 'default' },
};

export default function BackupsTab({ serverId, canManage = true }: { serverId: string; canManage?: boolean }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [backupName, setBackupName] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const { data, loading, error, refresh } = usePolledResource<BackupsPayload>(
    `/api/servers/${serverId}/backups`,
    EMPTY_PAYLOAD,
    {
      select: (raw) => ({
        backups: raw?.backups ?? [],
        retention: { count: raw?.retention?.count ?? null, days: raw?.retention?.days ?? null, maxTotalMb: raw?.retention?.maxTotalMb ?? null },
      }),
    }
  );
  const backups = data.backups;

  // The retention inputs are seeded from the server once and then left alone: this endpoint
  // polls, and re-syncing on every poll would yank a half-typed number out from under the user.
  const [retentionForm, setRetentionForm] = useState<RetentionForm>({ count: '', days: '', maxTotalMb: '' });
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || loading) return;
    seeded.current = true;
    setRetentionForm({
      count: data.retention.count?.toString() ?? '',
      days: data.retention.days?.toString() ?? '',
      maxTotalMb: data.retention.maxTotalMb?.toString() ?? '',
    });
  }, [loading, data.retention]);

  const [savingRetention, setSavingRetention] = useState(false);

  const handleSaveRetention = async () => {
    setSavingRetention(true);
    try {
      const result = await apiRequest(`/api/servers/${serverId}/backups`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: retentionForm.count === '' ? null : retentionForm.count,
          days: retentionForm.days === '' ? null : retentionForm.days,
          maxTotalMb: retentionForm.maxTotalMb === '' ? null : retentionForm.maxTotalMb,
        }),
      });
      const pruned = result?.pruned?.length ?? 0;
      toast.success(
        'Retention policy saved',
        pruned ? `${pruned} backup(s) outside the new policy were deleted.` : undefined
      );
      await refresh();
    } catch (err) {
      toast.error('Could not save the retention policy', errorMessage(err));
    } finally {
      setSavingRetention(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    // Archiving a big world takes a while; a sticky toast beats a button that just sits there.
    const toastId = toast.toast('info', 'Creating backup…', 'Archiving the world and configs.', { sticky: true });
    try {
      await apiPost(`/api/servers/${serverId}/backups`, { name: backupName.trim() });
      toast.toast('success', 'Backup created', undefined, { id: toastId });
      setBackupName('');
      await refresh();
    } catch (err) {
      toast.toast('error', 'Backup failed', errorMessage(err), { id: toastId });
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = async (name: string) => {
    const ok = await confirm({
      title: 'Restore this backup?',
      message: (
        <>
          The server will be stopped and its current world files replaced with the contents of{' '}
          <strong style={{ color: 'var(--text-primary)' }}>{name}</strong>. Anything built since that snapshot will be lost.
        </>
      ),
      confirmLabel: 'Restore backup',
      danger: true,
    });
    if (!ok) return;

    setActionLoading(`restore-${name}`);
    const toastId = toast.toast('info', 'Restoring backup…', 'The server is being stopped and rolled back.', { sticky: true });
    try {
      await apiPost(`/api/servers/${serverId}/backups`, { action: 'restore', name });
      toast.toast('success', 'Backup restored', 'Start the server to play on the restored world.', { id: toastId });
    } catch (err) {
      toast.toast('error', 'Restore failed', errorMessage(err), { id: toastId });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (name: string) => {
    const ok = await confirm({
      title: 'Delete this backup?',
      message: (
        <>
          <strong style={{ color: 'var(--text-primary)' }}>{name}</strong> will be removed from the node. You will no longer be
          able to restore the server to this point.
        </>
      ),
      confirmLabel: 'Delete backup',
      danger: true,
    });
    if (!ok) return;

    setActionLoading(`delete-${name}`);
    try {
      await apiPost(`/api/servers/${serverId}/backups`, { action: 'delete', name });
      toast.success('Backup deleted');
      await refresh();
    } catch (err) {
      // Previously this failed completely silently — the row just stayed put.
      toast.error('Could not delete the backup', errorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const totalBytes = backups.reduce((sum, b) => sum + (b.sizeBytes || 0), 0);

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader
        title="Backups"
        chips={
          backups.length > 0 ? (
            <>
              <Chip>{backups.length} snapshot{backups.length === 1 ? '' : 's'}</Chip>
              <Chip>{formatBytes(totalBytes)}</Chip>
            </>
          ) : undefined
        }
        description="Compressed snapshots of the world, configs and player data, with one-click rollback."
        actions={<button onClick={refresh} className="cc-btn-ghost" disabled={loading}>Refresh</button>}
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      {canManage && (
        <form onSubmit={handleCreate} className="cc-panel" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <input
            value={backupName}
            onChange={(e) => setBackupName(e.target.value)}
            placeholder="Snapshot label (e.g. pre-modpack-update)"
            aria-label="Backup name"
            className="cc-input"
            style={{ flex: 1, minWidth: '220px' }}
            disabled={creating}
          />
          <button type="submit" disabled={creating} className="cc-btn-primary">
            {creating ? 'Archiving…' : 'Take snapshot'}
          </button>
        </form>
      )}

      {canManage && (
        <div className="cc-panel" style={{ display: 'grid', gap: '12px' }}>
          <div className="cc-section-title">Retention</div>
          <p className="cc-help" style={{ margin: 0 }}>
            Old snapshots are deleted automatically after each new backup, so a nightly schedule can&apos;t quietly fill
            the node&apos;s disk. Leave a box empty to switch that rule off. The newest backup is never deleted.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
            <div>
              <label className="cc-label" htmlFor="ret-count">Keep at most</label>
              <input
                id="ret-count"
                type="number"
                min={1}
                value={retentionForm.count}
                onChange={(e) => setRetentionForm({ ...retentionForm, count: e.target.value })}
                placeholder="No limit"
                className="cc-input"
              />
              <p className="cc-help">snapshots</p>
            </div>
            <div>
              <label className="cc-label" htmlFor="ret-days">Delete after</label>
              <input
                id="ret-days"
                type="number"
                min={1}
                value={retentionForm.days}
                onChange={(e) => setRetentionForm({ ...retentionForm, days: e.target.value })}
                placeholder="Never"
                className="cc-input"
              />
              <p className="cc-help">days</p>
            </div>
            <div>
              <label className="cc-label" htmlFor="ret-size">Storage limit</label>
              <input
                id="ret-size"
                type="number"
                min={1}
                value={retentionForm.maxTotalMb}
                onChange={(e) => setRetentionForm({ ...retentionForm, maxTotalMb: e.target.value })}
                placeholder="No limit"
                className="cc-input"
              />
              <p className="cc-help">MB total{totalBytes > 0 ? ` — currently ${formatBytes(totalBytes)}` : ''}</p>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={handleSaveRetention} disabled={savingRetention} className="cc-btn-primary">
              {savingRetention ? 'Saving…' : 'Save retention policy'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <SkeletonRows rows={3} />
      ) : backups.length === 0 ? (
        <EmptyState
          title="No backups yet"
          description={
            canManage
              ? 'Take a snapshot above to safeguard your world, configuration and player progress.'
              : 'No snapshots have been taken for this server yet.'
          }
        />
      ) : (
        /* The table scrolls inside its own container so the page never scrolls sideways. */
        <div className="cc-card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '640px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                {['Snapshot', 'Size', 'Created', 'Storage', ''].map((h, i) => (
                  <th
                    key={h || i}
                    style={{
                      padding: '12px 16px', textAlign: i === 4 ? 'right' : 'left', fontSize: '0.62rem', fontWeight: 800,
                      letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => {
                const loc = LOCATION_LABEL[backup.location || 'local'] ?? LOCATION_LABEL.local;
                const busy = actionLoading === `restore-${backup.name}` || actionLoading === `delete-${backup.name}`;
                return (
                  <tr key={backup.name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--accent)', fontWeight: 600 }}>
                      {backup.name}
                    </td>
                    <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                      {formatBytes(backup.sizeBytes)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {formatDateTime(backup.createdAt)}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <Chip tone={loc.tone}>{loc.text}</Chip>
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canManage && (
                        <span style={{ display: 'inline-flex', gap: '6px' }}>
                          <button
                            onClick={() => handleRestore(backup.name)}
                            disabled={!!actionLoading}
                            className="cc-btn-warning"
                            style={{ padding: '4px 10px' }}
                          >
                            {busy && actionLoading?.startsWith('restore') ? 'Restoring…' : 'Restore'}
                          </button>
                          <button
                            onClick={() => handleDelete(backup.name)}
                            disabled={!!actionLoading}
                            className="cc-btn-danger"
                            style={{ padding: '4px 10px' }}
                          >
                            Delete
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
