'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { ConsoleViewer } from '@/components/ConsoleViewer';

interface ServerDetail {
  id: string;
  name: string;
  description?: string;
  containerId?: string;
  status: string;
  serverType: string;
  mcVersion: string;
  serverPort: number;
  memoryMb: number;
  cpuLimit: number;
  modpackSlug?: string;
  eulaAccepted: boolean;
  node: {
    name: string;
    host: string;
    port: number;
    apiKey: string;
    isOnline: boolean;
  };
}

export default function ServerConsolePage() {
  const params = useParams();
  const serverId = params.id as string;
  const { user } = useAuth();

  const [server, setServer] = useState<ServerDetail | null>(null);
  const [userRole, setUserRole] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchServerDetails = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}`);
      if (res.ok) {
        const data = await res.json();
        setServer(data.server);
        setUserRole(data.role);
      } else {
        const errData = await res.json();
        setError(errData.error || 'Failed to fetch server details');
      }
    } catch (e: any) {
      setError('Network error retrieving server instance');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (serverId) {
      fetchServerDetails();
    }
  }, [serverId]);

  const handleAction = async (action: string) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const data = await res.json();
      if (res.ok) {
        await fetchServerDetails();
      } else {
        const fullErr = data.details ? `${data.error}: ${data.details}` : (data.error || `Failed to ${action} server`);
        alert(fullErr);
      }
    } catch (e: any) {
      alert(`Network error executing ${action}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500">Loading server console...</div>;
  }

  if (error || !server) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-center p-4">
        <h2 className="text-2xl font-bold text-white mb-2">Error Loading Server</h2>
        <p className="text-slate-400 mb-6">{error || 'Server instance not found'}</p>
        <Link href="/dashboard" className="bg-slate-800 hover:bg-slate-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium">
          ← Return to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur px-8 py-4 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center space-x-4">
          <Link href="/dashboard" className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
              M
            </div>
            <span className="font-bold text-lg text-white">CraftControl</span>
          </Link>
          <span className="text-xs text-slate-500">/</span>
          <span className="text-sm font-semibold text-slate-200">{server.name}</span>
          <span className="text-xs px-2.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
            {userRole}
          </span>
        </div>

        <Link href="/dashboard" className="text-xs bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-slate-200 transition">
          ← Dashboard
        </Link>
      </header>

      {/* Main Server Control Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-8 py-8 space-y-6">
        {/* Top Control Header Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <div className="flex items-center space-x-3 mb-2">
              <h1 className="text-2xl font-bold text-white">{server.name}</h1>
              <span
                className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                  server.status === 'RUNNING'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : server.status === 'STARTING'
                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse'
                    : server.status === 'ERROR'
                    ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                    : 'bg-slate-800 text-slate-400 border border-slate-700'
                }`}
              >
                {server.status}
              </span>
            </div>
            <p className="text-xs text-slate-400 font-mono">
              Node: {server.node.name} ({server.node.host}:{server.serverPort}) • Type: {server.serverType} ({server.mcVersion})
            </p>
          </div>

          {/* Quick Actions */}
          <div className="flex items-center space-x-3">
            {server.status === 'RUNNING' ? (
              <>
                <button
                  onClick={() => handleAction('restart')}
                  disabled={actionLoading}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-4 py-2.5 rounded-xl border border-slate-700 transition"
                >
                  Restart
                </button>
                <button
                  onClick={() => handleAction('stop')}
                  disabled={actionLoading}
                  className="bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 text-xs font-semibold px-5 py-2.5 rounded-xl border border-amber-500/30 transition"
                >
                  Stop
                </button>
                <button
                  onClick={() => handleAction('kill')}
                  disabled={actionLoading}
                  className="bg-red-600/20 hover:bg-red-600/30 text-red-300 text-xs font-semibold px-4 py-2.5 rounded-xl border border-red-500/30 transition"
                >
                  Kill
                </button>
              </>
            ) : (
              <button
                onClick={() => handleAction('start')}
                disabled={actionLoading}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-lg shadow-emerald-600/20 transition"
              >
                {actionLoading ? 'Starting...' : 'Start Server'}
              </button>
            )}
          </div>
        </div>

        {/* Modpack Platform Notice Banner for Modrinth Modpacks */}
        {server.serverType === 'MODRINTH' && server.modpackSlug && (
          <div className="bg-emerald-950/40 border border-emerald-500/30 rounded-2xl p-5 flex items-start space-x-4 text-emerald-200">
            <div className="p-2 bg-emerald-500/10 rounded-xl border border-emerald-500/20 text-emerald-400 mt-0.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-bold text-emerald-300">Client Compatibility Requirement</h3>
              <p className="text-xs text-emerald-200/80 mt-1 leading-relaxed">
                This server runs the official <span className="font-semibold text-white">Modrinth Build ({server.mcVersion})</span>.
                Players <span className="font-bold underline text-emerald-300">MUST install this modpack from the Modrinth App</span> or <a href={`https://modrinth.com/modpack/${server.modpackSlug}`} target="_blank" rel="noreferrer" className="underline font-semibold text-white hover:text-emerald-300">Modrinth.com</a>.
                <span className="block mt-1 text-slate-300 font-mono">
                  ⚠️ Note: CurseForge builds of this modpack carry different dependency mod versions and will cause a client-side Netty DecoderException network disconnect upon joining.
                </span>
              </p>
            </div>
          </div>
        )}

        {/* Server Metadata Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Allocated Memory</span>
            <div className="text-lg font-bold text-white mt-1">{server.memoryMb} MB</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">CPU Limit</span>
            <div className="text-lg font-bold text-white mt-1">{server.cpuLimit} Cores</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Server Port</span>
            <div className="text-lg font-bold text-white mt-1 font-mono">{server.serverPort}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">EULA Consent</span>
            <div className="text-lg font-bold text-emerald-400 mt-1">Accepted</div>
          </div>
        </div>

        {/* Live Interactive WebSocket Terminal Console */}
        <div>
          <h2 className="text-lg font-bold text-white mb-3">Live Terminal & Output</h2>
          <ConsoleViewer
            serverId={server.id}
            containerId={server.containerId || `mc-server-${server.id}`}
            daemonHost={server.node.host}
            daemonPort={server.node.port}
            apiKey={server.node.apiKey}
          />
        </div>
      </main>
    </div>
  );
}
