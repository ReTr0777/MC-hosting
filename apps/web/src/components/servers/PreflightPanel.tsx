'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/context/ToastContext';
import type { PreflightFinding, PreflightReport } from '@/app/api/servers/[id]/preflight/route';

/**
 * The problems a server has before it is started, and the buttons that resolve them.
 *
 * Rendered in two places from one hook: as a banner on the server page, so a broken
 * configuration announces itself rather than waiting to be discovered, and as the body of
 * the dialog that blocks Start.
 *
 * These failures are quiet by nature — a Forge pack started as Fabric loads no mods and
 * generates a plain world without a single line of complaint — so the interface has to be
 * the thing that speaks up.
 */

export function usePreflight(serverId: string, canManage: boolean) {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/preflight`);
      setReport(res.ok ? await res.json() : null);
    } catch {
      // A failed check is not a finding. Leaving the last report in place would be worse:
      // it would keep showing problems that may already have been fixed.
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    if (canManage) void refresh();
  }, [canManage, refresh]);

  return { report, loading, refresh };
}

interface PreflightPanelProps {
  serverId: string;
  findings: PreflightFinding[];
  onFixed: () => void;
  /** Set inside the Start dialog, where the surrounding chrome already explains itself. */
  compact?: boolean;
}

export default function PreflightPanel({ serverId, findings, onFixed, compact }: PreflightPanelProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (findings.length === 0) return null;

  const applyFix = async (finding: PreflightFinding) => {
    if (!finding.fix) return;
    setBusy(finding.id);
    try {
      const res = await fetch(`/api/servers/${serverId}/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: finding.fix.action,
          serverType: finding.fix.serverType,
          mcVersion: finding.fix.mcVersion,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.toast('success', 'Fixed', data.message);
        onFixed();
      } else {
        toast.toast('error', 'Could not apply that fix', data.error);
      }
    } catch {
      toast.toast('error', 'Could not apply that fix', 'The panel could not reach the server node.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 12 : 10 }}>
      {findings.map((finding) => {
        const blocking = finding.severity === 'block';
        return (
          <div
            key={finding.id}
            style={{
              border: `1px solid ${blocking ? 'var(--danger)' : 'var(--warning, #f59e0b)'}`,
              // Tinted rather than filled: these sit above the console on a page that is
              // already dark, and a solid block of red reads as the page being broken.
              background: blocking ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
              borderRadius: 8,
              padding: '12px 14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{finding.title}</strong>
              <span
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: blocking ? 'var(--danger)' : 'var(--warning, #f59e0b)',
                }}
              >
                {blocking ? 'stops the server starting' : 'worth knowing'}
              </span>
            </div>

            <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.55 }}>
              {finding.detail}
            </p>

            {finding.fix ? (
              <button
                className="btn small primary"
                style={{ marginTop: 10 }}
                disabled={busy !== null}
                onClick={() => applyFix(finding)}
              >
                {busy === finding.id ? 'Working…' : finding.fix.label}
              </button>
            ) : (
              // No button on purpose: some problems need a JDK installed or a different
              // node, and a fix button that cannot fix it would be a lie.
              <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-tertiary, var(--text-secondary))' }}>
                This one has to be sorted on the node itself.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The findings as the body of the Start dialog.
 *
 * Fetches its own report rather than being handed one, so a fix applied inside the dialog
 * updates the list underneath it — otherwise the dialog would go on showing a problem that
 * had just been resolved, and the only way to see that would be to close and reopen it.
 */
export function PreflightDialogBody({ serverId }: { serverId: string }) {
  const { report, loading, refresh } = usePreflight(serverId, true);

  if (loading && !report) return <p style={{ color: 'var(--text-secondary)' }}>Checking this server…</p>;

  if (!report || report.findings.length === 0) {
    return (
      <p style={{ color: 'var(--text-secondary)' }}>
        Nothing is blocking this server now. Close this and press Start again.
      </p>
    );
  }

  return (
    <div>
      <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
        Starting it like this would not fail loudly — it would come up looking fine and behave wrongly,
        which is why it is stopped here.
      </p>
      <PreflightPanel serverId={serverId} findings={report.findings} onFixed={refresh} compact />
    </div>
  );
}
