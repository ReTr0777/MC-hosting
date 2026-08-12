'use client';

import React, { useEffect, useState } from 'react';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useClipboard } from '@/hooks/useClipboard';
import { usePolledResource } from '@/hooks/usePolledResource';
import { Chip, LoadingLine, Notice, PanelHeader } from '@/components/ui';

/** Pre-filled for new servers so the common case is one field, not two. */
const DEFAULT_BASE_DOMAIN = 'retr0net.nl';

interface SubdomainConfig {
  subdomain: string;
  domain: string;
  serverPort: number;
  nodeHost: string;
  fullAddress: string;
  srvRecord: string;
}

export default function SubdomainTab({ serverId }: { serverId: string }) {
  const toast = useToast();
  const { copied, copy } = useClipboard();

  const [subdomainInput, setSubdomainInput] = useState('');
  const [domainInput, setDomainInput] = useState(DEFAULT_BASE_DOMAIN);
  const [saving, setSaving] = useState(false);
  const [hasGlobalToken, setHasGlobalToken] = useState(false);

  const { data: config, loading, refresh } = usePolledResource<SubdomainConfig | null>(
    `/api/servers/${serverId}/subdomain`,
    null
  );

  // Seed the form from the saved config, but never stomp on what the user is typing.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (config && !seeded) {
      setSubdomainInput(config.subdomain || '');
      setDomainInput(config.domain || DEFAULT_BASE_DOMAIN);
      setSeeded(true);
    }
  }, [config, seeded]);

  useEffect(() => {
    let active = true;
    apiRequest('/api/settings')
      .then((data) => {
        if (active) setHasGlobalToken(Boolean(data?.settings?.cloudflareApiToken));
      })
      .catch(() => {
        // Only drives a status chip — a failure here shouldn't interrupt the page.
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const data = await apiPost(`/api/servers/${serverId}/subdomain`, {
        subdomain: subdomainInput.trim(),
        domain: domainInput.trim(),
      });
      toast.success(data?.message || 'Proxy route updated');

      const cf = data?.cloudflareResult;
      if (cf?.success) {
        toast.success('Cloudflare SRV record provisioned', cf.srvRecordName);
      } else if (cf) {
        toast.toast('warning', 'Cloudflare did not apply the record', cf.message);
      }

      await refresh();
    } catch (err) {
      toast.error('Could not update the proxy route', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (text: string) => {
    if (!(await copy(text))) toast.error('Could not copy to the clipboard', 'Select the address and copy it manually.');
  };

  if (loading) return <LoadingLine>Loading proxy route config…</LoadingLine>;

  return (
    <div style={{ display: 'grid', gap: '16px', maxWidth: '64rem' }}>
      <PanelHeader
        title="Subdomain & DNS"
        chips={
          hasGlobalToken
            ? <Chip tone="accent">Cloudflare auto-DNS active</Chip>
            : <Chip tone="warning">Cloudflare token not configured</Chip>
        }
        description="Give this server a friendly join address and provision the matching Cloudflare SRV record automatically."
      />

      {!hasGlobalToken && (
        <Notice tone="warning">
          No Cloudflare API token is set in admin settings, so DNS records won&apos;t be created automatically. You can still
          save a route here and paste the generated SRV record into your DNS provider by hand.
        </Notice>
      )}

      <form onSubmit={handleSave} className="cc-panel">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', alignItems: 'end' }}>
          <div>
            <label className="cc-label" htmlFor="sd-prefix">Subdomain prefix</label>
            <input
              id="sd-prefix"
              value={subdomainInput}
              onChange={(e) => setSubdomainInput(e.target.value)}
              placeholder="survival"
              className="cc-input"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>

          <div>
            <label className="cc-label" htmlFor="sd-domain">Base domain</label>
            <input
              id="sd-domain"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="example.com"
              className="cc-input"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>

          <button type="submit" disabled={saving || !subdomainInput.trim() || !domainInput.trim()} className="cc-btn-primary" style={{ height: '36px' }}>
            {saving ? 'Provisioning…' : 'Provision route'}
          </button>
        </div>
        <p className="cc-help">
          Players will join at <strong style={{ color: 'var(--text-primary)' }}>
            {subdomainInput.trim() || 'prefix'}.{domainInput.trim() || 'example.com'}
          </strong> once the record propagates.
        </p>
      </form>

      {config?.fullAddress && (
        <div className="cc-panel" style={{ display: 'grid', gap: '16px' }}>
          <h3 className="cc-section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
            <span className="pulse-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />
            Active join address
          </h3>

          <div
            style={{
              background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '14px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <span className="cc-label" style={{ marginBottom: '4px' }}>Player join address</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1rem', color: 'var(--accent)', wordBreak: 'break-all' }}>
                {config.fullAddress}
              </span>
            </div>
            <button onClick={() => handleCopy(config.fullAddress)} className="cc-btn-ghost">
              {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>

          <div>
            <span className="cc-label">DNS SRV record</span>
            <p className="cc-help" style={{ margin: '0 0 8px' }}>
              If you aren&apos;t using automatic Cloudflare sync, paste this record into your DNS manager:
            </p>
            <div
              style={{
                background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '12px 14px',
                fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-primary)', wordBreak: 'break-all', userSelect: 'all',
              }}
            >
              {config.srvRecord}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
