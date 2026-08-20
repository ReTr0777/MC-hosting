'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { InlineError, LoadingLine, Mono, Notice, PanelHeader } from '@/components/ui';
import {
  TERRARIA_SECRET_SEEDS, TERRARIA_WORLD_EVILS, TerrariaVariant,
  TERRARIA_VERSIONS, TMODLOADER_BUILDS, DEFAULT_TERRARIA_VERSION, DEFAULT_TMODLOADER_VERSION,
} from '@mc-manager/shared';
import { useConfirm } from '@/context/ConfirmContext';

/**
 * Terraria's `serverconfig.txt` editor.
 *
 * A sibling of `PropertiesTab` rather than a generalisation of it. That file is
 * the Minecraft Settings tab and is heavily shaped around Minecraft concepts —
 * gamemode, the Nether, view distance, the multiplayer-list icon — none of which
 * exist here. Copying it and rewriting the fields is the same trade plan.md §2
 * makes on the daemon side: a little duplication instead of a risky rewrite of a
 * working Minecraft surface.
 *
 * Both tabs talk to the same comment-preserving merge on the daemon, so an
 * operator's hand-edits and comments survive a save from here.
 */

interface TerrariaSettingsTabProps {
  serverId: string;
  canManage?: boolean;
  /** Current variant, so the panel can offer the other one. Absent reads as vanilla. */
  variant?: TerrariaVariant;
  terrariaVersion?: string;
  tmodloaderVersion?: string;
  serverStatus?: string;
  /** Refetches the server after a conversion, so the Mods tab appears without a reload. */
  onVariantChanged?: () => void;
}

type Props = Record<string, string>;

const DIFFICULTY_LABELS: Record<string, string> = {
  '0': 'Classic', '1': 'Expert', '2': 'Master', '3': 'Journey',
};
const SIZE_LABELS: Record<string, string> = { '1': 'Small', '2': 'Medium', '3': 'Large' };

/**
 * Settings Terraria reads **only while generating a world**.
 *
 * They stay in the file afterwards but changing them does nothing — the values
 * are baked into the `.wld`. Shown read-only for that reason: offering them as
 * inputs would invite an edit that silently accomplishes nothing.
 */
const GENERATION_ONLY: Array<{ key: string; label: string; format?: (v: string) => string }> = [
  { key: 'worldname', label: 'World name' },
  { key: 'autocreate', label: 'World size', format: (v) => SIZE_LABELS[v] ?? v },
  { key: 'difficulty', label: 'Difficulty', format: (v) => DIFFICULTY_LABELS[v] ?? v },
  {
    key: 'evil',
    label: 'World evil',
    format: (v) => TERRARIA_WORLD_EVILS.find((e) => e.id === v)?.label ?? v,
  },
  { key: 'seed', label: 'Seed' },
];

/**
 * Keys the daemon rewrites on every start (world paths, port, language, upnp).
 *
 * Shown read-only rather than hidden: an operator who opens the file will see
 * them, and silently discarding an edit made here would be worse than saying up
 * front that the panel owns them.
 */
const PANEL_OWNED = ['world', 'worldpath', 'port', 'language', 'upnp'];

/** Process priority, as Terraria numbers it. */
const PRIORITIES: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Realtime' },
  { value: '1', label: 'High' },
  { value: '2', label: 'Above normal' },
  { value: '3', label: 'Normal' },
  { value: '4', label: 'Below normal' },
  { value: '5', label: 'Idle' },
];

/**
 * Journey-mode powers, each independently permissioned.
 *
 * Only meaningful on a Journey world, so the whole section is hidden otherwise
 * rather than shown inert.
 */
const JOURNEY_POWERS: Array<{ key: string; label: string }> = [
  { key: 'journeypermission_time_setfrozen', label: 'Freeze time' },
  { key: 'journeypermission_time_setdawn', label: 'Set time to dawn' },
  { key: 'journeypermission_time_setnoon', label: 'Set time to noon' },
  { key: 'journeypermission_time_setdusk', label: 'Set time to dusk' },
  { key: 'journeypermission_time_setmidnight', label: 'Set time to midnight' },
  { key: 'journeypermission_time_setspeed', label: 'Change time speed' },
  { key: 'journeypermission_godmode', label: 'God mode' },
  { key: 'journeypermission_wind_setstrength', label: 'Set wind strength' },
  { key: 'journeypermission_wind_setfrozen', label: 'Freeze wind' },
  { key: 'journeypermission_rain_setstrength', label: 'Set rain strength' },
  { key: 'journeypermission_rain_setfrozen', label: 'Freeze rain' },
  { key: 'journeypermission_increaseplacementrange', label: 'Increased placement range' },
  { key: 'journeypermission_setdifficulty', label: 'Change difficulty' },
  { key: 'journeypermission_biomespread_setfrozen', label: 'Freeze biome spread' },
  { key: 'journeypermission_setspawnrate', label: 'Set spawn rate' },
];

const JOURNEY_LEVELS: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Nobody' },
  { value: '1', label: 'Host only' },
  { value: '2', label: 'Everyone' },
];

export default function TerrariaSettingsTab({
  serverId, canManage = true, variant = 'VANILLA', terrariaVersion, tmodloaderVersion,
  serverStatus, onVariantChanged,
}: TerrariaSettingsTabProps) {
  const toast = useToast();

  const [properties, setProperties] = useState<Props>({});
  const [saved, setSaved] = useState<Props>({});
  const [fileName, setFileName] = useState('serverconfig.txt');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest(`/api/servers/${serverId}/gameconfig`);
      if (!mounted.current) return;
      const next: Props = data?.properties || {};
      setProperties(next);
      setSaved(next);
      if (data?.file) setFileName(data.file);
      setLoadError(null);
    } catch (err) {
      if (mounted.current) setLoadError(errorMessage(err, 'Could not load serverconfig.txt'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [serverId]);

  useEffect(() => { load(); }, [load]);

  const dirtyKeys = useMemo(
    () => Object.keys({ ...saved, ...properties }).filter((k) => (properties[k] ?? '') !== (saved[k] ?? '')),
    [properties, saved]
  );
  const isDirty = dirtyKeys.length > 0;

  // `seed_notthebees=1` and friends — reported as labels rather than raw keys.
  const secretSeedsInUse = useMemo(
    () => TERRARIA_SECRET_SEEDS
      .filter((s) => properties[`seed_${s.id}`] === '1')
      .map((s) => s.label),
    [properties]
  );

  useEffect(() => {
    if (!isDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const handleChange = (key: string, value: string) => {
    setProperties((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Only what actually changed, so a key the operator added by hand and never
      // touched here is not rewritten.
      const changed: Props = {};
      for (const key of dirtyKeys) changed[key] = properties[key] ?? '';

      await apiPost(`/api/servers/${serverId}/gameconfig`, { properties: changed });
      if (!mounted.current) return;
      setSaved(properties);
      toast.success('Settings saved. Restart the server for them to take effect.');
    } catch (err) {
      if (mounted.current) toast.error(errorMessage(err, 'Could not save settings'));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  if (loading) return <LoadingLine>Loading world settings…</LoadingLine>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader
        title="World settings"
        description={<>Edited in <Mono>{fileName}</Mono>. Changes apply the next time the server starts.</>}
        actions={
          canManage && (
            <button onClick={handleSave} disabled={saving || !isDirty} className="cc-btn-primary">
              {saving ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
            </button>
          )
        }
      />

      {loadError && <InlineError message={loadError} onRetry={load} />}

      <VariantPanel
        serverId={serverId}
        variant={variant}
        terrariaVersion={terrariaVersion}
        tmodloaderVersion={tmodloaderVersion}
        serverStatus={serverStatus}
        canManage={canManage}
        onChanged={onVariantChanged}
      />

      <section className="cc-panel">
        <h3 className="cc-section-title" style={{ marginBottom: '14px' }}>Players &amp; access</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
          <Field label="Max players" htmlFor="t-maxplayers" help="Terraria allows up to 255, but 8–16 is typical.">
            <input
              id="t-maxplayers"
              type="number"
              min={1}
              max={255}
              className="cc-input"
              value={properties['maxplayers'] ?? '8'}
              onChange={(e) => handleChange('maxplayers', e.target.value)}
              disabled={!canManage}
            />
          </Field>

          <Field
            label="Server password"
            htmlFor="t-password"
            help="Players must enter this to join. Leave empty for an open server."
          >
            <input
              id="t-password"
              className="cc-input"
              value={properties['password'] ?? ''}
              onChange={(e) => handleChange('password', e.target.value)}
              placeholder="No password"
              disabled={!canManage}
            />
          </Field>

          <Field label="Message of the day" htmlFor="t-motd" help="Shown to players as they connect.">
            <input
              id="t-motd"
              className="cc-input"
              value={properties['motd'] ?? ''}
              onChange={(e) => handleChange('motd', e.target.value)}
              disabled={!canManage}
            />
          </Field>

          <Field label="Cheat protection" htmlFor="t-secure" help="Terraria's `secure` mode. Recommended for a public server.">
            <select
              id="t-secure"
              className="cc-input"
              value={properties['secure'] ?? '1'}
              onChange={(e) => handleChange('secure', e.target.value)}
              disabled={!canManage}
            >
              <option value="1">On</option>
              <option value="0">Off</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="cc-panel">
        <h3 className="cc-section-title" style={{ marginBottom: '14px' }}>Performance</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
          <Field
            label="Enemy update rate"
            htmlFor="t-npcstream"
            help="Lower means smoother enemy movement but more bandwidth. 0 turns the limit off."
          >
            <input
              id="t-npcstream"
              type="number"
              min={0}
              className="cc-input"
              value={properties['npcstream'] ?? '60'}
              onChange={(e) => handleChange('npcstream', e.target.value)}
              disabled={!canManage}
            />
          </Field>

          <Field label="Process priority" htmlFor="t-priority" help="How much CPU the server asks for relative to everything else on the node.">
            <select
              id="t-priority"
              className="cc-input"
              value={properties['priority'] ?? '1'}
              onChange={(e) => handleChange('priority', e.target.value)}
              disabled={!canManage}
            >
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>

          <Field label="Slow liquids" htmlFor="t-slowliquids" help="Caps how much water and lava moves at once. Reduces lag; liquids settle more slowly.">
            <select
              id="t-slowliquids"
              className="cc-input"
              value={properties['slowliquids'] ?? '0'}
              onChange={(e) => handleChange('slowliquids', e.target.value)}
              disabled={!canManage}
            >
              <option value="0">Off</option>
              <option value="1">On</option>
            </select>
          </Field>

          <Field label="Rolling world backups" htmlFor="t-rollbacks" help="How many of Terraria's own world backups to keep, separate from panel backups.">
            <input
              id="t-rollbacks"
              type="number"
              min={0}
              className="cc-input"
              value={properties['worldrollbackstokeep'] ?? '2'}
              onChange={(e) => handleChange('worldrollbackstokeep', e.target.value)}
              disabled={!canManage}
            />
          </Field>
        </div>
      </section>

      {/* Journey powers only exist on a Journey world. */}
      {properties['difficulty'] === '3' && (
        <section className="cc-panel">
          <h3 className="cc-section-title" style={{ marginBottom: '6px' }}>Journey powers</h3>
          <p className="cc-help" style={{ margin: '0 0 14px' }}>
            Who may use each Journey-mode power. Defaults to everyone.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' }}>
            {JOURNEY_POWERS.map((p) => (
              <div key={p.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <label className="cc-label" htmlFor={p.key} style={{ margin: 0 }}>{p.label}</label>
                <select
                  id={p.key}
                  className="cc-input"
                  style={{ width: 'auto', minWidth: '120px' }}
                  value={properties[p.key] ?? '2'}
                  onChange={(e) => handleChange(p.key, e.target.value)}
                  disabled={!canManage}
                >
                  {JOURNEY_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="cc-panel">
        <h3 className="cc-section-title" style={{ marginBottom: '6px' }}>Fixed when the world was created</h3>
        <p className="cc-help" style={{ margin: '0 0 14px' }}>
          Terraria bakes these into the world file as it generates it. They stay in the config for
          reference, but changing them has no effect — a new world is the only way to change them.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          {GENERATION_ONLY.filter((g) => properties[g.key] !== undefined).map((g) => (
            <ReadOnlyValue key={g.key} label={g.label} value={g.format ? g.format(properties[g.key]) : properties[g.key]} />
          ))}
          {secretSeedsInUse.length > 0 && (
            <ReadOnlyValue label="Special world" value={secretSeedsInUse.join(', ')} />
          )}
        </div>
      </section>

      <section className="cc-panel">
        <h3 className="cc-section-title" style={{ marginBottom: '14px' }}>Managed by the panel</h3>
        <Notice>
          These are rewritten every time the server starts, so that the world stays where the panel
          expects it and the player list keeps working. Change the port under Resources instead.
        </Notice>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px', marginTop: '12px' }}>
          {PANEL_OWNED.filter((key) => properties[key] !== undefined).map((key) => (
            <ReadOnlyValue key={key} label={key} value={properties[key]} mono />
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Switch between vanilla Terraria and tModLoader.
 *
 * Unlike everything else on this tab, this does not edit `serverconfig.txt` — it changes
 * which binary the server runs, so it goes through its own route, which takes a backup
 * first and refuses while the server is up.
 *
 * The two directions are not equally safe, and the warning says so rather than being
 * symmetrical: tModLoader reads a vanilla world happily, but vanilla cannot read modded
 * content and drops it silently instead of refusing to load.
 */
function VariantPanel({
  serverId, variant, terrariaVersion, tmodloaderVersion, serverStatus, canManage, onChanged,
}: {
  serverId: string;
  variant: TerrariaVariant;
  terrariaVersion?: string;
  tmodloaderVersion?: string;
  serverStatus?: string;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const isModded = variant === 'TMODLOADER';
  const target: TerrariaVariant = isModded ? 'VANILLA' : 'TMODLOADER';
  // SLEEPING counts as running: the next player to connect starts it.
  const stopped = serverStatus === 'OFFLINE' || serverStatus === 'ERROR';

  const changeVersion = async (version: string) => {
    const ok = await confirm({
      title: `Run ${isModded ? 'tModLoader' : 'Terraria'} ${version}?`,
      message: isModded
        ? 'Every mod installed here is compiled against the current build and will stop loading. You will need to upload versions built for the new one. A backup is taken first.'
        : 'The world was generated by the current version and stays in its format. Moving to an older version may make it unreadable. A backup is taken first.',
      confirmLabel: 'Change version',
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    try {
      const data = await apiPost<{ message: string; backupName?: string }>(
        `/api/servers/${serverId}/variant`,
        { variant, version }
      );
      toast.success(data.message, data.backupName ? `Backed up as "${data.backupName}" first.` : undefined);
      onChanged?.();
    } catch (err) {
      toast.error('Could not change the version', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const convert = async () => {
    const ok = await confirm({
      title: isModded ? 'Switch back to vanilla Terraria?' : 'Switch to tModLoader?',
      message: isModded
        ? 'Vanilla cannot read modded content. Any blocks, items or NPCs your mods added are removed the ' +
          'first time vanilla loads this world, permanently and without warning. A backup is taken before ' +
          'the switch, and it is the only way back.'
        : 'The world carries over — this is the normal way to start a modded server. The next start will be ' +
          'slow while the node downloads tModLoader and its .NET runtime, and every player needs tModLoader ' +
          'and the same mods to join. A backup is taken first.',
      confirmLabel: isModded ? 'Switch to vanilla' : 'Switch to tModLoader',
      danger: isModded,
      ...(isModded ? { requireText: 'vanilla' } : {}),
    });
    if (!ok) return;

    setBusy(true);
    try {
      const data = await apiPost<{ message: string; backupName?: string }>(
        `/api/servers/${serverId}/variant`,
        { variant: target }
      );
      toast.success(
        data.message,
        data.backupName ? `Backed up as "${data.backupName}" first.` : undefined
      );
      onChanged?.();
    } catch (err) {
      toast.error('Could not change the server type', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cc-panel">
      <h3 className="cc-section-title" style={{ marginBottom: '6px' }}>Server type</h3>
      <p className="cc-help" style={{ marginTop: 0 }}>
        Currently running <strong>{isModded ? 'tModLoader' : 'vanilla Terraria'}</strong>.
        {isModded
          ? ' Mods are managed on the Mods tab.'
          : ' Vanilla has no mod system — switch to tModLoader to use mods.'}
      </p>

      {canManage && (
        <>
          <div style={{ maxWidth: '320px', marginBottom: '12px' }}>
            <label className="cc-label" htmlFor="t-version">
              {isModded ? 'tModLoader build' : 'Terraria version'}
            </label>
            <select
              id="t-version"
              className="cc-input"
              disabled={busy || !stopped}
              value={isModded
                ? (tmodloaderVersion ?? DEFAULT_TMODLOADER_VERSION)
                : (terrariaVersion ?? DEFAULT_TERRARIA_VERSION)}
              onChange={(e) => changeVersion(e.target.value)}
            >
              {isModded
                ? TMODLOADER_BUILDS.map((b) => (
                    <option key={b.version} value={b.version}>{b.label}</option>
                  ))
                : TERRARIA_VERSIONS.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
            </select>
            <p className="cc-help">
              {isModded
                ? 'Mods are compiled against a specific build and will not load on another, so changing this means replacing every mod installed here.'
                : 'A world stays in the format it was generated in. Moving to an older version may make it unreadable.'}
            </p>
          </div>

          <button
            onClick={convert}
            disabled={busy || !stopped}
            className={isModded ? 'cc-btn-ghost' : 'cc-btn-primary'}
            style={{ opacity: stopped ? 1 : 0.5 }}
          >
            {busy ? 'Switching…' : isModded ? 'Switch to vanilla' : 'Switch to tModLoader'}
          </button>
          {!stopped && (
            <p className="cc-help">
              Stop the server first. A sleeping server counts as running, because the next player to connect
              will start it.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ReadOnlyValue({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border-2)',
        borderRadius: '8px', minWidth: 0,
      }}
    >
      <span className="cc-help" style={{ display: 'block' }}>{label}</span>
      <span
        style={{
          display: 'block', fontSize: '0.75rem', color: 'var(--text-primary)', marginTop: '2px',
          ...(mono ? { fontFamily: 'var(--font-mono)' } : { fontWeight: 600 }),
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Field({
  label, htmlFor, help, children,
}: { label: string; htmlFor: string; help?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="cc-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {help && <p className="cc-help">{help}</p>}
    </div>
  );
}
