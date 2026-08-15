'use client';

import React, { useState } from 'react';
import { useConfirm } from '@/context/ConfirmContext';
import { useToast } from '@/context/ToastContext';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { Chip, Mono, Notice, PanelHeader } from '@/components/ui';

interface UpdateCenterTabProps {
  server: {
    id: string;
    name: string;
    serverType: string;
    mcVersion: string;
    status: string;
    memoryMb: number;
    serverPort: number;
  };
  canManage?: boolean;
  onUpdateSuccess?: () => void;
}

const ENGINE_OPTIONS = [
  { id: 'FABRIC', name: 'Fabric', desc: 'Lightweight, fast-updating mod loader.', label: 'FA', color: '#a78bfa' },
  { id: 'FORGE', name: 'Forge', desc: 'The classic loader most large modpacks target.', label: 'FO', color: '#fb923c' },
  { id: 'PAPER', name: 'Paper', desc: 'High-performance Spigot/Bukkit plugin server.', label: 'PA', color: '#60a5fa' },
  { id: 'PURPUR', name: 'Purpur', desc: 'Paper fork with many extra config options.', label: 'PU', color: '#c084fc' },
  { id: 'VANILLA', name: 'Vanilla', desc: 'The unmodified server from Mojang.', label: 'VA', color: '#34d399' },
];

const MC_VERSIONS = [
  '26.2', '1.21.4', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.20',
  '1.19.4', '1.19.2', '1.19', '1.18.2', '1.18.1', '1.18', '1.17.1', '1.16.5', '1.12.2', '1.8.9', 'CUSTOM',
];

const DEFAULT_VERSION = '26.2';

export default function UpdateCenterTab({ server, canManage = true, onUpdateSuccess }: UpdateCenterTabProps) {
  const confirm = useConfirm();
  const toast = useToast();

  const [selectedEngine, setSelectedEngine] = useState(server.serverType || 'FABRIC');
  const [selectedMcVersion, setSelectedMcVersion] = useState(server.mcVersion || DEFAULT_VERSION);
  const [customMcVersion, setCustomMcVersion] = useState('');
  const [updating, setUpdating] = useState(false);

  const currentMcVersion = server.mcVersion || DEFAULT_VERSION;
  const effectiveVersion = selectedMcVersion === 'CUSTOM' ? customMcVersion.trim() : selectedMcVersion;
  const isLocked = server.serverType === 'CUSTOM_ZIP';
  const noChange = selectedEngine === server.serverType && effectiveVersion === currentMcVersion;

  const handleApplyUpdate = async () => {
    if (selectedMcVersion === 'CUSTOM' && !customMcVersion.trim()) {
      toast.error('Enter a version', 'Type the snapshot or version string you want to install.');
      return;
    }

    const ok = await confirm({
      title: 'Change the server version?',
      message: (
        <>
          <strong style={{ color: 'var(--text-primary)' }}>{server.name}</strong> will switch from {server.serverType}{' '}
          {currentMcVersion} to <strong style={{ color: 'var(--text-primary)' }}>{selectedEngine} {effectiveVersion}</strong>.
          The server stops, its loader files are replaced, and it restarts.
          <br /><br />
          A safety backup is taken first, and the previous engine files are restored automatically if the download fails.
        </>
      ),
      confirmLabel: 'Apply update',
    });
    if (!ok) return;

    setUpdating(true);
    const toastId = toast.toast('info', 'Updating server engine…', 'Taking a safety backup and downloading the new files.', { sticky: true });
    try {
      await apiPost(`/api/servers/${server.id}/update-engine`, {
        serverType: selectedEngine,
        mcVersion: effectiveVersion,
      });
      toast.toast('success', 'Engine updated', `Now running ${selectedEngine} ${effectiveVersion}.`, { id: toastId });
      onUpdateSuccess?.();
    } catch (err) {
      toast.toast('error', 'Update failed', errorMessage(err), { id: toastId });
    } finally {
      setUpdating(false);
    }
  };

  const handleRepairWorld = async () => {
    const ok = await confirm({
      title: 'Repair the world headers?',
      message:
        'This restores level.dat from its backup copy, or resets invalid generator keys inside it. Your blocks, regions and player inventories are not touched.',
      confirmLabel: 'Repair world',
    });
    if (!ok) return;

    setUpdating(true);
    const toastId = toast.toast('info', 'Repairing world headers…', undefined, { sticky: true });
    try {
      const data = await apiRequest(`/api/servers/${server.id}/repair-world`, { method: 'POST' });
      toast.toast('success', 'World repaired', data?.message, { id: toastId });
      onUpdateSuccess?.();
    } catch (err) {
      toast.toast('error', 'Repair failed', errorMessage(err), { id: toastId });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: '16px', maxWidth: '64rem' }}>
      <PanelHeader
        title="Update Centre"
        chips={<Chip tone="accent">{server.serverType} {currentMcVersion}</Chip>}
        description="Switch between server engines or move to a different Minecraft version. A safety backup is always taken first."
      />

      {isLocked ? (
        <Notice tone="warning">
          <strong>Version locked to serverpack.</strong> This instance was deployed from an uploaded serverpack archive, so its
          engine version (<Mono>{currentMcVersion}</Mono>) comes from the files in that archive and can&apos;t be changed here.
        </Notice>
      ) : (
        <>
          {/* Engine */}
          <section className="cc-panel">
            <h3 className="cc-section-title" style={{ marginBottom: '4px' }}>1. Server engine</h3>
            <p className="cc-section-sub" style={{ marginBottom: '14px' }}>
              Changing loader family usually means your existing mods need replacing.
            </p>

            <div role="radiogroup" aria-label="Server engine" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
              {ENGINE_OPTIONS.map((eng) => {
                const isSelected = selectedEngine === eng.id;
                return (
                  /* A real button, so the choice is reachable by keyboard and announced correctly. */
                  <button
                    key={eng.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedEngine(eng.id)}
                    disabled={!canManage || updating}
                    style={{
                      textAlign: 'left', padding: '14px', borderRadius: '8px', cursor: canManage ? 'pointer' : 'not-allowed',
                      background: isSelected ? 'var(--accent-dim)' : 'var(--bg)',
                      border: `1px solid ${isSelected ? 'var(--accent-border)' : 'var(--border-2)'}`,
                      display: 'grid', gap: '10px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span
                        style={{
                          width: 30, height: 30, borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontFamily: 'var(--font-mono)', fontSize: '0.68rem', fontWeight: 900,
                          background: `${eng.color}20`, color: eng.color, border: `1px solid ${eng.color}40`,
                        }}
                      >
                        {eng.label}
                      </span>
                      {isSelected && <Chip tone="accent">Selected</Chip>}
                    </div>
                    <div>
                      <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{eng.name}</div>
                      <div className="cc-help">{eng.desc}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Version */}
          <section className="cc-panel">
            <h3 className="cc-section-title" style={{ marginBottom: '14px' }}>2. Minecraft version</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
              <div>
                <label className="cc-label" htmlFor="uc-version">Release version</label>
                <select
                  id="uc-version"
                  value={selectedMcVersion}
                  onChange={(e) => setSelectedMcVersion(e.target.value)}
                  disabled={!canManage || updating}
                  className="cc-input"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {MC_VERSIONS.map((ver) => (
                    <option key={ver} value={ver}>{ver === 'CUSTOM' ? 'Custom / snapshot…' : `Minecraft ${ver}`}</option>
                  ))}
                </select>
              </div>

              {selectedMcVersion === 'CUSTOM' && (
                <div>
                  <label className="cc-label" htmlFor="uc-custom">Custom version string</label>
                  <input
                    id="uc-custom"
                    value={customMcVersion}
                    onChange={(e) => setCustomMcVersion(e.target.value)}
                    placeholder="24w10a"
                    disabled={!canManage || updating}
                    className="cc-input"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  />
                  <p className="cc-help">Any version string the loader recognises, e.g. a snapshot id.</p>
                </div>
              )}
            </div>
          </section>

          {/* Apply */}
          <section className="cc-panel" style={{ display: 'grid', gap: '16px' }}>
            <h3 className="cc-section-title" style={{ margin: 0 }}>3. Apply</h3>

            <Notice>
              A safety backup of the world, configs and player data is taken before the new engine is downloaded, and the
              previous engine is restored automatically if that download fails. This can&apos;t be skipped.
            </Notice>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                Target: <strong style={{ color: 'var(--text-primary)' }}>{selectedEngine} {effectiveVersion || '—'}</strong>
                {noChange && ' (already current)'}
              </span>
              {canManage && (
                <button onClick={handleApplyUpdate} disabled={updating || noChange || !effectiveVersion} className="cc-btn-primary">
                  {updating ? 'Updating…' : 'Apply update'}
                </button>
              )}
            </div>
          </section>
        </>
      )}

      {/* World repair */}
      <section className="cc-panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 className="cc-section-title" style={{ margin: 0 }}>World header repair</h3>
            <p className="cc-section-sub">
              Fixes <Mono>WorldGenSettings: No key dimensions in MapLike</Mono> startup crashes caused by a corrupted
              level.dat or a version downgrade. Blocks and inventories are left untouched.
            </p>
          </div>
          {canManage && (
            <button onClick={handleRepairWorld} disabled={updating} className="cc-btn-ghost">
              Repair world header
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
