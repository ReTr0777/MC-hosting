'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { Chip, InlineError, LoadingLine, Notice, PanelHeader } from '@/components/ui';

interface ResizeInfo {
  memoryMb: number;
  cpuLimit: number;
  executionMode: string;
  status: string;
  isBusy: boolean;
  minMemoryMb: number;
  memoryCeiling: number | null;
  cpuCeiling: number | null;
  /** The owner's quota alone, before the node's free space is folded in. */
  quotaMemoryCeiling: number | null;
  nodeName: string;
  nodeFreeMemoryMb: number | null;
  nodeFreeCpu: number | null;
  requiresRebuild: boolean;
}

const RAM_PRESETS = [1024, 2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768];
const CPU_PRESETS = [0.5, 1, 2, 3, 4, 6, 8, 12, 16];

function formatRam(mb: number): string {
  return mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`;
}

/** Presets plus whatever the server is currently set to, so a custom size stays selectable. */
function withCurrent(presets: number[], current: number): number[] {
  return presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
}

export default function ResourcesTab({ serverId, onResized }: { serverId: string; onResized?: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [info, setInfo] = useState<ResizeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);

  const [memoryMb, setMemoryMb] = useState(0);
  const [cpuLimit, setCpuLimit] = useState(0);

  const load = useCallback(async () => {
    try {
      const data: ResizeInfo = await apiRequest(`/api/servers/${serverId}/resize`);
      setInfo(data);
      setMemoryMb(data.memoryMb);
      setCpuLimit(data.cpuLimit);
      setLoadError('');
      setForbidden(false);
    } catch (err) {
      const message = errorMessage(err, 'Could not read the resource settings');
      // Everyone can see this tab; only the owner gets the controls.
      if (/forbidden/i.test(message)) setForbidden(true);
      else setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => { load(); }, [load]);

  const dirty = !!info && (memoryMb !== info.memoryMb || cpuLimit !== info.cpuLimit);

  const handleSave = async () => {
    if (!info || !dirty) return;

    if (info.requiresRebuild) {
      const ok = await confirm({
        title: 'Rebuild this container?',
        message:
          'Docker fixes a container’s memory and CPU limits when it is created, so applying new limits rebuilds ' +
          'the container. The world volume is synced to the host first and re-attached afterwards, so your world and ' +
          'files are kept — but the server must stay stopped until the rebuild finishes.',
        confirmLabel: 'Rebuild with new limits',
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      const data = await apiPost(`/api/servers/${serverId}/resize`, { memoryMb, cpuLimit });
      toast.success('Resources updated', data?.message);
      await load();
      onResized?.();
    } catch (err) {
      toast.error('Could not change the resources', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingLine>Loading resource settings…</LoadingLine>;

  if (forbidden) {
    return (
      <div style={{ display: 'grid', gap: '16px', maxWidth: '64rem' }}>
        <PanelHeader title="Resources" description="How much RAM and CPU this server is allowed to use." />
        <Notice tone="warning">
          Only the server&apos;s owner can change its RAM and CPU, because the allocation is charged against their quota.
        </Notice>
      </div>
    );
  }

  if (loadError || !info) return <InlineError message={loadError || 'No resource data'} onRetry={load} />;

  const ramOptions = withCurrent(RAM_PRESETS, info.memoryMb);
  const cpuOptions = withCurrent(CPU_PRESETS, info.cpuLimit);
  const overRam = info.memoryCeiling != null && memoryMb > info.memoryCeiling;
  const overCpu = info.cpuCeiling != null && cpuLimit > info.cpuCeiling;

  return (
    <div style={{ display: 'grid', gap: '16px', maxWidth: '64rem' }}>
      <PanelHeader
        title="Resources"
        chips={
          <>
            <Chip tone="accent">{formatRam(info.memoryMb)} RAM</Chip>
            <Chip>{info.cpuLimit} core{info.cpuLimit === 1 ? '' : 's'}</Chip>
          </>
        }
        description="Change how much memory and CPU this server may use. Changes are checked against the owner's quota."
      />

      {info.isBusy && (
        <Notice tone="warning">
          The server is {info.status.toLowerCase()}. Stop it before changing its resources — a running server is holding
          the allocation you are trying to change.
        </Notice>
      )}

      {info.requiresRebuild && !info.isBusy && (
        <Notice>
          This server runs in a Docker container, whose limits are fixed at creation. Saving rebuilds the container
          around the existing world volume; nothing in the world is lost, but the rebuild takes a moment.
        </Notice>
      )}

      <div className="cc-panel" style={{ display: 'grid', gap: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
          <div>
            <label className="cc-label" htmlFor="rs-ram">Memory</label>
            <select
              id="rs-ram"
              value={memoryMb}
              disabled={info.isBusy || saving}
              onChange={(e) => setMemoryMb(parseInt(e.target.value, 10))}
              className="cc-input"
            >
              {ramOptions.map((mb) => (
                <option key={mb} value={mb} disabled={info.memoryCeiling != null && mb > info.memoryCeiling}>
                  {formatRam(mb)}{info.memoryCeiling != null && mb > info.memoryCeiling ? ' — over quota' : ''}
                </option>
              ))}
            </select>
            <p className="cc-help">
              {info.memoryCeiling == null
                ? 'Nothing limits how much memory this server may have.'
                : // Saying which of the two ceilings is binding is the difference between "ask for
                  // more quota" and "this node is full" — very different next steps.
                  info.quotaMemoryCeiling != null && info.quotaMemoryCeiling <= info.memoryCeiling
                  ? `Your quota allows up to ${formatRam(info.memoryCeiling)} for this server.`
                  : `Up to ${formatRam(info.memoryCeiling)} — that is all node "${info.nodeName}" has free.`}
            </p>
          </div>

          <div>
            <label className="cc-label" htmlFor="rs-cpu">CPU cores</label>
            <select
              id="rs-cpu"
              value={cpuLimit}
              disabled={info.isBusy || saving}
              onChange={(e) => setCpuLimit(parseFloat(e.target.value))}
              className="cc-input"
            >
              {cpuOptions.map((cores) => (
                <option key={cores} value={cores} disabled={info.cpuCeiling != null && cores > info.cpuCeiling}>
                  {cores} core{cores === 1 ? '' : 's'}{info.cpuCeiling != null && cores > info.cpuCeiling ? ' — over quota' : ''}
                </option>
              ))}
            </select>
            <p className="cc-help">
              {info.cpuCeiling != null
                ? `Your quota allows up to ${info.cpuCeiling} core(s) for this server.`
                : 'No CPU quota applies to this server.'}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <p className="cc-help" style={{ margin: 0 }}>
            {dirty
              ? `${formatRam(info.memoryMb)} / ${info.cpuLimit} core(s) → ${formatRam(memoryMb)} / ${cpuLimit} core(s)`
              : 'Pick a new size to change this server.'}
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            {dirty && (
              <button
                type="button"
                className="cc-btn-ghost"
                disabled={saving}
                onClick={() => { setMemoryMb(info.memoryMb); setCpuLimit(info.cpuLimit); }}
              >
                Reset
              </button>
            )}
            <button
              type="button"
              className="cc-btn-primary"
              disabled={!dirty || saving || info.isBusy || overRam || overCpu}
              onClick={handleSave}
            >
              {saving ? 'Applying…' : info.requiresRebuild ? 'Apply & rebuild' : 'Apply'}
            </button>
          </div>
        </div>

        <p className="cc-help" style={{ margin: 0 }}>
          {info.requiresRebuild
            ? 'The new limits take effect as soon as the container is rebuilt.'
            : 'The new limits take effect the next time this server starts.'}
        </p>
      </div>
    </div>
  );
}
