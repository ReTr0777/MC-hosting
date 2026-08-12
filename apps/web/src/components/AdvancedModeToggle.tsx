'use client';

import React from 'react';
import { useUIPrefs } from '@/context/UIPrefsContext';

/**
 * The single switch that reveals every expert-level control in the panel. Simple mode is the
 * default so a new user sees only the handful of things they actually need to run a server.
 */
export default function AdvancedModeToggle({ compact = false }: { compact?: boolean }) {
  const { advanced, toggleAdvanced } = useUIPrefs();

  return (
    <button
      type="button"
      onClick={toggleAdvanced}
      role="switch"
      aria-checked={advanced}
      className="cc-adv-toggle"
      title={
        advanced
          ? 'Advanced mode is ON — expert tabs and settings are visible. Click to simplify the panel.'
          : 'Advanced mode is OFF — showing only everyday controls. Click to reveal expert tabs and settings.'
      }
      style={{ borderColor: advanced ? 'rgba(139,92,246,0.45)' : 'var(--border-2)', background: advanced ? 'rgba(139,92,246,0.12)' : 'transparent' }}
    >
      <span className="cc-switch" data-on={advanced ? 'true' : 'false'}>
        <span className="cc-switch-knob" />
      </span>
      <span style={{ fontWeight: 600, color: advanced ? '#a78bfa' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {compact ? 'Advanced' : advanced ? 'Advanced mode' : 'Advanced mode'}
      </span>
    </button>
  );
}

/** Small purple marker that labels anything only visible in advanced mode. */
export function AdvancedBadge({ label = 'Advanced' }: { label?: string }) {
  return <span className="cc-adv-badge">{label}</span>;
}

/**
 * Renders children only in advanced mode. In simple mode it optionally leaves behind a one-line
 * hint so the feature is discoverable rather than merely absent.
 */
export function AdvancedOnly({ children, hint }: { children: React.ReactNode; hint?: string }) {
  const { advanced, setAdvanced } = useUIPrefs();

  if (advanced) return <>{children}</>;
  if (!hint) return null;

  return (
    <div className="cc-adv-hint">
      <span>{hint}</span>
      <button type="button" onClick={() => setAdvanced(true)}>Turn on advanced mode</button>
    </div>
  );
}
