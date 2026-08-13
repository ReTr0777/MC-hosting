'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, InlineError, Notice } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { apiPost, errorMessage } from '@/lib/api';
import type { CrashAnalysis, CrashSeverity, SuggestedAction } from '@/lib/crash-analyzer';

interface AnalyzeResponse {
  analysis: CrashAnalysis | null;
  logSource: string;
  aiAvailable: boolean;
  aiAttempted: boolean;
  message?: string;
}

const SEVERITY_STYLE: Record<CrashSeverity, { label: string; color: string; bg: string; border: string }> = {
  critical: { label: 'Critical', color: 'var(--danger)', bg: 'rgba(248,81,73,0.12)', border: 'rgba(248,81,73,0.3)' },
  error: { label: 'Error', color: 'var(--danger)', bg: 'rgba(248,81,73,0.1)', border: 'rgba(248,81,73,0.25)' },
  warning: { label: 'Warning', color: 'var(--warning)', bg: 'rgba(240,136,62,0.1)', border: 'rgba(240,136,62,0.28)' },
  info: { label: 'Info', color: 'var(--accent)', bg: 'var(--accent-dim)', border: 'var(--accent-border)' },
};

/**
 * Explains a stopped server and offers the fixes that apply to it.
 *
 * Opened manually from the Console tab, or automatically the first time a server is seen
 * in ERROR — automatic once per visit, because a diagnosis that reopens itself every poll
 * would be impossible to dismiss.
 */
export default function CrashAnalysisModal({
  serverId,
  serverName,
  canManage,
  onClose,
  onNavigateTab,
  onServerChanged,
}: {
  serverId: string;
  serverName: string;
  canManage: boolean;
  onClose: () => void;
  onNavigateTab: (tab: string) => void;
  onServerChanged?: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setData(await apiPost<AnalyzeResponse>(`/api/servers/${serverId}/analyze-crash`, {}));
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not analyse the server log.'));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    runAnalysis();
  }, [runAnalysis]);

  const applyFix = async (action: SuggestedAction) => {
    if (action.kind === 'navigate') {
      const tab = action.payload?.tab;
      if (typeof tab === 'string') onNavigateTab(tab);
      onClose();
      return;
    }
    if (action.kind !== 'mutate') return;

    setApplying(action.id);
    try {
      const res = await apiPost<{ message?: string }>(`/api/servers/${serverId}/quick-fix`, { action: action.id });
      toast.success(res.message || 'Fix applied.');
      onServerChanged?.();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'The fix could not be applied.'));
    } finally {
      setApplying(null);
    }
  };

  const analysis = data?.analysis || null;
  const severity = analysis ? SEVERITY_STYLE[analysis.severity] : null;

  return (
    <Modal
      title={`Crash analysis — ${serverName}`}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button onClick={runAnalysis} disabled={loading} className="cc-btn-ghost">
            {loading ? 'Analysing…' : 'Re-analyse'}
          </button>
          <button onClick={onClose} className="cc-btn-primary">Close</button>
        </>
      }
    >
      {loading && !data && (
        <div role="status" style={{ padding: '32px 0', textAlign: 'center', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
          Reading the server log and matching known failure patterns…
        </div>
      )}

      {loadError && <InlineError message={loadError} onRetry={runAnalysis} />}

      {data && !analysis && data.message && <Notice>{data.message}</Notice>}

      {analysis && severity && (
        <div style={{ display: 'grid', gap: '18px' }}>
          {/* Verdict */}
          <div
            style={{
              padding: '14px 16px',
              borderRadius: '10px',
              background: severity.bg,
              border: `1px solid ${severity.border}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
              <span
                style={{
                  fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase',
                  color: severity.color, border: `1px solid ${severity.border}`, borderRadius: '4px', padding: '2px 7px',
                }}
              >
                {severity.label}
              </span>
              <span style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                {analysis.source === 'ai' ? 'AI analysis' : 'Pattern match'} · {analysis.confidence} confidence
              </span>
            </div>
            <p style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 800, color: 'var(--text-primary)' }}>
              {analysis.summary}
            </p>
          </div>

          {/* Explanation */}
          <section>
            <SectionLabel>What happened</SectionLabel>
            <p style={{ margin: 0, fontSize: '0.8125rem', lineHeight: 1.7, color: 'var(--text-muted)' }}>
              {analysis.rootCause}
            </p>
          </section>

          {/* Fixes */}
          {analysis.suggestedActions.length > 0 && (
            <section>
              <SectionLabel>Suggested fixes</SectionLabel>
              <div style={{ display: 'grid', gap: '8px' }}>
                {analysis.suggestedActions.map((action, i) => (
                  <FixRow
                    key={`${action.id}-${i}`}
                    action={action}
                    canManage={canManage}
                    busy={applying === action.id}
                    disabled={applying !== null}
                    onApply={() => applyFix(action)}
                  />
                ))}
              </div>
              {!canManage && analysis.suggestedActions.some((a) => a.kind === 'mutate') && (
                <p className="cc-help" style={{ marginTop: '8px' }}>
                  You need operator access on this server to apply fixes directly.
                </p>
              )}
            </section>
          )}

          {/* Evidence */}
          {analysis.rawSnippet.length > 0 && (
            <section>
              <SectionLabel>
                Log evidence
                <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>
                  {' '}· from {data?.logSource || 'the server log'}
                </span>
              </SectionLabel>
              <pre
                style={{
                  margin: 0, maxHeight: '220px', overflow: 'auto', padding: '12px 14px', borderRadius: '8px',
                  background: 'var(--bg)', border: '1px solid var(--border-2)', fontFamily: 'var(--font-mono)',
                  fontSize: '0.7rem', lineHeight: 1.6, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
              >
                {analysis.rawSnippet.join('\n')}
              </pre>
            </section>
          )}

          {data && !data.aiAvailable && analysis.confidence === 'low' && (
            <Notice>
              No pattern matched this log. A global admin can connect an AI model under Settings → AI crash analysis to
              have unrecognised crashes explained automatically.
            </Notice>
          )}
        </div>
      )}
    </Modal>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4
      style={{
        margin: '0 0 8px', fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.09em',
        textTransform: 'uppercase', color: 'var(--text-muted)',
      }}
    >
      {children}
    </h4>
  );
}

function FixRow({
  action,
  canManage,
  busy,
  disabled,
  onApply,
}: {
  action: SuggestedAction;
  canManage: boolean;
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
}) {
  // Model-written suggestions are advice only — they carry no button to press.
  const actionable = action.kind !== 'manual' && (action.kind === 'navigate' || canManage);

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
        padding: '11px 14px', borderRadius: '8px', background: 'var(--surface)', border: '1px solid var(--border-2)',
      }}
    >
      <div style={{ flex: 1, minWidth: '200px' }}>
        <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{action.label}</div>
        {action.description && (
          <p style={{ margin: '3px 0 0', fontSize: '0.72rem', lineHeight: 1.55, color: 'var(--text-muted)' }}>
            {action.description}
          </p>
        )}
      </div>
      {actionable && (
        <button
          onClick={onApply}
          disabled={disabled}
          className={action.kind === 'mutate' ? 'cc-btn-primary' : 'cc-btn-ghost'}
          style={{ flexShrink: 0 }}
        >
          {busy ? 'Working…' : action.kind === 'mutate' ? 'Apply' : 'Open'}
        </button>
      )}
    </div>
  );
}
