'use client';

import React, { useEffect, useState } from 'react';

interface Props {
  nodeId: string;
  nodeName: string;
  onClose: () => void;
}

export default function NodeBackupStorageModal({ nodeId, nodeName, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [secretSet, setSecretSet] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [retainLocal, setRetainLocal] = useState(true);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    fetch(`/api/nodes/${nodeId}/backup-storage`)
      .then((res) => res.json())
      .then((data) => {
        if (data.config) {
          setEndpoint(data.config.s3Endpoint || '');
          setBucket(data.config.s3Bucket || '');
          setRegion(data.config.s3Region || '');
          setAccessKeyId(data.config.s3AccessKeyId || '');
          setSecretSet(!!data.config.s3SecretAccessKeySet);
          setPrefix(data.config.s3Prefix || '');
          setRetainLocal(data.config.s3RetainLocal !== false);
          setConfigured(!!data.config.configured);
        }
      })
      .finally(() => setLoading(false));
  }, [nodeId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/backup-storage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          s3Endpoint: endpoint,
          s3Bucket: bucket,
          s3Region: region,
          s3AccessKeyId: accessKeyId,
          s3SecretAccessKey: secretAccessKey || undefined,
          s3Prefix: prefix,
          s3RetainLocal: retainLocal,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setMessage('Saved. New backups on this node will upload off-site.');
      setSecretAccessKey('');
      if (secretAccessKey) setSecretSet(true);
    } catch (err: any) {
      setMessage(`${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,17,23,0.85)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 50 }}>
      <div className="cc-card" style={{ width: '100%', maxWidth: '480px', padding: '24px', boxShadow: '0 24px 48px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Off-Site Backup Storage</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
        </div>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Node: <strong>{nodeName}</strong> — mirrors this node's backups to an S3-compatible bucket (AWS, Backblaze B2, Wasabi, MinIO, R2). Leave the bucket blank to disable.
        </p>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '0.8rem' }}>Loading...</div>
        ) : (
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: configured ? '#34d399' : 'var(--text-muted)' }}>
              {configured ? '● Configured & active' : '○ Not configured'}
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Endpoint URL (blank for AWS S3)</label>
              <input className="cc-input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://s3.us-west-000.backblazeb2.com" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Bucket</label>
                <input className="cc-input" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-mc-backups" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Region</label>
                <input className="cc-input" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-west-000" />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Access Key ID</label>
              <input className="cc-input" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder="Access Key ID" />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>
                Secret Access Key {secretSet && '(set — leave blank to keep unchanged)'}
              </label>
              <input type="password" className="cc-input" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} placeholder={secretSet ? 'Leave blank to keep current secret' : 'Secret Access Key'} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '5px', fontWeight: 600 }}>Key Prefix (optional)</label>
              <input className="cc-input" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="craftcontrol" />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.75rem', color: 'var(--text-primary)', fontWeight: 600 }}>
              <input type="checkbox" checked={retainLocal} onChange={(e) => setRetainLocal(e.target.checked)} />
              Keep a local copy after uploading off-site
            </label>

            {message && <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>{message}</div>}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button type="button" onClick={onClose} className="cc-btn-ghost">Close</button>
              <button type="submit" disabled={saving} className="cc-btn-primary">{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
