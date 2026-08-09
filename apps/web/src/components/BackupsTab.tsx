'use client';

import React, { useEffect, useState } from 'react';

interface Backup {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export default function BackupsTab({ serverId }: { serverId: string }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [backupName, setBackupName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchBackups();
  }, [serverId]);

  const fetchBackups = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/backups`);
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/backups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: backupName }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('✅ Backup snapshot created successfully!');
        setBackupName('');
        fetchBackups();
      } else {
        setMessage(`❌ Error: ${data.error}`);
      }
    } catch (err: any) {
      setMessage(`❌ Error: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = async (name: string) => {
    if (!confirm(`Are you sure you want to restore '${name}'? This will stop the server and overwrite current world files.`)) {
      return;
    }
    setActionLoading(`restore-${name}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/backups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', name }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('✅ Backup restored successfully!');
      } else {
        setMessage(`❌ Error: ${data.error}`);
      }
    } catch (err: any) {
      setMessage(`❌ Error: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Are you sure you want to delete '${name}'?`)) return;
    setActionLoading(`delete-${name}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/backups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', name }),
      });
      if (res.ok) {
        setMessage('✅ Backup deleted.');
        fetchBackups();
      }
    } catch (e) {
    } finally {
      setActionLoading(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <span>💾 Scheduled Backups & Snapshots</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">Create compressed `.zip` world snapshots and perform 1-click server rollbacks.</p>
        </div>
      </div>

      {message && (
        <div className={`p-4 rounded-xl text-xs font-semibold ${message.startsWith('❌') ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
          {message}
        </div>
      )}

      {/* Create Backup Form */}
      <form onSubmit={handleCreate} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex items-center space-x-3">
        <input
          type="text"
          value={backupName}
          onChange={(e) => setBackupName(e.target.value)}
          placeholder="Snapshot label (e.g. pre_modpack_update)..."
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={creating}
          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-emerald-600/20 transition"
        >
          {creating ? 'Archiving...' : '📸 Take Backup Snapshot'}
        </button>
      </form>

      {/* Backup List */}
      {loading ? (
        <div className="text-center py-12 text-slate-500 text-sm animate-pulse">Scanning backup vault...</div>
      ) : backups.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center">
          <div className="text-4xl mb-3">📦</div>
          <h3 className="text-base font-bold text-white mb-1">No Backups Created Yet</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Take a backup snapshot above to safeguard your Minecraft world, configuration, and player progress.
          </p>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/50 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                <th className="px-6 py-4">Snapshot Archive</th>
                <th className="px-6 py-4">File Size</th>
                <th className="px-6 py-4">Created Date</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-xs">
              {backups.map((backup) => (
                <tr key={backup.name} className="hover:bg-slate-800/40 transition">
                  <td className="px-6 py-4 font-mono text-emerald-300 font-semibold">{backup.name}</td>
                  <td className="px-6 py-4 text-slate-300 font-mono">{formatBytes(backup.sizeBytes)}</td>
                  <td className="px-6 py-4 text-slate-400">{new Date(backup.createdAt).toLocaleString()}</td>
                  <td className="px-6 py-4 text-right space-x-2">
                    <button
                      onClick={() => handleRestore(backup.name)}
                      disabled={!!actionLoading}
                      className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 font-semibold px-3 py-1.5 rounded-lg border border-amber-500/20 transition"
                    >
                      ↺ 1-Click Restore
                    </button>

                    <button
                      onClick={() => handleDelete(backup.name)}
                      disabled={!!actionLoading}
                      className="bg-red-500/10 hover:bg-red-500/20 text-red-400 font-semibold px-3 py-1.5 rounded-lg border border-red-500/20 transition"
                    >
                      🗑️ Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
