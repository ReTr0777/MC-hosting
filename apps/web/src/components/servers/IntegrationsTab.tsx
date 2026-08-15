'use client';

import React, { useState } from 'react';
import { INTEGRATIONS, isIntegrationInstalled, isIntegrationVisible, integrationCategoryForServerType } from '@/lib/integrations/catalog';
import { COMMAND_ACTIONS } from '@/lib/integrations/configs';
import VoiceChatConfigPanel from './integrations/VoiceChatConfigPanel';
import YamlConfigPanel from './integrations/YamlConfigPanel';
import CommandActionsPanel from './integrations/CommandActionsPanel';
import { usePolledResource } from '@/hooks/usePolledResource';
import { Chip, InlineError, LoadingLine, Notice, PanelHeader } from '@/components/ui';

interface IntegrationsTabProps {
  serverId: string;
  canManage: boolean;
  serverType: string;
  serverStatus: string;
  onGoToMods?: () => void;
}

interface InstalledSets {
  mods: string[];
  plugins: string[];
}

const EMPTY: InstalledSets = { mods: [], plugins: [] };

export default function IntegrationsTab({ serverId, canManage, serverType, serverStatus, onGoToMods }: IntegrationsTabProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, loading, error, refresh } = usePolledResource<InstalledSets>(
    `/api/servers/${serverId}/integrations`,
    EMPTY,
    { select: (raw) => ({ mods: raw?.mods ?? [], plugins: raw?.plugins ?? [] }) }
  );

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const loaderCategory = integrationCategoryForServerType(serverType);
  const visible = INTEGRATIONS.filter((def) => isIntegrationVisible(def, serverType));
  const installedCount = visible.filter((def) => isIntegrationInstalled(def, data.mods, data.plugins)).length;

  if (loading) return <LoadingLine>Scanning mods/ and plugins/ for known integrations…</LoadingLine>;

  return (
    <div style={{ display: 'grid', gap: '16px', maxWidth: '64rem' }}>
      <PanelHeader
        title="Integrations"
        chips={installedCount > 0 ? <Chip tone="accent">{installedCount} installed</Chip> : undefined}
        description="Dedicated setup for popular mods and plugins, detected automatically from what's installed on this server."
        actions={<button onClick={refresh} className="cc-btn-ghost">Rescan</button>}
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      {!loaderCategory && (
        <Notice tone="warning">
          Vanilla servers can&apos;t run mods or plugins. Switch this server&apos;s engine to Fabric, Forge, Paper or Purpur in
          the Update Centre to use integrations.
        </Notice>
      )}

      <div style={{ display: 'grid', gap: '10px' }}>
        {visible.map((def) => {
          const installed = isIntegrationInstalled(def, data.mods, data.plugins);
          const isExpanded = expanded.has(def.id);

          return (
            <div key={def.id} className="cc-card" style={{ overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '16px 20px', flexWrap: 'wrap' }}>
                {/* Only the title area toggles; the "find it" action sits outside so it stays
                    independently focusable rather than nested inside another button. */}
                <button
                  onClick={() => installed && toggleExpanded(def.id)}
                  disabled={!installed}
                  aria-expanded={installed ? isExpanded : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1,
                    background: 'none', border: 'none', padding: 0, textAlign: 'left',
                    cursor: installed ? 'pointer' : 'default',
                  }}
                >
                  {installed && (
                    <span
                      aria-hidden="true"
                      style={{
                        color: 'var(--text-muted)', fontSize: '0.65rem', flexShrink: 0,
                        transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease',
                      }}
                    >
                      ▶
                    </span>
                  )}
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>{def.name}</span>
                    <span className="cc-help" style={{ display: 'block' }}>{def.description}</span>
                  </span>
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                  {!installed && onGoToMods && (
                    <button onClick={onGoToMods} className="cc-btn-ghost" style={{ padding: '4px 10px' }}>
                      Find it in Mods
                    </button>
                  )}
                  <Chip tone={installed ? 'accent' : 'default'}>{installed ? 'Installed' : 'Not installed'}</Chip>
                </div>
              </div>

              {isExpanded && installed && (
                <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
                  {def.panelType === 'voicechat' && <VoiceChatConfigPanel serverId={serverId} canManage={canManage} />}
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
                  {def.panelType === 'info' && <p className="cc-help" style={{ margin: 0 }}>{def.infoText}</p>}
                  {def.panelType === 'none' && (
                    <p className="cc-help" style={{ margin: 0 }}>
                      Dedicated configuration for {def.name} is coming soon. For now its config files can be edited directly
                      from the Files tab.
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
