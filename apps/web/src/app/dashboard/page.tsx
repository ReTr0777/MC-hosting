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
  executionMode?: string;
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
  '26.2',
  '26.1.2',
  '26.1.1',
  '26.1',
  '1.21.11',
  '1.21.10',
  '1.21.9',
  '1.21.8',
  '1.21.7',
  '1.21.6',
  '1.21.5',
  '1.21.4',
  '1.21.3',
  '1.21.2',
  '1.21.1',
  '1.21',
  '1.20.6',
  '1.20.5',
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
  { id: 'FABRIC', name: 'Fabric', desc: 'Lightweight & highly moddable loader', icon: 'FA', color: '#a78bfa' },
  { id: 'FORGE', name: 'Forge', desc: 'Classic heavy modpack framework', icon: 'FO', color: '#fb923c' },
  { id: 'PAPER', name: 'Paper', desc: 'High performance Spigot/Bukkit server', icon: 'PA', color: '#60a5fa' },
  { id: 'PURPUR', name: 'Purpur', desc: 'Ultra configurable high performance Paper fork', icon: 'PU', color: '#c084fc' },
  { id: 'VANILLA', name: 'Vanilla', desc: 'Official unmodified Mojang server', icon: 'VA', color: '#34d399' },
  { id: 'CUSTOM_ZIP', name: 'Serverpack Upload (ZIP/RAR)', desc: 'Deploy from an uploaded serverpack archive (.zip or .rar)', icon: 'ZIP', color: '#f59e0b' },
];

function ServerCardIcon({ serverId, serverType, serverTypeMeta }: { serverId: string; serverType: string; serverTypeMeta: any }) {
  const [hasError, setHasError] = useState(false);
  const meta = serverTypeMeta[serverType] || { label: 'MC', color: '#8b949e' };

  if (hasError) {
    return (
      <div style={{
        width: '42px', height: '42px', borderRadius: '8px',
        background: `${meta.color}18`,
        border: `1px solid ${meta.color}40`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 800,
        color: meta.color,
        letterSpacing: '0.04em',
      }}>
        {meta.label}
      </div>
    );
  }

  return (
    <div style={{
      width: '42px', height: '42px', borderRadius: '8px',
      overflow: 'hidden', flexShrink: 0,
      background: 'var(--surface-2)', border: '1px solid var(--border-2)',
      position: 'relative',
    }}>
      <img
        src={`/api/servers/${serverId}/icon`}
        alt="Server Icon"
        style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
        onError={() => setHasError(true)}
      />
    </div>
  );
}

export default function DashboardPage() {
  const { user, logout, loading } = useAuth();
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);

  // Node Form State
  const [showNodeModal, setShowNodeModal] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
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
  const [executionMode, setExecutionMode] = useState<'CONTAINER' | 'PROCESS'>('PROCESS');
  const [selectedMcVersion, setSelectedMcVersion] = useState('26.2');
  const [customMcVersion, setCustomMcVersion] = useState('');
  const [serverPort, setServerPort] = useState(24000);
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
        setNodes(Array.isArray(nodesData.nodes) ? nodesData.nodes : []);
      } else {
        setNodes([]);
      }

      if (serversRes.ok) {
        const serversData = await serversRes.json();
        setServers(Array.isArray(serversData.servers) ? serversData.servers : []);
      } else {
        setServers([]);
      }
    } catch (e) {
      console.error('Failed to load dashboard data:', e);
    }
  };

  useEffect(() => {
    if (!loading && user) {
      fetchData();
      
      const intervalId = setInterval(async () => {
        // Ping all nodes to update their online status in the database every 5s
        try {
          const res = await fetch('/api/nodes');
          if (res.ok) {
            const data = await res.json();
            const currentNodes = Array.isArray(data.nodes) ? data.nodes : [];
            await Promise.all(
              currentNodes.map((n: NodeItem) => 
                fetch(`/api/nodes/${n.id}/ping`, { method: 'POST' }).catch(() => {})
              )
            );
          }
          fetchData();
        } catch (e) {
          // ignore
        }
      }, 5000); // Fast 5 seconds polling for instant status updates

      return () => clearInterval(intervalId);
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
      const url = editingNodeId ? `/api/nodes/${editingNodeId}` : '/api/nodes';
      const method = editingNodeId ? 'PUT' : 'POST';
      
      const payload: any = {
        name: nodeName,
        host: nodeHost,
        port: nodePort,
        offloadPriority: nodeOffloadPriority,
      };

      if (nodeApiKey) {
        payload.apiKey = nodeApiKey;
      } else if (!editingNodeId) {
        throw new Error('API Key is required for new nodes');
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save node');

      setShowNodeModal(false);
      setEditingNodeId(null);
      setNodeName('');
      setNodeHost('');
      setNodeApiKey('');
      fetchData();
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  const openEditNodeModal = (node: NodeItem) => {
    setEditingNodeId(node.id);
    setNodeName(node.name);
    setNodeHost(node.host);
    setNodePort(node.port);
    setNodeOffloadPriority(node.offloadPriority);
    setNodeApiKey(''); // Leave empty for edit
    setShowNodeModal(true);
  };

  const handleDeleteNode = async (nodeId: string) => {
    if (!confirm('Are you sure you want to delete this node? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/nodes/${nodeId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete node');
      
      fetchData();
    } catch (err: any) {
      alert(err.message);
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
      setActionError('Please upload a serverpack archive (.zip or .rar).');
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
          name: serverName || (serverpackFile ? serverpackFile.name.replace(/\.(zip|rar)$/i, '') : 'Minecraft Server'),
          nodeId: selectedNodeId,
          serverType: serverType === 'CUSTOM_ZIP' ? 'FABRIC' : serverType,
          executionMode,
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
        setActionError('Uploading & extracting serverpack archive... Please wait...');
        const uploadRes = await fetch(`/api/servers/${data.server.id}/upload-pack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: serverpackFile,
        });

        if (!uploadRes.ok) {
          const upErr = await uploadRes.json();
          throw new Error(upErr.error || 'Failed to upload serverpack archive');
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

  const serverTypeMeta: Record<string, { label: string; color: string }> = {
    FABRIC:     { label: 'FA',  color: '#a78bfa' },
    FORGE:      { label: 'FO',  color: '#fb923c' },
    PAPER:      { label: 'PA',  color: '#60a5fa' },
    PURPUR:     { label: 'PU',  color: '#c084fc' },
    VANILLA:    { label: 'VA',  color: '#34d399' },
    MODRINTH:   { label: 'MR',  color: '#00d97e' },
    CURSEFORGE: { label: 'CF',  color: '#f97316' },
    CUSTOM_ZIP: { label: 'ZIP', color: '#f59e0b' },
  };

  const initials = user.username.slice(0, 2).toUpperCase();

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column' }}>

      {/* ── Top Navbar ── */}
      <header className="bg-slate-900 border-b border-slate-800 p-3 sm:px-6 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2.5">
          {/* Left: Logo & Role */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <Link href="/" className="flex items-center gap-2 text-decoration-none">
              <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center text-xs font-black text-slate-950">
                C
              </div>
              <span className="font-bold text-sm text-white">CraftControl</span>
            </Link>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 tracking-wider">
              {user.globalRole}
            </span>

            {user.globalRole === 'GLOBAL_ADMIN' && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <Link href="/dashboard/users" className="text-xs font-semibold text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2.5 py-1 rounded-md">
                  Users
                </Link>
                <Link href="/dashboard/settings" className="text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-md">
                  Settings
                </Link>
              </div>
            )}
            <Link href="/modrinth" className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-md">
              Modrinth
            </Link>
          </div>

          {/* Right: User Profile & Sign Out */}
          <div className="flex items-center gap-3 ml-auto">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center text-[10px] font-extrabold">
                {initials}
              </div>
              <div className="hidden sm:block text-left">
                <div className="text-xs font-bold text-white leading-tight">{user.username}</div>
                <div className="text-[10px] text-slate-400">{user.email}</div>
              </div>
            </div>
            <button
              onClick={() => logout()}
              className="text-xs text-slate-400 hover:text-red-400 border border-slate-700 hover:border-red-500/30 px-2.5 py-1 rounded-md transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Breadcrumb row */}
      <div className="border-b border-slate-800 p-4 sm:px-6 bg-slate-950">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
            <span>CraftControl</span>
            <span className="text-slate-600">&gt;</span>
            <span className="text-white font-semibold">Node &amp; Server Overview</span>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {user?.globalRole === 'GLOBAL_ADMIN' && (
              <button
                onClick={() => {
                  setEditingNodeId(null);
                  setNodeName('');
                  setNodeHost('');
                  setNodePort(3500);
                  setNodeApiKey('');
                  setNodeOffloadPriority(0);
                  setShowNodeModal(true);
                }}
                className="cc-btn-ghost flex-1 sm:flex-initial text-center justify-center"
              >
                + Register Node
              </button>
            )}
            <button
              onClick={() => {
                const usedPorts = new Set((servers || []).map((s) => s.serverPort));
                let nextPort = 24000;
                while (usedPorts.has(nextPort) && nextPort <= 25000) nextPort++;
                setServerPort(nextPort);
                setShowServerModal(true);
                setModalStep(1);
              }}
              disabled={nodes.length === 0}
              className="cc-btn-primary flex-1 sm:flex-initial text-center justify-center"
              style={{ opacity: nodes.length === 0 ? 0.4 : 1 }}
            >
              + Create New Server
            </button>
          </div>
        </div>
      </div>

      {/* ── Main Layout ── */}
      <main className="flex-1 flex flex-col lg:flex-row w-full max-w-7xl mx-auto">

        {/* LEFT: Active Nodes panel */}
        <aside className="w-full lg:w-72 lg:min-w-[288px] border-b lg:border-b-0 lg:border-r border-slate-800 p-4 lg:p-6 space-y-3">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
            Active Nodes
          </div>

          {nodes.length === 0 ? (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>
              No daemon nodes registered yet.
            </div>
          ) : (
            nodes.map(node => (
              <div key={node.id} className="cc-card" style={{ padding: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)', marginBottom: '2px' }}>{node.name}</div>
                    <div style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                      {node.host}:{node.port}
                    </div>
                  </div>
                  <span className={node.isOnline ? 'cc-badge-online' : 'cc-badge-offline'}>
                    {node.isOnline ? 'Online' : 'Offline'}
                  </span>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{node._count.servers} Active Servers</span>
                  {user?.globalRole === 'GLOBAL_ADMIN' && (
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        onClick={() => openEditNodeModal(node)}
                        title="Edit Node"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--text-muted)' }}
                        onMouseOver={e => (e.currentTarget.style.color = '#60a5fa')}
                        onMouseOut={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                      >
                        <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={() => handleDeleteNode(node.id)}
                        title="Delete Node"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--danger)' }}
                      >
                        <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </aside>

        {/* RIGHT: Server grid */}
        <section className="flex-1 p-4 lg:p-6">
          <div style={{ marginBottom: '16px' }}>
            <h2 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Your Servers</h2>
          </div>

          {servers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', fontSize: '0.875rem', border: '1px dashed var(--border-2)', borderRadius: '10px' }}>
              No servers found. Click &quot;+ Create New Server&quot; above to launch an instance.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
              {servers.map(server => (
                <div key={server.id} className="cc-card" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {/* Card top row */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    <ServerCardIcon serverId={server.id} serverType={server.serverType} serverTypeMeta={serverTypeMeta} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {server.name}
                        </span>
                        <span style={{ fontSize: '1rem', cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>...</span>
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        {server.serverType} {server.mcVersion}
                      </div>
                    </div>
                  </div>

                  {/* Player count + status */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        0 / 20 Players
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        Port: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{server.serverPort}</span>
                        &nbsp;&bull;&nbsp;
                        {server.memoryMb >= 1024 ? `${server.memoryMb / 1024} GB` : `${server.memoryMb} MB`} RAM
                      </div>
                    </div>
                    <span className={
                      server.status === 'RUNNING' ? 'cc-badge-running' :
                      server.status === 'STARTING' ? 'cc-badge-starting' :
                      server.status === 'ERROR' ? 'cc-badge-error' : 'cc-badge-offline'
                    }>
                      {server.status}
                    </span>
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                    <Link
                      href={`/dashboard/servers/${server.id}`}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                        background: 'var(--surface-2)', color: 'var(--text-primary)',
                        border: '1px solid var(--border-2)', borderRadius: '6px',
                        padding: '7px 0', fontSize: '0.75rem', fontWeight: 600, textDecoration: 'none',
                        transition: 'border-color 0.15s',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>&gt;_</span> Console
                    </Link>
                    {server.status === 'RUNNING' ? (
                      <button
                        onClick={() => handleServerAction(server.id, 'stop')}
                        className="cc-btn-danger"
                        style={{ borderRadius: '6px', padding: '7px 0', fontWeight: 600 }}
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => handleServerAction(server.id, 'start')}
                        style={{ background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent-border)', borderRadius: '6px', padding: '7px 0', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
                      >
                        Start
                      </button>
                    )}
                  </div>
                  <Link
                    href={`/dashboard/servers/${server.id}`}
                    style={{
                      display: 'block', textAlign: 'center', background: 'var(--accent)',
                      color: '#0d1117', borderRadius: '6px', padding: '8px 0',
                      fontSize: '0.75rem', fontWeight: 700, textDecoration: 'none',
                      transition: 'opacity 0.15s',
                    }}
                    onMouseOver={e => (e.currentTarget.style.opacity = '0.85')}
                    onMouseOut={e => (e.currentTarget.style.opacity = '1')}
                  >
                    Manage --&gt;
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* â”€â”€ Modal: Register/Edit Node â”€â”€ */}
      {showNodeModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,17,23,0.85)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 50 }}>
          <div className="cc-card" style={{ width: '100%', maxWidth: '420px', padding: '24px', boxShadow: '0 24px 48px rgba(0,0,0,0.5)' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
              {editingNodeId ? 'Edit Remote Daemon Node' : 'Register Remote Daemon Node'}
            </h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--warning)', background: 'rgba(240,136,62,0.08)', border: '1px solid rgba(240,136,62,0.2)', padding: '8px 12px', borderRadius: '6px', marginBottom: '18px' }}>
              Note: Daemon Port is <code style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>3500</code> (Not 25565, which is for Minecraft player connections).
            </p>
            {actionError && <div style={{ marginBottom: '14px', fontSize: '0.75rem', color: 'var(--danger)', background: 'rgba(248,81,73,0.08)', padding: '10px 12px', borderRadius: '6px' }}>{actionError}</div>}
            <form onSubmit={handleRegisterNode} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Node Name</label>
                <input type="text" required value={nodeName} onChange={e => setNodeName(e.target.value)} placeholder="Secondary-PC-Node" className="cc-input" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Host IP / Container Name</label>
                  <input type="text" required value={nodeHost} onChange={e => setNodeHost(e.target.value)} placeholder="192.168.1.100" className="cc-input" />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Daemon Port</label>
                  <input type="number" required value={nodePort} onChange={e => setNodePort(parseInt(e.target.value, 10))} className="cc-input" />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Daemon API Secret Key {editingNodeId && '(Leave blank to keep unchanged)'}</label>
                <input type="password" required={!editingNodeId} value={nodeApiKey} onChange={e => setNodeApiKey(e.target.value)} placeholder={editingNodeId ? 'Leave blank to keep current key' : 'Bearer key...'} className="cc-input" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Smart Offload Priority (0-10)</label>
                <input type="number" required value={nodeOffloadPriority} onChange={e => setNodeOffloadPriority(parseInt(e.target.value, 10))} placeholder="0 = Main, 10 = Offload" className="cc-input" />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '4px' }}>
                <button type="button" onClick={() => setShowNodeModal(false)} className="cc-btn-ghost">Cancel</button>
                <button type="submit" className="cc-btn-primary">{editingNodeId ? 'Update Node' : 'Register Node'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* â”€â”€ Modal: Create Server Wizard â”€â”€ */}
      {showServerModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,17,23,0.85)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 50 }}>
          <div className="cc-card" style={{ width: '100%', maxWidth: '640px', maxHeight: '90vh', overflowY: 'auto', padding: '28px', boxShadow: '0 24px 48px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '16px', borderBottom: '1px solid var(--border)' }}>
              <div>
                <h3 style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Create Minecraft Server</h3>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>Deploy containerized instance with smart resource allocation</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {[1, 2, 3].map(n => (
                  <React.Fragment key={n}>
                    <div style={{
                      width: '28px', height: '28px', borderRadius: '50%',
                      background: modalStep >= n ? 'var(--accent)' : 'var(--surface-2)',
                      color: modalStep >= n ? '#0d1117' : 'var(--text-muted)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.72rem', fontWeight: 700,
                    }}>{n}</div>
                    {n < 3 && <div style={{ width: '16px', height: '1px', background: 'var(--border-2)' }} />}
                  </React.Fragment>
                ))}
              </div>
            </div>

            {actionError && <div style={{ fontSize: '0.75rem', color: 'var(--danger)', background: 'rgba(248,81,73,0.08)', padding: '10px 14px', borderRadius: '6px', border: '1px solid rgba(248,81,73,0.2)' }}>{actionError}</div>}

            {/* Step 1 */}
            {modalStep === 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Step 1: Select Server Engine or Modpack</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                  {SERVER_TYPES.map(t => (
                    <div
                      key={t.id}
                      onClick={() => { setServerType(t.id); if (t.id !== 'MODRINTH' && t.id !== 'CURSEFORGE') { setModpackSlug(''); setSelectedModpackTitle(''); } }}
                      style={{
                        padding: '14px', borderRadius: '8px', cursor: 'pointer', transition: 'all 0.15s',
                        background: serverType === t.id ? 'var(--accent-dim)' : 'var(--bg)',
                        border: `1px solid ${serverType === t.id ? 'var(--accent)' : 'var(--border-2)'}`,
                        display: 'flex', flexDirection: 'column', gap: '6px',
                      }}
                    >
                      <div style={{
                        width: '32px', height: '32px', borderRadius: '6px',
                        background: `${t.color}18`, border: `1px solid ${t.color}40`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 800, color: t.color,
                        marginBottom: '4px'
                      }}>{t.icon}</div>
                      <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t.name}</div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{t.desc}</div>
                    </div>
                  ))}
                </div>
                {/* Upload section */}
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '16px' }}>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent)', marginBottom: '6px' }}>
                    Upload Serverpack Archive (.zip or .rar) {serverType === 'CUSTOM_ZIP' ? '(Required)' : '(Optional)'}
                  </label>
                  <input type="file" accept=".zip,.rar" onChange={e => { const f = e.target.files?.[0]; if (f) { setServerpackFile(f); if (!serverName) setServerName(f.name.replace(/\.(zip|rar)$/i, '') + ' Server'); } }} className="cc-input" style={{ padding: '6px' }} />
                  {serverpackFile && (
                    <div style={{ marginTop: '8px', fontSize: '0.72rem', color: 'var(--accent)', background: 'var(--accent-dim)', padding: '6px 10px', borderRadius: '5px', border: '1px solid var(--accent-border)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>[OK] {serverpackFile.name} ({(serverpackFile.size / (1024 * 1024)).toFixed(2)} MB)</span>
                      <button type="button" onClick={() => setServerpackFile(null)} style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600 }}>Remove</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step 2 */}
            {modalStep === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Step 2: Instance Name &amp; Resource Limits</label>
                <div>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Server Instance Name</label>
                  <input type="text" required value={serverName} onChange={e => setServerName(e.target.value)} placeholder="My Minecraft World" className="cc-input" />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600 }}>Execution Mode</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    {[{id: 'CONTAINER', icon: 'DOCKER', name: 'Docker Container', desc: 'Isolated container per server'}, {id: 'PROCESS', icon: 'PROC', name: 'Standalone Process', desc: 'Direct process, no extra Docker containers'}].map(m => (
                      <div key={m.id} onClick={() => setExecutionMode(m.id as any)}
                        style={{ padding: '12px', borderRadius: '8px', cursor: 'pointer', border: `1px solid ${executionMode === m.id ? 'var(--accent)' : 'var(--border-2)'}`, background: executionMode === m.id ? 'var(--accent-dim)' : 'var(--bg)', display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--accent)' }}>[{m.icon}]</span>
                        <div>
                          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{m.name}</div>
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px' }}>{m.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Target Worker Node</label>
                    <select value={selectedNodeId} onChange={e => setSelectedNodeId(e.target.value)} className="cc-input">
                      <option value="AUTO">Auto-Select (Smart Priority)</option>
                      {nodes.map(n => <option key={n.id} value={n.id}>{n.name} (Priority: {n.offloadPriority})</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Minecraft Version</label>
                    <select value={selectedMcVersion} disabled={serverType === 'MODRINTH'} onChange={e => setSelectedMcVersion(e.target.value)} className="cc-input" style={{ opacity: serverType === 'MODRINTH' ? 0.5 : 1 }}>
                      {MC_VERSIONS.map(v => <option key={v} value={v}>{v === 'CUSTOM' ? 'Custom / Snapshot...' : v}</option>)}
                    </select>
                  </div>
                </div>
                {selectedMcVersion === 'CUSTOM' && serverType !== 'MODRINTH' && (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--accent)', marginBottom: '5px', fontWeight: 600 }}>Custom Minecraft Version / Snapshot</label>
                    <input type="text" required value={customMcVersion} onChange={e => setCustomMcVersion(e.target.value)} placeholder="e.g. 24w10a, 1.7.10" className="cc-input" />
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Server Port</label>
                    <input type="number" required value={serverPort} onChange={e => setServerPort(parseInt(e.target.value, 10))} className="cc-input" />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Memory (RAM)</label>
                    <select value={memoryMb} onChange={e => setMemoryMb(parseInt(e.target.value, 10))} className="cc-input">
                      <option value={1024}>1 GB</option>
                      <option value={2048}>2 GB</option>
                      <option value={4096}>4 GB</option>
                      <option value={8192}>8 GB</option>
                      <option value={16384}>16 GB</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>CPU Cores</label>
                    <select value={cpuLimit} onChange={e => setCpuLimit(parseFloat(e.target.value))} className="cc-input">
                      <option value={1.0}>1 Core</option>
                      <option value={2.0}>2 Cores</option>
                      <option value={4.0}>4 Cores</option>
                      <option value={8.0}>8 Cores</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Step 3 */}
            {modalStep === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Step 3: Mojang EULA Agreement &amp; Confirmation</label>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {[
                    { label: 'Execution Mode', value: executionMode === 'PROCESS' ? 'Standalone Process' : 'Docker Container' },
                    { label: 'Server Engine', value: serverType },
                    ...(serverType !== 'MODRINTH' ? [{ label: 'Minecraft Version', value: selectedMcVersion === 'CUSTOM' ? customMcVersion : selectedMcVersion }] : []),
                    ...(modpackSlug ? [{ label: 'Modpack', value: `@${modpackSlug}` }] : []),
                    { label: 'Allocated RAM', value: `${memoryMb} MB` },
                    { label: 'Game Port', value: String(serverPort) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <span>{label}:</span>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{value}</span>
                    </div>
                  ))}
                </div>
                <div style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', borderRadius: '8px', padding: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                  <input type="checkbox" id="eulaModalCheckStep3" checked={eulaAccepted} onChange={e => setEulaAccepted(e.target.checked)} style={{ marginTop: '2px', accentColor: 'var(--accent)', width: '16px', height: '16px', cursor: 'pointer', flexShrink: 0 }} />
                  <label htmlFor="eulaModalCheckStep3" style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6, cursor: 'pointer' }}>
                    I agree to the <a href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 700 }}>Mojang Minecraft EULA</a>. By checking this box, CraftControl sets <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: '0.75rem' }}>EULA=TRUE</code> on server boot.
                  </label>
                </div>
              </div>
            )}

            {/* Wizard footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
              {modalStep > 1 ? (
                <button type="button" onClick={() => setModalStep(s => (s - 1) as any)} className="cc-btn-ghost">&lt;-- Back</button>
              ) : (
                <button type="button" onClick={() => setShowServerModal(false)} style={{ fontSize: '0.75rem', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
              )}
              {modalStep < 3 ? (
                <button type="button" onClick={() => { if (serverType === 'MODRINTH' && !modpackSlug) { setActionError('Please select a Modrinth modpack.'); return; } setActionError(''); setModalStep(s => (s + 1) as any); }} className="cc-btn-primary">
                  Next Step --&gt;
                </button>
              ) : (
                <button type="button" onClick={handleCreateServer} className="cc-btn-primary">
                  Launch Server
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

