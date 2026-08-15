'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirm } from '@/context/ConfirmContext';
import { useToast } from '@/context/ToastContext';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { Chip, ChipTone, EmptyState, InlineError, Modal } from '@/components/ui';

interface SystemUser {
  id: string;
  username: string;
  email: string;
  globalRole: string;
}

type ServerRole = 'VIEWER' | 'OPERATOR' | 'ADMIN';

interface ServerPermissionItem {
  id: string;
  userId: string;
  role: ServerRole;
  user: SystemUser;
}

interface ServerPermissionsModalProps {
  serverId: string;
  serverName: string;
  isOpen: boolean;
  onClose: () => void;
  /** Transfer is the owner's decision alone, so the section only appears for them. */
  canTransfer?: boolean;
  /** Called after a successful transfer — the caller's own role has probably just changed. */
  onTransferred?: () => void;
}

const ROLE_META: Record<ServerRole, { label: string; help: string; tone: ChipTone }> = {
  VIEWER: { label: 'Viewer', help: 'Can watch the console and see status, but change nothing.', tone: 'default' },
  OPERATOR: { label: 'Operator', help: 'Can start, stop and restart the server, and manage its files.', tone: 'accent' },
  ADMIN: { label: 'Admin', help: 'Full control, including settings, backups and access for others.', tone: 'warning' },
};

export function ServerPermissionsModal({
  serverId,
  serverName,
  isOpen,
  onClose,
  canTransfer = false,
  onTransferred,
}: ServerPermissionsModalProps) {
  const confirm = useConfirm();
  const toast = useToast();

  const [permissions, setPermissions] = useState<ServerPermissionItem[]>([]);
  const [allUsers, setAllUsers] = useState<SystemUser[]>([]);
  const [directory, setDirectory] = useState<{ id: string; username: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState<ServerRole>('OPERATOR');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [transferTo, setTransferTo] = useState('');
  const [transferKeepAccess, setTransferKeepAccess] = useState(true);
  const [transferring, setTransferring] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [permData, usersData, dirData] = await Promise.all([
        apiRequest(`/api/servers/${serverId}/permissions`),
        // Admin-only, and an ordinary owner opening this modal is not one — fall back rather
        // than failing the whole load.
        apiRequest('/api/users').catch(() => ({ users: [] })),
        // Every signed-in user can read this one; /api/users above is admin-only.
        apiRequest('/api/users/directory').catch(() => ({ users: [] })),
      ]);
      setPermissions(Array.isArray(permData?.permissions) ? permData.permissions : []);
      setAllUsers(Array.isArray(usersData?.users) ? usersData.users : []);
      setDirectory(Array.isArray(dirData?.users) ? dirData.users : []);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load permissions'));
      setPermissions([]);
      setAllUsers([]);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    if (isOpen) fetchData();
  }, [isOpen, fetchData]);

  // Global admins already have access everywhere, so offering them here is noise.
  const grantableUsers = useMemo(
    () => allUsers.filter((u) => u.globalRole !== 'GLOBAL_ADMIN'),
    [allUsers]
  );

  const existingRole = permissions.find((p) => p.userId === selectedUserId)?.role;

  const handleGrantPermission = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId) return;
    setIsSubmitting(true);
    setError('');
    try {
      await apiPost(`/api/servers/${serverId}/permissions`, { targetUserId: selectedUserId, role: selectedRole });
      const name = allUsers.find((u) => u.id === selectedUserId)?.username || 'User';
      toast.success(`${name} is now ${ROLE_META[selectedRole].label.toLowerCase()}`);
      setSelectedUserId('');
      await fetchData();
    } catch (err) {
      setError(errorMessage(err, 'Failed to assign permission'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevokePermission = async (perm: ServerPermissionItem) => {
    const ok = await confirm({
      title: 'Revoke access for this user?',
      message: (
        <>
          <strong style={{ color: 'var(--text-primary)' }}>{perm.user?.username || 'This user'}</strong> will no longer see or
          control this server in their dashboard. You can grant access again at any time.
        </>
      ),
      confirmLabel: 'Revoke access',
      danger: true,
    });
    if (!ok) return;

    try {
      await apiRequest(`/api/servers/${serverId}/permissions/${perm.id}`, { method: 'DELETE' });
      toast.success('Access revoked');
      await fetchData();
    } catch (err) {
      toast.error('Could not revoke access', errorMessage(err));
    }
  };

  const currentOwnerId = permissions.find((p) => (p.role as string) === 'OWNER')?.userId;
  const transferCandidates = directory.filter((u) => u.id !== currentOwnerId);

  const handleTransfer = async () => {
    if (!transferTo) return;
    const name = directory.find((u) => u.id === transferTo)?.username || 'that user';

    const ok = await confirm({
      title: `Hand ${serverName} to ${name}?`,
      message: (
        <>
          <strong style={{ color: 'var(--text-primary)' }}>{name}</strong> becomes the owner: the server starts counting
          against their quota instead of the current owner&apos;s, and only they can transfer or delete it from then on.
          {transferKeepAccess
            ? ' The current owner stays on as an admin.'
            : ' The current owner loses access entirely.'}
        </>
      ),
      confirmLabel: 'Transfer ownership',
      danger: true,
    });
    if (!ok) return;

    setTransferring(true);
    try {
      const result = await apiPost(`/api/servers/${serverId}/transfer`, {
        targetUserId: transferTo,
        keepAccess: transferKeepAccess,
      });
      toast.success('Ownership transferred', result?.message);
      setTransferTo('');
      await fetchData();
      onTransferred?.();
    } catch (err) {
      toast.error('Could not transfer ownership', errorMessage(err));
    } finally {
      setTransferring(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      title={`Access to ${serverName}`}
      onClose={onClose}
      width={680}
      footer={<button onClick={onClose} className="cc-btn-ghost">Close</button>}
    >
      <div style={{ display: 'grid', gap: '20px' }}>
        {error && <InlineError message={error} onRetry={fetchData} />}

        {/* Grant */}
        <form
          onSubmit={handleGrantPermission}
          style={{ display: 'grid', gap: '12px', background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '16px' }}
        >
          <div className="cc-section-title">Grant or update access</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
            <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
              <label className="cc-label" htmlFor="perm-user">User</label>
              <select
                id="perm-user"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                required
                className="cc-input"
              >
                <option value="">Select a user…</option>
                {grantableUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.username} — {u.email}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="cc-label" htmlFor="perm-role">Role</label>
              <select
                id="perm-role"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as ServerRole)}
                className="cc-input"
              >
                {(Object.keys(ROLE_META) as ServerRole[]).map((r) => (
                  <option key={r} value={r}>{ROLE_META[r].label}</option>
                ))}
              </select>
            </div>
          </div>

          <p className="cc-help" style={{ margin: 0 }}>{ROLE_META[selectedRole].help}</p>

          {existingRole && existingRole !== selectedRole && (
            <p className="cc-help" style={{ margin: 0, color: 'var(--warning)' }}>
              This user is currently {ROLE_META[existingRole].label.toLowerCase()} — saving will change their role.
            </p>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" disabled={isSubmitting || !selectedUserId} className="cc-btn-primary">
              {isSubmitting ? 'Saving…' : existingRole ? 'Update access' : 'Grant access'}
            </button>
          </div>
        </form>

        {/* Current grants */}
        <div style={{ display: 'grid', gap: '10px' }}>
          <div className="cc-section-title">Who has access</div>

          {loading ? (
            <p className="cc-help" style={{ margin: 0 }}>Loading permissions…</p>
          ) : permissions.length === 0 ? (
            <EmptyState title="No one else has access" description="Only global admins and the owner can see this server right now." />
          ) : (
            <div style={{ display: 'grid', gap: '8px', maxHeight: '16rem', overflowY: 'auto' }}>
              {permissions.map((p) => {
                const meta = ROLE_META[p.role] ?? { label: p.role, tone: 'default' as ChipTone };
                return (
                  <div key={p.id} className="cc-row">
                    <div style={{ minWidth: 0 }}>
                      <span className="cc-row-title" style={{ display: 'block' }}>{p.user?.username || 'Unknown user'}</span>
                      <span className="cc-row-sub">{p.user?.email || p.userId}</span>
                    </div>
                    <div className="cc-row-actions">
                      <Chip tone={meta.tone}>{meta.label}</Chip>
                      <button onClick={() => handleRevokePermission(p)} className="cc-btn-danger" style={{ padding: '4px 10px' }}>
                        Revoke
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Transfer ownership */}
        {canTransfer && (
          <div
            style={{
              display: 'grid',
              gap: '12px',
              background: 'var(--bg)',
              border: '1px solid var(--border-2)',
              borderRadius: '8px',
              padding: '16px',
            }}
          >
            <div className="cc-section-title">Transfer ownership</div>
            <p className="cc-help" style={{ margin: 0 }}>
              The owner is who this server&apos;s RAM and CPU are charged to. Transferring moves that cost — and the
              right to delete or transfer the server — to somebody else. It is refused if it would put them over their
              quota.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
              <div style={{ minWidth: 0 }}>
                <label className="cc-label" htmlFor="transfer-user">New owner</label>
                <select
                  id="transfer-user"
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                  className="cc-input"
                >
                  <option value="">Select a user…</option>
                  {transferCandidates.map((u) => (
                    <option key={u.id} value={u.id}>{u.username}</option>
                  ))}
                </select>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', alignSelf: 'end', paddingBottom: '8px' }}>
                <input
                  type="checkbox"
                  checked={transferKeepAccess}
                  onChange={(e) => setTransferKeepAccess(e.target.checked)}
                />
                <span className="cc-help" style={{ margin: 0 }}>Keep the current owner as an admin</span>
              </label>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={handleTransfer}
                disabled={!transferTo || transferring}
                className="cc-btn-danger"
              >
                {transferring ? 'Transferring…' : 'Transfer ownership'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ServerPermissionsModal;
