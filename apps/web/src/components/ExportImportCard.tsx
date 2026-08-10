'use client';

import React, { useRef, useState } from 'react';
import { uploadFileInChunks } from '@/lib/chunked-upload';

export default function ExportImportCard({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const handleImportClick = () => {
    if (!canManage || importing) return;
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!confirm(
      `This will extract "${file.name}" over this server's existing files, overwriting any that match. ` +
      'Files not present in the archive are left untouched. Continue?'
    )) {
      return;
    }

    setImporting(true);
    setProgress(0);
    setMessage(null);
    try {
      await uploadFileInChunks({
        serverId,
        file,
        isServerpack: false,
        isFullImport: true,
        onProgress: (percent) => setProgress(percent),
      });
      setMessage({ kind: 'ok', text: 'Archive imported successfully. Restart the server to pick up any changed files.' });
    } catch (err: any) {
      setMessage({ kind: 'err', text: err.message || 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="cc-card" style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
        <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>Export / Import</span>
      </div>
      <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
        Download the entire server (world, mods, configs) as a .tar.gz archive, or restore one onto this server.
      </p>

      {message && (
        <div style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          padding: '10px 12px',
          borderRadius: '6px',
          marginBottom: '14px',
          background: message.kind === 'err' ? 'rgba(248,81,73,0.08)' : 'rgba(0,217,126,0.08)',
          color: message.kind === 'err' ? 'var(--danger)' : 'var(--accent)',
          border: `1px solid ${message.kind === 'err' ? 'rgba(248,81,73,0.2)' : 'var(--accent-border)'}`,
        }}>
          {message.text}
        </div>
      )}

      {importing && (
        <div style={{ marginBottom: '14px' }}>
          <div className="cc-bar-track">
            <div className="cc-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>Uploading and extracting... {progress}%</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <a
          href={`/api/servers/${serverId}/export`}
          download
          style={{
            background: 'rgba(0,217,126,0.1)',
            color: 'var(--accent)',
            border: '1px solid var(--accent-border)',
            borderRadius: '6px',
            padding: '8px 18px',
            fontSize: '0.8125rem',
            fontWeight: 600,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          Export Server (.tar.gz)
        </a>

        {canManage && (
          <>
            <input ref={fileInputRef} type="file" accept=".tar.gz,.tgz,application/gzip" style={{ display: 'none' }} onChange={handleFileSelected} />
            <button
              onClick={handleImportClick}
              disabled={importing}
              style={{
                background: 'rgba(99,102,241,0.15)',
                color: '#818cf8',
                border: '1px solid rgba(99,102,241,0.3)',
                borderRadius: '6px',
                padding: '8px 18px',
                fontSize: '0.8125rem',
                fontWeight: 600,
                cursor: importing ? 'default' : 'pointer',
                opacity: importing ? 0.5 : 1,
              }}
            >
              {importing ? 'Importing...' : 'Import Archive'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
