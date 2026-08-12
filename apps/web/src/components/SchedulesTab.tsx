'use client';

import React, { useState } from 'react';
import { useConfirm } from '@/context/ConfirmContext';
import { useToast } from '@/context/ToastContext';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Chip, ChipTone, EmptyState, InlineError, Modal, PanelHeader, SkeletonRows } from '@/components/ui';

type ActionType = 'BACKUP' | 'COMMAND' | 'START' | 'RESTART' | 'STOP';

interface ServerSchedule {
  id: string;
  name: string;
  cronExpression: string;
  actionType: ActionType;
  payload?: string | null;
  isEnabled: boolean;
  lastRunAt?: string | null;
  createdAt: string;
}

const FREQUENCY_PRESETS = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Daily at midnight', cron: '0 0 * * *' },
  { label: 'Daily at 4 AM', cron: '0 4 * * *' },
  { label: 'Custom cron…', cron: 'CUSTOM' },
];

const ACTION_META: Record<ActionType, { label: string; tone: ChipTone; option: string }> = {
  BACKUP: { label: 'Backup', tone: 'accent', option: 'Take a backup' },
  COMMAND: { label: 'Command', tone: 'default', option: 'Run a console command' },
  START: { label: 'Start', tone: 'accent', option: 'Start the server' },
  RESTART: { label: 'Restart', tone: 'warning', option: 'Restart the server' },
  STOP: { label: 'Stop', tone: 'danger', option: 'Stop the server' },
};

/** Rough sanity check for standard 5-field cron, so obvious typos fail before the round trip. */
const CRON_PATTERN = /^(\S+\s+){4}\S+$/;

const DEFAULT_COMMAND = '/say Automated broadcast message';

export const SchedulesTab: React.FC<{ serverId: string; canManage?: boolean }> = ({ serverId, canManage = true }) => {
  const confirm = useConfirm();
  const toast = useToast();

  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [actionType, setActionType] = useState<ActionType>('BACKUP');
  const [payload, setPayload] = useState(DEFAULT_COMMAND);
  const [selectedPreset, setSelectedPreset] = useState(FREQUENCY_PRESETS[1].cron);
  const [customCron, setCustomCron] = useState('0 0 * * *');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: schedules, loading, error, refresh } = usePolledResource<ServerSchedule[]>(
    `/api/servers/${serverId}/schedules`,
    [],
    { select: (raw) => raw?.schedules ?? [] }
  );

  const resetForm = () => {
    setName('');
    setActionType('BACKUP');
    setPayload(DEFAULT_COMMAND);
    setSelectedPreset(FREQUENCY_PRESETS[1].cron);
    setCustomCron('0 0 * * *');
  };

  const closeModal = () => {
    setShowModal(false);
    resetForm();
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const cronExpression = selectedPreset === 'CUSTOM' ? customCron.trim() : selectedPreset;

    if (!name.trim()) {
      toast.error('Give the schedule a name');
      return;
    }
    if (!CRON_PATTERN.test(cronExpression)) {
      toast.error('That cron expression looks wrong', 'Use five fields: minute hour day month weekday.');
      return;
    }
    if (actionType === 'COMMAND' && !payload.trim()) {
      toast.error('Enter the command to run');
      return;
    }

    setSubmitting(true);
    try {
      await apiPost(`/api/servers/${serverId}/schedules`, {
        name: name.trim(),
        cronExpression,
        actionType,
        payload: actionType === 'COMMAND' ? payload.trim() : null,
        isEnabled: true,
      });
      toast.success(`Schedule “${name.trim()}” created`);
      closeModal();
      await refresh();
    } catch (err) {
      toast.error('Could not create the schedule', errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleSchedule = async (schedule: ServerSchedule) => {
    setBusyId(schedule.id);
    try {
      await apiRequest(`/api/servers/${serverId}/schedules/${schedule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: !schedule.isEnabled }),
      });
      toast.success(schedule.isEnabled ? `Paused “${schedule.name}”` : `Enabled “${schedule.name}”`);
      await refresh();
    } catch (err) {
      // This used to swallow the error, leaving the toggle looking stuck.
      toast.error('Could not update the schedule', errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteSchedule = async (schedule: ServerSchedule) => {
    const ok = await confirm({
      title: 'Delete this schedule?',
      message: (
        <>
          <strong style={{ color: 'var(--text-primary)' }}>{schedule.name}</strong> will stop running. Anything it has already
          done is left alone.
        </>
      ),
      confirmLabel: 'Delete schedule',
      danger: true,
    });
    if (!ok) return;

    setBusyId(schedule.id);
    try {
      await apiRequest(`/api/servers/${serverId}/schedules/${schedule.id}`, { method: 'DELETE' });
      toast.success(`Deleted “${schedule.name}”`);
      await refresh();
    } catch (err) {
      toast.error('Could not delete the schedule', errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleTriggerSchedule = async (schedule: ServerSchedule) => {
    setBusyId(schedule.id);
    try {
      await apiPost(`/api/servers/${serverId}/schedules/${schedule.id}/trigger`, {});
      toast.success(`Ran “${schedule.name}”`);
      await refresh();
    } catch (err) {
      toast.error('Could not run the schedule', errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: 'grid', gap: '16px', maxWidth: '72rem' }}>
      <PanelHeader
        title="Schedules"
        chips={schedules.length > 0 ? <Chip>{schedules.length} configured</Chip> : undefined}
        description="Run backups, console commands, restarts and shutdowns automatically on a cron schedule."
        actions={canManage && <button onClick={() => setShowModal(true)} className="cc-btn-primary">New schedule</button>}
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      {loading ? (
        <SkeletonRows rows={2} height={84} />
      ) : schedules.length === 0 ? (
        <EmptyState
          title="No schedules configured"
          description="Set up an automatic backup every few hours, or a nightly restart with a warning broadcast beforehand."
        />
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          {schedules.map((schedule) => {
            const meta = ACTION_META[schedule.actionType] ?? { label: schedule.actionType, tone: 'default' as ChipTone };
            const busy = busyId === schedule.id;
            return (
              <div
                key={schedule.id}
                className="cc-row"
                style={{ alignItems: 'flex-start', flexWrap: 'wrap', opacity: schedule.isEnabled ? 1 : 0.6 }}
              >
                <div style={{ display: 'grid', gap: '6px', minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>{schedule.name}</span>
                    <Chip tone={meta.tone}>{meta.label}</Chip>
                    {!schedule.isEnabled && <Chip>Paused</Chip>}
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-muted)',
                        background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '4px', padding: '1px 7px',
                      }}
                    >
                      {schedule.cronExpression}
                    </span>
                  </div>

                  {schedule.actionType === 'COMMAND' && schedule.payload && (
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-primary)',
                        background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: '6px',
                        padding: '6px 10px', wordBreak: 'break-all',
                      }}
                    >
                      {schedule.payload}
                    </code>
                  )}

                  <span className="cc-row-sub">Last run: {schedule.lastRunAt ? formatDateTime(schedule.lastRunAt) : 'Never'}</span>
                </div>

                {canManage && (
                  <div className="cc-row-actions">
                    <button onClick={() => handleTriggerSchedule(schedule)} disabled={busy} className="cc-btn-ghost" style={{ padding: '4px 10px' }} title="Run this schedule now">
                      {busy ? '…' : 'Run now'}
                    </button>
                    <button onClick={() => handleToggleSchedule(schedule)} disabled={busy} className="cc-btn-ghost" style={{ padding: '4px 10px' }}>
                      {schedule.isEnabled ? 'Pause' : 'Enable'}
                    </button>
                    <button onClick={() => handleDeleteSchedule(schedule)} disabled={busy} className="cc-btn-danger" style={{ padding: '4px 10px' }}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <Modal
          title="Create a schedule"
          onClose={closeModal}
          footer={
            <>
              <button type="button" onClick={closeModal} className="cc-btn-ghost">Cancel</button>
              <button type="submit" form="schedule-form" disabled={submitting} className="cc-btn-primary">
                {submitting ? 'Creating…' : 'Create schedule'}
              </button>
            </>
          }
        >
          <form id="schedule-form" onSubmit={handleCreateSchedule} style={{ display: 'grid', gap: '16px' }}>
            <div>
              <label className="cc-label" htmlFor="sch-name">Name</label>
              <input
                id="sch-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nightly backup"
                className="cc-input"
                required
              />
            </div>

            <div>
              <label className="cc-label" htmlFor="sch-action">What should it do?</label>
              <select
                id="sch-action"
                value={actionType}
                onChange={(e) => setActionType(e.target.value as ActionType)}
                className="cc-input"
              >
                {(Object.keys(ACTION_META) as ActionType[]).map((key) => (
                  <option key={key} value={key}>{ACTION_META[key].option}</option>
                ))}
              </select>
            </div>

            {actionType === 'COMMAND' && (
              <div>
                <label className="cc-label" htmlFor="sch-payload">Console command</label>
                <input
                  id="sch-payload"
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  placeholder="/say Server restarting in 5 minutes"
                  className="cc-input"
                  style={{ fontFamily: 'var(--font-mono)' }}
                  required
                />
              </div>
            )}

            <div>
              <label className="cc-label" htmlFor="sch-freq">How often?</label>
              <select
                id="sch-freq"
                value={selectedPreset}
                onChange={(e) => setSelectedPreset(e.target.value)}
                className="cc-input"
              >
                {FREQUENCY_PRESETS.map((p) => (
                  <option key={p.cron} value={p.cron}>
                    {p.label}{p.cron !== 'CUSTOM' ? ` (${p.cron})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {selectedPreset === 'CUSTOM' && (
              <div>
                <label className="cc-label" htmlFor="sch-cron">Cron expression</label>
                <input
                  id="sch-cron"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 0 * * *"
                  className="cc-input"
                  style={{ fontFamily: 'var(--font-mono)' }}
                  required
                />
                <p className="cc-help">Five fields: minute, hour, day of month, month, day of week.</p>
              </div>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
};

export default SchedulesTab;
