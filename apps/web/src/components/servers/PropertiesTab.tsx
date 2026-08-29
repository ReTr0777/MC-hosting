'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { Chip, InlineError, LoadingLine, Mono, PanelHeader } from '@/components/ui';
import { motdNotes } from '@mc-manager/shared';

interface PropertiesTabProps {
  serverId: string;
  canManage?: boolean;
  onSaveNotice?: () => void;
}

type Props = Record<string, string>;

/** Icons larger than this are rejected before upload rather than after a round trip. */
const MAX_ICON_BYTES = 2 * 1024 * 1024;

const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

/** `server.properties` booleans are strings; these two helpers keep that in one place. */
const isOn = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === '' ? fallback : value === 'true';
const asBool = (checked: boolean) => (checked ? 'true' : 'false');

const TOGGLES: Array<{ key: string; label: string; help: string; defaultOn: boolean }> = [
  { key: 'pvp', label: 'PvP', help: 'Let players damage each other.', defaultOn: true },
  { key: 'allow-nether', label: 'Allow Nether', help: 'Enable the Nether dimension.', defaultOn: true },
  { key: 'hardcore', label: 'Hardcore', help: 'Death bans the player from the world.', defaultOn: false },
  { key: 'allow-flight', label: 'Allow flight', help: 'Needed by most flight mods, else players get kicked.', defaultOn: false },
  { key: 'enable-command-block', label: 'Command blocks', help: 'Allow command blocks to run.', defaultOn: false },
  { key: 'online-mode', label: 'Online mode', help: 'Verify players against Mojang. Turn off only for offline/cracked play.', defaultOn: true },
];

export default function PropertiesTab({ serverId, canManage = true }: PropertiesTabProps) {
  const toast = useToast();

  const [properties, setProperties] = useState<Props>({});
  const [saved, setSaved] = useState<Props>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [iconKey, setIconKey] = useState(() => Date.now());
  const [iconBroken, setIconBroken] = useState(false);
  const [uploadingIcon, setUploadingIcon] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest(`/api/servers/${serverId}/properties`);
      if (!mounted.current) return;
      const next: Props = data?.properties || {};
      setProperties(next);
      setSaved(next);
      setLoadError(null);
    } catch (err) {
      if (mounted.current) setLoadError(errorMessage(err, 'Could not load server.properties'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [serverId]);

  useEffect(() => { load(); }, [load]);

  // Compared against the last saved snapshot so the Save button reflects reality.
  const dirtyKeys = useMemo(
    () => Object.keys({ ...saved, ...properties }).filter((k) => (properties[k] ?? '') !== (saved[k] ?? '')),
    [properties, saved]
  );
  const isDirty = dirtyKeys.length > 0;

  // Closing the tab mid-edit used to discard changes with no warning.
  useEffect(() => {
    if (!isDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const handleChange = (key: string, value: string) => setProperties((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiPost(`/api/servers/${serverId}/properties`, { properties });
      if (!mounted.current) return;
      setSaved(properties);
      toast.success('server.properties saved', 'Restart the server to apply the changes.');
    } catch (err) {
      toast.error('Could not save server.properties', errorMessage(err));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size > MAX_ICON_BYTES) {
      toast.error('That image is too large', 'Server icons must be under 2 MB.');
      return;
    }

    setUploadingIcon(true);
    try {
      await apiRequest(`/api/servers/${serverId}/icon`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!mounted.current) return;
      setIconBroken(false);
      setIconKey(Date.now());
      toast.success('Server icon updated', 'Minecraft shows it next to your server in the multiplayer list.');
    } catch (err) {
      toast.error('Icon upload failed', errorMessage(err));
    } finally {
      if (mounted.current) setUploadingIcon(false);
    }
  };

  if (loading) return <LoadingLine>Loading server.properties…</LoadingLine>;

  return (
    <div style={{ display: 'grid', gap: '16px', maxWidth: '64rem' }}>
      <PanelHeader
        title="Server Properties"
        chips={isDirty ? <Chip tone="warning">{dirtyKeys.length} unsaved</Chip> : undefined}
        description={<>Game rules, difficulty, MOTD and performance settings, written to <Mono>server.properties</Mono>.</>}
        actions={
          canManage && (
            <>
              {isDirty && (
                <button onClick={() => setProperties(saved)} disabled={saving} className="cc-btn-ghost">
                  Discard
                </button>
              )}
              <button onClick={handleSave} disabled={saving || !isDirty} className="cc-btn-primary">
                {saving ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
              </button>
            </>
          )
        }
      />

      {loadError && <InlineError message={loadError} onRetry={load} />}

      {/* Server icon */}
      <section className="cc-panel">
        <h3 className="cc-section-title" style={{ marginBottom: '14px' }}>Server icon</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
          <div
            style={{
              width: 64, height: 64, borderRadius: '10px', background: 'var(--bg)', border: '1px solid var(--border-2)',
              overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            {iconBroken ? (
              <span style={{ fontSize: '0.62rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>64×64</span>
            ) : (
              <img
                src={`/api/servers/${serverId}/icon?v=${iconKey}`}
                alt="Server icon"
                width={64}
                height={64}
                style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
                onError={() => setIconBroken(true)}
              />
            )}
          </div>

          <div style={{ flex: 1, minWidth: '240px' }}>
            <p className="cc-help" style={{ margin: '0 0 10px' }}>
              Upload a 64×64 PNG. Minecraft loads <Mono>server-icon.png</Mono> next to your server name in the multiplayer
              list. Larger images are scaled by the server.
            </p>
            {canManage && (
              <label className={uploadingIcon ? 'cc-btn-ghost' : 'cc-btn-primary'} style={{ display: 'inline-flex', cursor: uploadingIcon ? 'not-allowed' : 'pointer' }}>
                {uploadingIcon ? 'Uploading…' : 'Upload new icon'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleIconUpload}
                  disabled={uploadingIcon}
                  style={{ display: 'none' }}
                />
              </label>
            )}
          </div>
        </div>
      </section>

      {/* General */}
      <section className="cc-panel">
        <h3 className="cc-section-title" style={{ marginBottom: '14px' }}>General &amp; gameplay</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
          <Field
            label="Message of the day"
            htmlFor="p-motd"
            help={
              <>
                Shown under the server name in the multiplayer list. Codes from a MOTD
                generator work as pasted: colours <Mono>&amp;0</Mono>–<Mono>&amp;9</Mono> and{' '}
                <Mono>&amp;a</Mono>–<Mono>&amp;f</Mono>, and <Mono>&amp;u</Mono> underline,{' '}
                <Mono>&amp;l</Mono> bold, <Mono>&amp;o</Mono> italic, <Mono>&amp;m</Mono> strikethrough,{' '}
                <Mono>&amp;k</Mono> obfuscated, <Mono>&amp;r</Mono> reset. <Mono>&amp;g</Mono> is a
                Bedrock colour with no Java equivalent, so it is shown as the nearest one, yellow.
                Write <Mono>&amp;&amp;</Mono> for a literal ampersand. Restart the server for a
                change here to reach the server list.
              </>
            }
          >
            <input
              id="p-motd"
              className="cc-input"
              value={properties['motd'] ?? ''}
              onChange={(e) => handleChange('motd', e.target.value)}
              placeholder="A Minecraft Server"
              disabled={!canManage}
            />
            {motdNotes(properties['motd'] ?? '').map((note) => (
              <p key={note.typed} className="cc-help" style={{ marginTop: '6px' }}>
                <Mono>{note.typed}</Mono>
                {note.becomes ? <> → <Mono>{note.becomes}</Mono></> : <> stays as text</>} — {note.explanation}
              </p>
            ))}
          </Field>

          <Field label="Default game mode" htmlFor="p-gamemode">
            <select
              id="p-gamemode"
              className="cc-input"
              value={properties['gamemode'] ?? 'survival'}
              onChange={(e) => handleChange('gamemode', e.target.value)}
              disabled={!canManage}
            >
              {GAMEMODES.map((m) => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}
            </select>
          </Field>

          <Field label="Difficulty" htmlFor="p-difficulty">
            <select
              id="p-difficulty"
              className="cc-input"
              value={properties['difficulty'] ?? 'easy'}
              onChange={(e) => handleChange('difficulty', e.target.value)}
              disabled={!canManage}
            >
              {DIFFICULTIES.map((d) => <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>)}
            </select>
          </Field>

          <Field label="Max players" htmlFor="p-maxplayers">
            <input
              id="p-maxplayers"
              type="number"
              min={1}
              max={1000}
              className="cc-input"
              value={properties['max-players'] ?? '20'}
              onChange={(e) => handleChange('max-players', e.target.value)}
              disabled={!canManage}
            />
          </Field>
        </div>
      </section>

      {/* Toggles */}
      <section className="cc-panel">
        <h3 className="cc-section-title" style={{ marginBottom: '14px' }}>Rules &amp; toggles</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '10px' }}>
          {TOGGLES.map((t) => {
            const on = isOn(properties[t.key], t.defaultOn);
            return (
              <label
                key={t.key}
                title={t.help}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                  padding: '12px 14px', background: 'var(--bg)', border: '1px solid var(--border-2)',
                  borderRadius: '8px', cursor: canManage ? 'pointer' : 'not-allowed',
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>{t.label}</span>
                  <span className="cc-help" style={{ display: 'block', marginTop: '2px' }}>{t.help}</span>
                </span>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => handleChange(t.key, asBool(e.target.checked))}
                  disabled={!canManage}
                  style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0, cursor: 'inherit' }}
                />
              </label>
            );
          })}
        </div>
      </section>

      {/* Performance */}
      <section className="cc-panel">
        <h3 className="cc-section-title" style={{ marginBottom: '14px' }}>Performance</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
          <Field label="View distance (chunks)" htmlFor="p-view" help="How far players can see. Lowering this is the cheapest way to cut lag.">
            <input
              id="p-view"
              type="number"
              min={2}
              max={32}
              className="cc-input"
              value={properties['view-distance'] ?? '10'}
              onChange={(e) => handleChange('view-distance', e.target.value)}
              disabled={!canManage}
            />
          </Field>

          <Field label="Simulation distance (chunks)" htmlFor="p-sim" help="How far mobs, crops and redstone keep ticking.">
            <input
              id="p-sim"
              type="number"
              min={2}
              max={32}
              className="cc-input"
              value={properties['simulation-distance'] ?? '10'}
              onChange={(e) => handleChange('simulation-distance', e.target.value)}
              disabled={!canManage}
            />
          </Field>
        </div>
      </section>
    </div>
  );
}

function Field({
  label, htmlFor, help, children,
  // ReactNode rather than string: the MOTD's help has to show the codes as code.
}: { label: string; htmlFor: string; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="cc-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {help && <p className="cc-help">{help}</p>}
    </div>
  );
}
