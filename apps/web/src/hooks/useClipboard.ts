'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copy-to-clipboard with a short-lived "Copied!" flag.
 *
 * `navigator.clipboard` is undefined on plain-HTTP origins and can reject when
 * the document isn't focused, so this falls back to a hidden textarea and
 * reports failure instead of silently doing nothing.
 */
export function useClipboard(resetMs = 2000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand('copy');
        document.body.removeChild(area);
      }
    } catch {
      ok = false;
    }

    if (ok) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
    }
    return ok;
  }, [resetMs]);

  return { copied, copy };
}
