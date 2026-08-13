'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme, customThemeKey, type ThemeDefinition } from '@/context/ThemeContext';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { PanelHeader, Notice } from '@/components/ui';
import { apiRequest, errorMessage } from '@/lib/api';
import { resolveThemeTokens, serializeTheme, type CustomTheme } from '@/lib/theme-tokens';

interface BuiltinThemeSummary {
  slug: string;
  name: string;
  description?: string;
  scheme: 'dark' | 'light';
  swatch: [string, string, string];
}

/**
 * Theme picker. Hovering a card previews the palette live across the whole app; moving away
 * reverts, so nothing is committed until it is actually clicked.
 *
 * Custom themes are uploaded as CSS-syntax token files. They are parsed and revalidated
 * before use — see `lib/theme-tokens` for why the file is never applied verbatim.
 */
export default function ThemeSelector() {
  const { theme, setTheme, previewTheme, themes, customThemes, importTheme, removeCustomTheme, ready } = useTheme();
  const { user } = useAuth();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [bundled, setBundled] = useState<BuiltinThemeSummary[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);

  const isAdmin = user?.globalRole === 'GLOBAL_ADMIN';

  // Bundled theme files are restricted to global admins.
  useEffect(() => {
    if (!isAdmin) {
      setBundled([]);
      return;
    }
    apiRequest<{ themes: BuiltinThemeSummary[] }>('/api/themes')
      .then((res) => setBundled(res.themes || []))
      .catch(() => setBundled([]));
  }, [isAdmin]);

  const installBundled = useCallback(
    async (summary: BuiltinThemeSummary) => {
      setInstalling(summary.slug);
      setWarnings([]);
      try {
        const source = await fetch(`/api/themes/${summary.slug}`).then((r) => {
          if (!r.ok) throw new Error(`Could not load "${summary.name}" (HTTP ${r.status})`);
          return r.text();
        });

        const result = importTheme(source, summary.name);
        if (!result.theme) {
          toast.error(`"${summary.name}" could not be loaded`, result.errors[0]);
          return;
        }
        toast.success(`Applied "${result.theme.name}"`);
        setWarnings(result.warnings);
      } catch (err) {
        toast.error(errorMessage(err, 'Could not load that theme.'));
      } finally {
        setInstalling(null);
      }
    },
    [importTheme, toast]
  );

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setWarnings([]);

    let source: string;
    try {
      source = await file.text();
    } catch {
      toast.error('Could not read that file');
      return;
    }

    const fallbackName = file.name.replace(/\.(css|txt)$/i, '');
    const result = importTheme(source, fallbackName);

    if (!result.theme) {
      toast.error('That file is not a valid theme', result.errors[0]);
      setWarnings(result.errors);
      return;
    }

    toast.success(`Applied "${result.theme.name}"`, `${Object.keys(result.theme.tokens).length} tokens loaded.`);
    setWarnings(result.warnings);
  };

  const exportTheme = (custom: CustomTheme) => {
    const blob = new Blob([serializeTheme(custom)], { type: 'text/css' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${custom.id}.css`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="cc-panel" style={{ display: 'grid', gap: '4px' }} onMouseLeave={() => previewTheme(null)}>
      <PanelHeader
        title="Appearance"
        description="Pick a colour palette for the panel. Hover a theme to preview it, click to keep it. The choice is stored in this browser."
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".css,text/css,text/plain"
              onChange={(e) => {
                handleFile(e.target.files?.[0]);
                // Reset so re-picking the same file after an edit still fires onChange.
                e.target.value = '';
              }}
              style={{ display: 'none' }}
            />
            <button type="button" onClick={() => fileInput.current?.click()} className="cc-btn-ghost">
              Upload theme
            </button>
          </>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '12px',
          marginTop: '16px',
        }}
      >
        {themes.map((t) => (
          <ThemeCard
            key={t.key}
            label={t.label}
            description={t.description}
            swatch={t.swatch}
            active={ready && theme === t.key}
            onSelect={() => setTheme(t.key)}
            onPreview={() => previewTheme(t.key)}
          />
        ))}

        {customThemes.map((custom) => {
          const resolved = resolveThemeTokens(custom);
          return (
            <ThemeCard
              key={custom.id}
              label={custom.name}
              description={custom.description || (custom.author ? `by ${custom.author}` : 'Uploaded theme')}
              swatch={[resolved['--bg'], resolved['--surface-2'], resolved['--accent']]}
              active={ready && theme === customThemeKey(custom.id)}
              custom
              onSelect={() => setTheme(customThemeKey(custom.id))}
              onPreview={() => previewTheme(customThemeKey(custom.id))}
              onExport={() => exportTheme(custom)}
              onRemove={() => {
                removeCustomTheme(custom.id);
                toast.info(`Removed "${custom.name}"`);
              }}
            />
          );
        })}
      </div>

      {/* Illustrated themes that ship with the panel. Only available to global admins. */}
      {isAdmin && bundled.length > 0 && (
        <div style={{ marginTop: '22px' }}>
          <h4
            style={{
              margin: '0 0 4px', fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.09em',
              textTransform: 'uppercase', color: 'var(--text-muted)',
            }}
          >
            Included themes
          </h4>
          <p className="cc-help" style={{ margin: '0 0 12px' }}>
            Shipped with the panel and only available to signed-in users. Install one to make it
            yours — you can then export it as a file to share.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
            {bundled.map((b) => {
              const already = customThemes.some((c) => c.name === b.name);
              return (
                <div
                  key={b.slug}
                  style={{
                    padding: '12px', borderRadius: '10px', background: 'var(--surface)',
                    border: '1px solid var(--border-2)',
                  }}
                >
                  <div
                    aria-hidden="true"
                    style={{
                      height: '52px', borderRadius: '6px', background: b.swatch[0],
                      border: '1px solid rgba(127,127,127,0.28)', padding: '8px',
                      display: 'flex', alignItems: 'flex-end', gap: '6px', marginBottom: '10px',
                    }}
                  >
                    <div style={{ flex: 1, height: '22px', borderRadius: '4px', background: b.swatch[1] }} />
                    <div style={{ width: '26px', height: '22px', borderRadius: '4px', background: b.swatch[2] }} />
                  </div>

                  <div style={{ fontSize: '0.8125rem', fontWeight: 800, color: 'var(--text-primary)' }}>{b.name}</div>
                  {b.description && (
                    <p style={{ margin: '4px 0 0', fontSize: '0.7rem', lineHeight: 1.5, color: 'var(--text-muted)' }}>
                      {b.description}
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => installBundled(b)}
                    disabled={installing !== null}
                    className={already ? 'cc-btn-ghost' : 'cc-btn-primary'}
                    style={{ marginTop: '10px', width: '100%' }}
                  >
                    {installing === b.slug ? 'Installing…' : already ? 'Reinstall' : 'Install'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div style={{ marginTop: '14px' }}>
          <Notice tone="warning">
            <strong>Imported with notes:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
              {warnings.map((w, i) => (
                <li key={i} style={{ marginTop: '2px' }}>{w}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <div style={{ marginTop: '14px' }}>
        <Notice>
          A theme file is ordinary CSS that sets the panel&apos;s design tokens — <code>--bg</code>, <code>--surface</code>,{' '}
          <code>--accent</code> and friends. Only those tokens are read: the file is parsed, every value is validated, and
          the stylesheet is rebuilt from the result, so a theme someone sends you cannot run code, load remote resources
          or cover the page. A theme may also set <code>--bg-image</code> to an embedded <code>data:</code> image with{' '}
          <code>--bg-size</code> and <code>--bg-animation</code> (<code>none</code>, <code>drift</code> or{' '}
          <code>fall</code>) for a decorated backdrop — external image URLs are rejected. Use <strong>Export</strong> on
          any custom theme to get a file you can share.
        </Notice>
      </div>
    </section>
  );
}

function ThemeCard({
  label,
  description,
  swatch,
  active,
  custom,
  onSelect,
  onPreview,
  onExport,
  onRemove,
}: {
  label: string;
  description: string;
  swatch: ThemeDefinition['swatch'];
  active: boolean;
  custom?: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onExport?: () => void;
  onRemove?: () => void;
}) {
  const [bg, surface, accent] = swatch;

  return (
    <div
      style={{
        padding: '12px',
        borderRadius: '10px',
        background: 'var(--surface)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-2)'}`,
        boxShadow: active ? '0 0 0 1px var(--accent)' : 'none',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        onMouseEnter={onPreview}
        onFocus={onPreview}
        aria-pressed={active}
        style={{
          display: 'block', width: '100%', textAlign: 'left', padding: 0,
          background: 'none', border: 'none', cursor: 'pointer', color: 'inherit',
        }}
      >
        {/* Miniature of the palette: page background, a card on it, and the accent bar. */}
        <div
          aria-hidden="true"
          style={{
            height: '52px', borderRadius: '6px', background: bg,
            border: '1px solid rgba(127,127,127,0.28)', padding: '8px',
            display: 'flex', alignItems: 'flex-end', gap: '6px', marginBottom: '10px',
          }}
        >
          <div style={{ flex: 1, height: '22px', borderRadius: '4px', background: surface }} />
          <div style={{ width: '26px', height: '22px', borderRadius: '4px', background: accent }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <span style={{ fontSize: '0.8125rem', fontWeight: 800, color: 'var(--text-primary)' }}>{label}</span>
          {active && (
            <span style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.07em', color: 'var(--accent)' }}>
              ACTIVE
            </span>
          )}
        </div>
        <p style={{ margin: '4px 0 0', fontSize: '0.7rem', lineHeight: 1.5, color: 'var(--text-muted)' }}>
          {description}
        </p>
      </button>

      {custom && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)' }}>
          <button type="button" onClick={onExport} className="cc-btn-ghost" style={{ padding: '3px 10px', fontSize: '0.68rem' }}>
            Export
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="cc-btn-ghost"
            style={{ padding: '3px 10px', fontSize: '0.68rem', color: 'var(--danger)' }}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
