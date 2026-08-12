'use client';

import React from 'react';

/* ─────────────────────────────────────────────────
   Shared building blocks for the dashboard panels.
   Everything here draws from the design tokens in
   globals.css so panels stay visually in step.
───────────────────────────────────────────────── */

const STEVE_AVATAR = 'https://mc-heads.net/avatar/MHF_Steve/64';

/** Player head with a graceful fallback when the skin service is unreachable. */
export function PlayerAvatar({ src, name, size = 40 }: { src?: string; name: string; size?: number }) {
  return (
    <img
      src={src || STEVE_AVATAR}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      title={name}
      onError={(e) => {
        const img = e.currentTarget;
        // Guard against an endless error loop if the fallback itself 404s.
        if (img.src !== STEVE_AVATAR) img.src = STEVE_AVATAR;
      }}
      style={{
        width: size,
        height: size,
        borderRadius: '8px',
        background: 'var(--bg)',
        border: '1px solid var(--border-2)',
        flexShrink: 0,
        imageRendering: 'pixelated',
      }}
    />
  );
}

export type ChipTone = 'default' | 'accent' | 'warning' | 'danger';

export function Chip({ tone = 'default', title, children }: { tone?: ChipTone; title?: string; children: React.ReactNode }) {
  const cls = tone === 'default' ? 'cc-chip' : `cc-chip cc-chip-${tone}`;
  return <span className={cls} title={title}>{children}</span>;
}

/** Standard panel header: title, inline chips, description, and right-aligned actions. */
export function PanelHeader({
  title,
  description,
  chips,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  chips?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="cc-panel-head">
      <div style={{ minWidth: 0 }}>
        <h2 className="cc-panel-title">
          <span>{title}</span>
          {chips}
        </h2>
        {description && <p className="cc-panel-desc">{description}</p>}
      </div>
      {actions && <div className="cc-row-actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="cc-empty">
      <h3 className="cc-empty-title">{title}</h3>
      {description && <p className="cc-empty-desc">{description}</p>}
    </div>
  );
}

/** Non-blocking inline error, for when a panel's background refresh fails. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
        fontSize: '0.75rem',
        fontWeight: 600,
        padding: '10px 14px',
        borderRadius: '8px',
        background: 'rgba(248,81,73,0.08)',
        color: 'var(--danger)',
        border: '1px solid rgba(248,81,73,0.2)',
      }}
    >
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="cc-btn-ghost" style={{ padding: '3px 10px' }}>
          Retry
        </button>
      )}
    </div>
  );
}

export type StatTone = 'default' | 'accent' | 'warning' | 'danger';

export function StatTile({ label, value, tone = 'default' }: { label: string; value: React.ReactNode; tone?: StatTone }) {
  const color =
    tone === 'accent' ? 'var(--accent)'
    : tone === 'warning' ? 'var(--warning)'
    : tone === 'danger' ? 'var(--danger)'
    : 'var(--text-primary)';
  return (
    <div className="cc-card" style={{ padding: '12px 16px' }}>
      <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.125rem', fontWeight: 800, marginTop: '2px', color }}>{value}</div>
    </div>
  );
}

/** Muted callout used for "heads up, this setting has a caveat" notes. */
export function Notice({ tone = 'default', children }: { tone?: 'default' | 'warning'; children: React.ReactNode }) {
  const warning = tone === 'warning';
  return (
    <div
      style={{
        fontSize: '0.75rem',
        lineHeight: 1.65,
        padding: '12px 14px',
        borderRadius: '8px',
        background: warning ? 'rgba(240,136,62,0.08)' : 'var(--surface)',
        color: warning ? 'var(--warning)' : 'var(--text-muted)',
        border: `1px solid ${warning ? 'rgba(240,136,62,0.22)' : 'var(--border-2)'}`,
      }}
    >
      {children}
    </div>
  );
}

/** Placeholder rows shown during a panel's first load. */
export function SkeletonRows({ rows = 3, height = 62 }: { rows?: number; height?: number }) {
  return (
    <div style={{ display: 'grid', gap: '10px' }} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="cc-skeleton" style={{ height }} />
      ))}
    </div>
  );
}

/** Screen-reader-friendly loading line for first paint. */
export function LoadingLine({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" style={{ textAlign: 'center', padding: '48px 0', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{children}</code>;
}

/**
 * Dialog shell shared by the panel modals.
 *
 * Handles the parts each hand-rolled modal was missing: Escape to close, a
 * click-outside target, a labelled `role="dialog"`, initial focus, and locking
 * the background scroll while it is open.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog so keyboard and screen-reader users land in the right place.
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
    );
    focusable?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="cc-modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="cc-card animate-fadeIn"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: `${width}px`, maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <h3 id={titleId} style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>{title}</h3>
          <button onClick={onClose} className="cc-toast-close" aria-label="Close dialog" style={{ fontSize: '0.85rem' }}>✕</button>
        </div>

        <div style={{ padding: '20px 22px', overflowY: 'auto' }}>{children}</div>

        {footer && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '16px 22px', borderTop: '1px solid var(--border)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
