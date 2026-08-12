'use client';

import React, { useState } from 'react';
import { useConfirm } from '@/context/ConfirmContext';
import { useToast } from '@/context/ToastContext';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { Chip, EmptyState, InlineError, PanelHeader, SkeletonRows } from '@/components/ui';

interface Backup {
  name: string;
  sizeBytes: number;
  createdAt: string;
  location?: 'local' | 'remote' | 'both';
}

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

  const { data: backups, loading, error, refresh } = usePolledResource<Backup[]>(
    `/api/servers/${serverId}/backups`,
    [],
    { select: (raw) => raw?.backups ?? [] }
  );

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
