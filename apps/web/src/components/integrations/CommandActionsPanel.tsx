'use client';

import React, { useState } from 'react';
import { CommandActionDef } from '@/lib/integration-configs';

interface CommandActionsPanelProps {
  serverId: string;
  canManage: boolean;
  serverStatus: string;
  actions: CommandActionDef[];
}

export default function CommandActionsPanel({ serverId, canManage, serverStatus, actions }: CommandActionsPanelProps) {
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const isRunning = serverStatus === 'RUNNING';

  const valueFor = (actionId: string, paramName: string, fallback: string) =>
    paramValues[actionId]?.[paramName] ?? fallback;

  const setValue = (actionId: string, paramName: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [actionId]: { ...prev[actionId], [paramName]: value } }));
  };

  const run = async (action: CommandActionDef) => {
    let command = action.commandTemplate;
    for (const param of action.params || []) {
      const value = valueFor(action.id, param.name, param.default);
      command = command.replace(`{{${param.name}}}`, value);
    }

    setBusy(action.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ kind: 'ok', text: `Sent: ${command} — check console for the result.` });
      } else {
        setMessage({ kind: 'err', text: data.error || 'Command failed' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: 'Network error sending command' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 pt-2">
      {!isRunning && (
        <div className="p-3 rounded-xl text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
          The server must be running for these commands to do anything.
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

      <div className="space-y-3">
        {actions.map((action) => (
          <div key={action.id} className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-xs font-bold text-slate-200">{action.label}</p>
                {action.description && <p className="text-[10px] text-slate-500 mt-0.5">{action.description}</p>}
              </div>
              {canManage && (
                <button
                  onClick={() => run(action)}
                  disabled={!isRunning || busy === action.id}
                  className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-[11px] px-4 py-1.5 rounded-lg shadow transition shrink-0"
                >
                  {busy === action.id ? 'Sending...' : 'Run'}
                </button>
              )}
            </div>

            {action.params && action.params.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {action.params.map((param) => (
                  <div key={param.name}>
                    <label className="block text-[10px] text-slate-400 mb-1">{param.label}</label>
                    <input
                      type={param.type === 'number' ? 'number' : 'text'}
                      value={valueFor(action.id, param.name, param.default)}
                      disabled={!canManage}
                      onChange={(e) => setValue(action.id, param.name, e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-[11px] text-white focus:border-emerald-500 focus:outline-none disabled:opacity-50"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
