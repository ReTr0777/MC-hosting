'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import AlertsPanel from '@/components/admin/AlertsPanel';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Chip, EmptyState, InlineError, LoadingLine, Notice, PanelHeader } from '@/components/ui';

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

const DEFAULT_DOMAIN = 'retr0net.com';

/** Reveal toggle shared by the token and password fields. */
function SecretInput({
  id, value, onChange, placeholder,
}: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="cc-input"
        style={{ fontFamily: 'var(--font-mono)', paddingRight: '58px' }}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide value' : 'Show value'}
        style={{
          position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem',
          fontWeight: 600, color: 'var(--text-muted)',
        }}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const toast = useToast();

  const [tokenInput, setTokenInput] = useState('');
  const [zoneIdInput, setZoneIdInput] = useState('');
  const [defaultDomainInput, setDefaultDomainInput] = useState(DEFAULT_DOMAIN);
  const [logs, setLogs] = useState<CloudflareLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [publicAppUrl, setPublicAppUrl] = useState('');
  const [publicAppUrlFromEnv, setPublicAppUrlFromEnv] = useState('');
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [testingEmail, setTestingEmail] = useState(false);

  const isAdmin = user?.globalRole === 'GLOBAL_ADMIN';

  const fetchSettings = useCallback(async () => {
    try {
      const data = await apiRequest('/api/settings');
      const s = data?.settings || {};
      setTokenInput(s.cloudflareApiToken || '');
      setZoneIdInput(s.cloudflareZoneId || '');
      setDefaultDomainInput(s.defaultDomain || DEFAULT_DOMAIN);
      setSmtpHost(s.smtpHost || '');
      setSmtpPort(s.smtpPort || '587');
      setSmtpUser(s.smtpUser || '');
      setSmtpPass(s.smtpPass || '');
      setSmtpFrom(s.smtpFrom || '');
      setSmtpSecure(Boolean(s.smtpSecure));
      setPublicAppUrl(s.publicAppUrl || '');
      setPublicAppUrlFromEnv(s.publicAppUrlFromEnv || '');
      setAiEnabled(Boolean(s.aiAnalysisEnabled));
      setAiBaseUrl(s.aiBaseUrl || '');
      setAiModel(s.aiModel || '');
      setAiApiKey(s.aiApiKey || '');
      setLogs(data?.logs || []);
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load settings'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiPost('/api/settings', {
        cloudflareApiToken: tokenInput,
        cloudflareZoneId: zoneIdInput,
        defaultDomain: defaultDomainInput,
        smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpSecure,
        aiAnalysisEnabled: aiEnabled, aiBaseUrl, aiModel, aiApiKey,
        publicAppUrl,
      });
      toast.success('Settings saved');
      await fetchSettings();
    } catch (err) {
      toast.error('Could not save settings', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      // This endpoint reports failures as HTTP 200 with success:false, so the body decides.
      const data = await apiPost('/api/settings/test-cloudflare', { token: tokenInput, zoneId: zoneIdInput });
      if (data?.success) toast.success('Cloudflare API reachable', data.message);
      else toast.error('Cloudflare test failed', data?.message || data?.error);
    } catch (err) {
      toast.error('Cloudflare test failed', errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  const handleTestEmail = async () => {
    setTestingEmail(true);
    try {
      const data = await apiPost('/api/settings/test-email', {
        host: smtpHost, port: smtpPort, smtpUser, pass: smtpPass, from: smtpFrom, secure: smtpSecure,
      });
      if (data?.success) toast.success('Test email sent', data.message);
      else toast.error('SMTP test failed', data?.message || data?.error);
    } catch (err) {
      toast.error('SMTP test failed', errorMessage(err));
    } finally {
      setTestingEmail(false);
    }
  };

  if (loading) return <LoadingLine>Loading global settings…</LoadingLine>;

  if (!isAdmin) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Not authorised</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>
          Only global admins can view system settings and provisioning logs.
        </p>
        <Link href="/dashboard" className="cc-btn-primary" style={{ textDecoration: 'none' }}>Back to dashboard</Link>
      </div>
    );
  }

  const th: React.CSSProperties = {
    padding: '10px 14px', textAlign: 'left', fontSize: '0.62rem', fontWeight: 800,
    letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = { padding: '10px 14px', fontSize: '0.72rem', fontFamily: 'var(--font-mono)' };

  return (
    <div style={{ minHeight: '100vh' }}>
      <header
        style={{
          borderBottom: '1px solid var(--border)', background: 'var(--surface)',
          position: 'sticky', top: 0, zIndex: 50,
        }}
      >
        <div style={{ maxWidth: '80rem', margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Global settings</h1>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Alerts, Cloudflare DNS and outbound email</span>
          </div>
          <Link href="/dashboard" className="cc-btn-ghost" style={{ textDecoration: 'none' }}>Back to dashboard</Link>
        </div>
      </header>

      <main style={{ maxWidth: '80rem', margin: '0 auto', padding: '24px', display: 'grid', gap: '20px' }}>
        {loadError && <InlineError message={loadError} onRetry={fetchSettings} />}

        <AlertsPanel />

        {/* One form covers both Cloudflare and SMTP, so a single Save applies everything. */}
        <form onSubmit={handleSave} style={{ display: 'grid', gap: '20px' }}>
          <section className="cc-panel">
            <PanelHeader
              title="Cloudflare DNS"
              description="A global API token lets every server subdomain provision its own SRV record automatically."
              actions={
                <button type="button" onClick={handleTestConnection} disabled={testing || !tokenInput} className="cc-btn-ghost">
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
              }
            />

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
              <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
                <label className="cc-label" htmlFor="cf-token">API token</label>
                <SecretInput id="cf-token" value={tokenInput} onChange={setTokenInput} placeholder="Token with Zone:DNS:Edit" />
                <p className="cc-help">Create this under Cloudflare profile → API tokens, with <strong>Zone:DNS:Edit</strong> permission.</p>
              </div>

              <div>
                <label className="cc-label" htmlFor="cf-zone">Zone ID</label>
                <input id="cf-zone" value={zoneIdInput} onChange={(e) => setZoneIdInput(e.target.value)} placeholder="From the domain overview page" className="cc-input" style={{ fontFamily: 'var(--font-mono)' }} />
              </div>

              <div>
                <label className="cc-label" htmlFor="cf-domain">Default domain</label>
                <input id="cf-domain" value={defaultDomainInput} onChange={(e) => setDefaultDomainInput(e.target.value)} placeholder={DEFAULT_DOMAIN} className="cc-input" style={{ fontFamily: 'var(--font-mono)' }} />
              </div>
            </div>
          </section>

          <section className="cc-panel">
            <PanelHeader
              title="Panel address"
              description="The address people reach this panel on. Verification and password-reset emails build their links from it, so a wrong value here produces links that cannot be opened."
            />

            <div>
              <label className="cc-label" htmlFor="public-url">Public panel URL</label>
              <input
                id="public-url"
                value={publicAppUrl}
                onChange={(e) => setPublicAppUrl(e.target.value)}
                placeholder="https://panel.example.com"
                disabled={!!publicAppUrlFromEnv}
                className="cc-input"
                style={{ fontFamily: 'var(--font-mono)', opacity: publicAppUrlFromEnv ? 0.6 : 1 }}
              />
              {publicAppUrlFromEnv ? (
                <p className="cc-help">
                  Set by the <code>APP_URL</code> environment variable to <strong>{publicAppUrlFromEnv}</strong>, which
                  takes precedence over this field. Clear that variable to edit it here.
                </p>
              ) : (
                <p className="cc-help">
                  Leave blank to work it out from each request, which is right when the panel is only reached at one
                  address. Set it when the panel answers on several — a LAN IP and a domain, say — so emails always
                  point at the one you want.
                </p>
              )}
            </div>
          </section>

          <section className="cc-panel">
            <PanelHeader
              title="Outbound email (SMTP)"
              description="Used for password reset links and email verification. Leave the host blank to disable outbound email entirely."
              actions={
                <button type="button" onClick={handleTestEmail} disabled={testingEmail || !smtpHost} className="cc-btn-ghost">
                  {testingEmail ? 'Sending…' : 'Send test email'}
                </button>
              }
            />

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
              <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
                <label className="cc-label" htmlFor="smtp-host">Host</label>
                <input id="smtp-host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" className="cc-input" style={{ fontFamily: 'var(--font-mono)' }} />
              </div>
              <div>
                <label className="cc-label" htmlFor="smtp-port">Port</label>
                <input id="smtp-port" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" className="cc-input" style={{ fontFamily: 'var(--font-mono)' }} />
              </div>
              <div>
                <label className="cc-label" htmlFor="smtp-user">Username</label>
                <input id="smtp-user" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="user@example.com" autoComplete="off" className="cc-input" style={{ fontFamily: 'var(--font-mono)' }} />
              </div>
              <div>
                <label className="cc-label" htmlFor="smtp-pass">Password</label>
                <SecretInput id="smtp-pass" value={smtpPass} onChange={setSmtpPass} placeholder="App password or SMTP secret" />
              </div>
              <div>
                <label className="cc-label" htmlFor="smtp-from">From address</label>
                <input id="smtp-from" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="CraftControl <no-reply@example.com>" className="cc-input" style={{ fontFamily: 'var(--font-mono)' }} />
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px', fontSize: '0.8125rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              <span>Use implicit TLS (port 465). Leave unchecked for STARTTLS on port 587.</span>
            </label>
          </section>

          <section className="cc-panel">
            <PanelHeader
              title="AI crash analysis"
              description={
                'Optional. The crash analyser recognises the common Minecraft failures on its own, offline and instantly. ' +
                'Connect a model here and anything it cannot classify is sent to that model for an explanation instead.'
              }
            />

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', fontSize: '0.8125rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              <span>Send unrecognised crash logs to the configured model</span>
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
              <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
                <label className="cc-label" htmlFor="ai-base-url">API base URL</label>
                <input id="ai-base-url" value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="cc-input" style={{ fontFamily: 'var(--font-mono)' }} />
                <p className="cc-help">
                  Any OpenAI-compatible endpoint. Use <code>http://localhost:11434/v1</code> for Ollama, or your OpenRouter,
                  LM Studio or vLLM address — logs then never leave your network.
                </p>
              </div>
              <div>
                <label className="cc-label" htmlFor="ai-model">Model</label>
                <input id="ai-model" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="gpt-4o-mini" className="cc-input" style={{ fontFamily: 'var(--font-mono)' }} />
              </div>
              <div>
                <label className="cc-label" htmlFor="ai-key">API key</label>
                <SecretInput id="ai-key" value={aiApiKey} onChange={setAiApiKey} placeholder="Not needed for a local model" />
              </div>
            </div>

            <Notice tone="warning">
              Enabling this sends the tail of a crashed server's log to the endpoint above. Minecraft logs routinely contain
              player names, IP addresses and file paths — only point this at a provider you are willing to share that with.
            </Notice>
          </section>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" disabled={saving} className="cc-btn-primary">
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>

        {/* Audit log */}
        <section className="cc-panel">
          <PanelHeader
            title="Cloudflare audit log"
            chips={logs.length > 0 ? <Chip>{logs.length}</Chip> : undefined}
            description="Every SRV record creation, update and API event, newest first."
            actions={<button onClick={fetchSettings} className="cc-btn-ghost">Refresh</button>}
          />

          {logs.length === 0 ? (
            <EmptyState title="No provisioning events yet" description="Records appear here once a server provisions a subdomain." />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '820px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={th}>Time</th>
                    <th style={th}>Action</th>
                    <th style={th}>Target</th>
                    <th style={th}>Status</th>
                    <th style={th}>User</th>
                    <th style={th}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatDateTime(log.createdAt)}</td>
                      <td style={{ ...td, color: 'var(--text-primary)', fontWeight: 600 }}>{log.action}</td>
                      <td style={{ ...td, color: 'var(--accent)' }}>{log.subdomain}.{log.domain}</td>
                      <td style={{ ...td }}>
                        <Chip tone={log.status === 'SUCCESS' ? 'accent' : 'danger'}>{log.status}</Chip>
                      </td>
                      <td style={{ ...td, color: 'var(--text-muted)' }}>{log.userEmail || 'system'}</td>
                      <td style={{ ...td, color: 'var(--text-muted)', maxWidth: '24rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={log.details}>
                        {log.details}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <Notice tone="warning">
          The Cloudflare token and SMTP password are stored so they can be used by background jobs, and are returned to this
          page to populate the fields above. Anyone with global admin access can reveal them.
        </Notice>
      </main>
    </div>
  );
}
