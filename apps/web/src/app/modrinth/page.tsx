'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useUIPrefs } from '@/context/UIPrefsContext';
import { AdvancedBadge } from '@/components/AdvancedModeToggle';
import { apiRequest, errorMessage } from '@/lib/api';
import {
  Chip, EmptyState, InlineError, LoadingLine, Modal, Notice, PanelHeader, SkeletonRows,
} from '@/components/ui';

interface Modpack {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string;
  downloads: number;
  follows: number;
  categories: string[];
  client_side?: string;
  server_side?: string;
}

interface ModpackVersion {
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
}

interface NodeItem {
  id: string;
  name: string;
  isOnline?: boolean;
}

const LOADERS = [
  { id: '', label: 'Any loader' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'forge', label: 'Forge' },
  { id: 'neoforge', label: 'NeoForge' },
  { id: 'quilt', label: 'Quilt' },
];

const SORTS = [
  { id: 'downloads', label: 'Most downloaded' },
  { id: 'follows', label: 'Most followed' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'newest', label: 'Newest' },
] as const;

const PAGE_SIZE = 12;

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** The loader a version targets, ignoring the tags that are not mod loaders. */
function primaryLoader(version: ModpackVersion): string | null {
  const known = ['neoforge', 'forge', 'fabric', 'quilt'];
  return version.loaders.map((l) => l.toLowerCase()).find((l) => known.includes(l)) || null;
}

export default function ModrinthExplorerPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const { advanced } = useUIPrefs();

  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [modpacks, setModpacks] = useState<Modpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [nodes, setNodes] = useState<NodeItem[]>([]);

  const [offset, setOffset] = useState(0);
  const [totalHits, setTotalHits] = useState(0);
  const [sortBy, setSortBy] = useState<(typeof SORTS)[number]['id']>('downloads');
  const [loaderFilter, setLoaderFilter] = useState('');

  const [selected, setSelected] = useState<Modpack | null>(null);

  const fetchModpacks = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setLoadError('');
      try {
        const url = new URL('/api/modrinth/search', window.location.origin);
        if (submittedQuery.trim()) url.searchParams.set('q', submittedQuery.trim());
        url.searchParams.set('limit', String(PAGE_SIZE));
        url.searchParams.set('offset', String(nextOffset));
        url.searchParams.set('index', sortBy);
        if (loaderFilter) url.searchParams.set('loader', loaderFilter);

        const data = await apiRequest<{ hits: Modpack[]; total_hits: number; offset: number }>(url.toString());
        setModpacks(data.hits || []);
        setTotalHits(data.total_hits || 0);
        setOffset(data.offset ?? nextOffset);
      } catch (err) {
        setLoadError(errorMessage(err, 'Could not reach Modrinth.'));
        setModpacks([]);
      } finally {
        setLoading(false);
      }
    },
    [submittedQuery, sortBy, loaderFilter]
  );

  useEffect(() => {
    fetchModpacks(0);
  }, [fetchModpacks]);

  useEffect(() => {
    apiRequest<{ nodes: NodeItem[] }>('/api/nodes')
      .then((data) => setNodes(data.nodes || []))
      .catch(() => setNodes([]));
  }, []);

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(totalHits / PAGE_SIZE));

  if (!user) return <LoadingLine>Loading…</LoadingLine>;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          borderBottom: '1px solid var(--border)', background: 'var(--surface)',
          position: 'sticky', top: 0, zIndex: 50,
        }}
      >
        <div
          style={{
            maxWidth: '80rem', margin: '0 auto', padding: '14px 24px', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span
              style={{
                width: 34, height: 34, borderRadius: '8px', background: 'var(--accent)',
                color: 'var(--on-accent)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontWeight: 900, fontSize: '1rem',
              }}
            >
              M
            </span>
            <div>
              <h1 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                Modrinth modpacks
              </h1>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Deploy a modpack straight onto one of your nodes
              </span>
            </div>
          </div>
          <Link href="/dashboard" className="cc-btn-ghost" style={{ textDecoration: 'none' }}>
            Back to dashboard
          </Link>
        </div>
      </header>

      <main style={{ maxWidth: '80rem', width: '100%', margin: '0 auto', padding: '24px', display: 'grid', gap: '20px' }}>
        <section className="cc-panel" style={{ display: 'grid', gap: '14px' }}>
          <PanelHeader
            title="Find a modpack"
            description="The panel builds a server from the pack itself — downloading its mods, installing the loader it asks for, and setting aside anything that only works on a client."
          />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedQuery(query);
            }}
            style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Modrinth — Cobblemon, All the Mods, Better MC…"
              className="cc-input"
              style={{ flex: '1 1 260px' }}
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as (typeof SORTS)[number]['id'])}
              className="cc-input"
              style={{ flex: '0 1 180px' }}
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <select
              value={loaderFilter}
              onChange={(e) => setLoaderFilter(e.target.value)}
              className="cc-input"
              style={{ flex: '0 1 150px' }}
            >
              {LOADERS.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
            <button type="submit" className="cc-btn-primary">Search</button>
          </form>

          {loadError && <InlineError message={loadError} onRetry={() => fetchModpacks(offset)} />}
        </section>

        <section className="cc-panel" style={{ display: 'grid', gap: '16px' }}>
          <PanelHeader
            title={submittedQuery ? `Results for "${submittedQuery}"` : 'Popular modpacks'}
            chips={totalHits > 0 ? <Chip>{formatCount(totalHits)} found</Chip> : undefined}
          />

          {loading ? (
            <SkeletonRows rows={4} height={92} />
          ) : modpacks.length === 0 ? (
            <EmptyState
              title="No modpacks matched"
              description="Try a different search term, or widen the loader filter to “Any loader”."
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
              {modpacks.map((pack) => (
                <ModpackCard key={pack.project_id} pack={pack} onDeploy={() => setSelected(pack)} />
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <button
                onClick={() => fetchModpacks(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0 || loading}
                className="cc-btn-ghost"
              >
                ← Previous
              </button>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Page {currentPage} of {formatCount(totalPages)}
              </span>
              <button
                onClick={() => fetchModpacks(offset + PAGE_SIZE)}
                disabled={currentPage >= totalPages || loading}
                className="cc-btn-ghost"
              >
                Next →
              </button>
            </div>
          )}
        </section>
      </main>

      {selected && (
        <DeployModal
          pack={selected}
          nodes={nodes}
          advanced={advanced}
          onClose={() => setSelected(null)}
          onDeployed={(serverId) => {
            setSelected(null);
            toast.success('Server created', 'Building the modpack now — watch the console for progress.');
            router.push(`/dashboard/servers/${serverId}`);
          }}
        />
      )}
    </div>
  );
}

function ModpackCard({ pack, onDeploy }: { pack: Modpack; onDeploy: () => void }) {
  // Modrinth marks packs that cannot run server-side at all; deploying one is a wasted build.
  const serverUnsupported = (pack.server_side || '').toLowerCase() === 'unsupported';

  return (
    <div
      className="cc-card"
      style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}
    >
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <img
          src={pack.icon_url || '/icon.svg'}
          alt=""
          width={48}
          height={48}
          loading="lazy"
          style={{
            width: 48, height: 48, borderRadius: '8px', flexShrink: 0,
            background: 'var(--bg)', border: '1px solid var(--border-2)', objectFit: 'cover',
          }}
          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 800, color: 'var(--text-primary)' }}>{pack.title}</div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '3px', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
            <span>↓ {formatCount(pack.downloads)}</span>
            <span>♥ {formatCount(pack.follows)}</span>
          </div>
        </div>
      </div>

      <p
        style={{
          margin: 0, fontSize: '0.72rem', lineHeight: 1.55, color: 'var(--text-muted)',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}
      >
        {pack.description}
      </p>

      {serverUnsupported && (
        <div style={{ fontSize: '0.68rem', color: 'var(--warning)', fontWeight: 700 }}>
          Marked client-only by its author — a server build will likely fail.
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: 'auto' }}>
        <button onClick={onDeploy} className="cc-btn-primary" style={{ flex: 1 }}>
          Set up server
        </button>
        <a
          href={`https://modrinth.com/modpack/${pack.slug}`}
          target="_blank"
          rel="noreferrer"
          className="cc-btn-ghost"
          style={{ textDecoration: 'none' }}
        >
          View
        </a>
      </div>
    </div>
  );
}

/**
 * Full server setup for one modpack.
 *
 * The version choice is the important part: it pins both the Minecraft version and the
 * loader. Deploying without one previously left the panel recording its schema default of
 * 1.20.1 no matter what the pack actually targeted.
 */
function DeployModal({
  pack,
  nodes,
  advanced,
  onClose,
  onDeployed,
}: {
  pack: Modpack;
  nodes: NodeItem[];
  advanced: boolean;
  onClose: () => void;
  onDeployed: (serverId: string) => void;
}) {
  const [versions, setVersions] = useState<ModpackVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [versionsError, setVersionsError] = useState('');
  const [versionId, setVersionId] = useState('');

  const [serverName, setServerName] = useState(`${pack.title} Server`);
  const [nodeId, setNodeId] = useState('AUTO');
  const [serverPort, setServerPort] = useState(24000);
  const [memoryMb, setMemoryMb] = useState(6144);
  const [executionMode, setExecutionMode] = useState<'PROCESS' | 'DOCKER'>('PROCESS');
  const [eulaAccepted, setEulaAccepted] = useState(false);

  const [deployError, setDeployError] = useState('');
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setVersionsLoading(true);
    apiRequest<{ versions: ModpackVersion[] }>(`/api/modrinth/versions?slug=${encodeURIComponent(pack.slug)}`)
      .then((data) => {
        if (cancelled) return;
        const list = data.versions || [];
        setVersions(list);
        // Newest first from the API, so the first entry is the sensible default.
        if (list.length > 0) setVersionId(list[0].id);
        if (list.length === 0) setVersionsError('This modpack has no published versions to build from.');
      })
      .catch((err) => {
        if (!cancelled) setVersionsError(errorMessage(err, 'Could not load versions for this modpack.'));
      })
      .finally(() => {
        if (!cancelled) setVersionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [pack.slug]);

  const chosen = versions.find((v) => v.id === versionId) || null;
  const mcVersion = chosen?.game_versions?.[0];
  const loader = chosen ? primaryLoader(chosen) : null;

  const deploy = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeployError('');

    if (!eulaAccepted) {
      setDeployError('You need to accept the Minecraft EULA before a server can be created.');
      return;
    }
    if (!chosen) {
      setDeployError('Pick which version of the modpack to install.');
      return;
    }

    setDeploying(true);
    try {
      const data = await apiRequest<{ server?: { id: string }; id?: string }>('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: serverName.trim(),
          nodeId,
          serverType: 'MODRINTH',
          modpackSlug: pack.slug,
          // Pinning the version keeps the panel's record in step with what actually gets built.
          mcVersion: mcVersion || 'LATEST',
          executionMode,
          serverPort,
          memoryMb,
          eulaAccepted: true,
        }),
      });

      const serverId = data.server?.id || data.id;
      if (!serverId) throw new Error('The server was created but the panel did not get its id back.');
      onDeployed(serverId);
    } catch (err) {
      setDeployError(errorMessage(err, 'The server could not be created.'));
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Modal
      title={`Set up ${pack.title}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" onClick={onClose} className="cc-btn-ghost" disabled={deploying}>Cancel</button>
          <button type="submit" form="deploy-form" className="cc-btn-primary" disabled={deploying || versionsLoading}>
            {deploying ? 'Creating…' : 'Create server'}
          </button>
        </>
      }
    >
      <form id="deploy-form" onSubmit={deploy} style={{ display: 'grid', gap: '16px' }}>
        {deployError && <InlineError message={deployError} />}

        <div>
          <label className="cc-label" htmlFor="mp-version">Modpack version</label>
          {versionsLoading ? (
            <SkeletonRows rows={1} height={38} />
          ) : versionsError ? (
            <InlineError message={versionsError} />
          ) : (
            <>
              <select
                id="mp-version"
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
                className="cc-input"
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.version_number} — MC {v.game_versions[0] || '?'}
                    {primaryLoader(v) ? ` · ${primaryLoader(v)}` : ''}
                  </option>
                ))}
              </select>
              <p className="cc-help">
                Sets the Minecraft version and the loader for this server. The newest release is
                selected by default.
              </p>
            </>
          )}

          {chosen && (
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
              <Chip tone="accent">Minecraft {mcVersion || 'unknown'}</Chip>
              {loader && <Chip>{loader}</Chip>}
              {chosen.game_versions.length > 1 && <Chip>+{chosen.game_versions.length - 1} more versions</Chip>}
            </div>
          )}
        </div>

        <div>
          <label className="cc-label" htmlFor="mp-name">Server name</label>
          <input
            id="mp-name"
            required
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            className="cc-input"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px' }}>
          <div>
            <label className="cc-label" htmlFor="mp-node">Node</label>
            <select id="mp-node" value={nodeId} onChange={(e) => setNodeId(e.target.value)} className="cc-input">
              <option value="AUTO">Choose automatically</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>{n.name}{n.isOnline === false ? ' (offline)' : ''}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="cc-label" htmlFor="mp-memory">Memory</label>
            <select
              id="mp-memory"
              value={memoryMb}
              onChange={(e) => setMemoryMb(parseInt(e.target.value, 10))}
              className="cc-input"
            >
              <option value={4096}>4 GB</option>
              <option value={6144}>6 GB — recommended</option>
              <option value={8192}>8 GB</option>
              <option value={12288}>12 GB</option>
              <option value={16384}>16 GB</option>
            </select>
            <p className="cc-help">Modpacks need far more than a vanilla server. 6 GB is a safe starting point.</p>
          </div>

          <div style={{ display: advanced ? 'block' : 'none' }}>
            <label className="cc-label" htmlFor="mp-port">Port <AdvancedBadge /></label>
            <input
              id="mp-port"
              type="number"
              value={serverPort}
              onChange={(e) => setServerPort(parseInt(e.target.value, 10) || 24000)}
              className="cc-input"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>

          <div style={{ display: advanced ? 'block' : 'none' }}>
            <label className="cc-label" htmlFor="mp-mode">Execution mode <AdvancedBadge /></label>
            <select
              id="mp-mode"
              value={executionMode}
              onChange={(e) => setExecutionMode(e.target.value as 'PROCESS' | 'DOCKER')}
              className="cc-input"
            >
              <option value="PROCESS">Process</option>
              <option value="DOCKER">Docker container</option>
            </select>
          </div>
        </div>

        {(pack.server_side || '').toLowerCase() === 'unsupported' && (
          <Notice tone="warning">
            The author marks this pack as client-only. The panel will still try to build a server from
            it, but packs flagged this way usually have no server side at all.
          </Notice>
        )}

        <Notice>
          Building a modpack takes a few minutes: the panel downloads every mod the pack lists, installs
          the {loader || 'mod'} loader server, and moves client-only mods aside so it can boot. Progress
          appears in the server&apos;s console as it happens.
        </Notice>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '0.8125rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={eulaAccepted}
            onChange={(e) => setEulaAccepted(e.target.checked)}
            style={{ width: 16, height: 16, marginTop: '2px', accentColor: 'var(--accent)' }}
          />
          <span style={{ color: 'var(--text-primary)' }}>
            I accept the{' '}
            <a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
              Minecraft EULA
            </a>.
          </span>
        </label>
      </form>
    </Modal>
  );
}
