'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import TwoFactorSection from '@/components/account/TwoFactorSection';
import ThemeSelector from '@/components/account/ThemeSelector';
import { useConfirm } from '@/context/ConfirmContext';
import { useToast } from '@/context/ToastContext';
import { useClipboard } from '@/hooks/useClipboard';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { Chip, EmptyState, InlineError, LoadingLine, Notice, PanelHeader } from '@/components/ui';

interface AccountInfo {
  id: string;
  email: string;
  username: string;
  globalRole: string;
  emailVerifiedAt: string | null;
  totpEnabled: boolean;
  createdAt: string;
}

interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

export default function AccountPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { copy } = useClipboard();

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [resending, setResending] = useState(false);

  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyExpiry, setNewKeyExpiry] = useState('never');
  const [creatingKey, setCreatingKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  const fetchAccount = useCallback(async () => {
    try {
      const data = await apiRequest('/api/account');
      setAccount(data?.user ?? null);
      setLoadError('');
    } catch (err) {
      // Without this the page sat on its loading spinner forever.
      setLoadError(errorMessage(err, 'Could not load your account'));
    }
  }, []);

  const fetchApiKeys = useCallback(async () => {
    try {
      const data = await apiRequest('/api/account/api-keys');
      setApiKeys(data?.keys || []);
    } catch {
      // The keys list is secondary; the profile above is still usable without it.
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchAccount(), fetchApiKeys()]).finally(() => setLoading(false));
  }, [fetchAccount, fetchApiKeys]);

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingKey(true);
    setKeyError(null);
    try {
      const data = await apiPost('/api/account/api-keys', {
        name: newKeyName.trim(),
        expiresInDays: newKeyExpiry === 'never' ? null : newKeyExpiry,
      });
      setRevealedKey(data.rawKey);
      setNewKeyName('');
      await fetchApiKeys();
    } catch (err) {
      setKeyError(errorMessage(err, 'Failed to create key'));
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeKey = async (key: ApiKeyInfo) => {
    const ok = await confirm({
      title: 'Revoke this API key?',
      message: (
        <>
          Any script or integration still using <strong style={{ color: 'var(--text-primary)' }}>{key.name}</strong> will start
          failing immediately. Keys can&apos;t be restored — you would need to issue a new one.
        </>
      ),
      confirmLabel: 'Revoke key',
      danger: true,
    });
    if (!ok) return;

    try {
      await apiRequest(`/api/account/api-keys/${key.id}`, { method: 'DELETE' });
      toast.success(`Revoked “${key.name}”`);
      await fetchApiKeys();
    } catch (err) {
      toast.error('Could not revoke the key', errorMessage(err));
    }
  };

  const handleResendVerification = async () => {
    setResending(true);
    try {
      const data = await apiPost('/api/account/resend-verification', {});
      toast.success('Verification email sent', data?.message);
    } catch (err) {
      toast.error('Could not send the verification email', errorMessage(err));
    } finally {
      setResending(false);
    }
  };

  const copyKey = async () => {
    if (!revealedKey) return;
    if (await copy(revealedKey)) toast.success('API key copied');
    else toast.error('Could not copy the key', 'Select it and copy manually before dismissing.');
  };

  if (loading) return <LoadingLine>Loading your account…</LoadingLine>;

  if (!account) {
    return (
      <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '32px 24px', display: 'grid', gap: '16px' }}>
        <InlineError message={loadError || 'Your account could not be loaded.'} onRetry={fetchAccount} />
        <Link href="/dashboard" className="cc-btn-ghost" style={{ textDecoration: 'none', justifySelf: 'start' }}>Back to dashboard</Link>
      </main>
    );
  }

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: '80rem', margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span
              style={{
                width: 34, height: 34, borderRadius: '8px', background: 'var(--accent)', color: 'var(--bg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: '1rem',
              }}
            >
              {account.username?.charAt(0).toUpperCase() || '?'}
            </span>
            <div>
              <h1 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>My account</h1>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Profile, API keys and security</span>
            </div>
          </div>
          <Link href="/dashboard" className="cc-btn-ghost" style={{ textDecoration: 'none' }}>Back to dashboard</Link>
        </div>
      </header>

      <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '24px', display: 'grid', gap: '20px' }}>
        {loadError && <InlineError message={loadError} onRetry={fetchAccount} />}

        {/* Profile */}
        <section className="cc-panel" style={{ display: 'grid', gap: '18px' }}>
          <PanelHeader title="Profile" description="Your identity on this panel." />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
            <Detail label="Username" value={account.username} />
            <Detail label="Role" value={account.globalRole === 'GLOBAL_ADMIN' ? 'Global admin' : 'User'} />
            <Detail
              label="Email"
              value={
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {account.email}
                  <Chip tone={account.emailVerifiedAt ? 'accent' : 'warning'}>
                    {account.emailVerifiedAt ? 'Verified' : 'Unverified'}
                  </Chip>
                </span>
              }
            />
            <Detail label="Member since" value={formatDateTime(account.createdAt)} />
          </div>

          {!account.emailVerifiedAt && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <p className="cc-help" style={{ margin: 0, flex: 1, minWidth: '220px' }}>
                Verify your email so you can recover the account if you forget your password.
              </p>
              <button onClick={handleResendVerification} disabled={resending} className="cc-btn-primary">
                {resending ? 'Sending…' : 'Send verification email'}
              </button>
            </div>
          )}
        </section>

        {/* Appearance */}
        <ThemeSelector />

        {/* API keys */}
        <section className="cc-panel" style={{ display: 'grid', gap: '18px' }}>
          <PanelHeader
            title="API keys"
            chips={apiKeys.length > 0 ? <Chip>{apiKeys.length}</Chip> : undefined}
            description="Personal access tokens for scripting against the panel API. Each key has the same access as your account."
          />

          {revealedKey && (
            <div style={{ display: 'grid', gap: '10px', padding: '16px', borderRadius: '8px', background: 'var(--accent-dim)', border: '1px solid var(--accent-border)' }}>
              <p style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--accent)', margin: 0 }}>
                Copy this key now — it won&apos;t be shown again.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <code
                  style={{
                    flex: 1, minWidth: '220px', background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '6px',
                    padding: '8px 10px', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)',
                    wordBreak: 'break-all', userSelect: 'all',
                  }}
                >
                  {revealedKey}
                </code>
                <button type="button" onClick={copyKey} className="cc-btn-primary">Copy</button>
                <button type="button" onClick={() => setRevealedKey(null)} className="cc-btn-ghost">Dismiss</button>
              </div>
            </div>
          )}

          {keyError && <InlineError message={keyError} />}

          <form onSubmit={handleCreateKey} style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '180px' }}>
              <label className="cc-label" htmlFor="key-name">Key name</label>
              <input
                id="key-name"
                required
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="backup script"
                className="cc-input"
              />
            </div>
            <div>
              <label className="cc-label" htmlFor="key-expiry">Expires</label>
              <select id="key-expiry" value={newKeyExpiry} onChange={(e) => setNewKeyExpiry(e.target.value)} className="cc-input">
                {EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <button type="submit" disabled={creatingKey || !newKeyName.trim()} className="cc-btn-primary">
              {creatingKey ? 'Creating…' : 'Create key'}
            </button>
          </form>

          {apiKeys.length === 0 ? (
            <EmptyState title="No API keys yet" description="Create one above to script against the panel API." />
          ) : (
            <div style={{ display: 'grid', gap: '8px' }}>
              {apiKeys.map((key) => {
                const expired = Boolean(key.expiresAt && new Date(key.expiresAt).getTime() < Date.now());
                return (
                  <div key={key.id} className="cc-row">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span className="cc-row-title">{key.name}</span>
                        {expired && <Chip tone="danger">Expired</Chip>}
                      </div>
                      <div className="cc-row-sub" style={{ fontFamily: 'var(--font-mono)' }}>
                        {key.prefix}••••••••
                        {key.expiresAt && ` · expires ${formatDateTime(key.expiresAt)}`}
                        {key.lastUsedAt ? ` · last used ${formatRelative(key.lastUsedAt)}` : ' · never used'}
                      </div>
                    </div>
                    <button onClick={() => handleRevokeKey(key)} className="cc-btn-danger" style={{ padding: '4px 10px' }}>
                      Revoke
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <Notice>Treat API keys like passwords — anyone holding one can do anything your account can.</Notice>
        </section>

        <TwoFactorSection enabled={account.totpEnabled} onChanged={fetchAccount} />
      </main>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="cc-label">{label}</div>
      <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}
