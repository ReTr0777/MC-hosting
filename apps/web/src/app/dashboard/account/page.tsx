'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import TwoFactorSection from '@/components/TwoFactorSection';
import { useConfirm } from '@/context/ConfirmContext';

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

export default function AccountPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyExpiry, setNewKeyExpiry] = useState('never');
  const [creatingKey, setCreatingKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  const fetchAccount = async () => {
    const res = await fetch('/api/account');
    const data = await res.json();
    setAccount(data.user);
  };

  useEffect(() => {
    fetchAccount().finally(() => setLoading(false));
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    const res = await fetch('/api/account/api-keys');
    if (res.ok) {
      const data = await res.json();
      setApiKeys(data.keys || []);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingKey(true);
    setKeyError(null);
    try {
      const res = await fetch('/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newKeyName,
          expiresInDays: newKeyExpiry === 'never' ? null : newKeyExpiry,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create key');
      setRevealedKey(data.rawKey);
      setNewKeyName('');
      fetchApiKeys();
    } catch (err: any) {
      setKeyError(err.message);
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    const ok = await confirm({
      title: 'Revoke this API key?',
      message: 'Any script or integration still using it will start failing immediately. Keys cannot be restored — you would need to issue a new one.',
      confirmLabel: 'Revoke key',
      danger: true,
    });
    if (!ok) return;
    await fetch(`/api/account/api-keys/${id}`, { method: 'DELETE' });
    fetchApiKeys();
  };

  const handleResendVerification = async () => {
    setResending(true);
    setResendMessage(null);
    try {
      const res = await fetch('/api/account/resend-verification', { method: 'POST' });
      const data = await res.json();
      setResendMessage(res.ok ? `${data.message}` : `${data.error}`);
    } catch (err: any) {
      setResendMessage(`${err.message}`);
    } finally {
      setResending(false);
    }
  };

  if (loading || !account) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="animate-pulse text-sm text-slate-500 font-mono">Loading Account...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 bg-gradient-to-tr from-emerald-500 to-teal-500 rounded-xl flex items-center justify-center font-bold text-white shadow-lg shadow-emerald-500/20">
              {account.username?.charAt(0).toUpperCase() || '?'}
            </div>
            <div>
              <h1 className="text-base font-bold text-white tracking-wide">My Account</h1>
              <span className="text-[11px] text-slate-400">Manage your profile, security, and email preferences</span>
            </div>
          </div>

          <Link
            href="/dashboard"
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-4 py-2 rounded-xl border border-slate-700 transition flex items-center space-x-2"
          >
            <span>← Back to Dashboard</span>
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
          <div className="border-b border-slate-800 pb-4">
            <h2 className="text-base font-bold text-white">Profile</h2>
            <p className="text-xs text-slate-400 mt-0.5">Your account identity on this panel.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Username</div>
              <div className="text-white font-semibold">{account.username}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Role</div>
              <div className="text-white font-semibold">{account.globalRole}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Email</div>
              <div className="text-white font-semibold flex items-center gap-2">
                {account.email}
                {account.emailVerifiedAt ? (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                    Verified
                  </span>
                ) : (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                    Unverified
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Member Since</div>
              <div className="text-white font-semibold">{new Date(account.createdAt).toLocaleDateString()}</div>
            </div>
          </div>

          {!account.emailVerifiedAt && (
            <div className="pt-2 border-t border-slate-800 flex items-center justify-between flex-wrap gap-3">
              <p className="text-xs text-slate-400">Verify your email so you can recover your account if you ever forget your password.</p>
              <button
                onClick={handleResendVerification}
                disabled={resending}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                {resending ? 'Sending...' : 'Send verification email'}
              </button>
            </div>
          )}

          {resendMessage && (
            <div className="text-xs font-semibold text-slate-300">{resendMessage}</div>
          )}
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
          <div className="border-b border-slate-800 pb-4">
            <h2 className="text-base font-bold text-white">API Keys</h2>
            <p className="text-xs text-slate-400 mt-0.5">Personal access tokens for scripting against the panel API. Each key has the same access as your account.</p>
          </div>

          {revealedKey && (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 space-y-2">
              <p className="text-xs font-bold text-emerald-400">Copy this key now — it won't be shown again.</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white font-mono break-all">{revealedKey}</code>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(revealedKey)}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-2 rounded-lg transition shrink-0"
                >
                  Copy
                </button>
              </div>
              <button
                type="button"
                onClick={() => setRevealedKey(null)}
                className="text-[11px] text-slate-400 hover:text-slate-200"
              >
                Dismiss
              </button>
            </div>
          )}

          {keyError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{keyError}</div>
          )}

          <form onSubmit={handleCreateKey} className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[160px] space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">Key Name</label>
              <input
                type="text"
                required
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. backup script"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">Expires</label>
              <select
                value={newKeyExpiry}
                onChange={(e) => setNewKeyExpiry(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-emerald-500 focus:outline-none"
              >
                <option value="never">Never</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={creatingKey}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition"
            >
              {creatingKey ? 'Creating...' : 'Create Key'}
            </button>
          </form>

          {apiKeys.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-xs font-mono">No API keys yet.</div>
          ) : (
            <div className="divide-y divide-slate-800/60">
              {apiKeys.map((key) => (
                <div key={key.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-semibold text-white">{key.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {key.prefix}••••••••
                      {key.expiresAt && <span> · expires {new Date(key.expiresAt).toLocaleDateString()}</span>}
                      {key.lastUsedAt ? <span> · last used {new Date(key.lastUsedAt).toLocaleDateString()}</span> : <span> · never used</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevokeKey(key.id)}
                    className="text-xs text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/40 px-3 py-1.5 rounded-lg transition"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <TwoFactorSection enabled={account.totpEnabled} onChanged={fetchAccount} />
      </main>
    </div>
  );
}
