'use client';

import React, { useState } from 'react';

interface UpdateCenterTabProps {
  server: {
    id: string;
    name: string;
    serverType: string;
    mcVersion: string;
    status: string;
    memoryMb: number;
    serverPort: number;
  };
  onUpdateSuccess?: () => void;
}

const ENGINE_OPTIONS = [
  { id: 'FABRIC', name: 'Fabric', desc: 'Lightweight & highly moddable loader', label: 'FA', color: '#a78bfa' },
  { id: 'FORGE', name: 'Forge', desc: 'Classic heavy modpack framework', label: 'FO', color: '#fb923c' },
  { id: 'PAPER', name: 'Paper', desc: 'High performance Spigot/Bukkit server', label: 'PA', color: '#60a5fa' },
  { id: 'PURPUR', name: 'Purpur', desc: 'Ultra configurable high performance Paper fork', label: 'PU', color: '#c084fc' },
  { id: 'VANILLA', name: 'Vanilla', desc: 'Official unmodified Mojang server', label: 'VA', color: '#34d399' },
];

const MC_VERSIONS = [
  '26.2',
  '1.21.4',
  '1.21.1',
  '1.21',
  '1.20.6',
  '1.20.4',
  '1.20.2',
  '1.20.1',
  '1.20',
  '1.19.4',
  '1.19.2',
  '1.19',
  '1.18.2',
  '1.18.1',
  '1.18',
  '1.17.1',
  '1.16.5',
  '1.12.2',
  '1.8.9',
  'CUSTOM',
];

export default function UpdateCenterTab({ server, onUpdateSuccess }: UpdateCenterTabProps) {
  const [selectedEngine, setSelectedEngine] = useState<string>(server.serverType || 'FABRIC');
  const [selectedMcVersion, setSelectedMcVersion] = useState<string>(server.mcVersion || '26.2');
  const [customMcVersion, setCustomMcVersion] = useState<string>('');
  const [createSafetyBackup, setCreateSafetyBackup] = useState<boolean>(true);
  const [updating, setUpdating] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const currentMcVersion = server.mcVersion || '26.2';
  const effectiveVersion = selectedMcVersion === 'CUSTOM' ? customMcVersion : selectedMcVersion;

  const handleApplyUpdate = async () => {
    if (selectedMcVersion === 'CUSTOM' && !customMcVersion.trim()) {
      setStatusMessage({ type: 'error', text: 'Please specify a custom Minecraft version string.' });
      return;
    }

    const confirmMsg = `Are you sure you want to change server '${server.name}' to ${selectedEngine} (${effectiveVersion})?\n\nThis will stop the server, update the JAR/loader files, and restart instance.`;
    if (!confirm(confirmMsg)) return;

    setUpdating(true);
    setStatusMessage(null);

    try {
      const res = await fetch(`/api/servers/${server.id}/update-engine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverType: selectedEngine,
          mcVersion: effectiveVersion,
          createBackup: createSafetyBackup,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setStatusMessage({ type: 'success', text: `✅ Server engine updated successfully to ${selectedEngine} (${effectiveVersion})!` });
        if (onUpdateSuccess) onUpdateSuccess();
      } else {
        setStatusMessage({ type: 'error', text: `❌ Update failed: ${data.error || data.details || 'Unknown error'}` });
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `❌ Network error: ${err.message}` });
    } finally {
      setUpdating(false);
    }
  };

  const handleRepairWorld = async () => {
    if (!confirm('Are you sure you want to repair your world headers?\n\nThis will restore your world from level.dat_old or reset invalid level.dat generator keys. Your blocks, regions, and player items will NOT be deleted.')) return;

    setUpdating(true);
    setStatusMessage(null);

    try {
      const res = await fetch(`/api/servers/${server.id}/repair-world`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage({ type: 'success', text: `✅ ${data.message}` });
        if (onUpdateSuccess) onUpdateSuccess();
      } else {
        setStatusMessage({ type: 'error', text: `❌ Repair failed: ${data.error || data.details || 'Unknown error'}` });
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `❌ Network error: ${err.message}` });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header Overview */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-3 mb-1">
            <h2 className="text-xl font-bold text-white">Server Update &amp; Engine Centre</h2>
            <span className="bg-indigo-500/20 text-indigo-400 text-xs px-2.5 py-0.5 rounded-full border border-indigo-500/30 font-mono font-bold">
              v1.0
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Switch Minecraft server engines (Fabric, Paper, Purpur, Forge, Vanilla) or change target Minecraft versions seamlessly.
          </p>
        </div>

        {/* Current Active Engine Card */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 flex items-center space-x-3.5 flex-shrink-0">
          <div className="w-10 h-10 rounded-lg bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center font-mono text-xs font-black text-indigo-400">
            {server.serverType?.substring(0, 2).toUpperCase() || 'MC'}
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Active Loader</div>
            <div className="text-sm font-bold text-white">
              {server.serverType} <span className="text-emerald-400 font-mono">({currentMcVersion})</span>
            </div>
          </div>
        </div>
      </div>

      {statusMessage && (
        <div className={`p-4 rounded-xl text-xs font-semibold ${statusMessage.type === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
          {statusMessage.text}
        </div>
      )}

      {/* Step 1: Select Server Engine */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-wider border-b border-slate-800 pb-3 flex items-center justify-between">
          <span>1. Choose Server Engine / Loader</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {ENGINE_OPTIONS.map((eng) => {
            const isSelected = selectedEngine === eng.id;
            return (
              <div
                key={eng.id}
                onClick={() => setSelectedEngine(eng.id)}
                className={`p-4 rounded-xl cursor-pointer border transition flex flex-col justify-between space-y-3 ${
                  isSelected
                    ? 'bg-emerald-500/10 border-emerald-500/50 shadow-lg shadow-emerald-500/5'
                    : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center font-mono text-xs font-black"
                    style={{ background: `${eng.color}20`, color: eng.color, border: `1px solid ${eng.color}40` }}
                  >
                    {eng.label}
                  </div>
                  {isSelected && (
                    <span className="text-[10px] bg-emerald-500 text-slate-950 font-bold px-2 py-0.5 rounded-full uppercase">
                      Selected
                    </span>
                  )}
                </div>
                <div>
                  <div className="text-sm font-bold text-white">{eng.name}</div>
                  <div className="text-[11px] text-slate-400 leading-snug mt-0.5">{eng.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Step 2: Select Minecraft Version */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-cyan-400 uppercase tracking-wider border-b border-slate-800 pb-3 flex items-center justify-between">
          <span>2. Select Target Minecraft Version</span>
          {server.serverType === 'CUSTOM_ZIP' && (
            <span className="text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 rounded-full font-mono">
              🔒 Version Locked to Serverpack
            </span>
          )}
        </h3>

        {server.serverType === 'CUSTOM_ZIP' ? (
          <div className="bg-slate-950 border border-amber-500/20 rounded-xl p-4 text-xs text-amber-300/90 leading-relaxed">
            🔒 <strong>Serverpack Version Locked:</strong> This instance was deployed from an uploaded serverpack archive. The Minecraft engine version (<code className="font-mono text-white font-bold">{currentMcVersion}</code>) is locked to the files provided in your serverpack archive.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">Minecraft Release Version</label>
              <select
                value={selectedMcVersion}
                onChange={(e) => setSelectedMcVersion(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none font-mono"
              >
                {MC_VERSIONS.map((ver) => (
                  <option key={ver} value={ver}>
                    {ver === 'CUSTOM' ? '⚙️ Custom / Snapshot...' : `Minecraft ${ver}`}
                  </option>
                ))}
              </select>
            </div>

            {selectedMcVersion === 'CUSTOM' && (
              <div>
                <label className="block text-xs font-semibold text-emerald-400 mb-1.5">Custom Snapshot / Version String</label>
                <input
                  type="text"
                  value={customMcVersion}
                  onChange={(e) => setCustomMcVersion(e.target.value)}
                  placeholder="e.g. 24w10a, 1.20.4"
                  className="w-full bg-slate-950 border border-emerald-500/40 rounded-xl px-4 py-2.5 text-xs text-white focus:border-emerald-500 focus:outline-none font-mono"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 3: Safety & Execution */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
        <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider border-b border-slate-800 pb-3">
          3. Safety Snapshot &amp; Execution
        </h3>

        <label className="flex items-start space-x-3 p-4 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
          <input
            type="checkbox"
            checked={createSafetyBackup}
            onChange={(e) => setCreateSafetyBackup(e.target.checked)}
            className="w-4 h-4 mt-0.5 accent-emerald-500 rounded cursor-pointer"
          />
          <div className="text-xs">
            <span className="font-bold text-white block">Automatically create a safety backup before applying update</span>
            <span className="text-slate-400 text-[11px] mt-0.5 block">
              CraftControl will snapshot your world, config, and player inventories before downloading the new engine files so you can revert anytime.
            </span>
          </div>
        </label>

        <div className="pt-2 flex items-center justify-between">
          <div className="text-xs text-slate-400">
            Target Engine: <strong className="text-white">{selectedEngine}</strong> ({effectiveVersion})
          </div>

          <button
            onClick={handleApplyUpdate}
            disabled={updating}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs px-7 py-3 rounded-xl shadow-lg shadow-emerald-600/20 transition flex items-center space-x-2"
          >
            {updating ? (
              <span>Updating Engine &amp; Downloading JAR...</span>
            ) : (
              <span>Apply &amp; Switch Server Engine</span>
            )}
          </button>
        </div>
      </div>

      {/* World Repair & Level.dat Fix Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-purple-400 uppercase tracking-wider">
              🔧 WorldGen / Level.dat Repair Utility
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Fixes <code className="text-purple-300 font-mono">WorldGenSettings: No key dimensions in MapLike</code> startup crashes caused by corrupted level.dat or version downgrades.
            </p>
          </div>
          <button
            onClick={handleRepairWorld}
            disabled={updating}
            className="bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/40 font-bold text-xs px-5 py-2.5 rounded-xl transition flex-shrink-0"
          >
            🔧 Auto-Repair World Header
          </button>
        </div>
      </div>
    </div>
  );
}
