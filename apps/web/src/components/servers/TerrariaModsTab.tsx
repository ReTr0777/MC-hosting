'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';

/**
 * `.tmod` mods for a tModLoader server.
 *
 * Not the Modrinth browser beside it, and not a smaller version of it. tModLoader's mod
 * browser is Steam Workshop, which needs a Steam install and an account on the node, so
 * mods arrive here as files. What this adds over dropping them into the folder with the
 * file manager is the part that is easy to get wrong: a mod is loaded because
 * `enabled.json` names it, not because the file is present, and the name it must be
 * listed under is the mod's internal one rather than the filename.
 */

interface ModEntry {
  name: string;
  fileName: string;
  sizeBytes: number;
  enabled: boolean;
  nameGuessed: boolean;
}

interface Props {
  serverId: string;
  serverName: string;
  canManage: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function TerrariaModsTab({ serverId, serverName, canManage }: Props) {
  const toast = useToast();
  const confirm = useConfirm();

  const [mods, setMods] = useState<ModEntry[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/tmods`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load mods');
      setMods(data.mods ?? []);
      setMissing(data.missing ?? []);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setUploading(true);
    let installed = 0;
    try {
      // Sequential rather than parallel: each upload streams a whole file through the
      // panel to the node, and a handful at once on a home connection is how you get a
      // timeout partway through and no way to tell which ones landed.
      for (const file of Array.from(files)) {
        if (!file.name.toLowerCase().endsWith('.tmod')) {
          toast.error('Not a mod file', `${file.name} is not a .tmod file, so it was skipped.`);
          continue;
        }

        const res = await fetch(
          `/api/servers/${serverId}/tmods?fileName=${encodeURIComponent(file.name)}`,
          { method: 'POST', body: file }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Failed to upload ${file.name}`);
        installed++;
      }

      if (installed > 0) {
        toast.success(
          `${installed} mod${installed === 1 ? '' : 's'} uploaded`,
          'Switch each one on below, then restart the server — mods are read once, at boot.'
        );
      }
      load();
    } catch (err: any) {
      toast.error('Upload failed', err.message);
      load();
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const toggle = async (mod: ModEntry) => {
    setBusyName(mod.name);
    try {
      const res = await fetch(`/api/servers/${serverId}/tmods/${encodeURIComponent(mod.name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !mod.enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to change the mod');

      toast.success(
        mod.enabled ? `${mod.name} disabled` : `${mod.name} enabled`,
        'Restart the server for this to take effect.'
      );
      load();
    } catch (err: any) {
      toast.error('Could not change the mod', err.message);
    } finally {
      setBusyName(null);
    }
  };

  const remove = async (mod: ModEntry) => {
    const ok = await confirm({
      title: `Delete ${mod.name}?`,
      message: mod.enabled
        ? `This deletes the file from ${serverName} and switches the mod off. If your world already contains this mod's blocks or items, they will be gone the next time it loads — take a backup first if you are not sure.`
        : `This deletes ${mod.fileName} from ${serverName}. The mod is not currently enabled, so the world is unaffected.`,
      confirmLabel: 'Delete mod',
      danger: true,
    });
    if (!ok) return;

    setBusyName(mod.name);
    try {
      const res = await fetch(`/api/servers/${serverId}/tmods/${encodeURIComponent(mod.fileName)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove the mod');

      toast.success(`${mod.name} deleted`, 'Restart the server for this to take effect.');
      load();
    } catch (err: any) {
      toast.error('Could not remove the mod', err.message);
    } finally {
      setBusyName(null);
    }
  };

  if (loading) {
    return <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Loading mods…</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
          Mods
        </h3>
        <p className="cc-help" style={{ marginTop: 0 }}>
          Upload <code style={{ fontFamily: 'var(--font-mono)' }}>.tmod</code> files, then switch on the ones this
          server should load. tModLoader reads this list once when the server boots, so changes here take effect on
          the next restart. Every player also needs the same mods installed to join.
        </p>
      </div>

      {error && (
        <div style={{ fontSize: '0.78rem', color: 'var(--danger)', background: 'rgba(248,81,73,0.08)', padding: '10px 12px', borderRadius: '6px' }}>
          {error}
        </div>
      )}

      {canManage && (
        <div>
          <input
            ref={fileInput}
            type="file"
            accept=".tmod"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => upload(e.target.files)}
          />
          <button className="cc-btn-primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? 'Uploading…' : '+ Upload .tmod files'}
          </button>
        </div>
      )}

      {/*
        Enabled names with no file behind them. tModLoader ignores these silently, and they
        are what a restore from a backup taken on a differently-modded server leaves behind
        — worth naming, because they are otherwise invisible.
      */}
      {missing.length > 0 && (
        <div style={{ fontSize: '0.78rem', color: 'var(--warning)', background: 'rgba(240,136,62,0.08)', border: '1px solid rgba(240,136,62,0.2)', padding: '10px 12px', borderRadius: '6px', lineHeight: 1.5 }}>
          <strong>{missing.length} enabled mod{missing.length === 1 ? '' : 's'} not installed:</strong>{' '}
          {missing.join(', ')}. tModLoader will start without {missing.length === 1 ? 'it' : 'them'}, but a world
          that already uses {missing.length === 1 ? 'its' : 'their'} content will lose it. Upload the missing
          file{missing.length === 1 ? '' : 's'} before starting.
        </div>
      )}

      {mods.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', border: '1px dashed var(--border-2)', borderRadius: '10px' }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
            No mods installed
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: '0 auto', maxWidth: '420px', lineHeight: 1.6 }}>
            Get <code style={{ fontFamily: 'var(--font-mono)' }}>.tmod</code> files from the tModLoader mod browser
            in-game, or from the mod author, and upload them here. A server with no mods enabled runs as ordinary
            Terraria.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', background: 'var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
          {mods.map((mod) => (
            <div
              key={mod.fileName}
              style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '12px 14px', background: 'var(--surface)' }}
            >
              <div style={{ flex: 1, minWidth: '180px' }}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {mod.name}
                  {!mod.enabled && (
                    <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-muted)', marginLeft: '8px' }}>
                      not loaded
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
                  {mod.fileName} · {formatSize(mod.sizeBytes)}
                </div>
                {mod.nameGuessed && (
                  <div style={{ fontSize: '0.68rem', color: 'var(--warning)', marginTop: '3px', lineHeight: 1.4 }}>
                    The internal name could not be read from this file, so it was guessed from the filename. If the
                    mod does not load once enabled, that guess is why.
                  </div>
                )}
              </div>

              {canManage && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    className={mod.enabled ? 'cc-btn-ghost' : 'cc-btn-primary'}
                    disabled={busyName === mod.name}
                    onClick={() => toggle(mod)}
                    style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                  >
                    {mod.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="cc-btn-danger"
                    disabled={busyName === mod.name}
                    onClick={() => remove(mod)}
                    style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
