'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export interface ConfirmOptions {
  title: string;
  /** Plain-language explanation of what is about to happen. */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, the confirm button unlocks only once the user types this exact string. */
  requireText?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    setTyped('');
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  }, []);

  const unlocked = !opts?.requireText || typed.trim() === opts.requireText;

  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && unlocked) close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts, unlocked, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <div className="cc-modal-backdrop" onClick={() => close(false)}>
          <div className="cc-card animate-fadeIn" style={{ width: '100%', maxWidth: '440px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 8px' }}>
              {opts.danger && <span style={{ color: 'var(--danger)', marginRight: '8px' }}>⚠</span>}
              {opts.title}
            </h3>
            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.65 }}>{opts.message}</div>

            {opts.requireText && (
              <div style={{ marginTop: '16px' }}>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 600 }}>
                  Type <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{opts.requireText}</code> to confirm
                </label>
                <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="cc-input" placeholder={opts.requireText} />
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              <button onClick={() => close(false)} className="cc-btn-ghost">{opts.cancelLabel || 'Cancel'}</button>
              <button
                onClick={() => close(true)}
                disabled={!unlocked}
                className={opts.danger ? 'cc-btn-danger' : 'cc-btn-primary'}
                style={{ fontWeight: 700, opacity: unlocked ? 1 : 0.4, cursor: unlocked ? 'pointer' : 'not-allowed' }}
              >
                {opts.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmContext);
}
