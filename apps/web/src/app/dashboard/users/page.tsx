'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { useClipboard } from '@/hooks/useClipboard';
import { usePasswordConfirmation } from '@/hooks/usePasswordConfirmation';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Chip, EmptyState, InlineError, LoadingLine, Modal, PanelHeader } from '@/components/ui';

interface UserItem {
  id: string;
  email: string;
  username: string;
  globalRole: string;
  maxServers: number | null;
  maxMemoryMb: number | null;
  maxCpu: number | null;
  maxServerMemoryMb: number | null;
  maxServerCpu: number | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
}

interface InviteItem {
  id: string;
  code: string;
  uses: number;
  maxUses: number | null;
  createdAt: string;
  creator?: { username: string };
}

/** Normalises the two response shapes the API has used over time. */
function asArray<T>(payload: any, key: string): T[] {
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload)) return payload;
  return [];
}

/** MB rendered as GB once it divides cleanly enough to stay readable. */
function formatRam(mb: number): string {
  return mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`;
}

function quotaSummary(u: UserItem): string {
  const totals = [
    u.maxServers != null ? `${u.maxServers} srv` : null,
    u.maxMemoryMb != null ? formatRam(u.maxMemoryMb) : null,
    u.maxCpu != null ? `${u.maxCpu} cpu` : null,
  ].filter(Boolean);
  const perServer = [
    u.maxServerMemoryMb != null ? formatRam(u.maxServerMemoryMb) : null,
    u.maxServerCpu != null ? `${u.maxServerCpu} cpu` : null,
  ].filter(Boolean);

  if (totals.length === 0 && perServer.length === 0) return 'Unlimited';
  const parts = [totals.length ? totals.join(' · ') : 'unlimited total'];
  if (perServer.length) parts.push(`≤ ${perServer.join(' / ')} each`);
  return parts.join('  |  ');
}

/** Plain-English echo of the quota form, so the admin can see what they just configured. */
function quotaPreview(servers: string, ram: string, cpu: string, serverRam: string, serverCpu: string): string {
  if (!servers && !ram && !cpu && !serverRam && !serverCpu) {
    return 'No limits — this user can create any number of servers of any size.';
  }
  const totals = [
    servers ? `${servers} server${servers === '1' ? '' : 's'}` : null,
    ram ? formatRam(parseInt(ram, 10)) : null,
    cpu ? `${cpu} core${cpu === '1' ? '' : 's'}` : null,
  ].filter(Boolean);
  const each = [
    serverRam ? formatRam(parseInt(serverRam, 10)) : null,
    serverCpu ? `${serverCpu} core${serverCpu === '1' ? '' : 's'}` : null,
  ].filter(Boolean);

  const sentences = [];
  sentences.push(totals.length ? `Up to ${totals.join(', ')} in total.` : 'No total limit.');
  if (each.length) sentences.push(`No single server larger than ${each.join(' / ')}.`);
  return sentences.join(' ');
}

const RAM_PRESETS = [1024, 2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536];
const CPU_PRESETS = [0.5, 1, 2, 3, 4, 6, 8, 12, 16];
const SERVER_PRESETS = [1, 2, 3, 4, 5, 8, 10, 20];

/**
 * Quota picker: a dropdown of sensible presets plus a "Custom…" escape hatch, since typing
 * "40000" into a raw MB box is how you end up with quotas nobody meant to set.
 * The value is kept as a string; '' means unlimited.
 */
function QuotaField({
  id, label, help, value, onChange, presets, format, parse,
}: {
  id: string;
  label: string;
  help?: string;
  value: string;
  onChange: (next: string) => void;
  presets: number[];
  format: (n: number) => string;
  parse: (s: string) => number;
}) {
  // Only the initial value decides the mode; the parent remounts these per user being edited.
  const [custom, setCustom] = useState(value !== '' && !presets.some((p) => p === parse(value)));

  return (
    <div>
      <label className="cc-label" htmlFor={id}>{label}</label>
      {custom ? (
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            id={id}
            type="number"
            min="0"
            step="any"
            placeholder="Unlimited"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="cc-input"
          />
          <button
            type="button"
            className="cc-btn-ghost"
            style={{ padding: '4px 10px', whiteSpace: 'nowrap' }}
            onClick={() => { setCustom(false); onChange(''); }}
          >
            Presets
          </button>
        </div>
      ) : (
        <select
          id={id}
          value={value}
          onChange={(e) => {
            if (e.target.value === '__custom') { setCustom(true); return; }
            onChange(e.target.value);
          }}
          className="cc-input"
        >
          <option value="">Unlimited</option>
          {presets.map((p) => (
            <option key={p} value={String(p)}>{format(p)}</option>
          ))}
          <option value="__custom">Custom…</option>
        </select>
      )}
      {help && <p className="cc-help">{help}</p>}
    </div>
  );
}

export default function UsersDashboardPage() {
  const { user, loading } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { copy } = useClipboard();

  const [users, setUsers] = useState<UserItem[]>([]);
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [activeTab, setActiveTab] = useState<'users' | 'invites'>('users');
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  // window is not available during SSR, so the origin is read after mount.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const newPw = usePasswordConfirmation();
  const [newRole, setNewRole] = useState('USER');

  const [editingUser, setEditingUser] = useState<UserItem | null>(null);
  // Optional: blank means "keep their current password", so it only validates once typed in.
  const editPw = usePasswordConfirmation({ optional: true });
  const [editRole, setEditRole] = useState('USER');
  const [editMaxServers, setEditMaxServers] = useState('');
  const [editMaxMemoryMb, setEditMaxMemoryMb] = useState('');
  const [editMaxCpu, setEditMaxCpu] = useState('');
  const [editMaxServerMemoryMb, setEditMaxServerMemoryMb] = useState('');
  const [editMaxServerCpu, setEditMaxServerCpu] = useState('');

  const [showCreateInvite, setShowCreateInvite] = useState(false);
  const [maxUses, setMaxUses] = useState<number | ''>('');

  const isAdmin = user?.globalRole === 'GLOBAL_ADMIN';

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [usersData, invitesData] = await Promise.all([apiRequest('/api/users'), apiRequest('/api/invites')]);
      setUsers(asArray<UserItem>(usersData, 'users'));
      setInvites(asArray<InviteItem>(invitesData, 'invites'));
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load users and invites'));
    }
  }, [isAdmin]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!newPw.isValid) {
      setFormError(newPw.error || 'Please confirm the password');
      return;
    }

    setBusy(true);
    try {
      await apiPost('/api/users', { email: newEmail, username: newUsername, password: newPw.password, globalRole: newRole });
      setShowCreateUser(false);
      setNewEmail(''); setNewUsername(''); newPw.reset(); setNewRole('USER');
      toast.success(`Created ${newUsername}`);
      await refresh();
    } catch (err) {
      setFormError(errorMessage(err, 'Failed to create user'));
    } finally {
      setBusy(false);
    }
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setFormError('');

    if (!editPw.isValid) {
      setFormError(editPw.error || 'Please confirm the new password');
      return;
    }

    setBusy(true);
    try {
      await apiRequest(`/api/users/${editingUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: editPw.password || undefined,
          globalRole: editRole,
          maxServers: editMaxServers === '' ? null : parseInt(editMaxServers, 10),
          maxMemoryMb: editMaxMemoryMb === '' ? null : parseInt(editMaxMemoryMb, 10),
          maxCpu: editMaxCpu === '' ? null : parseFloat(editMaxCpu),
          maxServerMemoryMb: editMaxServerMemoryMb === '' ? null : parseInt(editMaxServerMemoryMb, 10),
          maxServerCpu: editMaxServerCpu === '' ? null : parseFloat(editMaxServerCpu),
        }),
      });
      toast.success(`Updated ${editingUser.username}`);
      setEditingUser(null);
      editPw.reset();
      await refresh();
    } catch (err) {
      setFormError(errorMessage(err, 'Failed to update user'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteUser = async (target: UserItem) => {
    const ok = await confirm({
      title: 'Delete this account?',
      message: (
        <>
          <strong style={{ color: 'var(--text-primary)' }}>{target.username}</strong> loses access to the panel immediately.
          Servers they own are not deleted.
        </>
      ),
      confirmLabel: 'Delete account',
      danger: true,
      requireText: target.username,
    });
    if (!ok) return;

    try {
      await apiRequest(`/api/users/${target.id}`, { method: 'DELETE' });
      toast.success('Account deleted', target.username);
      await refresh();
    } catch (err) {
      toast.error('Could not delete the account', errorMessage(err));
    }
  };

  /**
   * Suspension is the reversible middle ground between leaving an account alone and deleting
   * it: they cannot sign in and their servers are stopped, but nothing is destroyed.
   */
  const handleSuspendUser = async (target: UserItem) => {
    const suspend = !target.suspendedAt;

    if (suspend) {
      const ok = await confirm({
        title: `Suspend ${target.username}?`,
        message: (
          <>
            <strong style={{ color: 'var(--text-primary)' }}>{target.username}</strong> is signed out immediately and
            cannot sign back in. Every server they own is stopped and blocked from starting. Nothing is deleted, and you
            can lift this at any time.
          </>
        ),
        confirmLabel: 'Suspend account',
        danger: true,
      });
      if (!ok) return;
    }

    const reason = suspend ? window.prompt('Reason shown to the user (optional):') || '' : '';

    try {
      const result = await apiPost(`/api/users/${target.id}/suspend`, { suspended: suspend, reason });
      toast.success(suspend ? 'Account suspended' : 'Suspension lifted', result?.message);
      await refresh();
    } catch (err) {
      toast.error('Could not change the suspension', errorMessage(err));
    }
  };

  const handleGenerateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setBusy(true);
    try {
      await apiPost('/api/invites', { maxUses: maxUses === '' ? null : maxUses });
      setShowCreateInvite(false);
      setMaxUses('');
      toast.success('Invite generated');
      await refresh();
    } catch (err) {
      setFormError(errorMessage(err, 'Failed to generate invite'));
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeInvite = async (inv: InviteItem) => {
    const ok = await confirm({
      title: 'Revoke this invite code?',
      message: 'Anyone who still has the link will no longer be able to register with it. Accounts already created stay active.',
      confirmLabel: 'Revoke invite',
      danger: true,
    });
    if (!ok) return;

    try {
      await apiRequest(`/api/invites/${inv.id}`, { method: 'DELETE' });
      toast.success('Invite revoked');
      await refresh();
    } catch (err) {
      toast.error('Could not revoke the invite', errorMessage(err));
    }
  };

  const copyInvite = async (code: string) => {
    if (await copy(`${origin}/register?invite=${code}`)) toast.success('Invite link copied');
    else toast.error('Could not copy the link');
  };

  const openEditModal = (u: UserItem) => {
    setEditingUser(u);
    setEditRole(u.globalRole);
    editPw.reset();
    setEditMaxServers(u.maxServers != null ? String(u.maxServers) : '');
    setEditMaxMemoryMb(u.maxMemoryMb != null ? String(u.maxMemoryMb) : '');
    setEditMaxCpu(u.maxCpu != null ? String(u.maxCpu) : '');
    setEditMaxServerMemoryMb(u.maxServerMemoryMb != null ? String(u.maxServerMemoryMb) : '');
    setEditMaxServerCpu(u.maxServerCpu != null ? String(u.maxServerCpu) : '');
    setFormError('');
  };

  if (loading) return <LoadingLine>Loading…</LoadingLine>;

  if (!isAdmin) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Not authorised</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>Only global admins can manage users and invites.</p>
        <Link href="/dashboard" className="cc-btn-primary" style={{ textDecoration: 'none' }}>Back to dashboard</Link>
      </div>
    );
  }

  const th: React.CSSProperties = {
    padding: '12px 20px', textAlign: 'left', fontSize: '0.62rem', fontWeight: 800,
    letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = { padding: '12px 20px', fontSize: '0.8125rem', color: 'var(--text-primary)' };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          borderBottom: '1px solid var(--border)', background: 'var(--surface)', padding: '14px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap',
          position: 'sticky', top: 0, zIndex: 40,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <Link href="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none' }}>
            <span
              style={{
                width: 30, height: 30, borderRadius: '7px', background: 'var(--accent)', color: 'var(--bg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900,
              }}
            >
              M
            </span>
            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>CraftControl</span>
          </Link>
          <Chip>Users &amp; invites</Chip>
          <Link href="/dashboard" className="cc-btn-ghost" style={{ textDecoration: 'none' }}>Back to dashboard</Link>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>{user!.username}</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{user!.email}</div>
        </div>
      </header>

      <main style={{ flex: 1, width: '100%', maxWidth: '80rem', margin: '0 auto', padding: '24px', display: 'grid', gap: '20px', alignContent: 'start' }}>
        <nav style={{ display: 'flex', gap: '20px', borderBottom: '1px solid var(--border)' }}>
          <button onClick={() => setActiveTab('users')} className={`cc-tab${activeTab === 'users' ? ' cc-tab-active' : ''}`}>
            Users
          </button>
          <button onClick={() => setActiveTab('invites')} className={`cc-tab${activeTab === 'invites' ? ' cc-tab-active' : ''}`}>
            Invite codes
          </button>
        </nav>

        {loadError && <InlineError message={loadError} onRetry={refresh} />}

        {activeTab === 'users' && (
          <div style={{ display: 'grid', gap: '16px' }}>
            <PanelHeader
              title="Registered users"
              chips={<Chip>{users.length}</Chip>}
              description="Accounts that can sign in to this panel, and the resource quotas applied to servers they own."
              actions={<button onClick={() => { setShowCreateUser(true); setFormError(''); }} className="cc-btn-primary">Create user</button>}
            />

            {users.length === 0 ? (
              <EmptyState title="No users yet" description="Create an account or generate an invite link to get started." />
            ) : (
              <div className="cc-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '760px' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                      <th style={th}>Username</th>
                      <th style={th}>Email</th>
                      <th style={th}>Role</th>
                      <th style={th}>Quota</th>
                      <th style={th}>Created</th>
                      <th style={{ ...th, textAlign: 'right' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...td, fontWeight: 600 }}>{u.username}</td>
                        <td style={{ ...td, color: 'var(--text-muted)' }}>{u.email}</td>
                        <td style={td}>
                          <span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' }}>
                            <Chip tone={u.globalRole === 'GLOBAL_ADMIN' ? 'accent' : 'default'}>
                              {u.globalRole === 'GLOBAL_ADMIN' ? 'Admin' : 'User'}
                            </Chip>
                            {u.suspendedAt && (
                              <Chip tone="danger" title={u.suspendedReason || undefined}>Suspended</Chip>
                            )}
                          </span>
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          {quotaSummary(u)}
                        </td>
                        <td style={{ ...td, color: 'var(--text-muted)', fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
                          {formatDateTime(u.createdAt)}
                        </td>
                        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <span style={{ display: 'inline-flex', gap: '6px' }}>
                            <button onClick={() => openEditModal(u)} className="cc-btn-ghost" style={{ padding: '4px 10px' }}>Edit</button>
                            {u.id !== user!.id && (
                              <button
                                onClick={() => handleSuspendUser(u)}
                                className={u.suspendedAt ? 'cc-btn-primary' : 'cc-btn-ghost'}
                                style={{ padding: '4px 10px' }}
                                title={
                                  u.suspendedAt
                                    ? u.suspendedReason || 'Let this user sign in again'
                                    : 'Block sign-in and stop their servers, without deleting anything'
                                }
                              >
                                {u.suspendedAt ? 'Unsuspend' : 'Suspend'}
                              </button>
                            )}
                            {u.id !== user!.id && (
                              <button onClick={() => handleDeleteUser(u)} className="cc-btn-danger" style={{ padding: '4px 10px' }}>Delete</button>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'invites' && (
          <div style={{ display: 'grid', gap: '16px' }}>
            <PanelHeader
              title="Invite codes"
              chips={<Chip>{invites.length} active</Chip>}
              description="Share a link so someone can register their own account without you setting a password for them."
              actions={<button onClick={() => { setShowCreateInvite(true); setFormError(''); }} className="cc-btn-primary">Generate invite</button>}
            />

            {invites.length === 0 ? (
              <EmptyState title="No active invites" description="Generate one to let someone register an account." />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
                {invites.map((inv) => (
                  <div key={inv.id} className="cc-panel" style={{ display: 'grid', gap: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                      <div>
                        <span className="cc-label">Invite code</span>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.05em' }}>
                          {inv.code}
                        </div>
                      </div>
                      <button onClick={() => handleRevokeInvite(inv)} className="cc-btn-danger" style={{ padding: '4px 10px' }}>Revoke</button>
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        readOnly
                        value={origin ? `${origin}/register?invite=${inv.code}` : `/register?invite=${inv.code}`}
                        aria-label="Invite link"
                        onFocus={(e) => e.currentTarget.select()}
                        className="cc-input"
                        style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}
                      />
                      <button onClick={() => copyInvite(inv.code)} className="cc-btn-ghost">Copy</button>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      <span>Uses: {inv.uses} / {inv.maxUses ?? '∞'}</span>
                      <span>By {inv.creator?.username || 'System'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Edit user */}
      {editingUser && (
        <Modal
          title={`Edit ${editingUser.username}`}
          onClose={() => setEditingUser(null)}
          footer={
            <>
              <button type="button" onClick={() => setEditingUser(null)} className="cc-btn-ghost">Cancel</button>
              <button type="submit" form="edit-user-form" disabled={busy || !editPw.isValid} className="cc-btn-primary">
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </>
          }
        >
          <form id="edit-user-form" onSubmit={handleEditUser} style={{ display: 'grid', gap: '16px' }}>
            {formError && <InlineError message={formError} />}

            <div>
              <label className="cc-label" htmlFor="eu-pw">New password</label>
              <input id="eu-pw" type="password" autoComplete="new-password" value={editPw.password} onChange={(e) => editPw.setPassword(e.target.value)} className="cc-input" />
              <p className="cc-help">Leave blank to keep their current password.</p>
            </div>

            {editPw.password.length > 0 && (
              <div>
                <label className="cc-label" htmlFor="eu-pw2">Confirm new password</label>
                <input
                  id="eu-pw2"
                  type="password"
                  autoComplete="new-password"
                  value={editPw.confirmPassword}
                  onChange={(e) => editPw.setConfirmPassword(e.target.value)}
                  aria-invalid={!!editPw.error}
                  className="cc-input"
                />
                {editPw.error ? (
                  <p className="cc-help" style={{ color: 'var(--danger)' }}>{editPw.error}</p>
                ) : (
                  <p className="cc-help">You are setting this password on someone else&apos;s behalf — a typo locks them out.</p>
                )}
              </div>
            )}

            <div>
              <label className="cc-label" htmlFor="eu-role">Role</label>
              <select id="eu-role" value={editRole} onChange={(e) => setEditRole(e.target.value)} className="cc-input">
                <option value="USER">User</option>
                <option value="GLOBAL_ADMIN">Global admin</option>
              </select>
            </div>

            <div key={editingUser.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', display: 'grid', gap: '18px' }}>
              <div>
                <span className="cc-label">Resource quotas</span>
                <p className="cc-help" style={{ margin: 0 }}>
                  Only counts servers this user owns, and is ignored for global admins.
                </p>
              </div>

              <div>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
                  Total allowance
                </div>
                <p className="cc-help" style={{ margin: '0 0 10px' }}>
                  Added up across every server they own.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
                  <QuotaField
                    id="eu-srv"
                    label="Max servers"
                    value={editMaxServers}
                    onChange={setEditMaxServers}
                    presets={SERVER_PRESETS}
                    format={(n) => `${n} server${n === 1 ? '' : 's'}`}
                    parse={(s) => parseInt(s, 10)}
                  />
                  <QuotaField
                    id="eu-ram"
                    label="Total RAM"
                    help={editMaxMemoryMb === '' ? undefined : `${parseInt(editMaxMemoryMb, 10)} MB`}
                    value={editMaxMemoryMb}
                    onChange={setEditMaxMemoryMb}
                    presets={RAM_PRESETS}
                    format={formatRam}
                    parse={(s) => parseInt(s, 10)}
                  />
                  <QuotaField
                    id="eu-cpu"
                    label="Total CPU"
                    value={editMaxCpu}
                    onChange={setEditMaxCpu}
                    presets={CPU_PRESETS}
                    format={(n) => `${n} core${n === 1 ? '' : 's'}`}
                    parse={parseFloat}
                  />
                </div>
              </div>

              <div>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
                  Per server
                </div>
                <p className="cc-help" style={{ margin: '0 0 10px' }}>
                  The largest single server they may create, whatever their total allowance is.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
                  <QuotaField
                    id="eu-srv-ram"
                    label="RAM per server"
                    help={editMaxServerMemoryMb === '' ? undefined : `${parseInt(editMaxServerMemoryMb, 10)} MB`}
                    value={editMaxServerMemoryMb}
                    onChange={setEditMaxServerMemoryMb}
                    presets={RAM_PRESETS}
                    format={formatRam}
                    parse={(s) => parseInt(s, 10)}
                  />
                  <QuotaField
                    id="eu-srv-cpu"
                    label="CPU per server"
                    value={editMaxServerCpu}
                    onChange={setEditMaxServerCpu}
                    presets={CPU_PRESETS}
                    format={(n) => `${n} core${n === 1 ? '' : 's'}`}
                    parse={parseFloat}
                  />
                </div>
              </div>

              <p className="cc-help" style={{ margin: 0, color: 'var(--text-primary)' }}>
                {quotaPreview(editMaxServers, editMaxMemoryMb, editMaxCpu, editMaxServerMemoryMb, editMaxServerCpu)}
              </p>
            </div>
          </form>
        </Modal>
      )}

      {/* Generate invite */}
      {showCreateInvite && (
        <Modal
          title="Generate an invite link"
          onClose={() => setShowCreateInvite(false)}
          width={440}
          footer={
            <>
              <button type="button" onClick={() => setShowCreateInvite(false)} className="cc-btn-ghost">Cancel</button>
              <button type="submit" form="invite-form" disabled={busy} className="cc-btn-primary">
                {busy ? 'Generating…' : 'Generate link'}
              </button>
            </>
          }
        >
          <form id="invite-form" onSubmit={handleGenerateInvite} style={{ display: 'grid', gap: '14px' }}>
            {formError && <InlineError message={formError} />}
            <div>
              <label className="cc-label" htmlFor="inv-uses">Max uses</label>
              <input
                id="inv-uses"
                type="number"
                min="1"
                placeholder="Unlimited"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value ? parseInt(e.target.value, 10) : '')}
                className="cc-input"
              />
              <p className="cc-help">Leave blank to let the link be used any number of times.</p>
            </div>
          </form>
        </Modal>
      )}

      {/* Create user */}
      {showCreateUser && (
        <Modal
          title="Create a user"
          onClose={() => setShowCreateUser(false)}
          width={440}
          footer={
            <>
              <button type="button" onClick={() => setShowCreateUser(false)} className="cc-btn-ghost">Cancel</button>
              <button type="submit" form="create-user-form" disabled={busy || !newPw.isValid} className="cc-btn-primary">
                {busy ? 'Creating…' : 'Create user'}
              </button>
            </>
          }
        >
          <form id="create-user-form" onSubmit={handleCreateUser} style={{ display: 'grid', gap: '14px' }}>
            {formError && <InlineError message={formError} />}
            <div>
              <label className="cc-label" htmlFor="cu-email">Email</label>
              <input id="cu-email" required type="email" autoComplete="off" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="cc-input" />
            </div>
            <div>
              <label className="cc-label" htmlFor="cu-username">Username</label>
              <input id="cu-username" required autoComplete="off" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="cc-input" />
            </div>
            <div>
              <label className="cc-label" htmlFor="cu-pw">Password</label>
              <input id="cu-pw" required minLength={8} type="password" autoComplete="new-password" value={newPw.password} onChange={(e) => newPw.setPassword(e.target.value)} className="cc-input" />
              <p className="cc-help">At least 8 characters.</p>
            </div>
            <div>
              <label className="cc-label" htmlFor="cu-pw2">Confirm password</label>
              <input
                id="cu-pw2"
                required
                minLength={8}
                type="password"
                autoComplete="new-password"
                value={newPw.confirmPassword}
                onChange={(e) => newPw.setConfirmPassword(e.target.value)}
                aria-invalid={!!newPw.error}
                className="cc-input"
              />
              {newPw.error && <p className="cc-help" style={{ color: 'var(--danger)' }}>{newPw.error}</p>}
            </div>
            <div>
              <label className="cc-label" htmlFor="cu-role">Role</label>
              <select id="cu-role" value={newRole} onChange={(e) => setNewRole(e.target.value)} className="cc-input">
                <option value="USER">User</option>
                <option value="GLOBAL_ADMIN">Global admin</option>
              </select>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
