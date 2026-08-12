'use client';

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** Sticky toasts stay until dismissed — used for long-running progress messages. */
  sticky?: boolean;
}

interface ToastContextType {
  /** Shows a toast and returns its id so a long-running one can be updated or dismissed. */
  toast: (kind: ToastKind, title: string, detail?: string, opts?: { sticky?: boolean; id?: number }) => number;
  success: (title: string, detail?: string) => number;
  error: (title: string, detail?: string) => number;
  info: (title: string, detail?: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextType>({
  toast: () => 0,
  success: () => 0,
  error: () => 0,
  info: () => 0,
  dismiss: () => {},
});

const KIND_STYLES: Record<ToastKind, { icon: string; color: string; bg: string; border: string }> = {
  success: { icon: '✓', color: 'var(--accent)', bg: 'rgba(0,217,126,0.10)', border: 'rgba(0,217,126,0.35)' },
  error: { icon: '!', color: 'var(--danger)', bg: 'rgba(248,81,73,0.10)', border: 'rgba(248,81,73,0.35)' },
  warning: { icon: '▲', color: 'var(--warning)', bg: 'rgba(240,136,62,0.10)', border: 'rgba(240,136,62,0.35)' },
  info: { icon: 'i', color: '#60a5fa', bg: 'rgba(96,165,250,0.10)', border: 'rgba(96,165,250,0.35)' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastContextType['toast']>((kind, title, detail, opts) => {
    // Reusing an id lets a caller rewrite an in-place progress toast instead of stacking a new one.
    const id = opts?.id ?? nextId.current++;
    const entry: Toast = { id, kind, title, detail, sticky: opts?.sticky };

    setToasts((list) => (list.some((t) => t.id === id) ? list.map((t) => (t.id === id ? entry : t)) : [...list, entry]));

    clearTimeout(timers.current[id]);
    if (!entry.sticky) {
      // Errors carry information worth reading; successes are just reassurance.
      timers.current[id] = setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 4500);
    }
    return id;
  }, [dismiss]);

  const success = useCallback((t: string, d?: string) => toast('success', t, d), [toast]);
  const error = useCallback((t: string, d?: string) => toast('error', t, d), [toast]);
  const info = useCallback((t: string, d?: string) => toast('info', t, d), [toast]);

  return (
    <ToastContext.Provider value={{ toast, success, error, info, dismiss }}>
      {children}
      <div className="cc-toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => {
          const s = KIND_STYLES[t.kind];
          return (
            <div key={t.id} className="cc-toast" style={{ background: s.bg, borderColor: s.border }}>
              <span className="cc-toast-icon" style={{ color: s.color, borderColor: s.border }}>{s.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t.title}</div>
                {t.detail && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.5, wordBreak: 'break-word' }}>
                    {t.detail}
                  </div>
                )}
              </div>
              <button onClick={() => dismiss(t.id)} className="cc-toast-close" aria-label="Dismiss notification">✕</button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
