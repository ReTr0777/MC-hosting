'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, errorMessage } from '@/lib/api';
import { pickNewestTmods } from '@/lib/servers/tmod-select';
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

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.95em', wordBreak: 'break-all' }}>{children}</code>
  );
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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiRequest<{ mods?: ModEntry[]; missing?: string[] }>(
        `/api/servers/${serverId}/tmods`,
        { cache: 'no-store' }
      );
      setMods(data.mods ?? []);
      setMissing(data.missing ?? []);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Failed to load mods'));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async (selected: FileList | File[] | null) => {
    if (!selected) return;

    const chosen = pickNewestTmods(Array.from(selected));
    if (chosen.length === 0) {
      toast.error(
        'No mods in that selection',
        'Nothing there was a .tmod file. If you picked your Steam workshop folder, make sure it was ' +
          'the one named 1281930.'
      );
      return;
    }

    setUploading(true);
    setProgress({ done: 0, total: chosen.length });

    /*
     * Failures are collected rather than thrown, so one bad file out of thirty does not
     * abandon the twenty-nine after it. Picking a whole workshop folder makes that a real
     * case: it can easily contain a mod whose header this cannot read.
     */
    const failed: string[] = [];
    let installed = 0;

    try {
      // Sequential rather than parallel: each upload streams a whole file through the
      // panel to the node, and a folder's worth at once on a home connection is how you
      // get a timeout partway through and no way to tell which ones landed.
      for (const file of chosen) {
        try {
          /*
           * Sent as an ArrayBuffer with an explicit content type, mirroring
           * uploadFileInChunks — which is the one upload path in this panel already proven
           * to cross a Cloudflare-fronted deployment.
           *
           * Handing `fetch` the File directly instead lets the browser derive the content
           * type from the file, and `.tmod` is not a type any browser knows, so the POST
           * goes out carrying a body and no Content-Type header at all. A proxy is entitled
           * to refuse that, and one did: every upload came back as an HTML 502 the origin
           * never saw.
           */
          await apiRequest(
            `/api/servers/${serverId}/tmods?fileName=${encodeURIComponent(file.name)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: await file.arrayBuffer(),
            }
          );
          installed++;
        } catch (err) {
          failed.push(`${file.name}: ${errorMessage(err, 'upload failed')}`);
        }
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }

      if (installed > 0) {
        toast.success(
          `${installed} mod${installed === 1 ? '' : 's'} uploaded`,
          'Switch each one on below, then restart the server — mods are read once, at boot.'
        );
      }
      if (failed.length > 0) {
        toast.error(
          `${failed.length} file${failed.length === 1 ? '' : 's'} could not be installed`,
          // Every failure in a batch is normally the same failure, so one explained
          // properly is worth more than three truncated.
          failed[0] + (failed.length > 1 ? ` (and ${failed.length - 1} more, same problem)` : '')
        );
      }
      load();
    } finally {
      setUploading(false);
      setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
      if (folderInput.current) folderInput.current.value = '';
    }
  };

  const toggle = async (mod: ModEntry) => {
    setBusyName(mod.name);
    try {
      await apiRequest(`/api/servers/${serverId}/tmods/${encodeURIComponent(mod.name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !mod.enabled }),
      });

      toast.success(
        mod.enabled ? `${mod.name} disabled` : `${mod.name} enabled`,
        'Restart the server for this to take effect.'
      );
      load();
    } catch (err) {
      toast.error('Could not change the mod', errorMessage(err));
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
      await apiRequest(`/api/servers/${serverId}/tmods/${encodeURIComponent(mod.fileName)}`, {
        method: 'DELETE',
      });

      toast.success(`${mod.name} deleted`, 'Restart the server for this to take effect.');
      load();
    } catch (err) {
      toast.error('Could not remove the mod', errorMessage(err));
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
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!uploading) upload(e.dataTransfer.files);
          }}
          style={{
            border: `1px dashed ${dragging ? 'var(--accent)' : 'var(--border-2)'}`,
            background: dragging ? 'var(--accent-dim)' : 'transparent',
            borderRadius: '10px',
            padding: '16px',
            transition: 'background 0.15s ease, border-color 0.15s ease',
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".tmod"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => upload(e.target.files)}
          />
          {/*
            webkitdirectory is not in React's HTML typings, hence the spread. It is
            supported in every browser this panel is usable in, and a browser without it
            simply falls back to the file picker beside it.
          */}
          <input
            ref={folderInput}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => upload(e.target.files)}
            {...({ webkitdirectory: '', directory: '' } as any)}
          />

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="cc-btn-primary" disabled={uploading} onClick={() => folderInput.current?.click()}>
              Import from Steam workshop folder
            </button>
            <button className="cc-btn-ghost" disabled={uploading} onClick={() => fileInput.current?.click()}>
              Pick .tmod files
            </button>
            {uploading && progress && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Uploading {progress.done + 1} of {progress.total}…
              </span>
            )}
          </div>

          <p className="cc-help" style={{ marginBottom: 0 }}>
            Subscribe to the mods you want in tModLoader on your own PC, then import the folder Steam keeps
            them in — <Mono>{'steamapps\\workshop\\content\\1281930'}</Mono>. The panel finds every{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>.tmod</code> inside it, keeps the newest build of
            each, and skips everything else, so there is no need to dig through the numbered folders. You can
            also drag files straight onto this box.
          </p>
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
