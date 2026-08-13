'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { apiRequest, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { Chip, EmptyState, InlineError, LoadingLine, PanelHeader } from '@/components/ui';

interface AuditLogItem {
  id: string;
  userId: string | null;
  action: string;
  details: string | null;
  createdAt: string;
  user?: { username: string; email: string } | null;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

/** Colours an action badge by its rough category, purely cosmetic. */
function actionTone(action: string): 'default' | 'accent' | 'warning' | 'danger' {
  if (action.includes('DELETE') || action.includes('REVOKE') || action.includes('KILL')) return 'danger';
  if (action.includes('CREATE') || action.includes('GRANT') || action.includes('ADD')) return 'accent';
  if (action.includes('UPDATE') || action.includes('CHANGE')) return 'warning';
  return 'default';
}

function DetailsCell({ details }: { details: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!details) return <span style={{ color: 'var(--text-muted)' }}>—</span>;

  let pretty = details;
  try {
    pretty = JSON.stringify(JSON.parse(details), null, 2);
  } catch {
    // Not JSON — show as-is.
  }

  if (!expanded) {
    const preview = details.length > 60 ? `${details.slice(0, 60)}…` : details;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>{preview}</span>
        <button onClick={() => setExpanded(true)} className="cc-btn-ghost" style={{ padding: '2px 8px', fontSize: '0.65rem' }}>
          View
        </button>
      </span>
    );
  }

  return (
    <div>
      <pre
        style={{
          margin: 0,
          maxWidth: '28rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.68rem',
          color: 'var(--text-primary)',
          background: 'var(--bg)',
          border: '1px solid var(--border-2)',
          borderRadius: '6px',
          padding: '8px 10px',
        }}
      >
        {pretty}
      </pre>
      <button onClick={() => setExpanded(false)} className="cc-btn-ghost" style={{ marginTop: '6px', padding: '2px 8px', fontSize: '0.65rem' }}>
        Collapse
      </button>
    </div>
  );
}

export default function AuditLogPage() {
  const { user, loading: authLoading } = useAuth();

  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [actionFilter, setActionFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const isAdmin = user?.globalRole === 'GLOBAL_ADMIN';

  const fetchLogs = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('pageSize', String(pageSize));
      if (actionFilter.trim()) qs.set('action', actionFilter.trim());
      if (from) qs.set('from', new Date(from).toISOString());
      if (to) qs.set('to', new Date(to).toISOString());

      const data = await apiRequest(`/api/audit-log?${qs.toString()}`);
      setLogs(data?.logs || []);
      setTotal(data?.total || 0);
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load audit log'));
    } finally {
      setLoading(false);
    }
  }, [isAdmin, page, pageSize, actionFilter, from, to]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // Any filter change resets to page 1 so results aren't stranded on an empty page.
  useEffect(() => { setPage(1); }, [actionFilter, from, to, pageSize]);

  if (authLoading) return <LoadingLine>Loading…</LoadingLine>;

  if (!isAdmin) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Not authorised</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>
          Only global admins can view the audit log.
        </p>
        <Link href="/dashboard" className="cc-btn-primary" style={{ textDecoration: 'none' }}>Back to dashboard</Link>
      </div>
    );
  }

  const th: React.CSSProperties = {
    padding: '10px 14px', textAlign: 'left', fontSize: '0.62rem', fontWeight: 800,
    letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = { padding: '10px 14px', fontSize: '0.72rem', verticalAlign: 'top' };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: '80rem', margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Audit log</h1>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Every mutating action taken across the panel, newest first</span>
          </div>
          <Link href="/dashboard" className="cc-btn-ghost" style={{ textDecoration: 'none' }}>Back to dashboard</Link>
        </div>
      </header>

      <main style={{ maxWidth: '80rem', margin: '0 auto', padding: '24px', display: 'grid', gap: '20px' }}>
        {loadError && <InlineError message={loadError} onRetry={fetchLogs} />}

        <section className="cc-panel">
          <PanelHeader
            title="Filters"
            description="Narrow down by action text or a date range."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
            <div>
              <label className="cc-label" htmlFor="action-filter">Action contains</label>
              <input
                id="action-filter"
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                placeholder="e.g. SERVER_DELETE"
                className="cc-input"
                style={{ fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <div>
              <label className="cc-label" htmlFor="from-date">From</label>
              <input id="from-date" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="cc-input" />
            </div>
            <div>
              <label className="cc-label" htmlFor="to-date">To</label>
              <input id="to-date" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="cc-input" />
            </div>
            <div>
              <label className="cc-label" htmlFor="page-size">Page size</label>
              <select id="page-size" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="cc-input">
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="cc-panel">
          <PanelHeader
            title="Entries"
            chips={total > 0 ? <Chip>{total}</Chip> : undefined}
            description="Timestamps are shown relative, with the exact time on hover."
            actions={<button onClick={fetchLogs} className="cc-btn-ghost">Refresh</button>}
          />

          {loading ? (
            <LoadingLine>Loading audit log…</LoadingLine>
          ) : logs.length === 0 ? (
            <EmptyState title="No matching entries" description="Try widening the filters, or check back after the next mutating action." />
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={th}>Time</th>
                      <th style={th}>User</th>
                      <th style={th}>Action</th>
                      <th style={th}>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={formatDateTime(log.createdAt)}>
                          {formatRelative(log.createdAt)}
                        </td>
                        <td style={{ ...td, color: 'var(--text-primary)' }}>
                          {log.user ? (
                            <div>
                              <div style={{ fontWeight: 600 }}>{log.user.username}</div>
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{log.user.email}</div>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>System</span>
                          )}
                        </td>
                        <td style={td}>
                          <Chip tone={actionTone(log.action)}>{log.action}</Chip>
                        </td>
                        <td style={td}>
                          <DetailsCell details={log.details} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '16px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Page {page} of {totalPages} · {total} total
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="cc-btn-ghost">
                    Previous
                  </button>
                  <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="cc-btn-ghost">
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
