'use client';

import React, { useEffect, useState } from 'react';

interface SubdomainConfig {
  subdomain: string;
  domain: string;
  serverPort: number;
  nodeHost: string;
  fullAddress: string;
  srvRecord: string;
}

export default function SubdomainTab({ serverId }: { serverId: string }) {
  const [config, setConfig] = useState<SubdomainConfig | null>(null);
  const [subdomainInput, setSubdomainInput] = useState('');
  const [domainInput, setDomainInput] = useState('retr0net.nl');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cfStatus, setCfStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hasGlobalToken, setHasGlobalToken] = useState(false);

  useEffect(() => {
    fetchSubdomain();
    checkGlobalToken();
  }, [serverId]);

  const checkGlobalToken = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.settings?.cloudflareApiToken) {
          setHasGlobalToken(true);
        }
      }
    } catch (e) {}
  };

  const fetchSubdomain = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/subdomain`);
      if (res.ok) {
        const data: SubdomainConfig = await res.json();
        setConfig(data);
        setSubdomainInput(data.subdomain || '');
        setDomainInput(data.domain || 'retr0net.nl');
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
    setCfStatus(null);

    try {
      const res = await fetch(`/api/servers/${serverId}/subdomain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subdomain: subdomainInput,
          domain: domainInput,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(data.message || '✅ Proxy route updated successfully!');
        if (data.cloudflareResult) {
          if (data.cloudflareResult.success) {
            setCfStatus(`🟢 Cloudflare SRV Record Provisioned: ${data.cloudflareResult.srvRecordName}`);
          } else {
            setCfStatus(`⚠️ Cloudflare Note: ${data.cloudflareResult.message}`);
          }
        }
        fetchSubdomain();
      } else {
        setMessage(`❌ Error: ${data.error}`);
      }
    } catch (err: any) {
      setMessage(`❌ Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return <div className="text-center py-12 text-slate-500 text-sm animate-pulse">Loading proxy route config...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <span>🌐 Subdomain & Cloudflare DNS Router</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">Assign custom friendly subdomains (`survival.retr0net.nl`) and automatically provision Cloudflare DNS SRV records in 1 click.</p>
        </div>
      </div>

      {message && (
        <div className={`p-4 rounded-xl text-xs font-semibold ${message.startsWith('❌') ? 'bg-red-500/10 text-red-400 border border-red-500/20' : message.startsWith('⚠️') ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
          {message}
        </div>
      )}

      {cfStatus && (
        <div className={`p-4 rounded-xl text-xs font-mono font-semibold ${cfStatus.startsWith('🟢') ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20' : 'bg-rose-500/10 text-rose-300 border border-rose-500/20'}`}>
          {cfStatus}
        </div>
      )}

      {/* Subdomain Router Form Card */}
      <form onSubmit={handleSave} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
        <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-wider border-b border-slate-800 pb-3 flex items-center justify-between">
          <span>🚀 Subdomain Proxy Configuration</span>
          {hasGlobalToken ? (
            <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
              🟢 Cloudflare Auto-DNS Active (Global Token)
            </span>
          ) : (
            <span className="text-[11px] font-semibold text-amber-400 bg-amber-500/10 px-2.5 py-1 rounded-md border border-amber-500/20">
              ⚠️ Cloudflare Token Not Configured (Global Admin Settings)
            </span>
          )}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Subdomain Prefix</label>
            <input
              type="text"
              value={subdomainInput}
              onChange={(e) => setSubdomainInput(e.target.value)}
              placeholder="e.g. survival"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Base Domain</label>
            <input
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="e.g. retr0net.nl"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-indigo-600/20 transition h-[38px] flex items-center justify-center space-x-2"
          >
            {saving ? <span>Provisioning...</span> : <span>⚡ Auto-Provision Route</span>}
          </button>
        </div>
      </form>

      {/* Active Join Address Banner */}
      {config && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Active Server Join Address</span>
            </h3>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
            <div>
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Player Direct Join Address</span>
              <span className="text-base font-mono font-bold text-emerald-400">{config.fullAddress}</span>
            </div>
            <button
              onClick={() => copyToClipboard(config.fullAddress)}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-4 py-2 rounded-lg transition border border-slate-700"
            >
              {copied ? 'Copied!' : '📋 Copy Address'}
            </button>
          </div>

          <div className="space-y-2">
            <span className="text-xs font-bold text-slate-400 block">Generated Cloudflare / DNS SRV Record Syntax</span>
            <p className="text-[11px] text-slate-500">If not using automatic Cloudflare API sync, manually paste this SRV record into your DNS manager:</p>
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 font-mono text-xs text-indigo-300 break-all select-all">
              {config.srvRecord}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
