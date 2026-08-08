'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { ConsoleViewer } from '@/components/ConsoleViewer';
import { FileExplorer } from '@/components/FileExplorer';
import { ServerPermissionsModal } from '@/components/ServerPermissionsModal';

interface ServerDetail {
  id: string;
  name: string;
  description?: string;
  nodeId: string;
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
  const [nodes, setNodes] = useState<any[]>([]);
  const [userRole, setUserRole] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [migrationDestId, setMigrationDestId] = useState('');
  const [error, setError] = useState('');

  // Active View Tab: 'console' | 'files'
  const [activeTab, setActiveTab] = useState<'console' | 'files'>('console');
  // Permissions Modal State
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);

  const fetchServerDetails = async () => {
    try {
      const [serverRes, nodesRes] = await Promise.all([
        fetch(`/api/servers/${serverId}`),
        fetch(`/api/nodes`)
      ]);
      
      if (serverRes.ok) {
        const data = await serverRes.json();
        setServer(data.server);
        setUserRole(data.role);
      } else {
        const errData = await serverRes.json();
        setError(errData.error || 'Failed to fetch server details');
      }

      if (nodesRes.ok) {
        const data = await nodesRes.json();
        setNodes(Array.isArray(data.nodes) ? data.nodes : []);
      } else {
        setNodes([]);
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

  const handleMigrate = async () => {
    if (!migrationDestId) return alert('Select a destination node');
    if (!confirm('WARNING: If the server is currently running, it will gracefully shut down with a 10 second countdown. Once it shuts down, it will migrate to the new node. Your server will be offline during the transfer. Are you sure you want to proceed?')) return;
    
    setActionLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationNodeId: migrationDestId }),
      });
      const data = await res.json();
      if (res.ok) {
        alert('Migration process has started! Your server is currently migrating in the background.');
        // Force refresh
        setTimeout(() => window.location.reload(), 2000);
      } else {
        alert(data.error || 'Failed to trigger migration');
      }
    } catch (e) {
      alert('Network error');
    } finally {
      setActionLoading(false);
    }
  };

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
          <div className="flex flex-wrap items-center gap-3">
            {user?.globalRole === 'GLOBAL_ADMIN' && (
              <button
                onClick={() => setShowPermissionsModal(true)}
                className="bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 text-xs font-semibold px-4 py-2.5 rounded-xl border border-purple-500/30 transition flex items-center space-x-1.5"
              >
                <span>🔑</span>
                <span>User Access & Privileges</span>
              </button>
            )}

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

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 space-x-6">
          <button
            onClick={() => setActiveTab('console')}
            className={`pb-3 text-sm font-bold border-b-2 transition flex items-center space-x-2 ${
              activeTab === 'console'
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>🖥️ Console & Status</span>
          </button>
          <button
            onClick={() => setActiveTab('files')}
            className={`pb-3 text-sm font-bold border-b-2 transition flex items-center space-x-2 ${
              activeTab === 'files'
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>📁 File Explorer</span>
          </button>
        </div>

        {activeTab === 'console' ? (
          <>
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

            {/* Server Migration Block */}
            <div className="mt-8 bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                Server Migration
              </h3>
              <p className="text-sm text-slate-400 mb-6 max-w-3xl leading-relaxed">
                Instantly transfer this server and all of its files to a different node. If the server is currently running, it will automatically perform a graceful 10-second shutdown countdown in-game before transferring.
              </p>

              <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
                <select
                  value={migrationDestId}
                  onChange={(e) => setMigrationDestId(e.target.value)}
                  className="bg-slate-950 border border-slate-700 text-white text-sm rounded-xl focus:ring-indigo-500 focus:border-indigo-500 block w-full sm:max-w-xs p-3 transition"
                >
                  <option value="">Select Destination Node...</option>
                  {nodes
                    .filter(n => n.id !== server.nodeId)
                    .map(n => (
                      <option key={n.id} value={n.id}>
                        {n.name} (Priority {n.offloadPriority}) {n.isOnline ? '' : '- OFFLINE'}
                      </option>
                    ))}
                </select>
                <button
                  onClick={handleMigrate}
                  disabled={actionLoading || !migrationDestId}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-6 py-3 rounded-xl shadow-lg shadow-indigo-600/20 transition whitespace-nowrap"
                >
                  {actionLoading ? 'Migrating...' : 'Start Migration'}
                </button>
              </div>
            </div>
          </>
        ) : (
          /* File Explorer Tab */
          <div>
            <h2 className="text-lg font-bold text-white mb-3">Server File Explorer (v1.0.5)</h2>
            <FileExplorer
              serverId={server.id}
              canManageFiles={user?.globalRole === 'GLOBAL_ADMIN' || userRole === 'OPERATOR' || userRole === 'ADMIN'}
            />
          </div>
        )}

        {/* Server Permissions Modal */}
        <ServerPermissionsModal
          serverId={server.id}
          serverName={server.name}
          isOpen={showPermissionsModal}
          onClose={() => setShowPermissionsModal(false)}
        />

      </main>
    </div>
  );
}
