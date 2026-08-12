'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { useUIPrefs } from '@/context/UIPrefsContext';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import AdvancedModeToggle, { AdvancedBadge } from '@/components/AdvancedModeToggle';
import { uploadFileInChunks } from '@/lib/chunked-upload';
import GlobalSearch from '@/components/GlobalSearch';
import DiscordLinkButton from '@/components/DiscordLinkButton';
import NodeBackupStorageModal from '@/components/NodeBackupStorageModal';
import QuotaUsageBadge from '@/components/QuotaUsageBadge';

interface NodeItem {
  id: string;
  name: string;
  host: string;
  port: number;
  isOnline: boolean;
  totalMemory: number;
  totalCpu: number;
  offloadPriority: number;
  liveCpuUsage: number | null;
  liveRamUsed: number | null;
  liveRamTotal: number | null;
  liveDiskUsed: number | null;
  liveDiskTotal: number | null;
  liveCpuModel: string | null;
  liveCpuCores: number | null;
  liveOsDistro: string | null;
  liveCpuTemp: number | null;
  liveLastSeenAt: string | null;
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
  'AUTO_DETECT',
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

const SERVER_TYPES: Array<{ id: string; name: string; desc: string; icon: string; color: string; tag?: string }> = [
  { id: 'VANILLA', name: 'Vanilla', desc: 'Plain Minecraft, exactly as Mojang ships it. No mods.', icon: 'VA', color: '#34d399', tag: 'Simplest' },
  { id: 'PAPER', name: 'Paper', desc: 'Vanilla gameplay, much faster. Supports Bukkit/Spigot plugins.', icon: 'PA', color: '#60a5fa', tag: 'Recommended' },
  { id: 'FABRIC', name: 'Fabric', desc: 'Lightweight mod loader — the usual choice for modern modpacks.', icon: 'FA', color: '#a78bfa', tag: 'Best for mods' },
  { id: 'FORGE', name: 'Forge', desc: 'The older, heavier mod loader. Needed by many classic modpacks.', icon: 'FO', color: '#fb923c' },
  { id: 'PURPUR', name: 'Purpur', desc: 'A Paper fork with hundreds of extra gameplay toggles.', icon: 'PU', color: '#c084fc' },
  { id: 'CUSTOM_ZIP', name: 'Upload a pack', desc: 'Bring your own .zip / .rar serverpack, or a Modrinth .mrpack — mods and loader are installed for you.', icon: 'ZIP', color: '#f59e0b' },
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
  const { advanced } = useUIPrefs();
  const toast = useToast();
  const confirm = useConfirm();
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);

  // Node Form State
  const [showNodeModal, setShowNodeModal] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [backupStorageNode, setBackupStorageNode] = useState<NodeItem | null>(null);
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
  const [showProsCons, setShowProsCons] = useState(false);

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

  const handleDeleteNode = async (node: NodeItem) => {
    const ok = await confirm({
      title: `Remove the node "${node.name}"?`,
      message: node._count.servers > 0
        ? `This node still hosts ${node._count.servers} server(s). Removing it unregisters the machine from the panel — move those servers to another node first if you still need them.`
        : 'This unregisters the machine from the panel. The daemon itself keeps running and can be re-added later.',
      confirmLabel: 'Remove node',
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/nodes/${node.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete node');

      toast.success('Node removed', `${node.name} is no longer registered.`);
      fetchData();
    } catch (err: any) {
      toast.error('Could not remove the node', err.message);
    }
  };

  const handleDeleteServer = async (server: ServerItem) => {
    const ok = await confirm({
      title: 'Delete this server permanently?',
      message: (
        <>
          This removes <strong style={{ color: 'var(--text-primary)' }}>{server.name}</strong> from the panel and deletes its
          world, mods and configuration from the node. <strong style={{ color: 'var(--danger)' }}>This cannot be undone.</strong>
        </>
      ),
      confirmLabel: 'Delete server',
      danger: true,
      requireText: server.name,
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/servers/${server.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', deleteData: true }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete server');

      toast.success('Server deleted', `${server.name} and its files are gone.`);
      await fetchData();
    } catch (err: any) {
      toast.error('Could not delete the server', err.message);
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
      setActionError('Please upload a serverpack archive (.zip, .rar or .mrpack).');
      return;
    }

    let finalMcVersion = selectedMcVersion === 'CUSTOM' ? customMcVersion.trim() : selectedMcVersion;

    // For serverpack uploads, use LATEST as placeholder since actual version will be auto-detected from the archive
    if (serverType === 'CUSTOM_ZIP' && serverpackFile) {
      finalMcVersion = 'LATEST';
    }

    if (!finalMcVersion) {
      setActionError('Please specify a valid Minecraft version.');
      return;
    }

    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: serverName || (serverpackFile ? serverpackFile.name.replace(/\.(zip|rar|mrpack)$/i, '') : 'Minecraft Server'),
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

      const resText = await res.text();
      let data: any = {};
      try {
        data = JSON.parse(resText);
      } catch (e) {
        // If response is HTML (error page), extract any error message from it
        if (resText.includes('<html') || resText.includes('<!DOCTYPE')) {
          throw new Error(`Server error (${res.status}): Check server logs for details`);
        }
        throw new Error(`Server returned invalid response (${res.status}): ${resText.slice(0, 150)}`);
      }

      if (res.status === 207 && data.daemonError) {
        throw new Error(`Daemon Docker launch failed: ${data.daemonError}`);
      }
      if (!res.ok) throw new Error(data.error || data.details || `Failed to create server (${res.status})`);

      console.log('[Create Server] Server created successfully:', data.server);
      console.log('[Create Server] Has serverpackFile?', !!serverpackFile);
      console.log('[Create Server] Has data.server?', !!data.server);

      if (serverpackFile && data.server) {
        console.log('[Upload Pack] Starting chunked serverpack upload for server:', data.server.id);
        console.log('[Upload Pack] File size:', serverpackFile.size, 'bytes');
        console.log('[Upload Pack] File name:', serverpackFile.name);
        
        setActionError('Uploading serverpack archive (0%)... Please wait...');
        
        try {
          await uploadFileInChunks({
            serverId: data.server.id,
            file: serverpackFile,
            isServerpack: true,
            onProgress: (percent) => {
              if (percent < 100) {
                setActionError(`Uploading serverpack archive (${percent}%)... Please wait...`);
              } else {
                setActionError(`Assembling & extracting serverpack on node... Please wait...`);
              }
            },
          });

          console.log('[Upload Pack] Upload completed successfully!');

          // Restart container so Fabric detects all newly uploaded mods
          console.log('[Upload Pack] Restarting server to apply changes...');
          await fetch(`/api/servers/${data.server.id}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'restart' }),
          });
          console.log('[Upload Pack] Restart requested');
        } catch (uploadErr: any) {
          console.error('[Upload Pack] Upload error:', uploadErr.message);
          throw uploadErr;
        }
      } else {
        console.log('[Create Server] No serverpack file to upload, skipping upload step');
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
    const pending = action === 'start' ? 'Starting server…' : action === 'stop' ? 'Stopping server…' : `Running ${action}…`;
    const toastId = toast.toast('info', pending, undefined, { sticky: true });

    try {
      const res = await fetch(`/api/servers/${serverId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, deleteData: action === 'delete' }),
      });

      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        toast.toast('error', `Could not ${action} the server`, data.error, { id: toastId });
      } else {
        toast.toast('success', action === 'start' ? 'Server is starting' : action === 'stop' ? 'Server stopped' : `${action} complete`, undefined, { id: toastId });
      }
      // Re-fetch data ONLY AFTER the action has fully completed
      await fetchData();
    } catch {
      toast.toast('error', `Could not ${action} the server`, 'The panel could not reach the server node.', { id: toastId });
      await fetchData();
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
        Loading panel context…
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Sign in required</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>Please sign in to access the CraftControl dashboard.</p>
        <Link href="/login" className="cc-btn-primary" style={{ textDecoration: 'none' }}>Go to sign in</Link>
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
      <header className="p-3 sm:px-6 sticky top-0 z-40" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Left: Logo & Role */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <Link href="/" className="flex items-center gap-2 text-decoration-none">
              <div className="flex items-center justify-center" style={{ width: 28, height: 28, borderRadius: '7px', background: 'var(--accent)', color: 'var(--bg)', fontSize: '0.72rem', fontWeight: 900 }}>
                C
              </div>
              <span className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>CraftControl</span>
            </Link>
            <span className="cc-chip">{user.globalRole === 'GLOBAL_ADMIN' ? 'Admin' : 'User'}</span>

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

          {/* Center: Global Search */}
          <GlobalSearch />

          {/* Right: User Profile & Sign Out */}
          <div className="flex items-center gap-3 ml-auto">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center" style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)', color: 'var(--bg)', fontSize: '0.65rem', fontWeight: 800 }}>
                {initials}
              </div>
              <div className="hidden sm:block text-left">
                <div className="text-xs font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>{user.username}</div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>{user.email}</div>
              </div>
            </div>
            <Link href="/dashboard/account" className="cc-btn-ghost" style={{ textDecoration: 'none' }}>Account</Link>
            <DiscordLinkButton />
            <button
              onClick={() => logout()}
              className="cc-btn-ghost"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Breadcrumb row */}
      <div className="p-4 sm:px-6" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            <span>CraftControl</span>
            <span style={{ color: 'var(--border-2)' }}>&rsaquo;</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Nodes &amp; servers</span>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
            <AdvancedModeToggle />
            <QuotaUsageBadge />
            {/* Node registration is infrastructure work, so it hides in simple mode — unless there
                are no nodes at all, in which case hiding it would leave the panel unusable. */}
            {user?.globalRole === 'GLOBAL_ADMIN' && (advanced || nodes.length === 0) && (
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
      <main className="flex-1 flex flex-col lg:flex-row w-full">

        {/* LEFT: Active Nodes panel */}
        <aside className="w-full lg:w-72 lg:min-w-[288px] p-4 lg:p-6 space-y-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="cc-section-title" style={{ marginBottom: '8px' }}>Active nodes</div>

          {nodes.length === 0 ? (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>
              No daemon nodes registered yet.
            </div>
          ) : (
            nodes.map(node => {
              const cpuPct = node.liveCpuUsage ?? 0;
              const ramUsed = node.liveRamUsed ?? 0;
              const ramTotal = node.liveRamTotal ?? node.totalMemory ?? 1;
              const ramPct = ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0;
              const diskUsed = node.liveDiskUsed ?? 0;
              const diskTotal = node.liveDiskTotal ?? 1;
              const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
              const cpuBarColor = cpuPct > 85 ? '#f87171' : cpuPct > 60 ? '#fb923c' : '#34d399';
              const ramBarColor = ramPct > 85 ? '#f87171' : ramPct > 60 ? '#fb923c' : '#60a5fa';
              const diskBarColor = diskPct > 85 ? '#f87171' : diskPct > 60 ? '#fb923c' : '#a78bfa';

              return (
                <div key={node.id} className="cc-card" style={{ padding: '14px' }}>
                  {/* Node Header */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)', marginBottom: '2px' }}>{node.name}</div>
                      <div style={{ fontSize: '0.68rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                        {node.host}:{node.port}
                      </div>
                    </div>
                    <span className={node.isOnline ? 'cc-badge-online' : 'cc-badge-offline'}>
                      {node.isOnline ? 'Online' : 'Offline'}
                    </span>
                  </div>

                  {/* CPU Model + OS */}
                  {(node.liveCpuModel || node.liveOsDistro) && (
                    <div style={{ fontSize: '0.67rem', color: 'var(--text-muted)', marginBottom: '8px', lineHeight: 1.4 }}>
                      {node.liveCpuModel && (
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={node.liveCpuModel}>
                          {node.liveCpuModel}{node.liveCpuCores ? ` · ${node.liveCpuCores}C` : ''}
                        </div>
                      )}
                      {node.liveOsDistro && <div>{node.liveOsDistro}</div>}
                    </div>
                  )}

                  {/* Live Hardware Bars */}
                  {node.isOnline && node.liveCpuUsage !== null && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                      {/* CPU */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '3px' }}>
                          <span>CPU</span>
                          <span style={{ color: cpuBarColor, fontWeight: 700 }}>{cpuPct.toFixed(1)}%{node.liveCpuTemp ? ` · ${node.liveCpuTemp}°C` : ''}</span>
                        </div>
                        <div style={{ height: '4px', background: 'var(--border-2)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(cpuPct, 100)}%`, background: cpuBarColor, borderRadius: '2px', transition: 'width 0.5s ease' }} />
                        </div>
                      </div>
                      {/* RAM */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '3px' }}>
                          <span>RAM</span>
                          <span style={{ color: ramBarColor, fontWeight: 700 }}>{(ramUsed / 1024).toFixed(1)} / {(ramTotal / 1024).toFixed(1)} GB</span>
                        </div>
                        <div style={{ height: '4px', background: 'var(--border-2)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(ramPct, 100)}%`, background: ramBarColor, borderRadius: '2px', transition: 'width 0.5s ease' }} />
                        </div>
                      </div>
                      {/* Disk */}
                      {diskTotal > 0 && (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '3px' }}>
                            <span>Disk</span>
                            <span style={{ color: diskBarColor, fontWeight: 700 }}>{diskUsed.toFixed(0)} / {diskTotal.toFixed(0)} GB</span>
                          </div>
                          <div style={{ height: '4px', background: 'var(--border-2)', borderRadius: '2px', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${Math.min(diskPct, 100)}%`, background: diskBarColor, borderRadius: '2px', transition: 'width 0.5s ease' }} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Footer: server count + admin buttons */}
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                          onClick={() => setBackupStorageNode(node)}
                          title="Off-Site Backup Storage"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--text-muted)' }}
                          onMouseOver={e => (e.currentTarget.style.color = '#34d399')}
                          onMouseOut={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                        >
                          <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M5 8a4 4 0 014-4h6a4 4 0 014 4v8a4 4 0 01-4 4H9a4 4 0 01-4-4V8zm4-1v1m6-1v1M8 12h8m-8 4h5" /></svg>
                        </button>
                        <button
                          onClick={() => handleDeleteNode(node)}
                          title="Delete Node"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--danger)' }}
                        >
                          <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </aside>

        {/* RIGHT: Server grid */}
        <section className="flex-1 p-4 lg:p-6">
          <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Your Servers</h2>
            {servers.length > 0 && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {servers.filter((s) => s.status === 'RUNNING').length} of {servers.length} running
              </span>
            )}
          </div>

          {servers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '56px 24px', border: '1px dashed var(--border-2)', borderRadius: '10px' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '10px' }}>Servers</div>
              <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>No servers yet</div>
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: '0 auto 18px', maxWidth: '380px', lineHeight: 1.6 }}>
                {nodes.length === 0
                  ? 'Register a daemon node first — that is the machine your worlds will actually run on.'
                  : 'Create your first server and it will be ready to join in a couple of minutes.'}
              </p>
              {nodes.length > 0 && (
                <button
                  onClick={() => {
                    const usedPorts = new Set((servers || []).map((s) => s.serverPort));
                    let nextPort = 24000;
                    while (usedPorts.has(nextPort) && nextPort <= 25000) nextPort++;
                    setServerPort(nextPort);
                    setShowServerModal(true);
                    setModalStep(1);
                  }}
                  className="cc-btn-primary"
                  style={{ padding: '8px 20px' }}
                >
                  + Create your first server
                </button>
              )}
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
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        {server.serverType} {server.mcVersion}
                        {advanced && server.node?.name && <> · {server.node.name}</>}
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

                  {/* One primary action (Manage) beside the power control. "Console" used to sit
                      here too, pointing at the exact same page as "Manage" — two buttons, one
                      destination. Delete is destructive and rare, so it moves behind advanced mode. */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px' }}>
                    <Link
                      href={`/dashboard/servers/${server.id}`}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                        background: 'var(--accent)', color: '#0d1117',
                        borderRadius: '6px', padding: '8px 0',
                        fontSize: '0.75rem', fontWeight: 700, textDecoration: 'none',
                        transition: 'opacity 0.15s',
                      }}
                      onMouseOver={e => (e.currentTarget.style.opacity = '0.85')}
                      onMouseOut={e => (e.currentTarget.style.opacity = '1')}
                    >
                      Manage &amp; console →
                    </Link>
                    {server.status === 'RUNNING' ? (
                      <button
                        onClick={() => handleServerAction(server.id, 'stop')}
                        title="Save the world and shut this server down cleanly"
                        className="cc-btn-danger"
                        style={{ borderRadius: '6px', padding: '7px 16px', fontWeight: 600 }}
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => handleServerAction(server.id, 'start')}
                        title="Boot this server so players can join"
                        style={{ background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent-border)', borderRadius: '6px', padding: '7px 16px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
                      >
                        Start
                      </button>
                    )}
                  </div>
                  {advanced && (
                    <button
                      onClick={() => handleDeleteServer(server)}
                      title="Permanently delete this server and all of its files"
                      style={{
                        background: 'rgba(248,81,73,0.12)', color: 'var(--danger)',
                        border: '1px solid rgba(248,81,73,0.25)', borderRadius: '6px',
                        padding: '6px 0', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      Delete server
                    </button>
                  )}
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

      {backupStorageNode && (
        <NodeBackupStorageModal
          nodeId={backupStorageNode.id}
          nodeName={backupStorageNode.name}
          onClose={() => setBackupStorageNode(null)}
        />
      )}

      {/* â”€â”€ Modal: Create Server Wizard â”€â”€ */}
      {showServerModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,17,23,0.85)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 50 }}>
          <div className="cc-card" style={{ width: '100%', maxWidth: '640px', maxHeight: '90vh', overflowY: 'auto', padding: '28px', boxShadow: '0 24px 48px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '16px', borderBottom: '1px solid var(--border)' }}>
              <div>
                <h3 style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Create a Minecraft server</h3>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>Three quick steps — everything else is chosen for you.</p>
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
                <div>
                  <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Step 1 of 3 — What kind of server?</label>
                  <p className="cc-section-sub">
                    Not sure? <strong style={{ color: 'var(--text-primary)' }}>Paper</strong> is the safe default for a normal survival
                    server, and <strong style={{ color: 'var(--text-primary)' }}>Fabric</strong> if you want to add mods later.
                  </p>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                  {SERVER_TYPES.map(t => (
                    <div
                      key={t.id}
                      onClick={() => {
                        setServerType(t.id);
                        if (t.id === 'CUSTOM_ZIP') {
                          setSelectedMcVersion('AUTO_DETECT');
                        }
                        if (t.id !== 'MODRINTH' && t.id !== 'CURSEFORGE') {
                          setModpackSlug('');
                          setSelectedModpackTitle('');
                        }
                      }}
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t.name}</span>
                        {t.tag && (
                          <span style={{ fontSize: '0.55rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--accent)', background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', borderRadius: '4px', padding: '1px 5px' }}>
                            {t.tag}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{t.desc}</div>
                    </div>
                  ))}
                </div>
                {/* Upload section */}
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '16px' }}>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent)', marginBottom: '6px' }}>
                    Upload Serverpack Archive (.zip, .rar or .mrpack) {serverType === 'CUSTOM_ZIP' ? '(Required)' : '(Optional)'}
                  </label>
                  <input
                    type="file"
                    accept=".zip,.rar,.mrpack"
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setServerpackFile(f);
                        setServerType('CUSTOM_ZIP');
                        setSelectedMcVersion('AUTO_DETECT');
                        if (!serverName) setServerName(f.name.replace(/\.(zip|rar|mrpack)$/i, '') + ' Server');
                      }
                    }}
                    className="cc-input"
                    style={{ padding: '6px' }}
                  />
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
                <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Step 2 of 3 — Name and resources</label>
                <div>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Server name</label>
                  <input type="text" required value={serverName} onChange={e => setServerName(e.target.value)} placeholder="My Minecraft World" className="cc-input" />
                  <p className="cc-section-sub">Just a label inside the panel — you can rename it any time.</p>
                </div>
                <div style={{ display: advanced ? 'block' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>Execution Mode <AdvancedBadge /></label>
                    <button
                      type="button"
                      onClick={() => setShowProsCons(!showProsCons)}
                      style={{ fontSize: '0.72rem', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}
                    >
                      {showProsCons ? 'Hide comparison' : 'Compare pros & cons'}
                    </button>
                  </div>

                  {showProsCons && (
                    <div style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '14px', marginBottom: '10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '0.72rem' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>[D] Docker Container</div>
                        <div style={{ color: 'var(--accent)', fontWeight: 700, marginTop: '2px' }}>Pros:</div>
                        <ul style={{ margin: 0, paddingLeft: '14px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                          <li>Isolated container per server instance</li>
                          <li>Strict Memory &amp; CPU cgroup limits</li>
                          <li>Auto-managed Java runtimes</li>
                        </ul>
                        <div style={{ color: 'var(--danger)', fontWeight: 700, marginTop: '4px' }}>Cons:</div>
                        <ul style={{ margin: 0, paddingLeft: '14px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                          <li>Slight container initialization overhead</li>
                          <li>Slightly higher RAM footprint</li>
                        </ul>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderLeft: '1px solid var(--border-2)', paddingLeft: '12px' }}>
                        <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>[S] Standalone Process</div>
                        <div style={{ color: 'var(--accent)', fontWeight: 700, marginTop: '2px' }}>Pros:</div>
                        <ul style={{ margin: 0, paddingLeft: '14px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                          <li>Blazing fast instant server boot</li>
                          <li>Zero container overhead</li>
                          <li>Maximum memory for Java heap</li>
                        </ul>
                        <div style={{ color: 'var(--danger)', fontWeight: 700, marginTop: '4px' }}>Cons:</div>
                        <ul style={{ margin: 0, paddingLeft: '14px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                          <li>Shared host process space</li>
                          <li>Soft resource limits (-Xmx flag)</li>
                        </ul>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    {[{id: 'CONTAINER', icon: 'D', name: 'Docker Container', desc: 'Isolated container per server'}, {id: 'PROCESS', icon: 'S', name: 'Standalone Process', desc: 'Direct process, no extra Docker containers'}].map(m => (
                      <div key={m.id} onClick={() => setExecutionMode(m.id as any)}
                        style={{ padding: '12px', borderRadius: '8px', cursor: 'pointer', border: `1px solid ${executionMode === m.id ? 'var(--accent)' : 'var(--border-2)'}`, background: executionMode === m.id ? 'var(--accent-dim)' : 'var(--bg)', display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.85rem', fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--accent)' }}>[{m.icon}]</span>
                        <div>
                          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{m.name}</div>
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px' }}>{m.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: advanced ? '1fr 1fr' : '1fr', gap: '10px' }}>
                  {/* In simple mode the node stays on Auto-Select, which is the right answer almost always. */}
                  {advanced && (
                    <div>
                      <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Target Worker Node <AdvancedBadge /></label>
                      <select value={selectedNodeId} onChange={e => setSelectedNodeId(e.target.value)} className="cc-input">
                        <option value="AUTO">Auto-Select (Smart Priority)</option>
                        {nodes.map(n => (
                          <option key={n.id} value={n.id} disabled={!n.isOnline}>
                            {n.name} (Priority: {n.offloadPriority}){!n.isOnline ? ' — OFFLINE' : ''}
                          </option>
                        ))}
                      </select>
                      {selectedNodeId !== 'AUTO' && nodes.find(n => n.id === selectedNodeId)?.isOnline === false && (
                        <p style={{ fontSize: '0.7rem', color: 'var(--danger)', marginTop: '5px' }}>
                          This node is currently unreachable — the server cannot be provisioned here until it comes back online.
                        </p>
                      )}
                    </div>
                  )}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>
                      Minecraft Version {(serverType === 'MODRINTH' || serverType === 'CUSTOM_ZIP' || serverpackFile !== null) && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>(Locked to pack)</span>}
                    </label>
                    <select
                      value={(serverType === 'CUSTOM_ZIP' || serverpackFile !== null) ? 'AUTO_DETECT' : selectedMcVersion}
                      disabled={serverType === 'MODRINTH' || serverType === 'CUSTOM_ZIP' || serverpackFile !== null}
                      onChange={e => setSelectedMcVersion(e.target.value)}
                      className="cc-input"
                      style={{ opacity: (serverType === 'MODRINTH' || serverType === 'CUSTOM_ZIP' || serverpackFile !== null) ? 0.6 : 1 }}
                    >
                      {MC_VERSIONS.map(v => (
                        <option key={v} value={v}>
                          {v === 'AUTO_DETECT' ? 'Auto-detect from serverpack' : (v === 'CUSTOM' ? 'Custom / Snapshot...' : v)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {selectedMcVersion === 'CUSTOM' && serverType !== 'MODRINTH' && (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--accent)', marginBottom: '5px', fontWeight: 600 }}>Custom Minecraft Version / Snapshot</label>
                    <input type="text" required value={customMcVersion} onChange={e => setCustomMcVersion(e.target.value)} placeholder="e.g. 24w10a, 1.7.10" className="cc-input" />
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: advanced ? '1fr 1fr 1fr' : '1fr', gap: '10px' }}>
                  {/* The wizard already picked the next free port; only an expert needs to override it. */}
                  {advanced && (
                    <div>
                      <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Server Port <AdvancedBadge /></label>
                      <input type="number" required value={serverPort} onChange={e => setServerPort(parseInt(e.target.value, 10))} className="cc-input" />
                    </div>
                  )}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Memory (RAM)</label>
                    <select value={memoryMb} onChange={e => setMemoryMb(parseInt(e.target.value, 10))} className="cc-input">
                      <option value={1024}>1 GB — a few friends, vanilla</option>
                      <option value={2048}>2 GB — vanilla or light plugins</option>
                      <option value={4096}>4 GB — plugins or a small modpack</option>
                      <option value={8192}>8 GB — most modpacks</option>
                      <option value={16384}>16 GB — large or heavily modded packs</option>
                    </select>
                    {!advanced && (
                      <p className="cc-section-sub">
                        Port {serverPort} and 1 CPU core were picked automatically. Turn on advanced mode to change them.
                      </p>
                    )}
                  </div>
                  {advanced && (
                    <div>
                      <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>CPU Cores <AdvancedBadge /></label>
                      <select value={cpuLimit} onChange={e => setCpuLimit(parseFloat(e.target.value))} className="cc-input">
                        <option value={1.0}>1 Core</option>
                        <option value={2.0}>2 Cores</option>
                        <option value={4.0}>4 Cores</option>
                        <option value={8.0}>8 Cores</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step 3 */}
            {modalStep === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Step 3 of 3 — Review and accept the EULA</label>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {[
                    { label: 'Execution Mode', value: executionMode === 'PROCESS' ? 'Standalone Process' : 'Docker Container' },
                    { label: 'Server Engine', value: serverType },
                    { label: 'Minecraft Version', value: (serverType === 'CUSTOM_ZIP' || serverpackFile !== null) ? 'Auto-detected from serverpack' : (selectedMcVersion === 'CUSTOM' ? customMcVersion : selectedMcVersion) },
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

