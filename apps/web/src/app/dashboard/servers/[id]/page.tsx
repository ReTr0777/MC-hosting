'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUIPrefs } from '@/context/UIPrefsContext';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import AdvancedModeToggle, { AdvancedBadge, AdvancedOnly } from '@/components/AdvancedModeToggle';
import { ConsoleViewer } from '@/components/ConsoleViewer';
import { FileExplorer } from '@/components/FileExplorer';
import { ServerPermissionsModal } from '@/components/ServerPermissionsModal';
import AnalyticsWidget from '@/components/AnalyticsWidget';
import PlayersTab from '@/components/PlayersTab';
import WhitelistTab from '@/components/WhitelistTab';
import BanListTab from '@/components/BanListTab';
import MapTab from '@/components/MapTab';
import SleepTab from '@/components/SleepTab';
import PropertiesTab from '@/components/PropertiesTab';
import BackupsTab from '@/components/BackupsTab';
import SubdomainTab from '@/components/SubdomainTab';
import UpdateCenterTab from '@/components/UpdateCenterTab';
import { SchedulesTab } from '@/components/SchedulesTab';
import ModBrowserTab from '@/components/ModBrowserTab';
import IntegrationsTab from '@/components/IntegrationsTab';
import BroadcastBar from '@/components/BroadcastBar';
import ResourceHistoryChart from '@/components/ResourceHistoryChart';
import ExportImportCard from '@/components/ExportImportCard';

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

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'RUNNING' ? 'cc-badge-running' :
    status === 'STARTING' ? 'cc-badge-starting' :
    status === 'ERROR' ? 'cc-badge-error' :
    status === 'SLEEPING' ? 'cc-badge-starting' :
    'cc-badge-offline';
  return <span className={cls}>{status}</span>;
}

/**
 * Tabs carry a plain-language `hint` shown under the tab bar, and an `advanced` flag. Anything
 * marked advanced is an expert-level or rarely-touched surface — hidden until the user opts in,
 * so the everyday job of running a server isn't buried under thirteen equal-looking tabs.
 */
const TABS = [
  { key: 'console', label: 'Console', advanced: false, hint: 'Live server output, connection details and performance at a glance.' },
  { key: 'players', label: 'Players', advanced: false, hint: 'See who is online, and op, kick or message them.' },
  { key: 'whitelist', label: 'Whitelist', advanced: false, hint: 'Control exactly which accounts are allowed to join.' },
  { key: 'bans', label: 'Bans', advanced: false, hint: 'Review and lift bans on players and IP addresses.' },
  { key: 'mods', label: 'Mods', advanced: false, hint: 'Search Modrinth and install or remove mods for this server.' },
  { key: 'integrations', label: 'Integrations', advanced: false, hint: 'Dedicated setup for popular mods and plugins like Simple Voice Chat, Geyser, and LuckPerms.' },
  { key: 'backups', label: 'Backups', advanced: false, hint: 'Take a snapshot before risky changes, and restore one if something breaks.' },
  { key: 'properties', label: 'Settings', advanced: false, hint: 'Game rules from server.properties — difficulty, MOTD, view distance and more.' },
  { key: 'map', label: 'World Map', advanced: false, hint: 'Browse a live rendered map of your world in the browser.' },

  { key: 'update', label: 'Update Centre', advanced: true, hint: 'Change the Minecraft or mod-loader version. Back up first — version jumps can break worlds.' },
  { key: 'schedules', label: 'Schedules', advanced: true, hint: 'Run restarts, backups and commands automatically on a timetable.' },
  { key: 'sleep', label: 'Sleep & Wake', advanced: true, hint: 'Idle the server to free resources and wake it automatically when a player connects.' },
  { key: 'domain', label: 'Domain', advanced: true, hint: 'Point a custom domain or subdomain at this server instead of an IP and port.' },
  { key: 'files', label: 'Files', advanced: true, hint: 'Direct access to the server directory. Editing the wrong file here can stop the server booting.' },
] as const;

type TabKey = typeof TABS[number]['key'];

export default function ServerConsolePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const serverId = params.id as string;
  const { user } = useAuth();
  const { advanced } = useUIPrefs();
  const toast = useToast();
  const confirm = useConfirm();

  const [server, setServer] = useState<ServerDetail | null>(null);
  const [nodes, setNodes] = useState<any[]>([]);
  const [userRole, setUserRole] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [migrationDestId, setMigrationDestId] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const initialTab = TABS.some((t) => t.key === searchParams.get('tab')) ? (searchParams.get('tab') as TabKey) : 'console';
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);

  const [iconKey, setIconKey] = useState<number>(Date.now());
  const [uploadingIcon, setUploadingIcon] = useState(false);

  const [renamingServer, setRenamingServer] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Only bounce the user off an advanced tab when they actively switch advanced mode OFF. Watching
  // the raw flag instead would also fire on first paint and break links like `?tab=files`.
  const prevAdvanced = useRef(advanced);
  useEffect(() => {
    const turnedOff = prevAdvanced.current && !advanced;
    prevAdvanced.current = advanced;
    if (turnedOff && TABS.find((t) => t.key === activeTab)?.advanced) {
      setActiveTab('console');
    }
  }, [advanced, activeTab]);

  // A tab reached by direct link stays reachable even in simple mode, rather than vanishing mid-visit.
  const visibleTabs = TABS.filter((t) => !t.advanced || advanced || t.key === activeTab);
  const currentTab = TABS.find((t) => t.key === activeTab);
  const hiddenCount = TABS.filter((t) => t.advanced).length;

  const canManage = user?.globalRole === 'GLOBAL_ADMIN' || userRole === 'OWNER' || userRole === 'OPERATOR' || userRole === 'ADMIN';
  const canDeleteServer = user?.globalRole === 'GLOBAL_ADMIN' || userRole === 'OWNER';
  const canRenameServer = user?.globalRole === 'GLOBAL_ADMIN' || userRole === 'OWNER' || userRole === 'ADMIN';

  const startRenameServer = () => {
    if (!server || !canRenameServer) return;
    setNameDraft(server.name);
    setRenamingServer(true);
  };

  const saveServerName = async () => {
    const trimmed = nameDraft.trim();
    if (!server || !trimmed || trimmed === server.name) {
      setRenamingServer(false);
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch(`/api/servers/${serverId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        const data = await res.json();
        setServer((prev) => (prev ? { ...prev, name: data.server.name } : prev));
        toast.success('Server renamed', `Now known as "${data.server.name}".`);
        setRenamingServer(false);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error('Could not rename server', err.error || 'The panel rejected the request.');
      }
    } catch {
      toast.error('Could not rename server', 'Network error reaching the panel.');
    } finally {
      setSavingName(false);
    }
  };

  const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingIcon(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/icon`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });

      if (res.ok) {
        setIconKey(Date.now());
        toast.success('Server icon updated', 'Players will see it next to your server in their multiplayer list.');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error('Could not update the icon', err.error || 'The node rejected the upload.');
      }
    } catch {
      toast.error('Could not update the icon', 'The panel could not reach the server node.');
    } finally {
      setUploadingIcon(false);
    }
  };

  const fetchServerDetails = async () => {
    try {
      const [serverRes, nodesRes] = await Promise.all([
        fetch(`/api/servers/${serverId}`),
        fetch(`/api/nodes`),
      ]);

      if (serverRes.ok) {
        const data = await serverRes.json();
        setServer(data.server);
        setUserRole(data.role);
      } else {
        const errData = await serverRes.json().catch(() => ({}));
        setError(errData.error || 'Failed to fetch server details');
      }

      if (nodesRes.ok) {
        const data = await nodesRes.json();
        setNodes(Array.isArray(data.nodes) ? data.nodes : []);
      } else {
        setNodes([]);
      }
    } catch {
      setError('Network error retrieving server instance');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (serverId) fetchServerDetails();
  }, [serverId]);

  const connectAddress = server ? `${server.node.host}:${server.serverPort}` : '';

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(connectAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.info('Copy failed', `Connect manually using ${connectAddress}`);
    }
  };

  const handleMigrate = async () => {
    if (!migrationDestId) return toast.info('Pick a destination first', 'Choose the node you want this server moved to.');

    const destName = nodes.find((n) => n.id === migrationDestId)?.name || 'the selected node';
    const ok = await confirm({
      title: 'Move this server to another node?',
      message: (
        <>
          <strong style={{ color: 'var(--text-primary)' }}>{server?.name}</strong> and all of its files will be transferred to{' '}
          <strong style={{ color: 'var(--text-primary)' }}>{destName}</strong>.
          <br /><br />
          If it is running it will shut down gracefully with a 10 second warning first. Players will be disconnected for the
          duration of the transfer, which can take a while for a large world.
        </>
      ),
      confirmLabel: 'Start migration',
    });
    if (!ok) return;

    setActionLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationNodeId: migrationDestId }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('Migration started', 'The transfer runs in the background — this page will refresh shortly.');
        setTimeout(() => window.location.reload(), 2000);
      } else {
        toast.error('Migration could not start', data.error || 'The node refused the request.');
      }
    } catch {
      toast.error('Migration could not start', 'The panel could not reach the server node.');
    } finally {
      setActionLoading(false);
    }
  };

  const ACTION_WORDING: Record<string, { pending: string; done: string }> = {
    start: { pending: 'Starting server…', done: 'Server is starting' },
    stop: { pending: 'Stopping server…', done: 'Server stopped' },
    restart: { pending: 'Restarting server…', done: 'Server is restarting' },
    kill: { pending: 'Force stopping…', done: 'Server process killed' },
  };

  const handleAction = async (action: string) => {
    if (action === 'kill') {
      const ok = await confirm({
        title: 'Force stop the server?',
        message: 'This kills the process immediately without letting Minecraft save. Anything since the last autosave will be lost. Use Stop instead unless the server is frozen.',
        confirmLabel: 'Force stop',
        danger: true,
      });
      if (!ok) return;
    }

    const wording = ACTION_WORDING[action] || { pending: `Running ${action}…`, done: `${action} complete` };
    const toastId = toast.toast('info', wording.pending, undefined, { sticky: true });

    setActionLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const data = await res.json();
      if (res.ok) {
        toast.toast('success', wording.done, undefined, { id: toastId });
        await fetchServerDetails();
      } else {
        toast.toast('error', `Could not ${action} the server`, data.details ? `${data.error}: ${data.details}` : data.error, { id: toastId });
      }
    } catch {
      toast.toast('error', `Could not ${action} the server`, 'The panel could not reach the server node.', { id: toastId });
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteServer = async () => {
    const ok = await confirm({
      title: 'Delete this server permanently?',
      message: (
        <>
          This removes <strong style={{ color: 'var(--text-primary)' }}>{server?.name}</strong> from the panel and deletes its
          world, mods and configuration from the node. <strong style={{ color: 'var(--danger)' }}>This cannot be undone.</strong>
          <br /><br />
          If you might want this world back, take a backup first.
        </>
      ),
      confirmLabel: 'Delete server',
      danger: true,
      requireText: server?.name,
    });
    if (!ok) return;

    setActionLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', deleteData: true }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete server');

      router.push('/dashboard');
    } catch (e: any) {
      toast.error('Could not delete the server', e.message);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>
        Loading your server…
      </div>
    );
  }

  if (error || !server) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px', fontFamily: 'var(--font-ui)' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>We couldn&apos;t open this server</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: '24px', maxWidth: '420px', lineHeight: 1.6 }}>
          {error || 'This server no longer exists, or you don’t have access to it.'}
        </p>
        <Link href="/dashboard" style={{ background: 'var(--surface)', color: 'var(--text-primary)', padding: '8px 20px', borderRadius: '6px', border: '1px solid var(--border-2)', fontSize: '0.8125rem', textDecoration: 'none' }}>
          ← Back to all servers
        </Link>
      </div>
    );
  }

  const isRunning = server.status === 'RUNNING';

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column' }}>

      {/* ── Top Header Bar ── */}
      <header className="cc-header-responsive" style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        padding: '0 24px',
        minHeight: '52px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        {/* Left: logo + breadcrumb + status */}
        <div className="cc-header-row" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <Link href="/dashboard" title="Back to all servers" style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: '6px',
              background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '13px', fontWeight: 800, color: '#0d1117',
            }}>C</div>
            <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>CraftControl</span>
          </Link>
          <span style={{ color: 'var(--border-2)', fontSize: '1.1rem', fontWeight: 300 }}>&gt;</span>

          {/* Clickable Server Icon */}
          <label
            htmlFor="server-icon-upload-input"
            title={uploadingIcon ? 'Uploading icon…' : 'Click to set the icon players see in their server list'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '28px', height: '28px', borderRadius: '6px',
              background: 'var(--surface-2)', border: '1px solid var(--border-2)',
              cursor: 'pointer', overflow: 'hidden', flexShrink: 0,
              opacity: uploadingIcon ? 0.5 : 1,
            }}
          >
            <img
              src={`/api/servers/${server.id}/icon?v=${iconKey}`}
              alt="Icon"
              style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <span style={{ fontSize: '0.6rem', fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>MC</span>
          </label>
          <input
            id="server-icon-upload-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleIconUpload}
            style={{ display: 'none' }}
          />
          {renamingServer ? (
            <input
              autoFocus
              value={nameDraft}
              disabled={savingName}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveServerName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.currentTarget.blur(); }
                if (e.key === 'Escape') { setRenamingServer(false); }
              }}
              maxLength={100}
              style={{
                fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)',
                background: 'var(--surface-2)', border: '1px solid var(--accent)', borderRadius: '4px',
                padding: '2px 6px', width: '160px',
              }}
            />
          ) : (
            <span
              onClick={startRenameServer}
              title={canRenameServer ? 'Click to rename this server' : undefined}
              style={{
                fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px',
                cursor: canRenameServer ? 'pointer' : 'default',
              }}
            >
              {server.name}
            </span>
          )}
          <StatusBadge status={server.status} />
        </div>

        {/* Right: primary power controls. Destructive extras live in advanced mode only. */}
        <div className="cc-actions-row" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {canDeleteServer && advanced && (
            <button
              onClick={handleDeleteServer}
              disabled={actionLoading}
              title="Permanently delete this server and all of its files"
              style={{ background: 'rgba(248,81,73,0.12)', color: 'var(--danger)', border: '1px solid rgba(248,81,73,0.25)', borderRadius: '6px', padding: '5px 12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
            >
              Delete
            </button>
          )}
          {isRunning ? (
            <>
              <button
                onClick={() => handleAction('restart')}
                disabled={actionLoading}
                className="cc-btn-warning"
                title="Warn players, then stop and start the server again"
                style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
              >
                ↺ Restart
              </button>
              <button
                onClick={() => handleAction('stop')}
                disabled={actionLoading}
                className="cc-btn-danger"
                title="Save the world and shut the server down cleanly"
              >
                ■ Stop
              </button>
              {advanced && (
                <button
                  onClick={() => handleAction('kill')}
                  disabled={actionLoading}
                  title="Kill the process immediately without saving — only for a frozen server"
                  style={{ background: 'rgba(248,81,73,0.1)', color: 'var(--danger)', border: '1px solid rgba(248,81,73,0.2)', borderRadius: '6px', padding: '5px 12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
                >
                  Force stop
                </button>
              )}
            </>
          ) : (
            <button
              onClick={() => handleAction('start')}
              disabled={actionLoading}
              className="cc-btn-primary"
              style={{ padding: '6px 18px' }}
            >
              ▶ Start Server
            </button>
          )}
        </div>
      </header>

      {/* ── Tab Navigation ── */}
      <div className="cc-tab-nav no-scrollbar" style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        overflowX: 'auto',
        gap: '16px',
      }}>
        <div style={{ display: 'flex', gap: '18px', flexShrink: 0, alignItems: 'center' }}>
          {visibleTabs.map((tab, i) => {
            // Drop a divider in front of the first advanced tab so the two groups read apart.
            const firstAdvanced = tab.advanced && !visibleTabs[i - 1]?.advanced;
            return (
              <React.Fragment key={tab.key}>
                {firstAdvanced && <span className="cc-tab-group-label">· advanced ·</span>}
                <button
                  onClick={() => setActiveTab(tab.key)}
                  title={tab.hint}
                  className={`cc-tab${activeTab === tab.key ? ' cc-tab-active' : ''}`}
                >
                  {tab.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
          <AdvancedModeToggle compact />
          {user?.globalRole === 'GLOBAL_ADMIN' && (
            <button
              onClick={() => setShowPermissionsModal(true)}
              title="Choose who else can see and control this server"
              style={{
                background: 'rgba(139,92,246,0.12)', color: '#a78bfa',
                border: '1px solid rgba(139,92,246,0.25)', borderRadius: '6px',
                padding: '4px 12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              Who has access
            </button>
          )}
        </div>
      </div>

      {/* ── Contextual explainer for the current tab ── */}
      {currentTab && (
        <div style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)', padding: '10px 24px' }}>
          <div style={{ maxWidth: '1280px', margin: '0 auto', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{currentTab.hint}</span>
            {currentTab.advanced && <AdvancedBadge />}
          </div>
        </div>
      )}

      {/* ── Main Content ── */}
      <main className="cc-main-content" style={{ flex: 1, maxWidth: '1280px', width: '100%', margin: '0 auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {activeTab === 'console' && (
          <div className="animate-fadeIn" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Connection details — the first thing anyone actually needs */}
            <div className="cc-card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '28px', flexWrap: 'wrap', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: '4px' }}>
                    Join address
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', fontWeight: 700, color: 'var(--accent)' }}>{connectAddress}</code>
                    <button
                      onClick={copyAddress}
                      title="Copy the address players paste into Minecraft"
                      style={{ background: copied ? 'var(--accent-dim)' : 'var(--surface-2)', color: copied ? 'var(--accent)' : 'var(--text-muted)', border: `1px solid ${copied ? 'var(--accent-border)' : 'var(--border-2)'}`, borderRadius: '5px', padding: '2px 8px', fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer' }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: '4px' }}>Version</div>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{server.serverType} {server.mcVersion}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: '4px' }}>Memory</div>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{server.memoryMb >= 1024 ? `${server.memoryMb / 1024} GB` : `${server.memoryMb} MB`}</div>
                </div>
                {advanced && (
                  <div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: '4px' }}>
                      Node <AdvancedBadge />
                    </div>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                      {server.node.name}{' '}
                      <span style={{ color: server.node.isOnline ? 'var(--accent)' : 'var(--danger)', fontSize: '0.72rem' }}>
                        {server.node.isOnline ? '● online' : '● offline'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              {!isRunning && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Server is {server.status.toLowerCase()} — press <strong style={{ color: 'var(--accent)' }}>Start Server</strong> above to let players in.
                </div>
              )}
            </div>

            {/* Modrinth notice */}
            {server.serverType === 'MODRINTH' && server.modpackSlug && (
              <div style={{ background: 'rgba(0,217,126,0.06)', border: '1px solid var(--accent-border)', borderRadius: '10px', padding: '14px 18px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--accent)', marginBottom: '4px' }}>Players need the matching modpack</div>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
                    This server runs <strong style={{ color: 'var(--text-primary)' }}>{server.modpackSlug} ({server.mcVersion})</strong>.
                    Anyone joining must install the same pack from the{' '}
                    <a href={`https://modrinth.com/modpack/${server.modpackSlug}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
                      Modrinth App
                    </a>{' '}
                    or they will be kicked at login.
                  </p>
                </div>
              </div>
            )}

            {/* Analytics */}
            <AnalyticsWidget serverId={server.id} memoryLimitMb={server.memoryMb} />

            {/* Broadcast */}
            <BroadcastBar serverId={server.id} canManage={canManage} />

            {/* Console */}
            <div>
              <div className="cc-section-title" style={{ marginBottom: '8px' }}>Live console</div>
              <ConsoleViewer
                serverId={server.id}
                containerId={server.containerId || `process-${server.id}`}
                daemonHost={server.node.host}
                daemonPort={server.node.port}
                apiKey={server.node.apiKey}
              />
            </div>

            {/* Everything below is expert territory — hidden unless the user asks for it. */}
            <AdvancedOnly hint="Resource history, node migration and full server export live in advanced mode.">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <ResourceHistoryChart serverId={server.id} />

                {/* Migration */}
                <div className="cc-card" style={{ padding: '20px 24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>Move to another node</span>
                    <AdvancedBadge />
                  </div>
                  <p className="cc-section-sub" style={{ marginBottom: '16px' }}>
                    Transfers this server and every file it owns to a different machine. The server goes offline during the copy.
                  </p>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      value={migrationDestId}
                      onChange={(e) => setMigrationDestId(e.target.value)}
                      className="cc-input"
                      style={{ maxWidth: '260px' }}
                    >
                      <option value="">Choose a destination node…</option>
                      {nodes
                        .filter((n) => n.id !== server.nodeId)
                        .map((n) => (
                          <option key={n.id} value={n.id} disabled={!n.isOnline}>
                            {n.name} (Priority {n.offloadPriority}){n.isOnline ? '' : ' — offline'}
                          </option>
                        ))}
                    </select>
                    <button
                      onClick={handleMigrate}
                      disabled={actionLoading || !migrationDestId}
                      style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '6px', padding: '8px 18px', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer', opacity: (actionLoading || !migrationDestId) ? 0.5 : 1 }}
                    >
                      {actionLoading ? 'Migrating…' : 'Start migration'}
                    </button>
                  </div>
                </div>

                {/* Export / Import */}
                <ExportImportCard serverId={server.id} canManage={canManage} />

                {/* Danger zone */}
                {canDeleteServer && (
                  <div className="cc-card" style={{ padding: '20px 24px', borderColor: 'rgba(248,81,73,0.25)' }}>
                    <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--danger)', marginBottom: '6px' }}>Danger zone</div>
                    <p className="cc-section-sub" style={{ marginBottom: '14px' }}>
                      Deleting removes the world, mods and configuration from the node permanently. Take a backup first if you might want it back.
                    </p>
                    <button onClick={handleDeleteServer} disabled={actionLoading} className="cc-btn-danger" style={{ fontWeight: 700 }}>
                      Delete this server
                    </button>
                  </div>
                )}
              </div>
            </AdvancedOnly>
          </div>
        )}

        {activeTab === 'players' && <PlayersTab serverId={server.id} canManage={canManage} />}
        {activeTab === 'whitelist' && (
          <div className="animate-fadeIn"><WhitelistTab serverId={server.id} canManage={canManage} /></div>
        )}
        {activeTab === 'bans' && (
          <div className="animate-fadeIn"><BanListTab serverId={server.id} canManage={canManage} /></div>
        )}
        {activeTab === 'properties' && <PropertiesTab serverId={server.id} canManage={canManage} />}
        {activeTab === 'update' && <UpdateCenterTab server={server} canManage={canManage} onUpdateSuccess={fetchServerDetails} />}
        {activeTab === 'schedules' && <SchedulesTab serverId={server.id} canManage={canManage} />}
        {activeTab === 'backups' && <BackupsTab serverId={server.id} canManage={canManage} />}
        {activeTab === 'domain' && <SubdomainTab serverId={server.id} />}

        {activeTab === 'files' && (
          <div className="animate-fadeIn">
            <FileExplorer
              serverId={server.id}
              canManageFiles={user?.globalRole === 'GLOBAL_ADMIN' || userRole === 'OPERATOR' || userRole === 'ADMIN'}
            />
          </div>
        )}

        {activeTab === 'map' && (
          <div className="animate-fadeIn">
            <MapTab serverId={server.id} serverStatus={server.status} canManage={canManage} />
          </div>
        )}

        {activeTab === 'sleep' && (
          <div className="animate-fadeIn">
            <SleepTab serverId={server.id} serverStatus={server.status} canManage={canManage} onChanged={fetchServerDetails} />
          </div>
        )}

        {activeTab === 'mods' && (
          <div className="animate-fadeIn">
            <ModBrowserTab
              serverId={server.id}
              serverType={server.serverType}
              mcVersion={server.mcVersion}
              canManageFiles={user?.globalRole === 'GLOBAL_ADMIN' || userRole === 'OPERATOR' || userRole === 'ADMIN'}
            />
          </div>
        )}

        {activeTab === 'integrations' && (
          <div className="animate-fadeIn">
            <IntegrationsTab
              serverId={server.id}
              canManage={canManage}
              serverType={server.serverType}
              serverStatus={server.status}
              onGoToMods={() => setActiveTab('mods')}
            />
          </div>
        )}

        {/* Footer nudge so hidden features stay discoverable in simple mode. The console tab already
            carries its own inline hint, so it would read as a duplicate there. */}
        {!advanced && activeTab !== 'console' && (
          <div className="cc-adv-hint" style={{ marginTop: '4px' }}>
            <span>{hiddenCount} more tools — updates, schedules, sleep, custom domains and file access — are hidden to keep things simple.</span>
          </div>
        )}

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
