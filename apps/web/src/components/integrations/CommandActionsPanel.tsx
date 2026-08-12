'use client';

import React, { useState } from 'react';
import { CommandActionDef } from '@/lib/integration-configs';
import { apiPost, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { Notice } from '@/components/ui';

interface CommandActionsPanelProps {
  serverId: string;
  canManage: boolean;
  serverStatus: string;
  actions: CommandActionDef[];
}

/** Replaces every occurrence of `{{name}}` — `String.replace` would only do the first. */
function fillTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (out, [name, value]) => out.split(`{{${name}}}`).join(value),
    template
  );
}

export default function CommandActionsPanel({ serverId, canManage, serverStatus, actions }: CommandActionsPanelProps) {
  const toast = useToast();
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const isRunning = serverStatus === 'RUNNING';

  const valueFor = (actionId: string, paramName: string, fallback: string) =>
    paramValues[actionId]?.[paramName] ?? fallback;

  const setValue = (actionId: string, paramName: string, value: string) =>
    setParamValues((prev) => ({ ...prev, [actionId]: { ...prev[actionId], [paramName]: value } }));

  const run = async (action: CommandActionDef) => {
    const values: Record<string, string> = {};
    for (const param of action.params || []) {
      values[param.name] = valueFor(action.id, param.name, param.default);
    }
    const command = fillTemplate(action.commandTemplate, values);

    setBusy(action.id);
    try {
      await apiPost(`/api/servers/${serverId}/command`, { command });
      toast.success('Command sent', `${command} — check the console for the result.`);
    } catch (err) {
      toast.error('Command failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      {!isRunning && <Notice tone="warning">The server must be running for these commands to do anything.</Notice>}

      {actions.map((action) => (
        <div
          key={action.id}
          style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '8px', padding: '14px', display: 'grid', gap: '10px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{action.label}</p>
              {action.description && <p className="cc-help" style={{ margin: '2px 0 0' }}>{action.description}</p>}
            </div>
            {canManage && (
              <button
                onClick={() => run(action)}
                disabled={!isRunning || busy === action.id}
                title={isRunning ? undefined : 'Start the server first'}
                className="cc-btn-primary"
                style={{ flexShrink: 0 }}
              >
                {busy === action.id ? 'Sending…' : 'Run'}
              </button>
            )}
          </div>

          {action.params && action.params.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
              {action.params.map((param) => {
                const inputId = `${action.id}-${param.name}`;
                return (
                  <div key={param.name}>
                    <label className="cc-label" htmlFor={inputId}>{param.label}</label>
                    <input
                      id={inputId}
                      type={param.type === 'number' ? 'number' : 'text'}
                      value={valueFor(action.id, param.name, param.default)}
                      disabled={!canManage}
                      onChange={(e) => setValue(action.id, param.name, e.target.value)}
                      className="cc-input"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
