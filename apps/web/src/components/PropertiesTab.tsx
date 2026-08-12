'use client';

import React, { useEffect, useState } from 'react';

interface PropertiesTabProps {
  serverId: string;
  onSaveNotice?: () => void;
}

export default function PropertiesTab({ serverId }: PropertiesTabProps) {
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [iconKey, setIconKey] = useState<number>(Date.now());
  const [uploadingIcon, setUploadingIcon] = useState(false);

  useEffect(() => {
    fetchProperties();
  }, [serverId]);

  const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingIcon(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/icon`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });

      if (res.ok) {
        setIconKey(Date.now());
        setMessage({ kind: 'ok', text: 'Server icon updated! Minecraft will display server-icon.png in the multiplayer server list.' });
      } else {
        const err = await res.json();
        setMessage({ kind: 'err', text: `Icon upload failed: ${err.error}` });
      }
    } catch (err: any) {
      setMessage({ kind: 'err', text: `Icon upload failed: ${err.message}` });
    } finally {
      setUploadingIcon(false);
    }
  };

  const fetchProperties = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/properties`);
      if (res.ok) {
        const data = await res.json();
        setProperties(data.properties || {});
      }
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (key: string, value: string) => {
    setProperties((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/properties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: 'server.properties updated successfully! Restart the server to apply changes.' });
      } else {
        setMessage({ kind: 'err', text: `Error: ${data.error}` });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: `Error: ${e.message}` });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-center py-12 text-slate-500 text-sm animate-pulse">Loading server.properties config...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <span>Visual server.properties Editor</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">Easily configure game mechanics, difficulty, MOTD, server icon, and performance settings.</p>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-emerald-600/20 transition flex items-center space-x-2"
        >
          {saving ? <span>Saving...</span> : <span>Save Configuration</span>}
        </button>
      </div>

      {message && (
        <div className={`p-4 rounded-xl text-xs font-semibold ${message.kind === 'err' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
          {message.text}
        </div>
      )}

      {/* Server Icon & Branding Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-wider border-b border-slate-800 pb-3 flex items-center justify-between">
          <span>Minecraft Server Icon (server-icon.png)</span>
        </h3>
        <div className="flex items-center space-x-5">
          <div className="w-16 h-16 rounded-2xl bg-slate-950 border border-slate-800 overflow-hidden flex items-center justify-center flex-shrink-0 shadow-inner">
            <img
              src={`/api/servers/${serverId}/icon?v=${iconKey}`}
              alt="Server Icon"
              className="w-full h-full object-cover"
              style={{ imageRendering: 'pixelated' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <span className="text-xs font-mono font-bold text-slate-500">64x64</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-slate-300 font-semibold mb-1">Custom Multiplayer Server Icon</p>
            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
              Upload a 64x64 image. Minecraft automatically loads <code className="text-emerald-400 font-mono">server-icon.png</code> to display next to your server name in the in-game multiplayer list and on the CraftControl overview.
            </p>
            <label className="inline-flex items-center px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl cursor-pointer shadow transition">
              {uploadingIcon ? 'Uploading...' : 'Upload New Icon'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleIconUpload}
                className="hidden"
                disabled={uploadingIcon}
              />
            </label>
          </div>
        </div>
      </div>

      {/* Form Section 1: General & World */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
        <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-wider border-b border-slate-800 pb-3">
          General & Gameplay Mechanics
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Server MOTD (Message of the Day)</label>
            <input
              type="text"
              value={properties['motd'] || ''}
              onChange={(e) => handleChange('motd', e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
              placeholder="A Minecraft Server"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Default Game Mode</label>
            <select
              value={properties['gamemode'] || 'survival'}
              onChange={(e) => handleChange('gamemode', e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
            >
              <option value="survival">Survival</option>
              <option value="creative">Creative</option>
              <option value="adventure">Adventure</option>
              <option value="spectator">Spectator</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Game Difficulty</label>
            <select
              value={properties['difficulty'] || 'easy'}
              onChange={(e) => handleChange('difficulty', e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
            >
              <option value="peaceful">Peaceful</option>
              <option value="easy">Easy</option>
              <option value="normal">Normal</option>
              <option value="hard">Hard</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Max Players</label>
            <input
              type="number"
              value={properties['max-players'] || '20'}
              onChange={(e) => handleChange('max-players', e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Form Section 2: Features & Toggles */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
        <h3 className="text-sm font-bold text-cyan-400 uppercase tracking-wider border-b border-slate-800 pb-3">
          Toggles & Rules
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
            <span className="text-xs font-semibold text-slate-200">PvP (Player Combat)</span>
            <input
              type="checkbox"
              checked={properties['pvp'] === 'true'}
              onChange={(e) => handleChange('pvp', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
            />
          </label>

          <label className="flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
            <span className="text-xs font-semibold text-slate-200">Allow Nether</span>
            <input
              type="checkbox"
              checked={properties['allow-nether'] !== 'false'}
              onChange={(e) => handleChange('allow-nether', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
            />
          </label>

          <label className="flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
            <span className="text-xs font-semibold text-slate-200">Hardcore Mode</span>
            <input
              type="checkbox"
              checked={properties['hardcore'] === 'true'}
              onChange={(e) => handleChange('hardcore', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
            />
          </label>

          <label className="flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
            <span className="text-xs font-semibold text-slate-200">Allow Flight</span>
            <input
              type="checkbox"
              checked={properties['allow-flight'] === 'true'}
              onChange={(e) => handleChange('allow-flight', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
            />
          </label>

          <label className="flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
            <span className="text-xs font-semibold text-slate-200">Command Blocks</span>
            <input
              type="checkbox"
              checked={properties['enable-command-block'] === 'true'}
              onChange={(e) => handleChange('enable-command-block', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
            />
          </label>

          <label className="flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
            <span className="text-xs font-semibold text-slate-200">Online Mode (Mojang Auth)</span>
            <input
              type="checkbox"
              checked={properties['online-mode'] !== 'false'}
              onChange={(e) => handleChange('online-mode', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
            />
          </label>
        </div>
      </div>

      {/* Form Section 3: Performance */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
        <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider border-b border-slate-800 pb-3">
          Performance & Distances
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">View Distance (Chunks)</label>
            <input
              type="number"
              min={2}
              max={32}
              value={properties['view-distance'] || '10'}
              onChange={(e) => handleChange('view-distance', e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Simulation Distance (Chunks)</label>
            <input
              type="number"
              min={2}
              max={32}
              value={properties['simulation-distance'] || '10'}
              onChange={(e) => handleChange('simulation-distance', e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
