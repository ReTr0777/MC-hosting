'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';

interface NodeItem {
  id: string;
  name: string;
  host: string;
  port: number;
  isOnline: boolean;
  totalMemory: number;
  totalCpu: number;
  offloadPriority: number;
  _count: { servers: number };
}

interface ServerItem {
  id: string;
  name: string;
  description: string;
  status: string;
  serverType: string;
  mcVersion: string;
  serverPort: number;
  memoryMb: number;
  modpackSlug?: string;
  node: { name: string; isOnline: boolean };
}

interface ModpackHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string;
  downloads: number;
}

const MC_VERSIONS = [
  'LATEST',
  '1.20.4',
  '1.20.3',
  '1.20.2',
  '1.20.1',
  '1.20',
  '1.19.4',
  '1.19.3',
  '1.19.2',
  '1.19.1',
  '1.19',
  '1.18.2',
  '1.18.1',
  '1.18',
  '1.17.1',
  '1.17',
  '1.16.5',
  '1.16.4',
  '1.16.3',
  '1.16.2',
  '1.16.1',
  '1.16',
  '1.15.2',
  '1.15.1',
  '1.15',
  '1.14.4',
  '1.14.3',
  '1.14',
  '1.13.2',
  '1.13.1',
  '1.13',
  '1.12.2',
  '1.12.1',
  '1.12',
  '1.11.2',
  '1.11',
  '1.10.2',
  '1.10',
  '1.9.4',
  '1.9',
  '1.8.9',
  '1.8.8',
  '1.8',
  '1.7.10',
  '1.7.2',
  'CUSTOM',
];

const SERVER_TYPES = [
  { id: 'FABRIC', name: 'Fabric', desc: 'Lightweight & highly moddable loader', icon: '⚡' },
  { id: 'FORGE', name: 'Forge', desc: 'Classic heavy modpack framework', icon: '🛠️' },
  { id: 'PAPER', name: 'Paper', desc: 'High performance Spigot/Bukkit server', icon: '📄' },
  { id: 'PURPUR', name: 'Purpur', desc: 'Ultra configurable high performance Paper fork', icon: '🟣' },
  { id: 'VANILLA', name: 'Vanilla', desc: 'Official unmodified Mojang server', icon: '📦' },
  { id: 'CUSTOM_ZIP', name: 'Serverpack ZIP Upload', desc: 'Deploy from an uploaded serverpack .zip file', icon: '📁' },
];

export default function DashboardPage() {
  const { user, logout, loading } = useAuth();
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);

  // New Node Form State
  const [showNodeModal, setShowNodeModal] = useState(false);
  const [nodeName, setNodeName] = useState('');
  const [nodeHost, setNodeHost] = useState('');
  const [nodePort, setNodePort] = useState(3500);
  const [nodeApiKey, setNodeApiKey] = useState('');
  const [nodeOffloadPriority, setNodeOffloadPriority] = useState(0);

  // New Server Form Wizard State
  const [showServerModal, setShowServerModal] = useState(false);
  const [modalStep, setModalStep] = useState<1 | 2 | 3>(1);
  const [serverName, setServerName] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('AUTO');
  const [serverType, setServerType] = useState('FABRIC');
  const [selectedMcVersion, setSelectedMcVersion] = useState('1.20.1');
  const [customMcVersion, setCustomMcVersion] = useState('');
  const [serverPort, setServerPort] = useState(25565);
  const [modpackSlug, setModpackSlug] = useState('');
  const [selectedModpackTitle, setSelectedModpackTitle] = useState('');
  const [memoryMb, setMemoryMb] = useState(8192);
  const [cpuLimit, setCpuLimit] = useState(1.0);
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [serverpackFile, setServerpackFile] = useState<File | null>(null);
  const [actionError, setActionError] = useState('');

  // Live Modrinth Search in Wizard with Pagination
  const [modpackQuery, setModpackQuery] = useState('');
  const [modpackHits, setModpackHits] = useState<ModpackHit[]>([]);
  const [modpackOffset, setModpackOffset] = useState(0);
  const [modpackTotalHits, setModpackTotalHits] = useState(0);
  const [searchingModpacks, setSearchingModpacks] = useState(false);

  // Modpack Version Shower & Selector State
  const [modpackVersions, setModpackVersions] = useState<Array<{ id: string; name: string; version_number: string; game_versions: string[] }>>([]);
  const [selectedModpackVersionId, setSelectedModpackVersionId] = useState('');
  const [loadingModpackVersions, setLoadingModpackVersions] = useState(false);

  useEffect(() => {
    if (modpackSlug && (serverType === 'MODRINTH' || serverType === 'CURSEFORGE')) {
      setLoadingModpackVersions(true);
      fetch(`/api/modrinth/versions?slug=${encodeURIComponent(modpackSlug)}&source=${serverType}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.versions && data.versions.length > 0) {
            setModpackVersions(data.versions);
            setSelectedModpackVersionId(data.versions[0].id);
          } else {
            setModpackVersions([]);
            setSelectedModpackVersionId('');
          }
        })
        .catch((e) => console.error('Failed to fetch modpack versions:', e))
        .finally(() => setLoadingModpackVersions(false));
    }
  }, [modpackSlug, serverType]);

  const fetchData = async () => {
    try {
      const [nodesRes, serversRes] = await Promise.all([
        fetch('/api/nodes'),
        fetch('/api/servers'),
      ]);

      if (nodesRes.ok) {
        const nodesData = await nodesRes.json();
        setNodes(nodesData.nodes || []);
      }

      if (serversRes.ok) {
        const serversData = await serversRes.json();
        setServers(serversData.servers || []);
      }
    } catch (e) {
      console.error('Failed to load dashboard data:', e);
    }
  };

  useEffect(() => {
    if (!loading && user) {
      fetchData();
    }
  }, [loading, user]);

  const [modpackSearchError, setModpackSearchError] = useState('');

  const searchModpacksInModal = async (searchStr: string, offsetNum = 0) => {
    setSearchingModpacks(true);
    setModpackSearchError('');
    try {
      const endpoint = serverType === 'CURSEFORGE' ? '/api/curseforge/search' : '/api/modrinth/search';
      const url = new URL(endpoint, window.location.origin);
      if (searchStr.trim()) url.searchParams.append('q', searchStr.trim());
      url.searchParams.append('limit', '6');
      url.searchParams.append('offset', offsetNum.toString());

      const res = await fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        setModpackHits(data.hits || []);
        setModpackTotalHits(data.total_hits || 0);
        setModpackOffset(data.offset || 0);
        if (data.error) setModpackSearchError(data.error);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSearchingModpacks(false);
    }
  };

  useEffect(() => {
    if ((serverType === 'MODRINTH' || serverType === 'CURSEFORGE') && showServerModal) {
      searchModpacksInModal(modpackQuery, 0);
    }
  }, [serverType, showServerModal]);

  const handleRegisterNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError('');
    try {
      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nodeName,
          host: nodeHost,
          port: nodePort,
          apiKey: nodeApiKey,
          offloadPriority: nodeOffloadPriority,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add node');

      setShowNodeModal(false);
      setNodeName('');
      setNodeHost('');
      setNodeApiKey('');
      fetchData();
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  const handleCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError('');
    if (!eulaAccepted) {
      setActionError('You must agree to the Mojang Minecraft EULA before creating a server.');
      return;
    }

    if (serverType === 'CUSTOM_ZIP' && !serverpackFile) {
      setActionError('Please upload a serverpack .zip file.');
      return;
    }

    const finalMcVersion = selectedMcVersion === 'CUSTOM' ? customMcVersion.trim() : selectedMcVersion;

    if (!finalMcVersion) {
      setActionError('Please specify a valid Minecraft version.');
      return;
    }

    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: serverName || (serverpackFile ? serverpackFile.name.replace(/\.zip$/i, '') : 'Minecraft Server'),
          nodeId: selectedNodeId,
          serverType: serverType === 'CUSTOM_ZIP' ? 'FABRIC' : serverType,
          mcVersion: finalMcVersion,
          serverPort,
          memoryMb,
          cpuLimit,
          eulaAccepted: true,
        }),
      });

      const data = await res.json();
      if (res.status === 207 && data.daemonError) {
        throw new Error(`Daemon Docker launch failed: ${data.daemonError}`);
      }
      if (!res.ok) throw new Error(data.error || 'Failed to create server');

      if (serverpackFile && data.server) {
        setActionError('Uploading & extracting serverpack ZIP... Please wait...');
        const uploadRes = await fetch(`/api/servers/${data.server.id}/upload-pack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: serverpackFile,
        });

        if (!uploadRes.ok) {
          const upErr = await uploadRes.json();
          throw new Error(upErr.error || 'Failed to upload serverpack ZIP');
        }

        // Restart container so Fabric detects all newly uploaded mods
        await fetch(`/api/servers/${data.server.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restart' }),
        });
      }

      setShowServerModal(false);
      setModalStep(1);
      setServerName('');
      setServerpackFile(null);
      setModpackSlug('');
      setSelectedModpackTitle('');
      setCustomMcVersion('');
      fetchData();
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  const handleServerAction = async (serverId: string, action: string) => {
    try {
      const res = await fetch(`/api/servers/${serverId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, deleteData: action === 'delete' }),
      });
      
      if (!res.ok && res.status !== 404) {
        const data = await res.json();
        alert(data.error || `Failed to ${action} server`);
      }
      // Re-fetch data ONLY AFTER the action has fully completed
      await fetchData();
    } catch (e) {
      alert(`Network error executing ${action}`);
      await fetchData();
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
        Loading panel context...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4 text-center">
        <h2 className="text-2xl font-bold text-white mb-2">Authentication Required</h2>
        <p className="text-slate-400 mb-6">Please sign in to access the CraftControl dashboard.</p>
        <Link href="/login" className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-2.5 rounded-xl">
          Go to Sign In
        </Link>
      </div>
    );
  }

  const modpackPageCurrent = Math.floor(modpackOffset / 6) + 1;
  const modpackPageTotal = Math.ceil(modpackTotalHits / 6);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">
      {/* Top Navbar */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur px-8 py-4 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center space-x-4">
          <Link href="/" className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
              M
            </div>
            <span className="font-bold text-lg text-white">CraftControl</span>
          </Link>
          <span className="text-xs px-2.5 py-1 rounded bg-slate-800 text-slate-300 border border-slate-700 font-mono">
            {user.globalRole}
          </span>

          {user.globalRole === 'GLOBAL_ADMIN' && (
            <Link
              href="/dashboard/users"
              className="text-xs bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 px-3 py-1.5 rounded-lg font-medium transition"
            >
              Users & Invites
            </Link>
          )}

          <Link
            href="/modrinth"
            className="text-xs bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 px-3 py-1.5 rounded-lg font-medium transition"
          >
            Modrinth Explorer
          </Link>
        </div>

        <div className="flex items-center space-x-4">
          <div className="text-right">
            <div className="text-sm font-semibold text-white">{user.username}</div>
            <div className="text-xs text-slate-400">{user.email}</div>
          </div>
          <button
            onClick={() => logout()}
            className="text-xs text-slate-400 hover:text-red-400 border border-slate-800 hover:border-red-500/30 px-3 py-1.5 rounded-lg transition"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-8 py-8 space-y-8">
        {/* Nodes Overview Section */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-white">Remote Worker Nodes</h2>
              <p className="text-xs text-slate-400">Connected daemons managing containerized Minecraft instances</p>
            </div>
            {user.globalRole === 'GLOBAL_ADMIN' && (
              <button
                onClick={() => setShowNodeModal(true)}
                className="bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold px-4 py-2 rounded-xl border border-slate-700 transition"
              >
                + Register Daemon Node
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {nodes.length === 0 ? (
              <div className="col-span-full bg-slate-900/50 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-sm">
                No daemon nodes registered yet. Register a daemon node (Daemon Port 3500) to begin hosting.
              </div>
            ) : (
              nodes.map((node) => (
                <div key={node.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 relative overflow-hidden">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-white">{node.name}</span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        node.isOnline
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-red-500/10 text-red-400 border border-red-500/20'
                      }`}
                    >
                      {node.isOnline ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 font-mono mb-3">
                    {node.host}:{node.port}
                  </div>
                  <div className="flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/80 pt-3">
                    <span>{node._count.servers} Active Servers</span>
                    <span>Offload Priority: {node.offloadPriority}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Server Instances Section */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-white">Minecraft Servers</h2>
              <p className="text-xs text-slate-400">Instances you are authorized to administer or view</p>
            </div>
            <button
              onClick={() => {
                setShowServerModal(true);
                setModalStep(1);
              }}
              disabled={nodes.length === 0}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded-xl shadow transition"
            >
              + Create New Server
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {servers.length === 0 ? (
              <div className="col-span-full bg-slate-900/50 border border-slate-800 rounded-xl p-8 text-center text-slate-500 text-sm">
                No servers found. Click "+ Create New Server" above to launch an instance.
              </div>
            ) : (
              servers.map((server) => (
                <div key={server.id} className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col justify-between hover:border-slate-700 transition">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-bold text-white text-lg">{server.name}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${
                          server.status === 'RUNNING'
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : server.status === 'STARTING'
                            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                            : server.status === 'ERROR'
                            ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                            : 'bg-slate-800 text-slate-400 border border-slate-700'
                        }`}
                      >
                        {server.status}
                      </span>
                    </div>

                    <div className="text-xs text-slate-400 space-y-1 mb-6">
                      <div>Node: <span className="text-slate-200">{server.node.name}</span></div>
                      <div>Type: <span className="text-slate-200">{server.serverType} ({server.mcVersion})</span></div>
                      {server.modpackSlug && (
                        <div>Modpack: <span className="text-emerald-400 font-mono">@{server.modpackSlug}</span></div>
                      )}
                      <div>Port: <span className="text-slate-200 font-mono">{server.serverPort}</span></div>
                      <div>Allocated Memory: <span className="text-slate-200">{server.memoryMb} MB</span></div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-slate-800 pt-4 space-x-2">
                    <Link
                      href={`/dashboard/servers/${server.id}`}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition"
                    >
                      Console
                    </Link>

                    {server.status === 'RUNNING' ? (
                      <button
                        onClick={() => handleServerAction(server.id, 'stop')}
                        className="flex-1 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 text-xs font-semibold py-2 rounded-lg border border-amber-500/30 transition"
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => handleServerAction(server.id, 'start')}
                        className="flex-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 text-xs font-semibold py-2 rounded-lg border border-emerald-500/30 transition"
                      >
                        Start
                      </button>
                    )}

                    <button
                      onClick={() => handleServerAction(server.id, 'delete')}
                      className="px-3 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-semibold rounded-lg border border-red-500/20 transition"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      {/* Modal: Register Daemon Node */}
      {showNodeModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">Register Remote Daemon Node</h3>
            <p className="text-xs text-amber-400 mb-4 bg-amber-500/10 border border-amber-500/20 p-2.5 rounded-lg">
              Note: Daemon Port is <code className="font-bold font-mono">3500</code> (Not 25565, which is for Minecraft player connections).
            </p>
            {actionError && <div className="mb-4 text-xs text-red-400 bg-red-500/10 p-3 rounded-lg">{actionError}</div>}
            <form onSubmit={handleRegisterNode} className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Node Name</label>
                <input
                  type="text"
                  required
                  value={nodeName}
                  onChange={(e) => setNodeName(e.target.value)}
                  placeholder="Secondary-PC-Node"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Host IP / Container Name</label>
                  <input
                    type="text"
                    required
                    value={nodeHost}
                    onChange={(e) => setNodeHost(e.target.value)}
                    placeholder="mc_daemon_node"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Daemon Port</label>
                  <input
                    type="number"
                    required
                    value={nodePort}
                    onChange={(e) => setNodePort(parseInt(e.target.value, 10))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Daemon API Secret Key</label>
                <input
                  type="password"
                  required
                  value={nodeApiKey}
                  onChange={(e) => setNodeApiKey(e.target.value)}
                  placeholder="local-daemon-testing-bearer-key"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Smart Offload Priority Score (0-10)</label>
                <input
                  type="number"
                  required
                  value={nodeOffloadPriority}
                  onChange={(e) => setNodeOffloadPriority(parseInt(e.target.value, 10))}
                  placeholder="0 = Main Server, 10 = Offload PC"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div className="flex justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNodeModal(false)}
                  className="px-4 py-2 text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl">
                  Register Node
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Interactive User-Friendly Server Creation Wizard */}
      {showServerModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 w-full max-w-2xl shadow-2xl overflow-y-auto max-h-[90vh] flex flex-col justify-between">
            <div>
              {/* Wizard Steps Bar */}
              <div className="flex items-center justify-between border-b border-slate-800 pb-5 mb-6">
                <div>
                  <h3 className="text-xl font-extrabold text-white">Create Minecraft Server</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Deploy containerized instance with smart resource allocation</p>
                </div>
                <div className="flex items-center space-x-2">
                  <span className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center ${modalStep >= 1 ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-500'}`}>1</span>
                  <span className="w-4 h-0.5 bg-slate-800" />
                  <span className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center ${modalStep >= 2 ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-500'}`}>2</span>
                  <span className="w-4 h-0.5 bg-slate-800" />
                  <span className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center ${modalStep >= 3 ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-500'}`}>3</span>
                </div>
              </div>

              {actionError && (
                <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                  {actionError}
                </div>
              )}

              {/* STEP 1: Select Server Type & Modpack */}
              {modalStep === 1 && (
                <div className="space-y-5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Step 1: Select Server Engine or Modpack
                  </label>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {SERVER_TYPES.map((t) => (
                      <div
                        key={t.id}
                        onClick={() => {
                          setServerType(t.id);
                          if (t.id !== 'MODRINTH' && t.id !== 'CURSEFORGE') {
                            setModpackSlug('');
                            setSelectedModpackTitle('');
                          }
                        }}
                        className={`p-4 rounded-2xl border text-left cursor-pointer transition flex flex-col justify-between ${
                          serverType === t.id
                            ? 'bg-emerald-500/10 border-emerald-500 ring-2 ring-emerald-500/20'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="text-2xl mb-2">{t.icon}</div>
                        <div>
                          <div className="text-sm font-bold text-white">{t.name}</div>
                          <div className="text-[11px] text-slate-400 mt-1 leading-snug">{t.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Optional Serverpack ZIP Upload */}
                  <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 space-y-3 mt-4">
                    <label className="block text-xs font-bold text-emerald-400">
                      Upload Serverpack Archive (.zip) {serverType === 'CUSTOM_ZIP' ? '(Required)' : '(Optional)'}
                    </label>
                    <p className="text-[11px] text-slate-400">
                      Select or drag & drop a pre-configured Minecraft serverpack .zip file containing mods, configs, or world files.
                    </p>
                    <input
                      type="file"
                      accept=".zip"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          setServerpackFile(file);
                          if (!serverName) {
                            setServerName(file.name.replace(/\.zip$/i, '') + ' Server');
                          }
                        }
                      }}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs text-slate-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-emerald-600 file:text-white hover:file:bg-emerald-500 cursor-pointer"
                    />
                    {serverpackFile && (
                      <div className="text-xs text-emerald-400 font-mono bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20 flex items-center justify-between">
                        <span>✓ Upload Ready: <strong>{serverpackFile.name}</strong> ({(serverpackFile.size / (1024 * 1024)).toFixed(2)} MB)</span>
                        <button
                          type="button"
                          onClick={() => setServerpackFile(null)}
                          className="text-xs text-red-400 hover:underline font-semibold"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* STEP 2: Configure Server Settings & Hardware */}
              {modalStep === 2 && (
                <div className="space-y-5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Step 2: Instance Name & Resource Limits
                  </label>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Server Instance Name</label>
                    <input
                      type="text"
                      required
                      value={serverName}
                      onChange={(e) => setServerName(e.target.value)}
                      placeholder="My Minecraft World"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:border-emerald-500 focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Target Worker Node</label>
                      <select
                        value={selectedNodeId}
                        onChange={(e) => setSelectedNodeId(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:border-emerald-500 focus:outline-none"
                      >
                        <option value="AUTO">⚡ Auto-Select (Smart Priority Offload)</option>
                        {nodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.name} (Priority: {n.offloadPriority})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Minecraft Version</label>
                      <select
                        value={selectedMcVersion}
                        disabled={serverType === 'MODRINTH'}
                        onChange={(e) => setSelectedMcVersion(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:border-emerald-500 focus:outline-none disabled:opacity-50"
                      >
                        {MC_VERSIONS.map((v) => (
                          <option key={v} value={v}>
                            {v === 'CUSTOM' ? '⚙️ Custom / Snapshot...' : v}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Custom Version Input field when CUSTOM is selected */}
                  {selectedMcVersion === 'CUSTOM' && serverType !== 'MODRINTH' && (
                    <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
                      <label className="block text-xs text-emerald-400 font-semibold mb-1">
                        Enter Custom Minecraft Version / Snapshot
                      </label>
                      <input
                        type="text"
                        required
                        value={customMcVersion}
                        onChange={(e) => setCustomMcVersion(e.target.value)}
                        placeholder="e.g. 24w10a, 1.7.10-OptiFine, 1.16.5-Fabric"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:border-emerald-500 focus:outline-none"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Server Network Port</label>
                      <input
                        type="number"
                        required
                        value={serverPort}
                        onChange={(e) => setServerPort(parseInt(e.target.value, 10))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-3 text-white text-sm focus:border-emerald-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Memory (RAM)</label>
                      <select
                        value={memoryMb}
                        onChange={(e) => setMemoryMb(parseInt(e.target.value, 10))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-3 text-white text-sm focus:border-emerald-500 focus:outline-none"
                      >
                        <option value={1024}>1024 MB (1 GB)</option>
                        <option value={2048}>2048 MB (2 GB)</option>
                        <option value={4096}>4096 MB (4 GB)</option>
                        <option value={8192}>8192 MB (8 GB)</option>
                        <option value={16384}>16384 MB (16 GB)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-400 mb-1">CPU Cores</label>
                      <select
                        value={cpuLimit}
                        onChange={(e) => setCpuLimit(parseFloat(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-3 text-white text-sm focus:border-emerald-500 focus:outline-none"
                      >
                        <option value={1.0}>1 Core</option>
                        <option value={2.0}>2 Cores</option>
                        <option value={4.0}>4 Cores</option>
                        <option value={8.0}>8 Cores</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 3: EULA Agreement & Final Launch */}
              {modalStep === 3 && (
                <div className="space-y-5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Step 3: Mojang EULA Agreement & Confirmation
                  </label>

                  <div className="bg-slate-950 border border-slate-800 rounded-2xl p-5 space-y-3">
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>Server Engine:</span>
                      <span className="font-bold text-white">{serverType}</span>
                    </div>
                    {serverType !== 'MODRINTH' && (
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>Minecraft Version:</span>
                        <span className="font-bold text-white">
                          {selectedMcVersion === 'CUSTOM' ? customMcVersion : selectedMcVersion}
                        </span>
                      </div>
                    )}
                    {modpackSlug && (
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>Modpack:</span>
                        <span className="font-bold text-emerald-400">@{modpackSlug}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>Allocated RAM:</span>
                      <span className="font-bold text-white">{memoryMb} MB</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>Game Port:</span>
                      <span className="font-bold text-white font-mono">{serverPort}</span>
                    </div>
                  </div>

                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-5 flex items-start space-x-3">
                    <input
                      type="checkbox"
                      id="eulaModalCheckStep3"
                      checked={eulaAccepted}
                      onChange={(e) => setEulaAccepted(e.target.checked)}
                      className="mt-1 accent-emerald-500 w-5 h-5 rounded cursor-pointer"
                    />
                    <label htmlFor="eulaModalCheckStep3" className="text-xs text-slate-300 leading-relaxed cursor-pointer">
                      I agree to the <a href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noreferrer" className="text-emerald-400 font-bold underline">Mojang Minecraft EULA</a>. By checking this box, CraftControl sets <code className="text-emerald-300 font-mono">EULA=TRUE</code> on container boot.
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* Wizard Navigation Footer */}
            <div className="flex items-center justify-between border-t border-slate-800 pt-6 mt-6">
              {modalStep > 1 ? (
                <button
                  type="button"
                  onClick={() => setModalStep((s) => (s - 1) as any)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-5 py-2.5 rounded-xl transition"
                >
                  ← Back
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowServerModal(false)}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
              )}

              {modalStep < 3 ? (
                <button
                  type="button"
                  onClick={() => {
                    if (serverType === 'MODRINTH' && !modpackSlug) {
                      setActionError('Please select a Modrinth modpack to continue.');
                      return;
                    }
                    setActionError('');
                    setModalStep((s) => (s + 1) as any);
                  }}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow transition"
                >
                  Next Step →
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCreateServer}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-lg shadow-emerald-600/20 transition"
                >
                  🚀 Launch Server
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
