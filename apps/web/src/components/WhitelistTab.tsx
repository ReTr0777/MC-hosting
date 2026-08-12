'use client';

import React, { useState } from 'react';
import { usePolledResource } from '@/hooks/usePolledResource';
import { apiPost, errorMessage, isValidUsername, USERNAME_HINT } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import {
  Chip, EmptyState, InlineError, LoadingLine, Mono, Notice, PanelHeader, PlayerAvatar, StatTile,
} from '@/components/ui';

interface WhitelistEntry {
  uuid: string;
  name: string;
  isOp: boolean;
  opLevel: number | null;
  online: boolean;
  avatarUrl: string;
}

interface WhitelistSnapshot {
  enabled: boolean;
  enforce: boolean;
  onlineMode: boolean;
  live: boolean;
  count: number;
  entries: WhitelistEntry[];
  unlistedOps: string[];
}

const EMPTY: WhitelistSnapshot = {
  enabled: false,
  enforce: false,
  onlineMode: true,
  live: false,
  count: 0,
  entries: [],
  unlistedOps: [],
};

export default function WhitelistTab({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [filter, setFilter] = useState('');

  const { data: snapshot, loading, error, refresh } = usePolledResource<WhitelistSnapshot>(
    `/api/servers/${serverId}/whitelist`,
    EMPTY,
    { intervalMs: 15000, select: (raw) => ({ ...EMPTY, ...raw }) }
  );

  const runAction = async (action: 'add' | 'remove' | 'on' | 'off' | 'reload', username?: string) => {
    setBusy(`${action}-${username || ''}`);
    try {
      const data = await apiPost(`/api/servers/${serverId}/whitelist`, { action, username });
      toast.success(data?.message || 'Whitelist updated');
      if (action === 'add') setNewName('');
      await refresh();
    } catch (err) {
      toast.error('Whitelist action failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (!isValidUsername(name)) {
      toast.error('That username looks wrong', USERNAME_HINT);
      return;
    }
    runAction('add', name);
  };

  const handleRemove = async (name: string) => {
    const ok = await confirm({
      title: `Remove ${name} from the whitelist?`,
      message: snapshot.enabled
        ? `${name} will no longer be able to join, and will be kicked if they are online.`
        : `${name} will be taken off the list. Enforcement is currently off, so this won't block them until you turn the whitelist on.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) runAction('remove', name);
  };

  const handleToggleEnforcement = async () => {
    if (snapshot.enabled) {
      const ok = await confirm({
        title: 'Turn the whitelist off?',
        message: 'Anyone who knows the address will be able to join this server until you turn it back on.',
        confirmLabel: 'Turn off',
        danger: true,
      });
      if (!ok) return;
    }
    runAction(snapshot.enabled ? 'off' : 'on');
  };

  const needle = filter.trim().toLowerCase();
  const visible = needle ? snapshot.entries.filter((e) => e.name.toLowerCase().includes(needle)) : snapshot.entries;
  const onlineCount = snapshot.entries.filter((e) => e.online).length;

  if (loading) return <LoadingLine>Reading whitelist.json from the server…</LoadingLine>;

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader
        title="Whitelist"
        chips={
          <>
            <Chip tone="accent">{snapshot.count} allowed</Chip>
            <Chip tone={snapshot.enabled ? 'accent' : 'default'}>
              {snapshot.enabled ? 'Enforcing' : 'Not enforcing'}
            </Chip>
          </>
        }
        description={<>Everyone permitted to join, read live from <Mono>whitelist.json</Mono>.</>}
        actions={
          <>
            <button onClick={refresh} className="cc-btn-ghost">Refresh</button>
            {canManage && (
              <button
                onClick={handleToggleEnforcement}
                disabled={!!busy}
                className={snapshot.enabled ? 'cc-btn-warning' : 'cc-btn-primary'}
              >
                {snapshot.enabled ? 'Turn whitelist off' : 'Turn whitelist on'}
              </button>
            )}
          </>
        }
      />

      {error && <InlineError message={error} onRetry={refresh} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
        <StatTile label="Whitelisted" value={snapshot.count} />
        <StatTile label="Online now" value={onlineCount} tone={onlineCount > 0 ? 'accent' : 'default'} />
        <StatTile label="Enforcement" value={snapshot.enabled ? 'On' : 'Off'} tone={snapshot.enabled ? 'accent' : 'warning'} />
        <StatTile label="Server state" value={snapshot.live ? 'Live' : 'Offline'} tone={snapshot.live ? 'accent' : 'default'} />
      </div>

      {!snapshot.enabled && snapshot.count > 0 && (
        <Notice tone="warning">
          This list has {snapshot.count} {snapshot.count === 1 ? 'entry' : 'entries'} but <Mono>white-list=false</Mono> — anyone
          can currently join. Turn enforcement on to apply it.
        </Notice>
      )}

      {!snapshot.onlineMode && (
        <Notice>
          This server runs in <strong>offline mode</strong>. Entries are matched by username rather than Mojang UUID, and new
          names can only be added while the server is running.
        </Notice>
      )}

      {snapshot.unlistedOps.length > 0 && (
        <Notice>
          {snapshot.unlistedOps.length} operator{snapshot.unlistedOps.length === 1 ? '' : 's'} not on this list:{' '}
          <strong style={{ color: 'var(--text-primary)' }}>{snapshot.unlistedOps.join(', ')}</strong>. Operators are still
          rejected by an enforced whitelist unless they are added here.
        </Notice>
      )}

      <div className="cc-panel" style={{ display: 'grid', gap: '14px' }}>
        {canManage && (
          <form onSubmit={handleAdd} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Minecraft username"
              aria-label="Minecraft username to whitelist"
              className="cc-input"
              style={{ flex: 1, minWidth: '200px' }}
            />
            <button type="submit" disabled={!!busy || !newName.trim()} className="cc-btn-primary">
              {busy?.startsWith('add') ? 'Adding…' : 'Add to whitelist'}
            </button>
            {snapshot.live && (
              <button
                type="button"
                onClick={() => runAction('reload')}
                disabled={!!busy}
                title="Re-read whitelist.json into the running server"
                className="cc-btn-ghost"
              >
                Reload
              </button>
            )}
          </form>
        )}

        {snapshot.count > 6 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter whitelisted players…"
            aria-label="Filter whitelisted players"
            className="cc-input"
          />
        )}

        {snapshot.count === 0 ? (
          <EmptyState
            title="Whitelist is empty"
            description={
              canManage
                ? 'No players are on the allow-list yet. Add a username above to let them through.'
                : 'No players are on the allow-list yet. Ask a server admin to add you.'
            }
          />
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            No whitelisted player matches “{filter}”.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px' }}>
            {visible.map((entry) => (
              <div key={entry.uuid || entry.name} className="cc-row">
                <div className="cc-row-main">
                  <PlayerAvatar src={entry.avatarUrl} name={entry.name} size={36} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span className="cc-row-title">{entry.name}</span>
                      {entry.isOp && (
                        <Chip tone="warning" title={entry.opLevel ? `Operator level ${entry.opLevel}` : 'Operator'}>OP</Chip>
                      )}
                    </div>
                    {entry.online ? (
                      <span className="cc-row-sub" style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--accent)' }}>
                        <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
                        Online now
                      </span>
                    ) : (
                      <span
                        className="cc-row-sub"
                        title={entry.uuid || 'No UUID recorded'}
                        style={{ fontFamily: 'var(--font-mono)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {entry.uuid || 'no uuid'}
                      </span>
                    )}
                  </div>
                </div>

                {canManage && (
                  <button
                    onClick={() => handleRemove(entry.name)}
                    disabled={!!busy}
                    title={`Remove ${entry.name} from the whitelist`}
                    aria-label={`Remove ${entry.name} from the whitelist`}
                    className="cc-btn-danger"
                    style={{ padding: '4px 10px' }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
        {snapshot.live
          ? 'Changes are sent as console commands and take effect immediately.'
          : 'The server is offline — changes are written to whitelist.json and apply on next start.'}
      </p>
    </div>
  );
}
