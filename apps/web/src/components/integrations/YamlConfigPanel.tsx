'use client';

import React, { useEffect, useState } from 'react';
import { YamlFieldDef } from '@/lib/integration-configs';

interface YamlConfigPanelProps {
  serverId: string;
  canManage: boolean;
  mod: string;
}

export default function YamlConfigPanel({ serverId, canManage, mod }: YamlConfigPanelProps) {
  const [fields, setFields] = useState<YamlFieldDef[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [exists, setExists] = useState(true);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/integrations/config?mod=${mod}`);
      const data = await res.json();
      if (res.ok) {
        setFields(data.fields || []);
        setSettings(data.settings || {});
        setExists(data.exists);
        setPath(data.path || '');
      } else {
        setMessage({ kind: 'err', text: data.error || 'Failed to load configuration' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: 'Network error loading configuration' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, mod]);

  const handleChange = (dotPath: string, value: string) => {
    setSettings((prev) => ({ ...prev, [dotPath]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/integrations/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mod, settings }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: data.message });
        setExists(true);
      } else {
        setMessage({ kind: 'err', text: data.error || 'Failed to save configuration' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: 'Network error saving configuration' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-slate-500 py-4 animate-pulse">Reading configuration...</div>;
  }

  return (
    <div className="space-y-4 pt-2">
      {!exists && (
        <div className="p-3 rounded-xl text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
          No config file found yet at <code className="text-amber-300">{path}</code> — it's usually created the first
          time the server boots with this installed. Saving here will create it now with these values.
        </div>
      )}

      {message && (
        <div
          className={`p-3 rounded-xl text-[11px] font-semibold ${
            message.kind === 'err'
              ? 'bg-red-500/10 text-red-400 border border-red-500/20'
              : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {fields.map((field) => {
          const value = settings[field.dotPath] ?? field.default;

          if (field.type === 'boolean') {
            return (
              <label
                key={field.dotPath}
                className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer md:col-span-2"
              >
                <span className="text-[11px] font-semibold text-slate-200">{field.label}</span>
                <input
                  type="checkbox"
                  checked={value !== 'false'}
                  disabled={!canManage}
                  onChange={(e) => handleChange(field.dotPath, e.target.checked ? 'true' : 'false')}
                  className="w-4 h-4 accent-emerald-500 rounded cursor-pointer disabled:opacity-50"
                />
              </label>
            );
          }

          if (field.type === 'select') {
            return (
              <div key={field.dotPath}>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1.5">{field.label}</label>
                <select
                  value={value}
                  disabled={!canManage}
                  onChange={(e) => handleChange(field.dotPath, e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none disabled:opacity-50"
                >
                  {(field.options || []).map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>
            );
          }

          return (
            <div key={field.dotPath}>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1.5">
                {field.label}
                {field.hint && <span className="text-slate-500 font-normal"> — {field.hint}</span>}
              </label>
              <input
                type={field.type === 'number' ? 'number' : 'text'}
                value={value}
                disabled={!canManage}
                onChange={(e) => handleChange(field.dotPath, e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none disabled:opacity-50"
              />
            </div>
          );
        })}
      </div>

      {canManage && (
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg shadow-emerald-600/20 transition"
        >
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
      )}
    </div>
  );
}
