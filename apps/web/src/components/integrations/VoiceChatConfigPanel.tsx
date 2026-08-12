'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { InlineError, Notice } from '@/components/ui';

interface VoiceChatConfigPanelProps {
  serverId: string;
  canManage: boolean;
}

type Settings = Record<string, string>;

const FIELDS: Array<{ key: string; label: string; help?: string; type: 'number' | 'text'; step?: string; fallback: string }> = [
  { key: 'port', label: 'Voice port', help: 'Use -1 to share the server\'s own port.', type: 'number', fallback: '-1' },
  { key: 'max_voice_distance', label: 'Max voice distance', help: 'How far away players can still hear each other, in blocks.', type: 'number', step: '0.5', fallback: '48.0' },
  { key: 'voice_chat_prefix', label: 'Command prefix', type: 'text', fallback: '/vc' },
  { key: 'group_radius', label: 'Group radius', help: 'In blocks. 0 keeps groups audible at any distance.', type: 'number', step: '0.5', fallback: '8.0' },
];

export default function VoiceChatConfigPanel({ serverId, canManage }: VoiceChatConfigPanelProps) {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings>({});
  const [saved, setSaved] = useState<Settings>({});
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest(`/api/servers/${serverId}/integrations/voicechat`);
      const next: Settings = data?.settings || {};
      setSettings(next);
      setSaved(next);
      setExists(Boolean(data?.exists));
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err, 'Failed to load Voice Chat configuration'));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => { load(); }, [load]);

  const handleChange = (key: string, value: string) => setSettings((prev) => ({ ...prev, [key]: value }));

  const isDirty = useMemo(
    () => Object.keys({ ...saved, ...settings }).some((k) => (settings[k] ?? '') !== (saved[k] ?? '')),
    [settings, saved]
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await apiPost(`/api/servers/${serverId}/integrations/voicechat`, { settings });
      setSaved(settings);
      setExists(true);
      toast.success('Voice Chat settings saved', data?.message || 'Restart the server to apply them.');
    } catch (err) {
      toast.error('Could not save Voice Chat settings', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="cc-help" style={{ margin: 0 }}>Reading voicechat-server.properties…</p>;

  return (
    <div style={{ display: 'grid', gap: '14px' }}>
      {loadError && <InlineError message={loadError} onRetry={load} />}

      {!exists && (
        <Notice tone="warning">
          This mod hasn&apos;t generated its config file yet — it&apos;s created the first time the server boots with the mod
          installed. Saving here creates it now with these values.
        </Notice>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
        {FIELDS.map((f) => {
          const inputId = `vc-${f.key}`;
          return (
            <div key={f.key}>
              <label className="cc-label" htmlFor={inputId}>{f.label}</label>
              <input
                id={inputId}
                type={f.type}
                step={f.step}
                value={settings[f.key] ?? f.fallback}
                disabled={!canManage}
                onChange={(e) => handleChange(f.key, e.target.value)}
                className="cc-input"
              />
              {f.help && <p className="cc-help">{f.help}</p>}
            </div>
          );
        })}
      </div>

      <label
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 14px',
          background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px',
          cursor: canManage ? 'pointer' : 'not-allowed',
        }}
      >
        <span>
          <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>Voice groups</span>
          <span className="cc-help" style={{ display: 'block' }}>Let players form private voice channels.</span>
        </span>
        <input
          type="checkbox"
          checked={settings['groups_enabled'] !== 'false'}
          disabled={!canManage}
          onChange={(e) => handleChange('groups_enabled', e.target.checked ? 'true' : 'false')}
          style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0, cursor: 'inherit' }}
        />
      </label>

      {canManage && (
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={handleSave} disabled={saving || !isDirty} className="cc-btn-primary">
            {saving ? 'Saving…' : isDirty ? 'Save settings' : 'Saved'}
          </button>
          {isDirty && (
            <button onClick={() => setSettings(saved)} disabled={saving} className="cc-btn-ghost">Discard</button>
          )}
        </div>
      )}
    </div>
  );
}
