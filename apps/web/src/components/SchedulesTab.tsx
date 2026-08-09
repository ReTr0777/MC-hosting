'use client';

import React, { useEffect, useState } from 'react';

interface ServerSchedule {
  id: string;
  name: string;
  cronExpression: string;
  actionType: 'BACKUP' | 'COMMAND' | 'START' | 'RESTART' | 'STOP';
  payload?: string | null;
  isEnabled: boolean;
  lastRunAt?: string | null;
  createdAt: string;
}

interface SchedulesTabProps {
  serverId: string;
}

const FREQUENCY_PRESETS = [
  { label: 'Every 6 Hours', cron: '0 */6 * * *' },
  { label: 'Every 12 Hours', cron: '0 */12 * * *' },
  { label: 'Daily at Midnight', cron: '0 0 * * *' },
  { label: 'Daily at 4 AM', cron: '0 4 * * *' },
  { label: 'Every 15 Minutes', cron: '*/15 * * * *' },
  { label: 'Custom Cron', cron: 'CUSTOM' },
];

export const SchedulesTab: React.FC<SchedulesTabProps> = ({ serverId }) => {
  const [schedules, setSchedules] = useState<ServerSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Modal / Form state
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [actionType, setActionType] = useState<'BACKUP' | 'COMMAND' | 'START' | 'RESTART' | 'STOP'>('BACKUP');
  const [payload, setPayload] = useState('/say Automated broadcast message');
  const [selectedPreset, setSelectedPreset] = useState('0 */6 * * *');
  const [customCron, setCustomCron] = useState('0 0 * * *');
  const [submitting, setSubmitting] = useState(false);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);

  const fetchSchedules = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/servers/${serverId}/schedules`);
      if (res.ok) {
        const data = await res.json();
        setSchedules(data.schedules || []);
      }
    } catch (err: any) {
      console.error('Failed to load schedules:', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSchedules();
  }, [serverId]);

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionMessage(null);

    const cronExpression = selectedPreset === 'CUSTOM' ? customCron.trim() : selectedPreset;
    if (!name.trim()) {
      setActionMessage({ type: 'error', text: 'Please enter a schedule name' });
      return;
    }
    if (!cronExpression) {
      setActionMessage({ type: 'error', text: 'Please enter a valid cron expression' });
      return;
    }

    try {
      setSubmitting(true);
      const res = await fetch(`/api/servers/${serverId}/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          cronExpression,
          actionType,
          payload: actionType === 'COMMAND' ? payload.trim() : null,
          isEnabled: true,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setActionMessage({ type: 'success', text: `Schedule '${name}' created successfully!` });
        setShowModal(false);
        setName('');
        setPayload('/say Automated broadcast message');
        fetchSchedules();
      } else {
        setActionMessage({ type: 'error', text: data.error || 'Failed to create schedule' });
      }
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleSchedule = async (schedule: ServerSchedule) => {
    try {
      const res = await fetch(`/api/servers/${serverId}/schedules/${schedule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: !schedule.isEnabled }),
      });
      if (res.ok) {
        fetchSchedules();
      }
    } catch (e) {}
  };

  const handleDeleteSchedule = async (id: string, schedName: string) => {
    if (!confirm(`Are you sure you want to delete schedule '${schedName}'?`)) return;
    try {
      const res = await fetch(`/api/servers/${serverId}/schedules/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setActionMessage({ type: 'success', text: `Schedule '${schedName}' deleted.` });
        fetchSchedules();
      }
    } catch (e) {}
  };

  const handleTriggerSchedule = async (id: string, schedName: string) => {
    try {
      setTriggeringId(id);
      setActionMessage(null);
      const res = await fetch(`/api/servers/${serverId}/schedules/${id}/trigger`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setActionMessage({ type: 'success', text: `⚡ Executed schedule '${schedName}'!` });
        fetchSchedules();
      } else {
        setActionMessage({ type: 'error', text: data.error || 'Failed to run schedule' });
      }
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err.message });
    } finally {
      setTriggeringId(null);
    }
  };

  const getActionBadge = (type: string) => {
    switch (type) {
      case 'BACKUP':
        return <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-0.5 rounded text-[11px] font-bold">📦 AUTO BACKUP</span>;
      case 'COMMAND':
        return <span className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2.5 py-0.5 rounded text-[11px] font-bold">💬 COMMAND</span>;
      case 'START':
        return <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-0.5 rounded text-[11px] font-bold">▶ AUTO START</span>;
      case 'RESTART':
        return <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2.5 py-0.5 rounded text-[11px] font-bold">↺ RESTART</span>;
      case 'STOP':
        return <span className="bg-red-500/10 text-red-400 border border-red-500/20 px-2.5 py-0.5 rounded text-[11px] font-bold">■ STOP</span>;
      default:
        return <span className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-[11px]">{type}</span>;
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Overview Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
            ⏰ Automated Schedules &amp; Tasks
          </h2>
          <p className="text-xs text-slate-400">
            Configure automated background backups, scheduled console commands, and automatic server restarts.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="cc-btn-primary flex-shrink-0 w-full sm:w-auto text-center"
        >
          + Create New Schedule
        </button>
      </div>

      {actionMessage && (
        <div className={`p-4 rounded-xl text-xs font-semibold ${actionMessage.type === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
          {actionMessage.text}
        </div>
      )}

      {/* Schedules List */}
      {loading ? (
        <div className="text-xs text-slate-400 text-center py-12">Loading schedules...</div>
      ) : schedules.length === 0 ? (
        <div className="bg-slate-950 border border-dashed border-slate-800 rounded-2xl p-10 text-center space-y-3">
          <div className="text-3xl">⏰</div>
          <div className="text-sm font-bold text-white">No Schedules Configured</div>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Set up automatic server backups every 6 hours or scheduled console commands (e.g. broadcast warnings).
          </p>
          <button
            onClick={() => setShowModal(true)}
            className="cc-btn-primary mt-2"
          >
            Create Your First Schedule
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5">
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              className={`bg-slate-900 border rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition ${
                schedule.isEnabled ? 'border-slate-800 hover:border-slate-700' : 'border-slate-850 opacity-60'
              }`}
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="font-bold text-sm text-white">{schedule.name}</span>
                  {getActionBadge(schedule.actionType)}
                  <span className="text-[11px] font-mono text-slate-400 bg-slate-950 border border-slate-800 px-2 py-0.5 rounded">
                    {schedule.cronExpression}
                  </span>
                </div>

                {schedule.actionType === 'COMMAND' && schedule.payload && (
                  <div className="text-xs font-mono text-indigo-300 bg-indigo-950/40 border border-indigo-900/30 px-3 py-1.5 rounded-lg">
                    › {schedule.payload}
                  </div>
                )}

                <div className="text-[11px] text-slate-400 flex items-center gap-3">
                  <span>
                    Last Run:{' '}
                    <strong className="text-slate-300">
                      {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : 'Never'}
                    </strong>
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 w-full sm:w-auto justify-end border-t sm:border-t-0 border-slate-800 pt-3 sm:pt-0 flex-shrink-0">
                <button
                  onClick={() => handleTriggerSchedule(schedule.id, schedule.name)}
                  disabled={triggeringId === schedule.id}
                  className="bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs font-bold px-3 py-1.5 rounded-lg transition"
                  title="Run Schedule Now"
                >
                  {triggeringId === schedule.id ? 'Executing...' : '⚡ Run Now'}
                </button>

                <button
                  onClick={() => handleToggleSchedule(schedule)}
                  className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition ${
                    schedule.isEnabled
                      ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
                      : 'bg-emerald-600/20 text-emerald-300 border-emerald-500/30'
                  }`}
                >
                  {schedule.isEnabled ? 'Pause' : 'Enable'}
                </button>

                <button
                  onClick={() => handleDeleteSchedule(schedule.id, schedule.name)}
                  className="text-xs font-bold text-red-400 hover:text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-1.5 rounded-lg transition"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Schedule Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                ⏰ Create Automated Schedule
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSchedule} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">Schedule Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Nightly Auto-Backup or Hourly Broadcast"
                  className="cc-input"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">Action Type</label>
                <select
                  value={actionType}
                  onChange={(e) => setActionType(e.target.value as any)}
                  className="cc-input"
                >
                  <option value="BACKUP">📦 Automated Server Backup</option>
                  <option value="COMMAND">💬 Execute Console Command</option>
                  <option value="START">▶ Automated Server Auto-Start</option>
                  <option value="RESTART">↺ Automated Server Restart</option>
                  <option value="STOP">■ Automated Server Shutdown</option>
                </select>
              </div>

              {actionType === 'COMMAND' && (
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">Console Command</label>
                  <input
                    type="text"
                    value={payload}
                    onChange={(e) => setPayload(e.target.value)}
                    placeholder="e.g. /say Server restarting in 5 minutes! or /save-all"
                    className="cc-input font-mono text-xs"
                    required
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">Frequency Preset</label>
                <select
                  value={selectedPreset}
                  onChange={(e) => setSelectedPreset(e.target.value)}
                  className="cc-input"
                >
                  {FREQUENCY_PRESETS.map((p) => (
                    <option key={p.cron} value={p.cron}>
                      {p.label} {p.cron !== 'CUSTOM' ? `(${p.cron})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {selectedPreset === 'CUSTOM' && (
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">Custom Cron Expression</label>
                  <input
                    type="text"
                    value={customCron}
                    onChange={(e) => setCustomCron(e.target.value)}
                    placeholder="e.g. 0 0 * * * (minute hour day month wday)"
                    className="cc-input font-mono text-xs"
                    required
                  />
                  <p className="text-[10px] text-slate-400 mt-1">
                    Standard 5-part cron syntax: <code className="font-mono text-emerald-400">minute hour day month wday</code>
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="cc-btn-ghost"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="cc-btn-primary"
                >
                  {submitting ? 'Creating...' : 'Create Schedule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
