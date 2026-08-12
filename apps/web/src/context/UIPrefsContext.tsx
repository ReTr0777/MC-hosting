'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'craftcontrol.advancedMode';

interface UIPrefsContextType {
  /** When false, expert-level tabs, cards and form fields stay hidden behind sensible defaults. */
  advanced: boolean;
  setAdvanced: (v: boolean) => void;
  toggleAdvanced: () => void;
  /** False until the stored preference has been read, so nothing flashes on first paint. */
  ready: boolean;
}

const UIPrefsContext = createContext<UIPrefsContextType>({
  advanced: false,
  setAdvanced: () => {},
  toggleAdvanced: () => {},
  ready: false,
});

export function UIPrefsProvider({ children }: { children: React.ReactNode }) {
  // Always start simple. localStorage is not available during SSR, so reading it in the initial
  // state would desync server and client markup — we hydrate it in the effect below instead.
  const [advanced, setAdvancedState] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setAdvancedState(window.localStorage.getItem(STORAGE_KEY) === 'true');
    } catch {
      // Private-mode / blocked storage: simple mode is a fine fallback.
    }
    setReady(true);
  }, []);

  const setAdvanced = useCallback((v: boolean) => {
    setAdvancedState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      // Preference just won't survive a reload.
    }
  }, []);

  const toggleAdvanced = useCallback(() => setAdvanced(!advanced), [advanced, setAdvanced]);

  return (
    <UIPrefsContext.Provider value={{ advanced, setAdvanced, toggleAdvanced, ready }}>
      {children}
    </UIPrefsContext.Provider>
  );
}

export function useUIPrefs() {
  return useContext(UIPrefsContext);
}
