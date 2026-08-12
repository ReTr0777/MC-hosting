'use client';

import React, { useEffect, useState } from 'react';

interface VoiceChatConfigPanelProps {
  serverId: string;
  canManage: boolean;
}

export default function VoiceChatConfigPanel({ serverId, canManage }: VoiceChatConfigPanelProps) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/integrations/voicechat`);
      const data = await res.json();
      if (res.ok) {
        setSettings(data.settings || {});
        setExists(data.exists);
      } else {
        setMessage({ kind: 'err', text: data.error || 'Failed to load Voice Chat configuration' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: 'Network error loading Voice Chat configuration' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const handleChange = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/integrations/voicechat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
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
    return <div className="text-xs text-slate-500 py-4 animate-pulse">Reading voicechat-server.properties...</div>;
  }

  return (
    <div className="space-y-4 pt-2">
      {!exists && (
        <div className="p-3 rounded-xl text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
          This mod hasn't generated its config file yet — it's created the first time the server boots with the mod
          installed. Saving here will create it now with these values.
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
        <div>
          <label className="block text-[11px] font-semibold text-slate-300 mb-1.5">
            Voice Port <span className="text-slate-500 font-normal">(-1 = same as server port)</span>
          </label>
          <input
            type="number"
            value={settings['port'] ?? '-1'}
            disabled={!canManage}
            onChange={(e) => handleChange('port', e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold text-slate-300 mb-1.5">Max Voice Distance (blocks)</label>
          <input
            type="number"
            step="0.5"
            value={settings['max_voice_distance'] ?? '48.0'}
            disabled={!canManage}
            onChange={(e) => handleChange('max_voice_distance', e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold text-slate-300 mb-1.5">Chat Command Prefix</label>
          <input
            type="text"
            value={settings['voice_chat_prefix'] ?? '/vc'}
            disabled={!canManage}
            onChange={(e) => handleChange('voice_chat_prefix', e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold text-slate-300 mb-1.5">Group Radius (blocks)</label>
          <input
            type="number"
            step="0.5"
            value={settings['group_radius'] ?? '8.0'}
            disabled={!canManage}
            onChange={(e) => handleChange('group_radius', e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <label className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer md:col-span-2">
          <span className="text-[11px] font-semibold text-slate-200">Voice Groups Enabled</span>
          <input
            type="checkbox"
            checked={settings['groups_enabled'] !== 'false'}
            disabled={!canManage}
            onChange={(e) => handleChange('groups_enabled', e.target.checked ? 'true' : 'false')}
            className="w-4 h-4 accent-emerald-500 rounded cursor-pointer disabled:opacity-50"
          />
        </label>
      </div>

      {canManage && (
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg shadow-emerald-600/20 transition"
        >
          {saving ? 'Saving...' : 'Save Voice Chat Settings'}
        </button>
      )}
    </div>
  );
}
