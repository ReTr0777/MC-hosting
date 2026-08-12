'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import AlertsPanel from '@/components/AlertsPanel';

interface CloudflareLog {
  id: string;
  action: string;
  subdomain: string;
  domain: string;
  status: string;
  details: string;
  userEmail?: string;
  createdAt: string;
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [tokenInput, setTokenInput] = useState('');
  const [zoneIdInput, setZoneIdInput] = useState('');
  const [defaultDomainInput, setDefaultDomainInput] = useState('retr0net.com');
  const [showToken, setShowToken] = useState(false);
  const [logs, setLogs] = useState<CloudflareLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [showSmtpPass, setShowSmtpPass] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [emailTestResult, setEmailTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setTokenInput(data.settings.cloudflareApiToken || '');
        setZoneIdInput(data.settings.cloudflareZoneId || '');
        setDefaultDomainInput(data.settings.defaultDomain || 'retr0net.com');
        setSmtpHost(data.settings.smtpHost || '');
        setSmtpPort(data.settings.smtpPort || '587');
        setSmtpUser(data.settings.smtpUser || '');
        setSmtpPass(data.settings.smtpPass || '');
        setSmtpFrom(data.settings.smtpFrom || '');
        setSmtpSecure(!!data.settings.smtpSecure);
        setLogs(data.logs || []);
      }
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cloudflareApiToken: tokenInput,
          cloudflareZoneId: zoneIdInput,
          defaultDomain: defaultDomainInput,
          smtpHost,
          smtpPort,
          smtpUser,
          smtpPass,
          smtpFrom,
          smtpSecure,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: 'Global admin settings updated successfully!' });
        fetchSettings();
      } else {
        setMessage({ kind: 'err', text: `Error: ${data.error}` });
      }
    } catch (err: any) {
      setMessage({ kind: 'err', text: `Error: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/test-cloudflare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput, zoneId: zoneIdInput }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setTestResult({ ok: true, text: data.message });
      } else {
        setTestResult({ ok: false, text: `Connection failed: ${data.message || data.error}` });
      }
    } catch (err: any) {
      setTestResult({ ok: false, text: `Network error: ${err.message}` });
    } finally {
      setTesting(false);
    }
  };

  const handleTestEmail = async () => {
    setTestingEmail(true);
    setEmailTestResult(null);
    try {
      const res = await fetch('/api/settings/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: smtpHost, port: smtpPort, smtpUser, pass: smtpPass, from: smtpFrom, secure: smtpSecure }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setEmailTestResult({ ok: true, text: data.message });
      } else {
        setEmailTestResult({ ok: false, text: `${data.message || data.error}` });
      }
    } catch (err: any) {
      setEmailTestResult({ ok: false, text: `Network error: ${err.message}` });
    } finally {
      setTestingEmail(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="animate-pulse text-sm text-slate-500 font-mono">Loading Global Settings...</div>
      </div>
    );
  }

  if (user?.globalRole !== 'GLOBAL_ADMIN') {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-8 flex flex-col items-center justify-center">
        <div className="bg-red-950/40 border border-red-500/30 rounded-2xl p-8 max-w-md text-center">
          <h2 className="text-xl font-bold text-red-400">Access Denied</h2>
          <p className="text-xs text-slate-400 mt-2">Only Global Administrators can access System Settings and Cloudflare Logs.</p>
          <Link href="/dashboard" className="inline-block mt-6 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold px-6 py-2.5 rounded-xl border border-slate-700 transition">
            Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      {/* Header Bar */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 bg-gradient-to-tr from-amber-500 to-orange-500 rounded-xl flex items-center justify-center font-bold text-white shadow-lg shadow-orange-500/20">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </div>
            <div>
              <h1 className="text-base font-bold text-white tracking-wide">CraftControl Global Admin Settings</h1>
              <span className="text-[11px] text-slate-400">Manage Cloudflare API Keys & Provisioning Audit Logs</span>
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

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {message && (
          <div className={`p-4 rounded-xl text-xs font-semibold ${message.kind === 'err' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
            {message.text}
          </div>
        )}

        {/* Alerts & Webhooks */}
        <AlertsPanel />

        {/* Cloudflare API Integration Form Card */}
        <form onSubmit={handleSave} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-bold text-orange-400 flex items-center space-x-2">
                <span>Cloudflare API Global Configuration</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Configure your global Cloudflare API token. All server subdomains will automatically provision SRV records under this domain.</p>
            </div>

            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing || !tokenInput}
              className="bg-orange-600/20 hover:bg-orange-600/30 text-orange-300 border border-orange-500/40 text-xs font-bold px-4 py-2 rounded-xl transition flex items-center space-x-2 disabled:opacity-50"
            >
              {testing ? <span>Testing API Token...</span> : <span>Test Cloudflare API</span>}
            </button>
          </div>

          {testResult && (
            <div className={`p-4 rounded-xl text-xs font-mono font-semibold ${testResult.ok ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-red-500/10 text-red-300 border border-red-500/20'}`}>
              {testResult.text}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-1.5 md:col-span-2">
              <label className="block text-xs font-bold text-slate-300">Cloudflare API Token</label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Bearer API Token (requires Zone.DNS edit permissions)..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-orange-500 focus:outline-none pr-20"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-3 top-2.5 text-[11px] font-semibold text-slate-400 hover:text-slate-200"
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
              </div>
              <span className="text-[10px] text-slate-500 block">Create API Token at Cloudflare Profile &gt; API Tokens with `Zone:DNS:Edit` permissions.</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">Cloudflare Zone ID</label>
              <input
                type="text"
                value={zoneIdInput}
                onChange={(e) => setZoneIdInput(e.target.value)}
                placeholder="Cloudflare Zone ID (from domain overview)..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-orange-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end pt-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">Default Global Domain</label>
              <input
                type="text"
                value={defaultDomainInput}
                onChange={(e) => setDefaultDomainInput(e.target.value)}
                placeholder="e.g. retr0net.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-orange-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-orange-600/20 transition h-[38px]"
            >
              {saving ? 'Saving Settings...' : 'Save System Settings'}
            </button>
          </div>
        </form>

        {/* SMTP Email Configuration Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-bold text-sky-400 flex items-center space-x-2">
                <span>Outbound Email (SMTP)</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Used for password reset links and email verification. Leave blank to disable outbound email.</p>
            </div>

            <button
              type="button"
              onClick={handleTestEmail}
              disabled={testingEmail || !smtpHost}
              className="bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/40 text-xs font-bold px-4 py-2 rounded-xl transition flex items-center space-x-2 disabled:opacity-50"
            >
              {testingEmail ? <span>Sending Test Email...</span> : <span>Send Test Email</span>}
            </button>
          </div>

          {emailTestResult && (
            <div className={`p-4 rounded-xl text-xs font-mono font-semibold ${emailTestResult.ok ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-red-500/10 text-red-300 border border-red-500/20'}`}>
              {emailTestResult.text}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-1.5 md:col-span-2">
              <label className="block text-xs font-bold text-slate-300">SMTP Host</label>
              <input
                type="text"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">SMTP Port</label>
              <input
                type="text"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                placeholder="587"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">SMTP Username</label>
              <input
                type="text"
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
                placeholder="user@example.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">SMTP Password</label>
              <div className="relative">
                <input
                  type={showSmtpPass ? 'text' : 'password'}
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                  placeholder="App password or SMTP secret..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-sky-500 focus:outline-none pr-16"
                />
                <button
                  type="button"
                  onClick={() => setShowSmtpPass(!showSmtpPass)}
                  className="absolute right-3 top-2.5 text-[11px] font-semibold text-slate-400 hover:text-slate-200"
                >
                  {showSmtpPass ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300">From Address</label>
              <input
                type="text"
                value={smtpFrom}
                onChange={(e) => setSmtpFrom(e.target.value)}
                placeholder="CraftControl <no-reply@example.com>"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>

          <label className="flex items-center space-x-2 text-xs font-semibold text-slate-300">
            <input
              type="checkbox"
              checked={smtpSecure}
              onChange={(e) => setSmtpSecure(e.target.checked)}
              className="rounded border-slate-700 bg-slate-950"
            />
            <span>Use implicit TLS (port 465). Leave unchecked for STARTTLS (port 587).</span>
          </label>
        </div>

        {/* Cloudflare Audit Logs Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-bold text-white flex items-center space-x-2">
                <span>Cloudflare Provisioning Audit Log</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Comprehensive history of every Cloudflare SRV DNS record creation, update, and API event.</p>
            </div>
            <button
              onClick={fetchSettings}
              className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold px-3.5 py-1.5 rounded-xl border border-slate-700 transition"
            >
              Refresh Logs
            </button>
          </div>

          {logs.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs font-mono">No Cloudflare provisioning events logged yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 font-bold uppercase tracking-wider">
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-4">Action</th>
                    <th className="py-3 px-4">Target Subdomain</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">User</th>
                    <th className="py-3 px-4">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-950/40 transition">
                      <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                      <td className="py-3 px-4 font-bold text-indigo-300">{log.action}</td>
                      <td className="py-3 px-4 text-emerald-400 font-bold">{log.subdomain}.{log.domain}</td>
                      <td className="py-3 px-4">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${log.status === 'SUCCESS' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                          {log.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-300">{log.userEmail || 'system'}</td>
                      <td className="py-3 px-4 text-slate-400 max-w-md truncate">{log.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
