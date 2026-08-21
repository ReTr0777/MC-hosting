'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Game, GAME_LABELS, ALL_GAMES, isGame,
  daemonVersionState, MIN_SUPPORTED_DAEMON_VERSION,
} from '@mc-manager/shared';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import DashboardSidebar, { SidebarNode } from '@/components/common/DashboardSidebar';
import NodeBackupStorageModal from '@/components/admin/NodeBackupStorageModal';

/**
 * Everything about one node, in the one place that can hold it.
 *
 * Node management used to be four unlabelled icon buttons in the corner of a card in the
 * dashboard's left rail, visible only in advanced mode, and the only thing the panel
 * would tell you about a node's contents was a count of servers. That is enough to place
 * the next server and not enough to answer any of the questions that actually come up:
 * what breaks if I restart this, why does it say offline when it plainly is not, and how
 * do I stop it taking new work while I update it.
 */

interface NodeServer {
  id: string;
  name: string;
  status: string;
  game: string | null;
  memoryMb: number;
  cpuLimit: number;
  serverPort: number;
  serverType: string;
  mcVersion: string | null;
}

interface NodeCapacity {
  allocatedMemoryMb: number;
  memoryBudgetMb: number | null;
  freeMemoryMb: number | null;
  allocatedCpu: number;
  cpuBudget: number | null;
  overcommitRatio: number;
  cpuOvercommitRatio: number;
}

interface NodeDetail {
  id: string;
  /** Null for a node the installation runs; set when a user enrolled their own machine. */
  ownerId: string | null;
  name: string;
  host: string;
  port: number;
  isOnline: boolean;
  totalMemory: number;
  totalCpu: number;
  offloadPriority: number;
  overcommitRatio: number;
  cpuOvercommitRatio: number;
  enabledGames: string[];
  drainedAt: string | null;
  liveCpuUsage: number | null;
  liveRamUsed: number | null;
  liveRamTotal: number | null;
  liveDiskUsed: number | null;
  liveDiskTotal: number | null;
  liveCpuModel: string | null;
  liveCpuCores: number | null;
  liveOsDistro: string | null;
  liveCpuTemp: number | null;
  liveJavaMajor: number | null;
  liveDataDiskFreeMb: number | null;
  liveDaemonVersion: string | null;
  liveLastSeenAt: string | null;
  createdAt: string;
  servers: NodeServer[];
  serverCount: number;
  capacity: NodeCapacity | null;
}

type Level = 'ok' | 'warn' | 'fail' | 'unknown';

interface Check {
  id: string;
  label: string;
  level: Level;
  detail: string;
  remedy?: string;
}

interface Diagnostics {
  ranAt: string;
  summary: Level;
  latencyMs: number | null;
  checks: Check[];
}

const LEVEL_COLOR: Record<Level, string> = {
  ok: 'var(--accent)',
  warn: 'var(--warning)',
  fail: 'var(--danger)',
  unknown: 'var(--text-muted)',
};

const LEVEL_GLYPH: Record<Level, string> = { ok: '✓', warn: '!', fail: '✕', unknown: '?' };

const STATUS_CLASS: Record<string, string> = {
  RUNNING: 'cc-badge-running',
  STARTING: 'cc-badge-starting',
  RESTARTING: 'cc-badge-starting',
  ERROR: 'cc-badge-error',
};

export default function NodeDetailPage() {
  const params = useParams();
  const router = useRouter();
  const nodeId = String(params?.id ?? '');
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const isAdmin = user?.globalRole === 'GLOBAL_ADMIN';

  const [node, setNode] = useState<NodeDetail | null>(null);
  const [allNodes, setAllNodes] = useState<SidebarNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [showBackupStorage, setShowBackupStorage] = useState(false);
  const [savingGames, setSavingGames] = useState(false);

  // ── Settings form ──
  const [form, setForm] = useState({
    name: '', host: '', port: 3500, apiKey: '',
    offloadPriority: 0, totalMemory: '', totalCpu: '',
    overcommitRatio: '1', cpuOvercommitRatio: '4',
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    try {
      const [nodeRes, listRes] = await Promise.all([
        fetch(`/api/nodes/${nodeId}`, { cache: 'no-store' }),
        fetch('/api/nodes', { cache: 'no-store' }),
      ]);

      if (nodeRes.status === 404) {
        setNotFound(true);
        return;
      }
      if (!nodeRes.ok) throw new Error((await nodeRes.json().catch(() => ({}))).error || 'Failed to load node');

      const { node: fetched } = await nodeRes.json();
      setNode(fetched);
      /*
       * The form is seeded from the server only while it is untouched. Reseeding on every
       * poll would overwrite whatever the operator was halfway through typing, which is
       * exactly what a five-second refresh would do to a field being edited.
       */
      setForm((prev) =>
        prev.name === ''
          ? {
              name: fetched.name,
              host: fetched.host,
              port: fetched.port,
              apiKey: '',
              offloadPriority: fetched.offloadPriority,
              totalMemory: String(fetched.totalMemory ?? ''),
              totalCpu: String(fetched.totalCpu ?? ''),
              overcommitRatio: String(fetched.overcommitRatio ?? 1),
              cpuOvercommitRatio: String(fetched.cpuOvercommitRatio ?? 4),
            }
          : prev
      );

      if (listRes.ok) setAllNodes((await listRes.json()).nodes ?? []);
    } catch (err: any) {
      toast.error('Could not load the node', err.message);
    } finally {
      setLoading(false);
    }
  }, [nodeId, toast]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const enabledGames = useMemo<Game[]>(
    () => (node?.enabledGames ?? []).filter(isGame),
    [node]
  );

  const runDiagnostics = async () => {
    setDiagnosing(true);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/diagnostics`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Diagnostics failed');
      setDiagnostics(data);
    } catch (err: any) {
      toast.error('Could not run diagnostics', err.message);
    } finally {
      setDiagnosing(false);
    }
  };

  /**
   * Asks the panel to look for this node at every address it has offered.
   *
   * The recovery for a node registered at an address that has stopped being right — a new
   * DHCP lease, a firewall opened after the fact, a laptop on a different network. Without
   * it the only fix was deleting the node and enrolling it again.
   */
  const recheckAddress = async () => {
    setRechecking(true);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/recheck`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not reach the node');
      toast.success(data.moved ? 'Node found at a new address' : 'Node answered', data.message);
      load();
    } catch (err: any) {
      toast.error('Still no answer', err.message);
    } finally {
      setRechecking(false);
    }
  };

  const toggleGame = async (game: Game) => {
    if (!node) return;

    const next = enabledGames.includes(game)
      ? enabledGames.filter((g) => g !== game)
      : [...enabledGames, game];

    if (next.length === 0) {
      toast.error('A node has to host something', 'Enable another game before turning this one off.');
      return;
    }

    /*
     * Servers already here are not moved or stopped by this — disabling a game only stops
     * new ones being placed. Saying so up front matters: "disable Minecraft" reads like it
     * will take the Minecraft servers down with it, and it does not.
     */
    const stranded = node.servers.filter((s) => isGame(s.game) && !next.includes(s.game));
    if (stranded.length > 0) {
      const ok = await confirm({
        title: `Stop hosting ${GAME_LABELS[game]} on ${node.name}?`,
        message: `${stranded.length} server${stranded.length === 1 ? '' : 's'} here run games this node would no longer advertise. They keep running and keep their data — but none of them could be recreated on this node, and no new one can be placed here.`,
        confirmLabel: 'Turn it off',
      });
      if (!ok) return;
    }

    setSavingGames(true);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/games`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledGames: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');

      toast.success('Games updated', `${node.name} now hosts ${next.map((g) => GAME_LABELS[g]).join(' and ')}.`);
      load();
    } catch (err: any) {
      toast.error('Could not change what this node hosts', err.message);
    } finally {
      setSavingGames(false);
    }
  };

  const toggleDrain = async () => {
    if (!node) return;
    const draining = !!node.drainedAt;

    if (!draining) {
      const ok = await confirm({
        title: `Put ${node.name} into maintenance mode?`,
        message:
          'Nothing on this node stops. Its servers keep running and players keep playing — the node simply ' +
          'stops being given new ones, so you can update or restart it knowing nothing new landed while you worked.',
        confirmLabel: 'Start maintenance',
      });
      if (!ok) return;
    }

    try {
      const res = await fetch(`/api/nodes/${nodeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drained: !draining }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');

      toast.success(
        draining ? 'Maintenance mode off' : 'Maintenance mode on',
        draining ? `${node.name} is taking new servers again.` : `${node.name} will not be given new servers.`
      );
      load();
    } catch (err: any) {
      toast.error('Could not change maintenance mode', err.message);
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      const payload: any = {
        name: form.name,
        host: form.host,
        port: form.port,
      };
      // Scheduling knobs are a fleet-wide judgement and the API refuses them from anyone
      // else, so an owner saving their own machine must not send them at all.
      if (isAdmin) {
        payload.offloadPriority = form.offloadPriority;
        payload.overcommitRatio = form.overcommitRatio;
        payload.cpuOvercommitRatio = form.cpuOvercommitRatio;
      }
      if (form.totalMemory !== '') payload.totalMemory = Number(form.totalMemory);
      if (form.totalCpu !== '') payload.totalCpu = Number(form.totalCpu);
      // Blank means "leave the stored key alone" — the form never shows the current one.
      if (form.apiKey) payload.apiKey = form.apiKey;

      const res = await fetch(`/api/nodes/${nodeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');

      toast.success('Node updated', `${form.name} saved.`);
      setForm((p) => ({ ...p, apiKey: '' }));
      load();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const exportConfig = async () => {
    if (!node) return;
    try {
      const res = await fetch(`/api/nodes/${node.id}/config`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${node.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'node'}-node-config.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast.success(
        'Config exported',
        `Import it in the MC Hosting Node app on ${node.name}. It contains the daemon key — share it privately.`
      );
    } catch (err: any) {
      toast.error('Could not export the config', err.message);
    }
  };

  const deleteNode = async () => {
    if (!node) return;
    const ok = await confirm({
      title: `Remove the node "${node.name}"?`,
      message:
        node.serverCount > 0
          ? `This node still hosts ${node.serverCount} server(s). Removing it unregisters the machine from the panel — move those servers to another node first if you still need them.`
          : 'This unregisters the machine from the panel. The daemon itself keeps running and can be re-added later.',
      confirmLabel: 'Remove node',
      danger: true,
      requireText: node.name,
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/nodes/${node.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete node');

      toast.success('Node removed', `${node.name} is no longer registered.`);
      router.push('/dashboard');
    } catch (err: any) {
      toast.error('Could not remove the node', err.message);
    }
  };

  if (loading) {
    return <Shell nodes={allNodes} nodeId={nodeId} isAdmin={!!isAdmin}><Muted>Loading…</Muted></Shell>;
  }
  if (notFound || !node) {
    return (
      <Shell nodes={allNodes} nodeId={nodeId} isAdmin={!!isAdmin}>
        <Muted>
          That node is not registered. It may have been removed —{' '}
          <Link href="/dashboard" style={{ color: 'var(--accent)' }}>back to the dashboard</Link>.
        </Muted>
      </Shell>
    );
  }

  const draining = !!node.drainedAt;
  /*
   * Whoever enrolled this machine administers it: it is their hardware, and telling them
   * to open a ticket to rename their own PC or take it out of service is what made
   * self-hosting unusable. The scheduling knobs stay an admin's, and so does the whole of
   * the shared fleet.
   */
  const isOwner = !!node.ownerId && node.ownerId === user?.id;
  const canManage = isAdmin || isOwner;
  const ramTotal = node.liveRamTotal ?? node.totalMemory ?? 0;
  const ramPct = ramTotal > 0 ? Math.round(((node.liveRamUsed ?? 0) / ramTotal) * 100) : null;
  const diskPct =
    node.liveDiskTotal && node.liveDiskTotal > 0
      ? Math.round(((node.liveDiskUsed ?? 0) / node.liveDiskTotal) * 100)
      : null;

  return (
    <Shell nodes={allNodes} nodeId={nodeId} isAdmin={!!isAdmin}>
      {/* ── Identity ── */}
      <div style={{ marginBottom: '20px' }}>
        <Link href="/dashboard" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textDecoration: 'none' }}>
          &lsaquo; Nodes &amp; servers
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '6px' }}>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>{node.name}</h1>
          <span className={node.isOnline ? 'cc-badge-online' : 'cc-badge-offline'}>
            {node.isOnline ? 'Online' : 'Offline'}
          </span>
          {draining && <span className="cc-chip cc-chip-warning">Maintenance</span>}
          <NodeVersionBadge version={node.liveDaemonVersion} />
        </div>
        <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: '4px' }}>
          {node.host}:{node.port}
          {node.liveOsDistro ? ` · ${node.liveOsDistro}` : ''}
          {node.liveCpuModel ? ` · ${node.liveCpuModel}` : ''}
          {node.liveCpuCores ? ` (${node.liveCpuCores}C)` : ''}
        </div>
      </div>

      {/* ── Live load ── */}
      <Section title="Live load">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
          <Meter label="CPU" pct={node.liveCpuUsage != null ? Math.round(node.liveCpuUsage) : null}
                 value={node.liveCpuUsage != null ? `${node.liveCpuUsage.toFixed(1)}%${node.liveCpuTemp ? ` · ${node.liveCpuTemp}°C` : ''}` : '—'} />
          <Meter label="Memory" pct={ramPct}
                 value={ramTotal > 0 ? `${((node.liveRamUsed ?? 0) / 1024).toFixed(1)} / ${(ramTotal / 1024).toFixed(1)} GB` : '—'} />
          <Meter label="Disk" pct={diskPct}
                 value={node.liveDiskTotal ? `${(node.liveDiskUsed ?? 0).toFixed(0)} / ${node.liveDiskTotal.toFixed(0)} GB` : '—'} />
          {node.capacity?.memoryBudgetMb != null && (
            <Meter
              label="Allocated"
              pct={Math.round((node.capacity.allocatedMemoryMb / node.capacity.memoryBudgetMb) * 100)}
              value={`${(node.capacity.allocatedMemoryMb / 1024).toFixed(1)} / ${(node.capacity.memoryBudgetMb / 1024).toFixed(1)} GB`}
              hint={
                node.capacity.overcommitRatio > 1
                  ? `${node.capacity.overcommitRatio}× overcommit — promised, not in use`
                  : 'Promised to servers, running or not'
              }
            />
          )}
        </div>
        {node.liveDataDiskFreeMb != null && (
          <p className="cc-help" style={{ marginTop: '10px' }}>
            {(node.liveDataDiskFreeMb / 1024).toFixed(1)} GB free on the disk this node writes worlds to
            {node.liveJavaMajor != null ? ` · Java ${node.liveJavaMajor}` : ''}
            {node.liveLastSeenAt ? ` · last seen ${new Date(node.liveLastSeenAt).toLocaleTimeString()}` : ''}
          </p>
        )}
      </Section>

      {/* ── Servers on this node ── */}
      <Section title={`Servers on this node (${node.serverCount})`}>
        {node.servers.length === 0 ? (
          <Muted>
            {node.serverCount > 0
              ? `${node.serverCount} server(s) run here, none of which you have access to.`
              : 'Nothing runs on this node yet.'}
          </Muted>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', background: 'var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
            {node.servers.map((s) => (
              <Link
                key={s.id}
                href={`/dashboard/servers/${s.id}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                  padding: '10px 12px', background: 'var(--surface)', textDecoration: 'none',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: '0.8125rem', color: 'var(--text-primary)', flex: 1, minWidth: '140px' }}>
                  {s.name}
                </span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  :{s.serverPort}
                </span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  {(s.memoryMb / 1024).toFixed(1)} GB
                </span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  {isGame(s.game) ? GAME_LABELS[s.game] : s.serverType}
                  {s.mcVersion ? ` ${s.mcVersion}` : ''}
                </span>
                <span className={STATUS_CLASS[s.status] ?? 'cc-badge-offline'}>{s.status}</span>
              </Link>
            ))}
          </div>
        )}
      </Section>

      {/* ── Games ── */}
      <Section
        title="Games this node hosts"
        hint="Written to the node itself, not just recorded here — the panel reads this back from the node on every health check."
      >
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {ALL_GAMES.map((game) => {
            const on = enabledGames.includes(game);
            return (
              <button
                key={game}
                disabled={!canManage || savingGames}
                onClick={() => toggleGame(game)}
                className={on ? 'cc-btn-primary' : 'cc-btn-ghost'}
                style={{ opacity: !canManage || savingGames ? 0.5 : 1, cursor: canManage ? 'pointer' : 'not-allowed' }}
              >
                {on ? '✓ ' : ''}{GAME_LABELS[game]}
              </button>
            );
          })}
        </div>
        {!canManage && <p className="cc-help" style={{ marginTop: '8px' }}>Only an admin can change this.</p>}
      </Section>

      {/* ── Diagnostics ── */}
      {canManage && (
        <Section
          title="Diagnostics"
          hint="Offline is one bit, and a dead daemon, a wrong port and a rotated key all look identical from outside. This tells them apart."
        >
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button onClick={runDiagnostics} disabled={diagnosing} className="cc-btn-ghost">
              {diagnosing ? 'Checking…' : 'Run checks'}
            </button>
            <button onClick={recheckAddress} disabled={rechecking} className="cc-btn-ghost">
              {rechecking ? 'Looking…' : 'Find this node again'}
            </button>
          </div>
          <p className="cc-help" style={{ marginTop: '8px' }}>
            <strong>Find this node again</strong> re-probes every address the machine reported when it
            joined and re-registers it wherever it answers — the fix when its address has changed, or
            when a firewall was blocking the panel and no longer is.
          </p>

          {diagnostics && (
            <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {diagnostics.checks.map((check, i) => (
                <div
                  key={`${check.id}-${i}`}
                  style={{
                    display: 'flex', gap: '10px', padding: '10px 12px',
                    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '7px',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.65rem', fontWeight: 800,
                      color: LEVEL_COLOR[check.level],
                      border: `1px solid ${LEVEL_COLOR[check.level]}`,
                    }}
                  >
                    {LEVEL_GLYPH[check.level]}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {check.label}
                      <span className="sr-only"> — {check.level}</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.5 }}>
                      {check.detail}
                    </div>
                    {check.remedy && (
                      <div style={{ fontSize: '0.72rem', color: LEVEL_COLOR[check.level], marginTop: '5px', lineHeight: 1.5 }}>
                        {check.remedy}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <p className="cc-help">Checked {new Date(diagnostics.ranAt).toLocaleTimeString()}.</p>
            </div>
          )}
        </Section>
      )}

      {/* ── Maintenance ── */}
      {canManage && (
        <Section
          title="Maintenance mode"
          hint="Takes the node out of the scheduler without touching anything running on it."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button onClick={toggleDrain} className={draining ? 'cc-btn-primary' : 'cc-btn-warning'}>
              {draining ? 'End maintenance' : 'Start maintenance'}
            </button>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {draining
                ? `Taking no new servers since ${new Date(node.drainedAt!).toLocaleString()}.`
                : 'Currently accepting new servers.'}
            </span>
          </div>
          {draining && (
            <p className="cc-help" style={{ marginTop: '8px' }}>
              Recreating the daemon container restarts every server on this node. Maintenance mode
              stops new ones arriving mid-update; it does not protect the ones already here.
            </p>
          )}
        </Section>
      )}

      {/* ── Settings ── */}
      {canManage && (
        <Section title="Settings">
          {formError && (
            <div style={{ marginBottom: '14px', fontSize: '0.75rem', color: 'var(--danger)', background: 'rgba(248,81,73,0.08)', padding: '10px 12px', borderRadius: '6px' }}>
              {formError}
            </div>
          )}
          <form onSubmit={saveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '520px' }}>
            <Field label="Node name">
              <input className="cc-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '10px' }}>
              <Field label="Host IP / hostname">
                <input className="cc-input" required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              </Field>
              <Field label="Daemon port">
                <input className="cc-input" type="number" required value={form.port} onChange={(e) => setForm({ ...form, port: parseInt(e.target.value, 10) })} />
              </Field>
            </div>

            <Field label="Daemon API key" hint="Leave blank to keep the current key. Note that the node's config.json overrides its DAEMON_API_KEY environment variable.">
              <input className="cc-input" type="password" placeholder="Leave blank to keep current key" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
            </Field>

            {isAdmin && (
              <Field label="Smart offload priority (0–10)" hint="0 = main server, 10 = offload here first.">
                <input className="cc-input" type="number" min="0" max="10" value={form.offloadPriority} onChange={(e) => setForm({ ...form, offloadPriority: parseInt(e.target.value, 10) || 0 })} />
              </Field>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <Field label="Total memory (MB)">
                <input className="cc-input" type="number" min="0" value={form.totalMemory} onChange={(e) => setForm({ ...form, totalMemory: e.target.value })} />
              </Field>
              <Field label="Total CPU cores">
                <input className="cc-input" type="number" min="0" value={form.totalCpu} onChange={(e) => setForm({ ...form, totalCpu: e.target.value })} />
              </Field>
            </div>
            <p className="cc-help" style={{ marginTop: '-6px' }}>
              How much this machine may hand out. Set below the real hardware to keep headroom for the
              host; 0 disables the check entirely.
              {node.liveRamTotal ? ` The node reports ${(node.liveRamTotal / 1024).toFixed(1)} GB.` : ''}
            </p>

            {isAdmin && (
              <>
                <Field label="Memory overcommit (1.0 – 4.0)" hint="How much RAM this node may promise beyond what it has. 1.0 never oversubscribes; 1.5 allows 150% allocated, usually safe because servers rarely hold their full heap at once.">
                  <input className="cc-input" type="number" step="0.1" min="1" max="4" value={form.overcommitRatio} onChange={(e) => setForm({ ...form, overcommitRatio: e.target.value })} />
                </Field>

                <Field label="CPU overcommit (1.0 – 16.0)" hint="Looser than RAM on purpose: a server's CPU limit caps bursts rather than reserving a core, and an idle or sleeping server uses almost none of it.">
                  <input className="cc-input" type="number" step="0.5" min="1" max="16" value={form.cpuOvercommitRatio} onChange={(e) => setForm({ ...form, cpuOvercommitRatio: e.target.value })} />
                </Field>
              </>
            )}

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', paddingTop: '4px' }}>
              <button type="submit" className="cc-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save settings'}
              </button>
              <button type="button" className="cc-btn-ghost" onClick={() => setShowBackupStorage(true)}>
                Off-site backups
              </button>
              {/* The export carries the daemon key in plaintext and stays admin-only, as
                  the route itself does. An owner has the key in their own node app. */}
              {isAdmin && (
                <button type="button" className="cc-btn-ghost" onClick={exportConfig}>
                  Export config
                </button>
              )}
            </div>
          </form>
        </Section>
      )}

      {/* ── Danger zone ── */}
      {canManage && (
        <Section title="Danger zone">
          <div style={{ border: '1px solid rgba(248,81,73,0.3)', borderRadius: '8px', padding: '14px' }}>
            <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Unregister this node
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.6 }}>
              Removes the machine from the panel. The daemon keeps running and the worlds on its disk are
              untouched — but the panel forgets every server recorded against it, so move anything you still
              want first.
            </p>
            <button onClick={deleteNode} className="cc-btn-danger" disabled={node.serverCount > 0}>
              Unregister node
            </button>
            {node.serverCount > 0 && (
              <p className="cc-help" style={{ marginTop: '8px' }}>
                Blocked while {node.serverCount} server{node.serverCount === 1 ? '' : 's'} still live here.
              </p>
            )}
          </div>
        </Section>
      )}

      {showBackupStorage && (
        <NodeBackupStorageModal nodeId={node.id} nodeName={node.name} onClose={() => setShowBackupStorage(false)} />
      )}
    </Shell>
  );
}

/* ── Presentational helpers ─────────────────────────────────────────────────── */

function Shell({
  children,
  nodes,
  nodeId,
  isAdmin,
}: {
  children: React.ReactNode;
  nodes: SidebarNode[];
  nodeId: string;
  isAdmin: boolean;
}) {
  return (
    <div style={{ minHeight: '100vh', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)' }}>
      <main className="flex-1 flex flex-col lg:flex-row w-full">
        <DashboardSidebar nodes={nodes} activeNodeId={nodeId} isAdmin={isAdmin} />
        <section className="flex-1 p-4 lg:p-6" style={{ maxWidth: '900px' }}>
          {children}
        </section>
      </main>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '26px' }}>
      <div className="cc-section-title" style={{ marginBottom: hint ? '4px' : '10px' }}>{title}</div>
      {hint && <p className="cc-help" style={{ marginTop: 0, marginBottom: '10px' }}>{hint}</p>}
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>
        {label}
      </label>
      {children}
      {hint && <p className="cc-help">{hint}</p>}
    </div>
  );
}

function Meter({ label, pct, value, hint }: { label: string; pct: number | null; value: string; hint?: string }) {
  const color = pct == null ? 'var(--text-muted)' : pct > 85 ? 'var(--danger)' : pct > 60 ? 'var(--warning)' : 'var(--accent)';
  return (
    <div className="cc-card" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
        <span>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ height: '4px', background: 'var(--border-2)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(pct ?? 0, 100)}%`, background: color, transition: 'width 0.5s ease' }} />
      </div>
      {hint && <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '5px' }}>{hint}</div>}
    </div>
  );
}

/**
 * The daemon's version, and whether it is old enough to matter.
 *
 * Shown next to the online badge rather than buried in diagnostics because "which build is
 * this node on" is the first question asked after every update, and having to run a check
 * to find out makes a rollout across several nodes needlessly slow.
 */
function NodeVersionBadge({ version }: { version: string | null }) {
  const state = daemonVersionState(version);
  if (state === 'current' || state === 'ahead') {
    return (
      <span className="cc-chip" title={`Daemon ${version}`}>
        v{version}
      </span>
    );
  }
  return (
    <span
      className="cc-chip cc-chip-warning"
      title={
        state === 'unknown'
          ? 'Too old to report a version. Update this node.'
          : `Running ${version}; this panel expects ${MIN_SUPPORTED_DAEMON_VERSION} or newer.`
      }
    >
      {state === 'unknown' ? 'Version unknown' : `v${version} — outdated`}
    </span>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '16px 0', lineHeight: 1.6 }}>{children}</div>;
}
