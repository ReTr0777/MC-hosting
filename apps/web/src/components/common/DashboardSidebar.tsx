'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Game, GAME_LABELS, ALL_GAMES, DEFAULT_ENABLED_GAMES } from '@mc-manager/shared';
import ConnectMachineModal from './ConnectMachineModal';

/**
 * The dashboard's left rail: what you can host, and what you host it on.
 *
 * It replaces a panel that stacked a full statistics card per node — four progress bars,
 * a CPU model and four icon buttons each. That is a dashboard, not navigation: two nodes
 * filled the viewport, the game filter lived somewhere else entirely (a row of chips
 * above the server grid), and node management was a row of unlabelled icons that only
 * appeared in advanced mode.
 *
 * So the rail carries identity and state only — name, reachability, load in one bar —
 * and everything that needs explaining moved to the node's own page.
 */

export interface SidebarNode {
  id: string;
  name: string;
  host: string;
  port: number;
  isOnline: boolean;
  /** Null for a node the installation runs; set when someone enrolled their own machine. */
  ownerId?: string | null;
  enabledGames?: string[] | null;
  drainedAt?: string | null;
  liveCpuUsage?: number | null;
  liveRamUsed?: number | null;
  liveRamTotal?: number | null;
  totalMemory?: number | null;
  _count?: { servers: number };
}

interface Props {
  nodes: SidebarNode[];
  /** Games that at least one existing server uses; drives which entries show a count. */
  serverCountByGame?: Partial<Record<Game, number>>;
  /** Null means "all games". Only meaningful on the dashboard itself. */
  activeGame?: Game | null;
  /** Set on the node detail page so the rail can show which node you are looking at. */
  activeNodeId?: string | null;
  isAdmin: boolean;
  /** Opens the register-node modal, which still lives on the dashboard page. */
  onRegisterNode?: () => void;
}

const GAME_ACCENT: Record<Game, string> = {
  [Game.MINECRAFT]: '#4ade80',
  [Game.TERRARIA]: '#38bdf8',
};

/** One node's RAM pressure, or null when the node has not reported any. */
function ramPct(node: SidebarNode): number | null {
  const total = node.liveRamTotal ?? node.totalMemory ?? 0;
  const used = node.liveRamUsed ?? 0;
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((used / total) * 100));
}

function loadColor(pct: number): string {
  return pct > 85 ? 'var(--danger)' : pct > 60 ? 'var(--warning)' : 'var(--accent)';
}

export default function DashboardSidebar({
  nodes,
  serverCountByGame,
  activeGame = null,
  activeNodeId = null,
  isAdmin,
  onRegisterNode,
}: Props) {
  const router = useRouter();
  const [connecting, setConnecting] = useState(false);

  /*
   * The filter is a URL parameter rather than component state so that the rail can be a
   * set of links: a filtered view is then shareable, survives a reload, and the browser's
   * back button steps through filters the way it does through anything else. The
   * dashboard reads the same parameter.
   */
  const gameHref = (game: Game | null) => (game === null ? '/dashboard' : `/dashboard?game=${game}`);

  return (
    <aside
      className="w-full lg:w-64 lg:min-w-[256px] p-4 lg:p-5 cc-side-divider"
      style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}
    >
      {/* ── Games ── */}
      <nav aria-label="Games">
        <div className="cc-section-title" style={{ marginBottom: '10px' }}>Games</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <SidebarRow
            href={gameHref(null)}
            active={activeGame === null}
            label="All servers"
            accent="var(--text-muted)"
            badge={
              serverCountByGame
                ? String(Object.values(serverCountByGame).reduce((a, b) => a + (b ?? 0), 0))
                : undefined
            }
          />
          {ALL_GAMES.map((game) => (
            <SidebarRow
              key={game}
              href={gameHref(game)}
              active={activeGame === game}
              label={GAME_LABELS[game]}
              accent={GAME_ACCENT[game]}
              badge={serverCountByGame ? String(serverCountByGame[game] ?? 0) : undefined}
            />
          ))}
        </div>
      </nav>

      {/* ── Nodes ── */}
      <nav aria-label="Nodes" style={{ flex: 1 }}>
        <div className="cc-section-title" style={{ marginBottom: '10px' }}>Nodes</div>

        {nodes.length === 0 ? (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '12px 0', lineHeight: 1.5 }}>
            No nodes registered yet. A node is the machine that actually runs your servers.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {nodes.map((node) => {
              const pct = ramPct(node);
              const draining = !!node.drainedAt;
              const active = node.id === activeNodeId;
              const games = node.enabledGames?.length ? node.enabledGames : DEFAULT_ENABLED_GAMES;

              return (
                <Link
                  key={node.id}
                  href={`/dashboard/nodes/${node.id}`}
                  style={{
                    display: 'block',
                    padding: '8px 10px',
                    borderRadius: '7px',
                    textDecoration: 'none',
                    background: active ? 'var(--surface-2)' : 'transparent',
                    border: `1px solid ${active ? 'var(--border-2)' : 'transparent'}`,
                    transition: 'background 0.15s ease',
                  }}
                  onMouseOver={(e) => {
                    if (!active) e.currentTarget.style.background = 'var(--surface)';
                  }}
                  onMouseOut={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                    {/* Reachability, as a dot rather than a badge: it is one bit and the
                        rail has better uses for the width. */}
                    <span
                      aria-hidden
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: node.isOnline ? 'var(--accent)' : 'var(--danger)',
                      }}
                    />
                    <span
                      style={{
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                      title={`${node.host}:${node.port}`}
                    >
                      {node.name}
                    </span>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                      {node._count?.servers ?? 0}
                    </span>
                  </div>

                  {/* Screen-reader text, because the dot and the bar below are the only
                      things saying any of this and neither is readable. */}
                  <span className="sr-only">
                    {node.isOnline ? 'Online' : 'Offline'}
                    {draining ? ', in maintenance mode' : ''}
                    {pct !== null ? `, ${pct}% memory used` : ''}
                  </span>

                  {draining && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--warning)', fontWeight: 700, marginTop: '3px', paddingLeft: '14px' }}>
                      Maintenance
                    </div>
                  )}

                  {pct !== null && node.isOnline && (
                    <div
                      style={{
                        height: '3px',
                        background: 'var(--border-2)',
                        borderRadius: '2px',
                        overflow: 'hidden',
                        marginTop: '5px',
                        marginLeft: '14px',
                      }}
                    >
                      <div style={{ height: '100%', width: `${pct}%`, background: loadColor(pct), transition: 'width 0.5s ease' }} />
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '4px', marginTop: '5px', paddingLeft: '14px' }}>
                    {ALL_GAMES.filter((g) => games.includes(g)).map((g) => (
                      <span
                        key={g}
                        title={`Hosts ${GAME_LABELS[g]}`}
                        style={{
                          fontSize: '0.55rem',
                          fontWeight: 800,
                          letterSpacing: '0.05em',
                          color: GAME_ACCENT[g],
                          border: `1px solid ${GAME_ACCENT[g]}44`,
                          borderRadius: '3px',
                          padding: '0 4px',
                        }}
                      >
                        {GAME_LABELS[g].slice(0, 2).toUpperCase()}
                      </span>
                    ))}
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {isAdmin && onRegisterNode && (
          <button
            onClick={() => {
              /*
               * The modal lives on the dashboard page, so from anywhere else this has to
               * get there first. Without the push, the click on a node's own page would
               * do nothing at all and look like a broken button.
               */
              router.push('/dashboard');
              onRegisterNode();
            }}
            style={{
              marginTop: '8px',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              borderRadius: '7px',
              border: '1px dashed var(--border-2)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onMouseOver={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseOut={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            + Register node
          </button>
        )}

        {/* Open to everyone, unlike registering a node by hand: this one hands out a
            code rather than asking for an address and a key, and the node it produces
            belongs to whoever asked. */}
        <button
          onClick={() => setConnecting(true)}
          style={{
            marginTop: '8px',
            width: '100%',
            textAlign: 'left',
            padding: '8px 10px',
            borderRadius: '7px',
            border: '1px dashed var(--border-2)',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
          onMouseOver={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
          onMouseOut={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          + Connect a machine of your own
        </button>
      </nav>

      {connecting && (
        <ConnectMachineModal
          onClose={() => setConnecting(false)}
          // The rail is rendered from server data on several pages, so a refresh is what
          // makes the new node appear without asking the user to reload.
          onConnected={() => router.refresh()}
        />
      )}
    </aside>
  );
}

function SidebarRow({
  href,
  active,
  label,
  accent,
  badge,
}: {
  href: string;
  active: boolean;
  label: string;
  accent: string;
  badge?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '7px 10px',
        borderRadius: '7px',
        textDecoration: 'none',
        background: active ? 'var(--surface-2)' : 'transparent',
        border: `1px solid ${active ? 'var(--border-2)' : 'transparent'}`,
      }}
      onMouseOver={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--surface)';
      }}
      onMouseOut={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <span aria-hidden style={{ width: 3, height: 14, borderRadius: '2px', background: active ? accent : 'transparent', flexShrink: 0 }} />
      <span style={{ fontSize: '0.8125rem', fontWeight: active ? 700 : 500, color: active ? 'var(--text-primary)' : 'var(--text-muted)', flex: 1 }}>
        {label}
      </span>
      {badge !== undefined && (
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{badge}</span>
      )}
    </Link>
  );
}
