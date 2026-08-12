'use client';

import React, { useEffect, useState } from 'react';
import { INTEGRATIONS, isIntegrationInstalled, isIntegrationVisible, integrationCategoryForServerType } from '@/lib/integrations';
import { COMMAND_ACTIONS } from '@/lib/integration-configs';
import VoiceChatConfigPanel from './integrations/VoiceChatConfigPanel';
import YamlConfigPanel from './integrations/YamlConfigPanel';
import CommandActionsPanel from './integrations/CommandActionsPanel';

interface IntegrationsTabProps {
  serverId: string;
  canManage: boolean;
  serverType: string;
  serverStatus: string;
  onGoToMods?: () => void;
}

export default function IntegrationsTab({ serverId, canManage, serverType, serverStatus, onGoToMods }: IntegrationsTabProps) {
  const [mods, setMods] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/servers/${serverId}/integrations`);
        const data = await res.json();
        if (cancelled) return;
        if (res.ok) {
          setMods(data.mods || []);
          setPlugins(data.plugins || []);
        } else {
          setError(data.error || 'Failed to load installed mods/plugins');
        }
      } catch (e: any) {
        if (!cancelled) setError('Network error loading installed mods/plugins');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [serverId]);

  const loaderCategory = integrationCategoryForServerType(serverType);
  const visible = INTEGRATIONS.filter((def) => isIntegrationVisible(def, serverType));

  if (loading) {
    return <div className="text-center py-12 text-slate-500 text-sm animate-pulse">Scanning mods/ and plugins/ for known integrations...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-xl font-bold text-white">Integrations</h2>
        <p className="text-xs text-slate-400 mt-1">
          Dedicated setup for popular mods and plugins, detected automatically from what's installed.
        </p>
      </div>

      {error && (
        <div className="p-4 rounded-xl text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
          {error}
        </div>
      )}

      {!loaderCategory && (
        <div className="p-4 rounded-xl text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
          Vanilla servers can't run mods or plugins. Switch this server's engine to Fabric, Forge, Paper, or Purpur to use integrations.
        </div>
      )}

      <div className="space-y-3">
        {visible.map((def) => {
          const installed = isIntegrationInstalled(def, mods, plugins);
          const isExpanded = expanded.has(def.id);

          return (
            <div key={def.id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              <button
                onClick={() => installed && toggleExpanded(def.id)}
                className={`w-full flex items-center justify-between gap-4 p-5 text-left ${installed ? 'cursor-pointer hover:bg-slate-800/40' : 'cursor-default'} transition`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {installed && (
                    <span className={`text-slate-500 text-xs shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                  )}
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white">{def.name}</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{def.description}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {!installed && (
                    <span
                      onClick={(e) => { e.stopPropagation(); onGoToMods?.(); }}
                      className="text-xs font-bold text-slate-300 hover:text-white transition"
                    >
                      Find it in Mods →
                    </span>
                  )}
                  <span
                    className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${
                      installed
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                  >
                    {installed ? 'Installed' : 'Not installed'}
                  </span>
                </div>
              </button>

              {isExpanded && installed && (
                <div className="px-5 pb-5 pt-1 border-t border-slate-800">
                  {def.panelType === 'voicechat' && (
                    <VoiceChatConfigPanel serverId={serverId} canManage={canManage} />
                  )}
                  {def.panelType === 'yaml' && def.panelKey && (
                    <YamlConfigPanel serverId={serverId} canManage={canManage} mod={def.panelKey} />
                  )}
                  {def.panelType === 'commands' && def.panelKey && (
                    <CommandActionsPanel
                      serverId={serverId}
                      canManage={canManage}
                      serverStatus={serverStatus}
                      actions={COMMAND_ACTIONS[def.panelKey] || []}
                    />
                  )}
                  {def.panelType === 'info' && (
                    <p className="text-[11px] text-slate-400 leading-relaxed pt-3">{def.infoText}</p>
                  )}
                  {def.panelType === 'none' && (
                    <p className="text-[11px] text-slate-400 leading-relaxed pt-3">
                      Dedicated configuration for {def.name} is coming soon. For now, its config files can be edited
                      directly from the Files tab.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
