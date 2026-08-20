'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Game, GAME_CAPABILITIES, GAME_LABELS, GameCapabilities, isGame,
  parseTerrariaConfig, terrariaSupportsMods,
} from '@mc-manager/shared';
import { useAuth } from '@/context/AuthContext';
import { useUIPrefs } from '@/context/UIPrefsContext';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import AdvancedModeToggle, { AdvancedBadge, AdvancedOnly } from '@/components/common/AdvancedModeToggle';
import { ConsoleViewer } from '@/components/servers/ConsoleViewer';
import { FileExplorer } from '@/components/servers/FileExplorer';
import { ServerPermissionsModal } from '@/components/servers/ServerPermissionsModal';
import AnalyticsWidget from '@/components/servers/AnalyticsWidget';
import PlayersTab from '@/components/servers/PlayersTab';
import WhitelistTab from '@/components/servers/WhitelistTab';
import BanListTab from '@/components/servers/BanListTab';
import FlatBanListTab from '@/components/servers/FlatBanListTab';
import MapTab from '@/components/servers/MapTab';
import SleepTab from '@/components/servers/SleepTab';
import PropertiesTab from '@/components/servers/PropertiesTab';
import TerrariaSettingsTab from '@/components/servers/TerrariaSettingsTab';
import TerrariaModsTab from '@/components/servers/TerrariaModsTab';
import BackupsTab from '@/components/servers/BackupsTab';
import SubdomainTab from '@/components/servers/SubdomainTab';
import UpdateCenterTab from '@/components/servers/UpdateCenterTab';
import { SchedulesTab } from '@/components/servers/SchedulesTab';
import ModBrowserTab from '@/components/servers/ModBrowserTab';
import PackHealthTab from '@/components/servers/PackHealthTab';
import IntegrationsTab from '@/components/servers/IntegrationsTab';
import ResourcesTab from '@/components/servers/ResourcesTab';
import BroadcastBar from '@/components/servers/BroadcastBar';
import ResourceHistoryChart from '@/components/servers/ResourceHistoryChart';
import ExportImportCard from '@/components/servers/ExportImportCard';
import CrashAnalysisModal from '@/components/servers/CrashAnalysisModal';

interface ServerDetail {
  id: string;
  name: string;
  description?: string;
  nodeId: string;
  containerId?: string;
  status: string;
  /** Absent on a response from an older panel build; absent means Minecraft. */
  game?: string;
  gameConfig?: Record<string, unknown> | null;
  serverType: string;
  mcVersion: string;
  serverPort: number;
  memoryMb: number;
  cpuLimit: number;
  modpackSlug?: string;
  eulaAccepted: boolean;
  suspendedAt?: string | null;
  suspendedReason?: string | null;
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
 *
 * Three optional fields make a tab game-aware, and all three are **additive**: a tab with none
 * of them behaves exactly as it did before any of this existed.
 *
 *  - `requires`   — the capability flag that must be true for this tab to appear at all.
 *  - `labelByGame` / `hintByGame` — per-game copy overrides. When a game has no override the
 *    tab falls through to `label`/`hint`, which is why every Minecraft string below is
 *    untouched and cannot drift.
 */
const TABS = [
  { key: 'console', label: 'Console', advanced: false, hint: 'Live server output, connection details and performance at a glance.' },
  {
    key: 'players', label: 'Players', advanced: false, hint: 'See who is online, and op, kick or message them.',
    requires: 'players',
    // Terraria has no op system and identifies players by name only — no UUID analogue.
    hintByGame: { TERRARIA: 'See who is currently connected to your world.' },
  },
  { key: 'whitelist', label: 'Whitelist', advanced: false, hint: 'Control exactly which accounts are allowed to join.', requires: 'whitelist' },
  {
    key: 'bans', label: 'Bans', advanced: false, hint: 'Review and lift bans on players and IP addresses.',
    requires: 'bans',
    hintByGame: { TERRARIA: 'Review and lift bans. Terraria reads its ban list when the server starts.' },
  },
  { key: 'mods', label: 'Mods', advanced: false, hint: 'Search Modrinth and install or remove mods for this server.', requires: 'mods' },
  { key: 'integrations', label: 'Integrations', advanced: false, hint: 'Dedicated setup for popular mods and plugins like Simple Voice Chat, Geyser, and LuckPerms.', requires: 'mods' },
  {
    key: 'tmods', label: 'Mods', advanced: false,
    hint: 'Upload .tmod files and choose which ones this server loads.',
    requires: 'tmodMods',
  },
  {
    key: 'backups', label: 'Backups', advanced: false, hint: 'Take a snapshot before risky changes, and restore one if something breaks.',
    labelByGame: { TERRARIA: 'World Backups' },
    hintByGame: { TERRARIA: 'Take a snapshot of your world before risky changes, and restore one if something breaks.' },
  },
  {
    key: 'properties', label: 'Settings', advanced: false, hint: 'Game rules from server.properties — difficulty, MOTD, view distance and more.',
    requires: 'configFile',
    labelByGame: { TERRARIA: 'World Settings' },
    hintByGame: { TERRARIA: 'Game rules from serverconfig.txt — difficulty, max players, password and more.' },
  },
  { key: 'resources', label: 'Resources', advanced: false, hint: 'Change how much RAM and CPU this server may use, within your quota.' },
  { key: 'map', label: 'World Map', advanced: false, hint: 'Browse a live rendered map of your world in the browser.', requires: 'worldMap' },

  { key: 'pack-health', label: 'Pack Health', advanced: true, hint: 'Which mods the installer disabled and why, plus any dependency a mod needs but the pack never shipped.', requires: 'packHealth' },
  { key: 'update', label: 'Update Centre', advanced: true, hint: 'Change the Minecraft or mod-loader version. Back up first — version jumps can break worlds.', requires: 'updateEngine' },
  { key: 'schedules', label: 'Schedules', advanced: true, hint: 'Run restarts, backups and commands automatically on a timetable.' },
  { key: 'sleep', label: 'Sleep & Wake', advanced: true, hint: 'Idle the server to free resources and wake it automatically when a player connects.', requires: 'sleepWake' },
  { key: 'domain', label: 'Domain', advanced: true, hint: 'Point a custom domain or subdomain at this server instead of an IP and port.', requires: 'subdomain' },
  { key: 'files', label: 'Files', advanced: true, hint: 'Direct access to the server directory. Editing the wrong file here can stop the server booting.' },
] as const;

type TabKey = typeof TABS[number]['key'];
type TabDef = typeof TABS[number];

/**
 * A tab with no `requires` is game-neutral and always shows. Otherwise the capability
 * decides — `configFile` is a filename rather than a boolean, so truthiness is the test.
 */
function tabIsSupported(tab: TabDef, caps: GameCapabilities, modsUsable: boolean): boolean {
  const requires = (tab as { requires?: keyof GameCapabilities }).requires;
  if (!requires) return true;
  /*
   * `tmodMods` is the only capability that is not settled by the game alone. Terraria has
   * a mod system, but only a tModLoader server can load anything — vanilla ignores a Mods
   * folder rather than rejecting it, so the tab would be one where every upload silently
   * does nothing.
   */
  if (requires === 'tmodMods') return Boolean(caps.tmodMods) && modsUsable;
  return Boolean(caps[requires]);
}

function tabLabel(tab: TabDef, game: Game): string {
  return (tab as { labelByGame?: Partial<Record<Game, string>> }).labelByGame?.[game] ?? tab.label;
}

function tabHint(tab: TabDef, game: Game): string {
  return (tab as { hintByGame?: Partial<Record<Game, string>> }).hintByGame?.[game] ?? tab.hint;
}

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
  const [showCrashAnalysis, setShowCrashAnalysis] = useState(false);
  // A crashed server keeps reporting ERROR on every poll, so the diagnosis is offered
  // automatically only the first time it is seen — after that it stays a button.
  const crashAutoOffered = useRef(false);

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

  // Absent means Minecraft, so a server row written before the column existed — or fetched
  // from an older API — keeps every tab it has today.
  const serverGame: Game = isGame(server?.game) ? server.game : Game.MINECRAFT;
  const capabilities = GAME_CAPABILITIES[serverGame];

  // Capability filtering runs first and is not overridable: a tab the game cannot support has
  // nothing behind it, so unlike `advanced` it must not be reachable by direct link either.
  // Terraria only; parseTerrariaConfig defaults an absent or foreign config to VANILLA,
  // which is the safe reading — a Minecraft server must never grow a .tmod tab.
  const tmodUsable =
    serverGame === Game.TERRARIA && terrariaSupportsMods(parseTerrariaConfig(server?.gameConfig).variant);

  const supportedTabs = TABS.filter((t) => tabIsSupported(t, capabilities, tmodUsable));

  // A tab reached by direct link stays reachable even in simple mode, rather than vanishing mid-visit.
  const visibleTabs = supportedTabs.filter((t) => !t.advanced || advanced || t.key === activeTab);
  const currentTab = supportedTabs.find((t) => t.key === activeTab);
  const hiddenCount = supportedTabs.filter((t) => t.advanced).length;
  const hiddenToolNames = supportedTabs
    .filter((t) => t.advanced)
    .map((t) => tabLabel(t, serverGame).toLowerCase())
    .join(', ');

  // `?tab=mods` on a Terraria server points at a tab that cannot exist. Fall back to Console
  // rather than rendering a tab bar with nothing selected and an empty body.
  useEffect(() => {
    if (!server) return;
    if (!supportedTabs.some((t) => t.key === activeTab)) setActiveTab('console');
  }, [server, activeTab, supportedTabs]);

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

  // A server's status is settled by the monitor tick well after the action call returns,
  // so a start left the badge stuck on STARTING until the page was reloaded. Poll for it
  // here the way the dashboard list does, merging only the fields the node owns so an
  // in-flight rename or icon upload isn't overwritten by a stale read.
  useEffect(() => {
    if (!serverId) return;

    let cancelled = false;

    const pollStatus = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/servers/${serverId}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled || !data.server) return;
        setServer((prev) =>
          prev
            ? { ...prev, status: data.server.status, containerId: data.server.containerId }
            : data.server
        );
      } catch {
        // A dropped poll is not worth surfacing — the next tick retries.
      }
    };

    const id = setInterval(pollStatus, 5000);
    document.addEventListener('visibilitychange', pollStatus);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', pollStatus);
    };
  }, [serverId]);

  useEffect(() => {
    if (server?.status === 'ERROR' && !crashAutoOffered.current) {
      crashAutoOffered.current = true;
      setShowCrashAnalysis(true);
    }
  }, [server?.status]);

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

  /**
   * Suspending is the reversible alternative to deleting: nothing is removed, the server just
   * cannot be started until an admin lifts it. Global admins only.
   */
  const handleSuspension = async (suspend: boolean) => {
    let reason = '';
    if (suspend) {
      const ok = await confirm({
        title: `Suspend ${server?.name}?`,
        message:
          'The server is stopped if it is running and cannot be started again until the suspension is lifted. ' +
          'Its world, files and backups are left exactly as they are.',
        confirmLabel: 'Suspend server',
        danger: true,
      });
      if (!ok) return;
      reason = window.prompt('Reason shown to the owner (optional):') || '';
    }

    setActionLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/suspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suspended: suspend, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      toast.success(suspend ? 'Server suspended' : 'Suspension lifted', data.message);
      await fetchServerDetails();
    } catch (err: any) {
      toast.error('Could not change the suspension', err?.message);
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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>
        Loading your server…
      </div>
    );
  }

  if (error || !server) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px', fontFamily: 'var(--font-ui)' }}>
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
    <div style={{ minHeight: '100vh', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column' }}>

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
          {user?.globalRole === 'GLOBAL_ADMIN' && advanced && !server.suspendedAt && (
            <button
              onClick={() => handleSuspension(true)}
              disabled={actionLoading}
              title="Stop this server and block it from starting, without deleting anything"
              className="cc-btn-ghost"
            >
              Suspend
            </button>
          )}
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
              disabled={actionLoading || !!server.suspendedAt}
              title={server.suspendedAt ? 'This server is suspended and cannot be started' : undefined}
              className="cc-btn-primary"
              style={{ padding: '6px 18px' }}
            >
              ▶ Start Server
            </button>
          )}
        </div>
      </header>

      {/* A suspended server still shows every tab — the point of a suspension is that nothing is
          lost — but the reason has to be impossible to miss, and only an admin can lift it. */}
      {server.suspendedAt && (
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
            background: 'rgba(248,81,73,0.10)', borderBottom: '1px solid rgba(248,81,73,0.25)',
            padding: '10px 16px', color: 'var(--danger)', fontSize: '0.8125rem', fontWeight: 600,
          }}
        >
          <span>
            This server is suspended and cannot be started.
            {server.suspendedReason ? ` Reason: ${server.suspendedReason}` : ''}
          </span>
          {user?.globalRole === 'GLOBAL_ADMIN' && (
            <button onClick={() => handleSuspension(false)} className="cc-btn-ghost" disabled={actionLoading}>
              Lift suspension
            </button>
          )}
        </div>
      )}

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
                  title={tabHint(tab, serverGame)}
                  className={`cc-tab${activeTab === tab.key ? ' cc-tab-active' : ''}`}
                >
                  {tabLabel(tab, serverGame)}
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
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{tabHint(currentTab, serverGame)}</span>
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
                  {/* serverType and mcVersion are Minecraft-only columns; on another game's
                      row they hold defaults that would read as a real engine and version. */}
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                    {serverGame === Game.MINECRAFT
                      ? <>{server.serverType} {server.mcVersion}</>
                      : GAME_LABELS[serverGame]}
                  </div>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Server is {server.status.toLowerCase()} — press <strong style={{ color: 'var(--accent)' }}>Start Server</strong> above to let players in.
                  </div>
                  <button
                    onClick={() => setShowCrashAnalysis(true)}
                    className={server.status === 'ERROR' ? 'cc-btn-primary' : 'cc-btn-ghost'}
                    title="Read the server log and explain why it stopped"
                  >
                    Diagnose
                  </button>
                </div>
              )}
            </div>

            {/* A crashed server gets an unmissable prompt rather than a quiet status badge. */}
            {server.status === 'ERROR' && (
              <div
                style={{
                  background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.25)', borderRadius: '10px',
                  padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: '12px', flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: '220px', flex: 1 }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 800, color: 'var(--danger)', marginBottom: '4px' }}>
                    This server stopped unexpectedly
                  </div>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
                    The crash analyser reads the log and the crash report, names the cause in plain language, and offers the
                    fixes that apply to it.
                  </p>
                </div>
                <button onClick={() => setShowCrashAnalysis(true)} className="cc-btn-primary" style={{ flexShrink: 0 }}>
                  Analyse the crash
                </button>
              </div>
            )}

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
                commandHint={
                  serverGame === Game.TERRARIA
                    ? "Type command (e.g. say hello, playing, exit)..."
                    : undefined
                }
              />
            </div>

            {/* Everything below is expert territory — hidden unless the user asks for it. */}
            <AdvancedOnly hint="Resource history, node migration and full server export live in advanced mode.">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <ResourceHistoryChart serverId={server.id} memoryLimitMb={server.memoryMb} />

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

        {activeTab === 'players' && <PlayersTab serverId={server.id} canManage={canManage} game={serverGame} />}
        {activeTab === 'whitelist' && (
          <div className="animate-fadeIn"><WhitelistTab serverId={server.id} canManage={canManage} /></div>
        )}
        {activeTab === 'bans' && (
          <div className="animate-fadeIn">
            {/* A flat-file ban list gets the line editor; Minecraft keeps its structured one. */}
            {capabilities.banFile
              ? <FlatBanListTab serverId={server.id} canManage={canManage} />
              : <BanListTab serverId={server.id} canManage={canManage} />}
          </div>
        )}
        {activeTab === 'properties' && (
          serverGame === Game.TERRARIA
            ? <TerrariaSettingsTab
                serverId={server.id}
                canManage={canManage}
                variant={parseTerrariaConfig(server.gameConfig).variant}
                serverStatus={server.status}
                onVariantChanged={fetchServerDetails}
              />
            : <PropertiesTab serverId={server.id} canManage={canManage} />
        )}
        {activeTab === 'resources' && <ResourcesTab serverId={server.id} onResized={fetchServerDetails} />}
        {activeTab === 'pack-health' && (
          <div className="animate-fadeIn"><PackHealthTab serverId={server.id} canManage={canManage} /></div>
        )}
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

        {activeTab === 'tmods' && (
          <TerrariaModsTab serverId={server.id} serverName={server.name} canManage={canManage} />
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
            {/* Minecraft keeps its hand-written phrasing verbatim; any other game gets the list
                derived from the tabs it actually has, since naming Minecraft-only tools there
                would be describing features the server does not have. */}
            {serverGame === Game.MINECRAFT ? (
              <span>{hiddenCount} more tools — updates, schedules, sleep, custom domains and file access — are hidden to keep things simple.</span>
            ) : (
              <span>{hiddenCount} more tools — {hiddenToolNames} — are hidden to keep things simple.</span>
            )}
          </div>
        )}

        <ServerPermissionsModal
          serverId={server.id}
          serverName={server.name}
          isOpen={showPermissionsModal}
          onClose={() => setShowPermissionsModal(false)}
          canTransfer={userRole === 'OWNER' || userRole === 'GLOBAL_ADMIN'}
          onTransferred={fetchServerDetails}
        />

        {showCrashAnalysis && (
          <CrashAnalysisModal
            serverId={server.id}
            serverName={server.name}
            canManage={canManage}
            onClose={() => setShowCrashAnalysis(false)}
            onNavigateTab={(tab) => {
              if (TABS.some((t) => t.key === tab)) setActiveTab(tab as TabKey);
            }}
            onServerChanged={fetchServerDetails}
          />
        )}
      </main>
    </div>
  );
}
