'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { YamlFieldDef } from '@/lib/integrations/configs';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { InlineError, Mono, Notice } from '@/components/ui';

interface YamlConfigPanelProps {
  serverId: string;
  canManage: boolean;
  mod: string;
}

type Settings = Record<string, string>;

export default function YamlConfigPanel({ serverId, canManage, mod }: YamlConfigPanelProps) {
  const toast = useToast();
  const [fields, setFields] = useState<YamlFieldDef[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [saved, setSaved] = useState<Settings>({});
  const [exists, setExists] = useState(true);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest(`/api/servers/${serverId}/integrations/config?mod=${encodeURIComponent(mod)}`);
      const next: Settings = data?.settings || {};
      setFields(data?.fields || []);
      setSettings(next);
      setSaved(next);
      setExists(Boolean(data?.exists));
      setPath(data?.path || '');
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err, 'Failed to load configuration'));
    } finally {
      setLoading(false);
    }
  }, [serverId, mod]);

  useEffect(() => { load(); }, [load]);

  const handleChange = (dotPath: string, value: string) => setSettings((prev) => ({ ...prev, [dotPath]: value }));

  const isDirty = useMemo(
    () => Object.keys({ ...saved, ...settings }).some((k) => (settings[k] ?? '') !== (saved[k] ?? '')),
    [settings, saved]
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await apiPost(`/api/servers/${serverId}/integrations/config`, { mod, settings });
      setSaved(settings);
      setExists(true);
      toast.success('Configuration saved', data?.message || 'Restart the server to apply it.');
    } catch (err) {
      toast.error('Could not save the configuration', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="cc-help" style={{ margin: 0 }}>Reading configuration…</p>;

  return (
    <div style={{ display: 'grid', gap: '14px' }}>
      {loadError && <InlineError message={loadError} onRetry={load} />}

      {!exists && (
        <Notice tone="warning">
          No config file found yet at <Mono>{path}</Mono> — it&apos;s usually created the first time the server boots with this
          installed. Saving here creates it now with these values.
        </Notice>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
        {fields.map((field) => {
          const value = settings[field.dotPath] ?? field.default;
          const inputId = `yaml-${field.dotPath}`;

          if (field.type === 'boolean') {
            return (
              <label
                key={field.dotPath}
                style={{
                  gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                  padding: '12px 14px', background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px',
                  cursor: canManage ? 'pointer' : 'not-allowed',
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>{field.label}</span>
                  {field.hint && <span className="cc-help" style={{ display: 'block' }}>{field.hint}</span>}
                </span>
                <input
                  type="checkbox"
                  checked={value !== 'false'}
                  disabled={!canManage}
                  onChange={(e) => handleChange(field.dotPath, e.target.checked ? 'true' : 'false')}
                  style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0, cursor: 'inherit' }}
                />
              </label>
            );
          }

          if (field.type === 'select') {
            return (
              <div key={field.dotPath}>
                <label className="cc-label" htmlFor={inputId}>{field.label}</label>
                <select
                  id={inputId}
                  value={value}
                  disabled={!canManage}
                  onChange={(e) => handleChange(field.dotPath, e.target.value)}
                  className="cc-input"
                >
                  {(field.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
                {field.hint && <p className="cc-help">{field.hint}</p>}
              </div>
            );
          }

          return (
            <div key={field.dotPath}>
              <label className="cc-label" htmlFor={inputId}>{field.label}</label>
              <input
                id={inputId}
                type={field.type === 'number' ? 'number' : 'text'}
                value={value}
                disabled={!canManage}
                onChange={(e) => handleChange(field.dotPath, e.target.value)}
                className="cc-input"
              />
              {field.hint && <p className="cc-help">{field.hint}</p>}
            </div>
          );
        })}
      </div>

      {canManage && (
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={handleSave} disabled={saving || !isDirty} className="cc-btn-primary">
            {saving ? 'Saving…' : isDirty ? 'Save configuration' : 'Saved'}
          </button>
          {isDirty && <button onClick={() => setSettings(saved)} disabled={saving} className="cc-btn-ghost">Discard</button>}
        </div>
      )}
    </div>
  );
}
