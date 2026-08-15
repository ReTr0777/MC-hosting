'use client';

import React, { useEffect, useRef, useState } from 'react';
import { apiRequest, errorMessage } from '@/lib/api';
import { usePolledResource } from '@/hooks/usePolledResource';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { Chip, InlineError, LoadingLine, Notice, PanelHeader, StatTile } from '@/components/ui';

interface SleepConfig {
  sleepEnabled: boolean;
  sleepAfterMinutes: number;
  autoRestartEnabled: boolean;
}

interface DaemonSleep {
  sleeping: boolean;
  state: 'sleeping' | 'waking' | null;
  port: number | null;
  sleptAt?: string | null;
  lastWakeError?: string | null;
}

interface SleepSnapshot {
  config: SleepConfig;
  status: string;
  sleepEmptySince: string | null;
  lastSleptAt: string | null;
  lastWokeAt: string | null;
  daemon: DaemonSleep | null;
  daemonError: string | null;
  crashCount: number;
  crashWindowStartedAt: string | null;
}

const PRESETS = [5, 10, 15, 30, 60, 120];

const DEFAULT_CONFIG: SleepConfig = { sleepEnabled: false, sleepAfterMinutes: 15, autoRestartEnabled: false };

const EMPTY: SleepSnapshot = {
  config: DEFAULT_CONFIG,
  status: '',
  sleepEmptySince: null,
  lastSleptAt: null,
  lastWokeAt: null,
  daemon: null,
  daemonError: null,
  crashCount: 0,
  crashWindowStartedAt: null,
};

function relative(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const formatPreset = (m: number) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hr` : `${m} min`);

export default function SleepTab({
  serverId,
  serverStatus,
  canManage,
  onChanged,
}: {
  serverId: string;
  serverStatus: string;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(DEFAULT_CONFIG.sleepAfterMinutes);

  const { data: snap, loading, error, refresh } = usePolledResource<SleepSnapshot>(
    `/api/servers/${serverId}/sleep`,
    EMPTY,
    { intervalMs: 15000, select: (raw) => ({ ...EMPTY, ...raw, config: { ...DEFAULT_CONFIG, ...raw?.config } }) }
  );

  const config = snap.config;

  // Only follow the server's value when the server's value actually changes. Copying it on every
  // poll would wipe out a custom number the user is part-way through typing.
  const lastServerMinutes = useRef<number | null>(null);
  useEffect(() => {
    if (lastServerMinutes.current !== config.sleepAfterMinutes) {
      lastServerMinutes.current = config.sleepAfterMinutes;
      setMinutes(config.sleepAfterMinutes);
    }
  }, [config.sleepAfterMinutes]);

  const saveConfig = async (patch: Partial<SleepConfig>) => {
    setBusy('config');
    try {
      await apiRequest(`/api/servers/${serverId}/sleep`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      toast.success('Sleep settings saved');
      await refresh();
    } catch (err) {
      toast.error('Could not save sleep settings', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: 'sleep' | 'wake' | 'cancel') => {
    if (kind === 'sleep') {
      const ok = await confirm({
        title: 'Put this server to sleep?',
        message:
          'The server process stops now. It stays listed as online, and the next player who joins wakes it — that first player is asked to reconnect after about 30 seconds.',
        confirmLabel: 'Sleep now',
      });
      if (!ok) return;
    }
    if (kind === 'cancel') {
      const ok = await confirm({
        title: 'Stop holding the port?',
        message:
          'The node will release this server\'s port. Players will see it as offline instead of sleeping, and joining will no longer wake it automatically.',
        confirmLabel: 'Stop holding',
        danger: true,
      });
      if (!ok) return;
    }

    setBusy(kind);
    try {
      const url = kind === 'wake' ? `/api/servers/${serverId}/wake` : `/api/servers/${serverId}/sleep`;
      const data = await apiRequest(url, { method: kind === 'cancel' ? 'DELETE' : 'POST' });
      toast.success(data?.message || (kind === 'wake' ? 'Waking the server' : 'Done'));
      await refresh();
      onChanged?.();
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <LoadingLine>Loading sleep settings…</LoadingLine>;

  const sleeping = Boolean(snap.status === 'SLEEPING' || snap.daemon?.sleeping);
  const running = serverStatus === 'RUNNING';
  const state = sleeping ? 'Sleeping' : running ? 'Awake' : 'Offline';

  const emptyForMins = snap.sleepEmptySince
    ? Math.floor((Date.now() - new Date(snap.sleepEmptySince).getTime()) / 60000)
    : null;
  const remaining = emptyForMins !== null ? Math.max(0, config.sleepAfterMinutes - emptyForMins) : null;

  return (
    <div className="animate-fadeIn" style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader
        title="Sleep & Auto-restart"
        chips={<Chip tone={sleeping ? 'warning' : running ? 'accent' : 'default'}>{state}</Chip>}
        description="When nobody is online the server can stop itself to free memory and CPU. It stays visible in the multiplayer list, and starts back up the moment someone joins."
        actions={
          canManage && (
            sleeping ? (
              <>
                <button onClick={() => act('wake')} disabled={busy !== null} className="cc-btn-primary">
                  {busy === 'wake' ? 'Waking…' : 'Wake now'}
                </button>
                <button onClick={() => act('cancel')} disabled={busy !== null} className="cc-btn-ghost">
                  Stop holding port
                </button>
              </>
            ) : (
              <button
                onClick={() => act('sleep')}
                disabled={busy !== null || !running}
                title={running ? 'Stop the server but keep it listed as online' : 'The server must be running before it can sleep'}
                className="cc-btn-ghost"
              >
                {busy === 'sleep' ? 'Sleeping…' : 'Sleep now'}
              </button>
            )
          )
        }
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      {snap.daemonError && (
        <Notice tone="warning">Could not read live sleep state from the node: {snap.daemonError}</Notice>
      )}

      {sleeping && (
        <Notice>
          The node is holding port <strong style={{ color: 'var(--text-primary)' }}>{snap.daemon?.port ?? '—'}</strong> for
          this server. Players see it as online with a “sleeping” message, and joining wakes it automatically — they are
          asked to reconnect once after about 30 seconds.
          {snap.daemon?.lastWakeError && (
            <div style={{ marginTop: '8px', color: 'var(--danger)' }}>Last wake attempt failed: {snap.daemon.lastWakeError}</div>
          )}
        </Notice>
      )}

      {!sleeping && running && config.sleepEnabled && (
        <Notice>
          {emptyForMins === null ? (
            <>Players are online (or the server hasn&apos;t been polled yet). The idle timer starts once it is empty.</>
          ) : (
            <>
              Empty for <strong style={{ color: 'var(--text-primary)' }}>{emptyForMins} min</strong> — sleeping in{' '}
              <strong style={{ color: 'var(--accent)' }}>{remaining} min</strong> unless somebody joins.
            </>
          )}
        </Notice>
      )}

      {/* Sleep settings */}
      <section className="cc-panel" style={{ display: 'grid', gap: '18px' }}>
        <ToggleRow
          title="Sleep when empty"
          help="Automatically stop the server after a period with no players."
          checked={config.sleepEnabled}
          disabled={!canManage || busy !== null}
          onChange={(v) => saveConfig({ sleepEnabled: v })}
        />

        <div style={{ opacity: config.sleepEnabled ? 1 : 0.45, pointerEvents: config.sleepEnabled ? 'auto' : 'none' }}>
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>Idle time before sleeping</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
            {PRESETS.map((preset) => {
              const active = config.sleepAfterMinutes === preset;
              return (
                <button
                  key={preset}
                  onClick={() => saveConfig({ sleepAfterMinutes: preset })}
                  disabled={!canManage || busy !== null}
                  aria-pressed={active}
                  className="cc-btn-ghost"
                  style={active ? { background: 'var(--accent-dim)', color: 'var(--accent)', borderColor: 'var(--accent-border)', fontWeight: 700 } : undefined}
                >
                  {formatPreset(preset)}
                </button>
              );
            })}

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
              <label className="cc-label" htmlFor="sleep-custom" style={{ margin: 0 }}>Custom</label>
              <input
                id="sleep-custom"
                type="number"
                min={1}
                max={1440}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                disabled={!canManage}
                className="cc-input"
                style={{ width: '90px' }}
              />
              <button
                onClick={() => saveConfig({ sleepAfterMinutes: minutes })}
                disabled={!canManage || busy !== null || minutes === config.sleepAfterMinutes || minutes < 1 || minutes > 1440}
                className="cc-btn-ghost"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Crash auto-restart */}
      <section className="cc-panel" style={{ display: 'grid', gap: '10px' }}>
        <ToggleRow
          title="Auto-restart on crash"
          help="If the process dies unexpectedly, restart it automatically. Pauses after 3 crashes in 30 minutes to avoid a restart loop."
          checked={config.autoRestartEnabled}
          disabled={!canManage || busy !== null}
          onChange={(v) => saveConfig({ autoRestartEnabled: v })}
        />
        {config.autoRestartEnabled && snap.crashCount > 0 && (
          <p style={{ fontSize: '0.75rem', color: 'var(--warning)', margin: 0 }}>
            {snap.crashCount} crash{snap.crashCount === 1 ? '' : 'es'} in the current 30-minute window
            {snap.crashCount >= 3 ? ' — auto-restart is paused until the window expires or you restart manually.' : '.'}
          </p>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
        <StatTile label="Last slept" value={relative(snap.lastSleptAt)} />
        <StatTile label="Last woke" value={relative(snap.lastWokeAt)} />
      </div>

      <Notice>
        <strong style={{ color: 'var(--text-primary)' }}>Worth knowing:</strong> waking takes as long as a normal start —
        usually 20–60 seconds, longer for big modpacks. The first player to knock is disconnected with a “waking up”
        message and needs to reconnect. Everyone joining after that connects normally.
      </Notice>
    </div>
  );
}

function ToggleRow({
  title, help, checked, disabled, onChange,
}: { title: string; help: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        <span className="cc-help" style={{ display: 'block' }}>{help}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, accentColor: 'var(--accent)', flexShrink: 0, cursor: 'inherit' }}
      />
    </label>
  );
}
