'use client';

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Game, GAME_LABELS, ALL_GAMES, DEFAULT_ENABLED_GAMES, isGame,
  TerrariaConfig, DEFAULT_TERRARIA_CONFIG, TERRARIA_MAX_PLAYERS, TERRARIA_SECRET_SEEDS, TERRARIA_WORLD_EVILS,
} from '@mc-manager/shared';
import { useAuth } from '@/context/AuthContext';
import { useUIPrefs } from '@/context/UIPrefsContext';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import AdvancedModeToggle, { AdvancedBadge } from '@/components/common/AdvancedModeToggle';
import { uploadFileInChunks } from '@/lib/utils/chunked-upload';
import GlobalSearch from '@/components/common/GlobalSearch';
import DiscordLinkButton from '@/components/account/DiscordLinkButton';
import QuotaUsageBadge from '@/components/account/QuotaUsageBadge';
import DashboardSidebar from '@/components/common/DashboardSidebar';

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
  overcommitRatio: number;
  cpuOvercommitRatio: number | null;
  /** Games the node's daemon advertises. Absent on a node that has never pinged. */
  enabledGames?: string[];
  /** Allocation totals from /api/nodes — see lib/node-capacity.ts. Null on an unknown node. */
  capacity: {
    allocatedMemoryMb: number;
    allocatedCpu: number;
    activeMemoryMb: number;
    memoryBudgetMb: number | null;
    cpuBudget: number | null;
    freeMemoryMb: number | null;
    freeCpu: number | null;
    overcommitRatio: number;
    cpuOvercommitRatio: number;
    serverCount: number;
  } | null;
  _count: { servers: number };
}

/** How much of a node's allocation budget is spoken for, 0–100+. */
function allocPct(node: NodeItem): number {
  const budget = node.capacity?.memoryBudgetMb;
  if (!budget) return 0;
  return Math.round((node.capacity!.allocatedMemoryMb / budget) * 100);
}

function allocColor(node: NodeItem): string {
  const pct = allocPct(node);
  return pct >= 100 ? '#f87171' : pct > 80 ? '#fb923c' : '#34d399';
}

interface ServerItem {
  id: string;
  name: string;
  description: string;
  status: string;
  /** Absent on a row written before the column existed; absent means Minecraft. */
  game?: string | null;
  gameConfig?: Record<string, unknown> | null;
  serverType: string;
  executionMode?: string;
  mcVersion: string;
  serverPort: number;
  memoryMb: number;
  modpackSlug?: string;
  node: { name: string; isOnline: boolean };
}

interface QuotaLimits {
  maxServers: number | null;
  maxMemoryMb: number | null;
  maxCpu: number | null;
  maxServerMemoryMb: number | null;
  maxServerCpu: number | null;
  usedServers: number;
  usedMemoryMb: number;
  usedCpu: number;
}

/**
 * The tightest ceiling that applies to one new server: the explicit per-server limit, or
 * whatever is left of the total allowance. undefined when neither limit is set.
 */
function smallestCap(perServer: number | null | undefined, total: number | null | undefined, used: number | undefined): number | undefined {
  const caps: number[] = [];
  if (perServer != null) caps.push(perServer);
  if (total != null) caps.push(Math.max(0, total - (used ?? 0)));
  return caps.length ? Math.min(...caps) : undefined;
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

/**
 * Per-game identity: a short monogram and a colour.
 *
 * The colours are hardcoded hex, following the `serverTypeMeta` precedent below —
 * these are identity marks rather than theme colours, so they stay put under every
 * palette. Both are chosen to stay legible against `--bg` and `--surface` in light
 * and dark. Introducing a `--terraria-accent` custom property instead would be
 * unsettable by a user's theme file, since THEME_TOKENS is a closed allowlist.
 */
const GAME_META: Record<Game, { short: string; color: string; blurb: string }> = {
  [Game.MINECRAFT]: { short: 'MC', color: '#4ade80', blurb: 'Survival, creative and modded worlds.' },
  [Game.TERRARIA]: { short: 'TR', color: '#38bdf8', blurb: '2D sandbox adventure. Runs light.' },
};

/** Absent means Minecraft — a row written before the column existed keeps its old identity. */
function gameOf(server: { game?: string | null }): Game {
  return isGame(server.game) ? server.game : Game.MINECRAFT;
}

/**
 * Which game a server runs, as a small identity chip.
 *
 * Built from the existing `cc-*` sizing conventions and a hardcoded identity hex,
 * not a new CSS custom property — `THEME_TOKENS` is a closed allowlist, so a
 * `--terraria-accent` would be silently dropped by `parseThemeFile` and would look
 * identical under every theme a user wrote.
 */
function GameBadge({ game }: { game: Game }) {
  const meta = GAME_META[game];
  return (
    <span
      title={`${GAME_LABELS[game]} server`}
      style={{
        flexShrink: 0,
        fontSize: '0.55rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em',
        color: meta.color,
        background: `${meta.color}18`,
        border: `1px solid ${meta.color}40`,
        borderRadius: '4px', padding: '1px 5px',
      }}
    >
      {GAME_LABELS[game]}
    </span>
  );
}

const TERRARIA_WORLD_SIZES: Array<{ value: 1 | 2 | 3; label: string; help: string }> = [
  { value: 1, label: 'Small', help: 'Fastest to generate, cosiest to explore.' },
  { value: 2, label: 'Medium', help: 'The usual choice for a few friends.' },
  { value: 3, label: 'Large', help: 'Lots of room. Takes longest to generate.' },
];

const TERRARIA_DIFFICULTIES: Array<{ value: 0 | 1 | 2 | 3; label: string; help: string }> = [
  { value: 0, label: 'Classic', help: 'The standard game.' },
  { value: 1, label: 'Expert', help: 'Tougher enemies, better loot.' },
  { value: 2, label: 'Master', help: 'Harder still.' },
  { value: 3, label: 'Journey', help: 'Creative mode.' },
];

/** Terraria's half of wizard step 1, in place of the Minecraft engine cards. */
function TerrariaWizardStep({
  config,
  onChange,
}: {
  config: TerrariaConfig;
  onChange: <K extends keyof TerrariaConfig>(key: K, value: TerrariaConfig[K]) => void;
}) {
  const [showSecret, setShowSecret] = useState(false);
  const secretCount = (config.secretSeeds ?? []).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Step 1 of 3 — Your world</label>
        <p className="cc-section-sub">
          These are baked into the world when it is first generated, so choose the size and
          difficulty now — they cannot be changed afterwards.
        </p>
      </div>

      {/* Server flavour. First, because it decides whether the server can have mods
          at all — and unlike world size, this one *can* be changed later. */}
      <div>
        <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Server type</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
          {([
            { id: 'VANILLA' as const, label: 'Vanilla', blurb: 'The game as it ships. Starts in seconds.' },
            { id: 'TMODLOADER' as const, label: 'tModLoader', blurb: 'Runs mods. Slower first start while it downloads.' },
          ]).map((v) => {
            const selected = config.variant === v.id;
            return (
              <div
                key={v.id}
                onClick={() => onChange('variant', v.id)}
                style={{
                  padding: '12px', borderRadius: '8px', cursor: 'pointer',
                  background: selected ? 'var(--accent-dim)' : 'var(--bg)',
                  border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-2)'}`,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: 'var(--text-primary)' }}>{v.label}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.4 }}>{v.blurb}</div>
              </div>
            );
          })}
        </div>
        {config.variant === 'TMODLOADER' && (
          <p className="cc-help">
            You supply the mods as <code style={{ fontFamily: 'var(--font-mono)' }}>.tmod</code> files and upload them
            on the server&apos;s Mods tab — tModLoader&apos;s own browser is Steam Workshop, which needs Steam on the
            node. The world is generated by vanilla Terraria either way, which is what tModLoader expects.
          </p>
        )}
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>World name</label>
        <input
          type="text"
          value={config.worldName}
          onChange={(e) => onChange('worldName', e.target.value)}
          placeholder="World"
          className="cc-input"
        />
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>World size</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
          {TERRARIA_WORLD_SIZES.map((s) => (
            <div
              key={s.value}
              onClick={() => onChange('autocreate', s.value)}
              style={{
                padding: '12px', borderRadius: '8px', cursor: 'pointer',
                background: config.autocreate === s.value ? 'var(--accent-dim)' : 'var(--bg)',
                border: `1px solid ${config.autocreate === s.value ? 'var(--accent)' : 'var(--border-2)'}`,
              }}
            >
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{s.label}</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>{s.help}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Difficulty</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
          {TERRARIA_DIFFICULTIES.map((d) => (
            <div
              key={d.value}
              onClick={() => onChange('difficulty', d.value)}
              title={d.help}
              style={{
                padding: '10px 12px', borderRadius: '8px', cursor: 'pointer',
                background: config.difficulty === d.value ? 'var(--accent-dim)' : 'var(--bg)',
                border: `1px solid ${config.difficulty === d.value ? 'var(--accent)' : 'var(--border-2)'}`,
              }}
            >
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>{d.label}</div>
              <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.35 }}>{d.help}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>World evil</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
          {TERRARIA_WORLD_EVILS.map((e) => (
            <div
              key={e.id}
              onClick={() => onChange('evil', e.id)}
              style={{
                padding: '12px', borderRadius: '8px', cursor: 'pointer',
                background: (config.evil ?? 'RANDOM') === e.id ? 'var(--accent-dim)' : 'var(--bg)',
                border: `1px solid ${(config.evil ?? 'RANDOM') === e.id ? 'var(--accent)' : 'var(--border-2)'}`,
              }}
            >
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{e.label}</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>{e.help}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>World seed <span style={{ fontWeight: 400 }}>(optional)</span></label>
        <input
          type="text"
          value={config.seed ?? ''}
          onChange={(e) => onChange('seed', e.target.value || undefined)}
          placeholder="Leave empty for a random world"
          className="cc-input"
        />
        <p className="cc-section-sub">Two worlds made with the same seed, size and difficulty are identical.</p>
      </div>

      {/* Secret seeds are 8 switches that most people will never touch, so they start
          folded away rather than doubling the length of the step. */}
      <div>
        <button
          type="button"
          onClick={() => setShowSecret((v) => !v)}
          style={{ fontSize: '0.72rem', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, padding: 0 }}
        >
          {showSecret ? 'Hide special world types' : 'Special world types'}
          {secretCount > 0 && ` (${secretCount} on)`}
        </button>
        {showSecret && (
          <div style={{ marginTop: '10px' }}>
            <p className="cc-section-sub" style={{ marginTop: 0 }}>
              Terraria&rsquo;s secret worlds. These change how the world is generated and cannot be
              turned on or off later.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px' }}>
              {TERRARIA_SECRET_SEEDS.map((s) => {
                const on = (config.secretSeeds ?? []).includes(s.id);
                return (
                  <label
                    key={s.id}
                    title={s.help}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px',
                      background: on ? 'var(--accent-dim)' : 'var(--bg)',
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-2)'}`,
                      borderRadius: '8px', cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const current = config.secretSeeds ?? [];
                        const next = e.target.checked
                          ? [...current, s.id]
                          : current.filter((x) => x !== s.id);
                        onChange('secretSeeds', next.length ? next : undefined);
                      }}
                      style={{ marginTop: '2px', width: 15, height: 15, accentColor: 'var(--accent)', flexShrink: 0, cursor: 'pointer' }}
                    />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>{s.label}</span>
                      <span style={{ display: 'block', fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.35 }}>{s.help}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Max players</label>
          <input
            type="number"
            min={1}
            max={TERRARIA_MAX_PLAYERS}
            value={config.maxPlayers}
            onChange={(e) => onChange('maxPlayers', Number(e.target.value))}
            className="cc-input"
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Server password</label>
          <input
            type="text"
            value={config.password ?? ''}
            onChange={(e) => onChange('password', e.target.value || undefined)}
            placeholder="Optional"
            className="cc-input"
          />
        </div>
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Message of the day <span style={{ fontWeight: 400 }}>(optional)</span></label>
        <input
          type="text"
          value={config.motd ?? ''}
          onChange={(e) => onChange('motd', e.target.value || undefined)}
          placeholder="Shown to players as they connect"
          className="cc-input"
        />
      </div>

      <label
        style={{
          display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px',
          background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={config.secure !== false}
          onChange={(e) => onChange('secure', e.target.checked)}
          style={{ marginTop: '2px', width: 15, height: 15, accentColor: 'var(--accent)', flexShrink: 0, cursor: 'pointer' }}
        />
        <span>
          <span style={{ display: 'block', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>Extra cheat protection</span>
          <span style={{ display: 'block', fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.35 }}>
            Terraria&rsquo;s <code style={{ fontFamily: 'var(--font-mono)' }}>secure</code> mode. Recommended for a public server; can be changed later.
          </span>
        </span>
      </label>
    </div>
  );
}

function ServerCardIcon({ serverId, serverType, serverTypeMeta, game = Game.MINECRAFT }: { serverId: string; serverType: string; serverTypeMeta: any; game?: Game }) {
  const [hasError, setHasError] = useState(false);
  // `serverType` is a Minecraft loader, so for any other game it holds a meaningless
  // default and must not decide the fallback badge. Fall back on the game instead.
  const meta = game === Game.MINECRAFT
    ? (serverTypeMeta[serverType] || { label: 'MC', color: '#8b949e' })
    : { label: GAME_META[game].short, color: GAME_META[game].color };

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

/*
 * Wrapped because the game filter reads useSearchParams, and Next refuses to prerender a
 * page that does without a boundary to fall back to — `next build` fails outright, which
 * neither the typecheck nor the tests would have caught.
 */
export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  );
}

function Dashboard() {
  const { user, logout, loading } = useAuth();
  const { advanced } = useUIPrefs();
  const toast = useToast();
  const confirm = useConfirm();
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);

  // Node Form State
  const [showNodeModal, setShowNodeModal] = useState(false);
  const [nodeName, setNodeName] = useState('');
  const [nodeHost, setNodeHost] = useState('');
  const [nodePort, setNodePort] = useState(3500);
  const [nodeApiKey, setNodeApiKey] = useState('');
  const [nodeOffloadPriority, setNodeOffloadPriority] = useState(0);
  // Blank on a new node: the daemon reports its own RAM and cores on registration, and guessing
  // here would only overwrite the truth with a number typed before the machine was ever contacted.
  const [nodeTotalMemory, setNodeTotalMemory] = useState('');
  const [nodeTotalCpu, setNodeTotalCpu] = useState('');
  const [nodeDetected, setNodeDetected] = useState<{ ramMb: number | null; cores: number | null }>({ ramMb: null, cores: null });

  // New Server Form Wizard State
  const [showServerModal, setShowServerModal] = useState(false);
  const [modalStep, setModalStep] = useState<1 | 2 | 3>(1);
  const [serverName, setServerName] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('AUTO');
  const [targetGame, setTargetGame] = useState<Game>(Game.MINECRAFT);
  const isTerraria = targetGame === Game.TERRARIA;

  // Terraria's world settings. Seeded from the shared defaults so the wizard and the
  // API validator cannot disagree about what an unspecified field means.
  const [terrariaConfig, setTerrariaConfig] = useState<TerrariaConfig>(DEFAULT_TERRARIA_CONFIG);
  const setTerraria = <K extends keyof TerrariaConfig>(key: K, value: TerrariaConfig[K]) =>
    setTerrariaConfig((prev) => ({ ...prev, [key]: value }));

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

  // The wizard mirrors the quota the API enforces, so oversized sizes are visibly out of reach
  // instead of failing on submit. null = still loading or unlimited.
  const [quota, setQuota] = useState<QuotaLimits | null>(null);
  useEffect(() => {
    if (!showServerModal) return;
    let active = true;
    fetch('/api/account/quota')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (active) setQuota(data && !data.unlimited ? data : null); })
      .catch(() => { /* Informational only — the API still enforces the real limits. */ });
    return () => { active = false; };
  }, [showServerModal]);

  // A new server is capped by the per-server ceiling and by whatever is left of the total.
  const ramCap = smallestCap(quota?.maxServerMemoryMb, quota?.maxMemoryMb, quota?.usedMemoryMb);
  const cpuCap = smallestCap(quota?.maxServerCpu, quota?.maxCpu, quota?.usedCpu);

  // The wizard's defaults (8 GB / 1 core) can sit above a tight quota, so pull them down to the
  // largest allowed preset once the quota is known.
  useEffect(() => {
    if (ramCap != null) setMemoryMb((mb) => (mb > ramCap ? [16384, 8192, 4096, 2048, 1024].find((p) => p <= ramCap) ?? 1024 : mb));
    if (cpuCap != null) setCpuLimit((c) => (c > cpuCap ? [8, 4, 2, 1].find((p) => p <= cpuCap) ?? 1 : c));
  }, [ramCap, cpuCap]);

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

  // Only offer nodes that can actually host the game being created, so a mismatch surfaces
  // as an absent option rather than as a failure deep inside provisioning. A node that has
  // never reported its games is assumed Minecraft-capable — that matches the column default
  // and keeps an older daemon usable instead of vanishing from the picker.
  const gameCapableNodes = useMemo(
    () => nodes.filter((n) => (n.enabledGames ?? DEFAULT_ENABLED_GAMES).includes(targetGame)),
    [nodes, targetGame]
  );

  // If the chosen node loses the capability while the wizard is open — the operator unticks
  // the game on the daemon — fall back to Auto rather than submitting a doomed request.
  useEffect(() => {
    if (selectedNodeId !== 'AUTO' && !gameCapableNodes.some((n) => n.id === selectedNodeId)) {
      setSelectedNodeId('AUTO');
    }
  }, [gameCapableNodes, selectedNodeId]);

  // ── Dashboard game filter ──
  /*
   * Held in the URL rather than in state, because the sidebar drives it and a sidebar
   * whose entries are links is worth more than one whose entries are buttons: the view
   * becomes shareable, survives a reload, and the back button steps through filters.
   * `?game=` absent means "all".
   */
  const router = useRouter();
  const searchParams = useSearchParams();
  const gameParam = searchParams.get('game');
  const gameFilter: Game | null = isGame(gameParam) ? gameParam : null;
  const setGameFilter = (g: Game | null) =>
    router.replace(g === null ? '/dashboard' : `/dashboard?game=${g}`, { scroll: false });

  /** How many servers each game has, for the sidebar's counts. */
  const serverCountByGame = useMemo(() => {
    const counts: Partial<Record<Game, number>> = {};
    for (const g of ALL_GAMES) counts[g] = servers.filter((s) => gameOf(s) === g).length;
    return counts;
  }, [servers]);

  /** Games that actually have a server, in the enum's order. */
  const gamesInUse = useMemo(
    () => ALL_GAMES.filter((g) => servers.some((s) => gameOf(s) === g)),
    [servers]
  );

  const visibleServers = useMemo(
    () => (gameFilter === null ? servers : servers.filter((s) => gameOf(s) === gameFilter)),
    [servers, gameFilter]
  );

  /*
   * A filter pinned to a game whose last server was just deleted would show an empty grid
   * with no obvious way back. `servers.length > 0` guards the first render, where the
   * list has not loaded yet and every game looks empty — without it, a shared link with
   * ?game= set would rewrite itself away before the data it names arrives.
   */
  useEffect(() => {
    if (servers.length > 0 && gameFilter !== null && !gamesInUse.includes(gameFilter)) {
      setGameFilter(null);
    }
  }, [gamesInUse, gameFilter, servers.length]);

  // Switching game re-seeds RAM: Minecraft's 8 GB default would be six times what a
  // Terraria world needs, and a user who never opens the Resources step should not be
  // handed a wasteful allocation because of a default meant for another game.
  useEffect(() => {
    setMemoryMb(isTerraria ? 1024 : 8192);
  }, [isTerraria]);

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

  /** Opens the register-node modal with a clean form. Called from the sidebar. */
  const openRegisterNodeModal = () => {
    setNodeName('');
    setNodeHost('');
    setNodePort(3500);
    setNodeApiKey('');
    setNodeOffloadPriority(0);
    setNodeTotalMemory('');
    setNodeTotalCpu('');
    setNodeDetected({ ramMb: null, cores: null });
    setShowNodeModal(true);
  };

  const handleRegisterNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError('');
    try {
      const payload: any = {
        name: nodeName,
        host: nodeHost,
        port: nodePort,
        offloadPriority: nodeOffloadPriority,
      };

      // Overcommit is not offered at registration: a node starts at 1.0 (no overcommit),
      // and tuning it is a decision to make once the node has servers on it to measure.
      if (nodeTotalMemory !== '') payload.totalMemory = Number(nodeTotalMemory);
      if (nodeTotalCpu !== '') payload.totalCpu = Number(nodeTotalCpu);

      if (!nodeApiKey) throw new Error('API Key is required for new nodes');
      payload.apiKey = nodeApiKey;

      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save node');

      setShowNodeModal(false);
      setNodeName('');
      setNodeHost('');
      setNodeApiKey('');
      fetchData();
    } catch (err: any) {
      setActionError(err.message);
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

  /**
   * Terraria's create path.
   *
   * Deliberately separate from the Minecraft submit below rather than threaded
   * through it with conditionals — that function carries serverpack uploads,
   * modpack version resolution and version fallbacks, none of which apply here.
   */
  const createTerrariaServer = async () => {
    if (!serverName.trim()) {
      setActionError('Please give your server a name.');
      return;
    }

    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: serverName,
          nodeId: selectedNodeId,
          game: Game.TERRARIA,
          gameConfig: terrariaConfig,
          // Terraria is PROCESS-only for now — it never goes near docker.ts.
          executionMode: 'PROCESS',
          serverPort,
          memoryMb,
          cpuLimit,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.details || `Failed to create server (${res.status})`);

      setShowServerModal(false);
      setModalStep(1);
      setServerName('');
      setTerrariaConfig(DEFAULT_TERRARIA_CONFIG);
      fetchData();
    } catch (err: any) {
      setActionError(err.message || 'Failed to create server');
    }
  };

  const handleCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError('');

    // Terraria takes an entirely different path from here: no EULA (that licence is
    // Mojang's), no serverpack, no Minecraft version to resolve.
    if (isTerraria) {
      await createTerrariaServer();
      return;
    }

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
    <div style={{ minHeight: '100vh', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column' }}>

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
                <Link href="/dashboard/audit-log" className="text-xs font-semibold text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2.5 py-1 rounded-md">
                  Audit Log
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

        <DashboardSidebar
          nodes={nodes}
          serverCountByGame={serverCountByGame}
          activeGame={gameFilter}
          isAdmin={user?.globalRole === 'GLOBAL_ADMIN'}
          onRegisterNode={openRegisterNodeModal}
        />

        {/* RIGHT: Server grid */}
        <section className="flex-1 p-4 lg:p-6">
          <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Your Servers</h2>
            {visibleServers.length > 0 && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {visibleServers.filter((s) => s.status === 'RUNNING').length} of {visibleServers.length} running
              </span>
            )}

          </div>

          {visibleServers.length === 0 ? (
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
              {visibleServers.map(server => (
                <div key={server.id} className="cc-card" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {/* Card top row */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    <ServerCardIcon serverId={server.id} serverType={server.serverType} serverTypeMeta={serverTypeMeta} game={gameOf(server)} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '2px' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {server.name}
                        </span>
                        <GameBadge game={gameOf(server)} />
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        {/* serverType/mcVersion are Minecraft-only columns; on a Terraria row they
                            hold defaults that would read as a real engine and version. */}
                        {gameOf(server) === Game.MINECRAFT
                          ? <>{server.serverType} {server.mcVersion}</>
                          : <>{(server.gameConfig as any)?.worldName || GAME_LABELS[gameOf(server)]}</>}
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
              Register Remote Daemon Node
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
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Daemon API Secret Key</label>
                <input type="password" required value={nodeApiKey} onChange={e => setNodeApiKey(e.target.value)} placeholder="Bearer key..." className="cc-input" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Smart Offload Priority (0-10)</label>
                <input type="number" required value={nodeOffloadPriority} onChange={e => setNodeOffloadPriority(parseInt(e.target.value, 10))} placeholder="0 = Main, 10 = Offload" className="cc-input" />
              </div>
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Total memory (MB)</label>
                    <input
                      type="number"
                      min="0"
                      value={nodeTotalMemory}
                      onChange={e => setNodeTotalMemory(e.target.value)}
                      placeholder="Detected from the daemon"
                      className="cc-input"
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Total CPU cores</label>
                    <input
                      type="number"
                      min="0"
                      value={nodeTotalCpu}
                      onChange={e => setNodeTotalCpu(e.target.value)}
                      placeholder="Detected from the daemon"
                      className="cc-input"
                    />
                  </div>
                </div>
                <p className="cc-help">
                  How much this machine may hand out to servers. Set it below the real hardware to keep
                  headroom for the host; 0 disables the check entirely.
                  {(nodeDetected.ramMb || nodeDetected.cores) && (
                    <>
                      {' '}The daemon reports {nodeDetected.ramMb ? `${Math.round(nodeDetected.ramMb / 1024)} GB RAM` : 'unknown RAM'}
                      {nodeDetected.cores ? ` and ${nodeDetected.cores} cores` : ''}.
                      {' '}
                      <button
                        type="button"
                        onClick={() => {
                          if (nodeDetected.ramMb) setNodeTotalMemory(String(nodeDetected.ramMb));
                          if (nodeDetected.cores) setNodeTotalCpu(String(nodeDetected.cores));
                        }}
                        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}
                      >
                        Use detected
                      </button>
                    </>
                  )}
                </p>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '4px' }}>
                <button type="button" onClick={() => setShowNodeModal(false)} className="cc-btn-ghost">Cancel</button>
                <button type="submit" className="cc-btn-primary">Register Node</button>
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
                <h3 style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Create a {GAME_LABELS[targetGame]} server</h3>
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
                {/* ── Game picker ──
                    Sits above the engine cards rather than being its own numbered step, so the
                    Minecraft path stays the same three steps it has always been. Choosing
                    Terraria replaces everything below with its own settings rather than
                    showing Minecraft's disabled. */}
                <div>
                  <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Which game?</label>
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${ALL_GAMES.length}, 1fr)`, gap: '10px', marginTop: '8px' }}>
                    {ALL_GAMES.map((g) => {
                      const selected = targetGame === g;
                      const meta = GAME_META[g];
                      return (
                        <div
                          key={g}
                          onClick={() => setTargetGame(g)}
                          style={{
                            padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', transition: 'all 0.15s',
                            background: selected ? 'var(--accent-dim)' : 'var(--bg)',
                            border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-2)'}`,
                            display: 'flex', alignItems: 'center', gap: '10px',
                          }}
                        >
                          <span style={{
                            fontFamily: 'var(--font-mono)', fontSize: '0.72rem', fontWeight: 800,
                            color: meta.color, letterSpacing: '0.04em',
                          }}>{meta.short}</span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{GAME_LABELS[g]}</div>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>{meta.blurb}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {isTerraria ? (
                  <TerrariaWizardStep config={terrariaConfig} onChange={setTerraria} />
                ) : (
                <>
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
                </>
                )}
              </div>
            )}

            {/* Step 2 */}
            {modalStep === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>Step 2 of 3 — Name and resources</label>
                <div>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Server name</label>
                  <input type="text" required value={serverName} onChange={e => setServerName(e.target.value)} placeholder={isTerraria ? 'My Terraria World' : 'My Minecraft World'} className="cc-input" />
                  <p className="cc-section-sub">Just a label inside the panel — you can rename it any time.</p>
                </div>
                {/* Terraria is PROCESS-only in this release, so there is nothing to choose between. */}
                <div style={{ display: advanced && !isTerraria ? 'block' : 'none' }}>
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
                        {gameCapableNodes.map(n => (
                          <option key={n.id} value={n.id} disabled={!n.isOnline}>
                            {n.name} (Priority: {n.offloadPriority})
                            {n.capacity?.freeMemoryMb != null ? ` — ${(n.capacity.freeMemoryMb / 1024).toFixed(1)} GB free` : ''}
                            {!n.isOnline ? ' — OFFLINE' : ''}
                          </option>
                        ))}
                      </select>
                      {gameCapableNodes.length === 0 && (
                        <p style={{ fontSize: '0.7rem', color: 'var(--warning)', marginTop: '5px' }}>
                          No registered node is set up to host {GAME_LABELS[targetGame]}. Enable it under
                          &ldquo;Games Hosted On This Node&rdquo; in the node&rsquo;s daemon setup page.
                        </p>
                      )}
                      {selectedNodeId !== 'AUTO' && nodes.find(n => n.id === selectedNodeId)?.isOnline === false && (
                        <p style={{ fontSize: '0.7rem', color: 'var(--danger)', marginTop: '5px' }}>
                          This node is currently unreachable — the server cannot be provisioned here until it comes back online.
                        </p>
                      )}
                    </div>
                  )}
                  {/* Terraria's version is pinned by the daemon, so there is nothing to pick.
                      Hidden rather than disabled — an inert dropdown reads as broken. */}
                  <div style={{ display: isTerraria ? 'none' : 'block' }}>
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
                {!isTerraria && selectedMcVersion === 'CUSTOM' && serverType !== 'MODRINTH' && (
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
                      {[
                        { mb: 1024, note: 'a few friends, vanilla' },
                        { mb: 2048, note: 'vanilla or light plugins' },
                        { mb: 4096, note: 'plugins or a small modpack' },
                        { mb: 8192, note: 'most modpacks' },
                        { mb: 16384, note: 'large or heavily modded packs' },
                      ].map(({ mb, note }) => (
                        <option key={mb} value={mb} disabled={ramCap != null && mb > ramCap}>
                          {mb / 1024} GB — {ramCap != null && mb > ramCap ? 'over your quota' : note}
                        </option>
                      ))}
                    </select>
                    {ramCap != null && (
                      <p className="cc-section-sub">Your quota allows up to {ramCap >= 1024 ? `${Math.round((ramCap / 1024) * 10) / 10} GB` : `${ramCap} MB`} for this server.</p>
                    )}
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
                        {[1, 2, 4, 8].map((cores) => (
                          <option key={cores} value={cores} disabled={cpuCap != null && cores > cpuCap}>
                            {cores} Core{cores === 1 ? '' : 's'}{cpuCap != null && cores > cpuCap ? ' — over your quota' : ''}
                          </option>
                        ))}
                      </select>
                      {cpuCap != null && <p className="cc-section-sub">Your quota allows up to {cpuCap} core(s) for this server.</p>}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step 3 */}
            {modalStep === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>
                  {isTerraria ? 'Step 3 of 3 — Review' : 'Step 3 of 3 — Review and accept the EULA'}
                </label>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {(isTerraria ? [
                    { label: 'Game', value: GAME_LABELS[Game.TERRARIA] },
                    { label: 'World Name', value: terrariaConfig.worldName },
                    { label: 'World Size', value: TERRARIA_WORLD_SIZES.find(s => s.value === terrariaConfig.autocreate)?.label ?? '—' },
                    { label: 'Difficulty', value: TERRARIA_DIFFICULTIES.find(d => d.value === terrariaConfig.difficulty)?.label ?? '—' },
                    { label: 'World Evil', value: TERRARIA_WORLD_EVILS.find(e => e.id === (terrariaConfig.evil ?? 'RANDOM'))?.label ?? 'Random' },
                    { label: 'Seed', value: terrariaConfig.seed || 'Random' },
                    ...(terrariaConfig.secretSeeds?.length ? [{
                      label: 'Special World',
                      value: terrariaConfig.secretSeeds
                        .map(id => TERRARIA_SECRET_SEEDS.find(s => s.id === id)?.label ?? id)
                        .join(', '),
                    }] : []),
                    { label: 'Max Players', value: String(terrariaConfig.maxPlayers) },
                    { label: 'Password', value: terrariaConfig.password ? 'Set' : 'None' },
                    { label: 'Cheat Protection', value: terrariaConfig.secure === false ? 'Off' : 'On' },
                    { label: 'Allocated RAM', value: `${memoryMb} MB` },
                    { label: 'Game Port', value: String(serverPort) },
                  ] : [
                    { label: 'Execution Mode', value: executionMode === 'PROCESS' ? 'Standalone Process' : 'Docker Container' },
                    { label: 'Server Engine', value: serverType },
                    { label: 'Minecraft Version', value: (serverType === 'CUSTOM_ZIP' || serverpackFile !== null) ? 'Auto-detected from serverpack' : (selectedMcVersion === 'CUSTOM' ? customMcVersion : selectedMcVersion) },
                    ...(modpackSlug ? [{ label: 'Modpack', value: `@${modpackSlug}` }] : []),
                    { label: 'Allocated RAM', value: `${memoryMb} MB` },
                    { label: 'Game Port', value: String(serverPort) },
                  ]).map(({ label, value }) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <span>{label}:</span>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{value}</span>
                    </div>
                  ))}
                </div>
                {/* Mojang's licence, so it is asked for only when Mojang's game is being created. */}
                {!isTerraria && (
                <div style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', borderRadius: '8px', padding: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                  <input type="checkbox" id="eulaModalCheckStep3" checked={eulaAccepted} onChange={e => setEulaAccepted(e.target.checked)} style={{ marginTop: '2px', accentColor: 'var(--accent)', width: '16px', height: '16px', cursor: 'pointer', flexShrink: 0 }} />
                  <label htmlFor="eulaModalCheckStep3" style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6, cursor: 'pointer' }}>
                    I agree to the <a href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 700 }}>Mojang Minecraft EULA</a>. By checking this box, CraftControl sets <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: '0.75rem' }}>EULA=TRUE</code> on server boot.
                  </label>
                </div>
                )}
                {isTerraria && (
                  <p className="cc-section-sub">
                    The world is generated on first start, which takes about 15 seconds for a small
                    world and longer for a large one.
                  </p>
                )}
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
                <button type="button" onClick={() => { if (!isTerraria && serverType === 'MODRINTH' && !modpackSlug) { setActionError('Please select a Modrinth modpack.'); return; } setActionError(''); setModalStep(s => (s + 1) as any); }} className="cc-btn-primary">
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

