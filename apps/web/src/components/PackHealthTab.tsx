'use client';

import React, { useMemo, useState } from 'react';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import {
  Chip, ChipTone, EmptyState, InlineError, LoadingLine, Mono, Notice, PanelHeader, StatTile,
} from '@/components/ui';

type QuarantineReason =
  | 'denylist'
  | 'declared-client'
  | 'modrinth-client'
  | 'filename-hint'
  | 'missing-dependency';

interface QuarantinedMod {
  fileName: string;
  reason: QuarantineReason;
  detail: string;
  missingDependency?: string;
}

interface UnresolvedDependency {
  id: string;
  hard: boolean;
  requiredBy: string[];
}

interface PackHealth {
  generatedAt: string | null;
  scanned: number;
  quarantined: QuarantinedMod[];
  unresolved: UnresolvedDependency[];
  unidentified: string[];
}

const EMPTY: PackHealth = {
  generatedAt: null,
  scanned: 0,
  quarantined: [],
  unresolved: [],
  unidentified: [],
};

/**
 * How confident the scan was, shown next to each disabled mod. Restoring a `denylist` or
 * `declared-client` mod is almost certainly a mistake; restoring a `filename-hint` one often isn't,
 * and the label is what tells those apart at a glance.
 */
const REASON_LABEL: Record<QuarantineReason, { label: string; tone: ChipTone; confident: boolean }> = {
  denylist: { label: 'Known bad on servers', tone: 'danger', confident: true },
  'declared-client': { label: 'Declares client-only', tone: 'danger', confident: true },
  'modrinth-client': { label: 'Modrinth: client-side', tone: 'warning', confident: true },
  'filename-hint': { label: 'Matched by filename', tone: 'warning', confident: false },
  'missing-dependency': { label: 'Missing dependency', tone: 'warning', confident: false },
};

/** Strips version suffixes so `sodium-fabric-0.5.8.jar` reads as `sodium-fabric`. */
function prettyName(fileName: string): string {
  return fileName.replace(/\.jar$/i, '').replace(/[-_](\d[\d.+]*.*)$/, '');
}

export default function PackHealthTab({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const { data, loading, error, refresh } = usePolledResource<PackHealth>(
    `/api/servers/${serverId}/pack-health`,
    EMPTY,
    { select: (raw) => ({ ...EMPTY, ...raw }) }
  );

  const toggleMod = async (mod: QuarantinedMod | string, enable: boolean) => {
    const fileName = typeof mod === 'string' ? mod : mod.fileName;
    const reason = typeof mod === 'string' ? null : REASON_LABEL[mod.reason];

    if (enable && reason?.confident) {
      const ok = await confirm({
        title: `Re-enable ${prettyName(fileName)}?`,
        message:
          `This mod was disabled because ${reason.label.toLowerCase()}. Putting it back will most likely stop the ` +
          `server booting. Only do this if you know the scan got it wrong.`,
        confirmLabel: 'Re-enable anyway',
        danger: true,
      });
      if (!ok) return;
    }

    setBusy(fileName);
    try {
      await apiPost(`/api/servers/${serverId}/pack-health`, { fileName, enable });
      toast.success(
        enable ? `${prettyName(fileName)} re-enabled` : `${prettyName(fileName)} disabled`,
        'Restart the server for the change to take effect.'
      );
      await refresh();
    } catch (err) {
      toast.error('Could not move that mod', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const needle = filter.trim().toLowerCase();
  const visibleDisabled = useMemo(
    () => (needle ? data.quarantined.filter((q) => q.fileName.toLowerCase().includes(needle)) : data.quarantined),
    [data.quarantined, needle]
  );

  const hardMisses = data.unresolved.filter((u) => u.hard);
  const softMisses = data.unresolved.filter((u) => !u.hard);

  if (loading) return <LoadingLine>Reading mod metadata from the server…</LoadingLine>;

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader
        title="Pack health"
        chips={
          <>
            <Chip tone="accent">{data.scanned} active</Chip>
            {data.quarantined.length > 0 && <Chip tone="warning">{data.quarantined.length} disabled</Chip>}
            {hardMisses.length > 0 && <Chip tone="danger">{hardMisses.length} unresolved</Chip>}
          </>
        }
        description={
          <>
            What the installer did to this modpack, and why. Client-only mods are moved to{' '}
            <Mono>client-mods-disabled/</Mono> rather than deleted, so anything here can be put back.
          </>
        }
        actions={<button onClick={refresh} className="cc-btn-ghost">Re-scan</button>}
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
        <StatTile label="Mods loading" value={data.scanned} tone="accent" />
        <StatTile
          label="Disabled"
          value={data.quarantined.length}
          tone={data.quarantined.length > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label="Missing deps"
          value={hardMisses.length}
          tone={hardMisses.length > 0 ? 'danger' : 'default'}
        />
        <StatTile label="Unverified" value={data.unidentified.length} />
      </div>

      {hardMisses.length > 0 && (
        <Notice tone="warning">
          {hardMisses.length === 1 ? 'One mod requires' : `${hardMisses.length} mods require`} something that isn&apos;t
          installed. Fabric aborts the entire boot on an unsatisfied hard dependency rather than skipping the mod that
          wants it, so these were disabled to let the server start.
        </Notice>
      )}

      {/* Unresolved dependencies — the list that explains a feature silently not working. */}
      {data.unresolved.length > 0 && (
        <div className="cc-panel" style={{ display: 'grid', gap: '12px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '15px' }}>Missing dependencies</h3>
            <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
              Mod ids nothing in <Mono>mods/</Mono> provides. Install these to restore whatever needed them.
            </p>
          </div>

          <div style={{ display: 'grid', gap: '8px' }}>
            {[...hardMisses, ...softMisses].map((dep) => (
              <div
                key={dep.id}
                style={{
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  background: 'var(--surface-2, rgba(255,255,255,0.03))',
                }}
              >
                <Chip tone={dep.hard ? 'danger' : 'default'}>{dep.hard ? 'Required' : 'Optional'}</Chip>
                <Mono>{dep.id}</Mono>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)', flex: 1, minWidth: '180px' }}>
                  wanted by {dep.requiredBy.slice(0, 3).map(prettyName).join(', ')}
                  {dep.requiredBy.length > 3 ? ` and ${dep.requiredBy.length - 3} more` : ''}
                </span>
                <a
                  href={`https://modrinth.com/mods?q=${encodeURIComponent(dep.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="cc-btn-ghost"
                  style={{ textDecoration: 'none' }}
                >
                  Find on Modrinth
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Disabled mods */}
      <div className="cc-panel" style={{ display: 'grid', gap: '12px' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '15px' }}>Disabled mods</h3>
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
            Moved out of <Mono>mods/</Mono> so the server could boot. Re-enabling takes effect on the next restart.
          </p>
        </div>

        {data.quarantined.length > 6 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter disabled mods…"
            aria-label="Filter disabled mods"
            className="cc-input"
          />
        )}

        {data.quarantined.length === 0 ? (
          <EmptyState
            title="Nothing was disabled"
            description="Every mod in this pack is server-compatible as far as the scan could tell."
          />
        ) : visibleDisabled.length === 0 ? (
          <EmptyState title="No matches" description={`Nothing disabled matches "${filter.trim()}".`} />
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {visibleDisabled.map((mod) => {
              const meta = REASON_LABEL[mod.reason] ?? REASON_LABEL['declared-client'];
              return (
                <div
                  key={mod.fileName}
                  style={{
                    display: 'flex',
                    gap: '12px',
                    alignItems: 'flex-start',
                    flexWrap: 'wrap',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'var(--surface-2, rgba(255,255,255,0.03))',
                  }}
                >
                  <div style={{ flex: 1, minWidth: '220px' }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: '14px' }}>{prettyName(mod.fileName)}</strong>
                      <Chip tone={meta.tone}>{meta.label}</Chip>
                    </div>
                    <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>{mod.detail}</p>
                    <p style={{ margin: '2px 0 0', fontSize: '11px', color: 'var(--text-tertiary, var(--text-secondary))' }}>
                      <Mono>{mod.fileName}</Mono>
                    </p>
                  </div>
                  {canManage && (
                    <button
                      onClick={() => toggleMod(mod, true)}
                      disabled={busy === mod.fileName}
                      className="cc-btn-ghost"
                    >
                      {busy === mod.fileName ? 'Moving…' : 'Re-enable'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Unidentifiable mods — kept deliberately, but worth knowing about. */}
      {data.unidentified.length > 0 && (
        <div className="cc-panel" style={{ display: 'grid', gap: '10px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '15px' }}>Couldn&apos;t verify</h3>
            <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
              These jars declare no side and aren&apos;t on Modrinth, so nothing could confirm they run on a server. They
              are left enabled on purpose — a mod removed by mistake is a much harder problem than one that crashes with a
              named cause. If a boot fails with no other explanation, start here.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {data.unidentified.map((fileName) => (
              <span key={fileName} style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                <Chip>{prettyName(fileName)}</Chip>
                {canManage && (
                  <button
                    onClick={() => toggleMod(fileName, false)}
                    disabled={busy === fileName}
                    className="cc-btn-ghost"
                    style={{ padding: '2px 8px', fontSize: '12px' }}
                    title={`Move ${fileName} out of mods/`}
                  >
                    {busy === fileName ? '…' : 'Disable'}
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {data.generatedAt && (
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)' }}>
          Reasons recorded at install time ({new Date(data.generatedAt).toLocaleString()}). Dependencies are re-checked
          every time this tab opens.
        </p>
      )}
    </div>
  );
}
