'use client';

import React, { useState } from 'react';
import { apiPost, errorMessage } from '@/lib/api';
import { useToast } from '@/context/ToastContext';
import { useClipboard } from '@/hooks/useClipboard';
import { Chip, InlineError, Notice } from '@/components/ui';

interface Props {
  enabled: boolean;
  onChanged: () => void;
}

export default function TwoFactorSection({ enabled, onChanged }: Props) {
  const toast = useToast();
  const { copy } = useClipboard();

  const [step, setStep] = useState<'idle' | 'setup' | 'backupCodes'>('idle');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [codesAcknowledged, setCodesAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const startSetup = async () => {
    setError(null);
    setBusy(true);
    try {
      const data = await apiPost('/api/account/2fa/setup', {});
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setSecret(data.secret);
      setStep('setup');
    } catch (err) {
      setError(errorMessage(err, 'Failed to start setup'));
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await apiPost('/api/account/2fa/enable', { code: code.trim() });
      setBackupCodes(data.backupCodes || []);
      setCodesAcknowledged(false);
      setStep('backupCodes');
      setCode('');
      toast.success('Two-factor authentication enabled');
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'That code was not accepted'));
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiPost('/api/account/2fa/disable', { password: disablePassword, code: disableCode.trim() });
      setShowDisable(false);
      setDisablePassword('');
      setDisableCode('');
      toast.success('Two-factor authentication disabled');
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Failed to disable'));
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    if (await copy(backupCodes.join('\n'))) {
      setCodesAcknowledged(true);
      toast.success('Backup codes copied');
    } else {
      toast.error('Could not copy the codes', 'Select them and copy manually before continuing.');
    }
  };

  const copySecret = async () => {
    if (await copy(secret)) toast.success('Secret copied');
    else toast.error('Could not copy the secret');
  };

  if (enabled) {
    return (
      <section className="cc-panel" style={{ display: 'grid', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <h2 className="cc-panel-title">Two-factor authentication</h2>
            <p className="cc-panel-desc">Your account is protected with an authenticator app.</p>
          </div>
          <Chip tone="accent">Enabled</Chip>
        </div>

        {!showDisable ? (
          <div>
            <button onClick={() => setShowDisable(true)} className="cc-btn-danger">Disable 2FA</button>
          </div>
        ) : (
          <form onSubmit={handleDisable} style={{ display: 'grid', gap: '12px' }}>
            {error && <InlineError message={error} />}
            <Notice tone="warning">
              Turning this off means your password alone is enough to sign in.
            </Notice>
            <div>
              <label className="cc-label" htmlFor="tfa-pw">Current password</label>
              <input
                id="tfa-pw"
                type="password"
                required
                autoComplete="current-password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                className="cc-input"
              />
            </div>
            <div>
              <label className="cc-label" htmlFor="tfa-code">Authenticator or backup code</label>
              <input
                id="tfa-code"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                className="cc-input"
                style={{ fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button type="button" onClick={() => { setShowDisable(false); setError(null); }} className="cc-btn-ghost">Cancel</button>
              <button type="submit" disabled={busy} className="cc-btn-danger" style={{ fontWeight: 700 }}>
                {busy ? 'Disabling…' : 'Disable 2FA'}
              </button>
            </div>
          </form>
        )}
      </section>
    );
  }

  return (
    <section className="cc-panel" style={{ display: 'grid', gap: '16px' }}>
      <div>
        <h2 className="cc-panel-title">Two-factor authentication</h2>
        <p className="cc-panel-desc">
          Add an authenticator app (Google Authenticator, Authy, 1Password and similar) as a second step when signing in.
        </p>
      </div>

      {error && <InlineError message={error} />}

      {step === 'idle' && (
        <div>
          <button onClick={startSetup} disabled={busy} className="cc-btn-primary">
            {busy ? 'Starting…' : 'Set up 2FA'}
          </button>
        </div>
      )}

      {step === 'setup' && (
        <div style={{ display: 'grid', gap: '16px' }}>
          <p className="cc-help" style={{ margin: 0 }}>Scan this QR code with your authenticator app, or enter the secret by hand.</p>

          {/* The QR needs a light background to stay scannable in the dark theme. */}
          <div style={{ background: '#fff', padding: '12px', borderRadius: '10px', display: 'inline-block', width: 'fit-content' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrCodeDataUrl} alt="Two-factor setup QR code" width={180} height={180} />
          </div>

          <div>
            <span className="cc-label">Manual entry secret</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <code
                style={{
                  fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-primary)', background: 'var(--bg)',
                  border: '1px solid var(--border-2)', borderRadius: '6px', padding: '7px 10px', wordBreak: 'break-all',
                }}
              >
                {secret}
              </code>
              <button type="button" onClick={copySecret} className="cc-btn-ghost">Copy</button>
            </div>
          </div>

          <form onSubmit={confirmEnable} style={{ display: 'grid', gap: '12px' }}>
            <div>
              <label className="cc-label" htmlFor="tfa-confirm">Enter the 6-digit code to confirm</label>
              <input
                id="tfa-confirm"
                required
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="cc-input"
                style={{ maxWidth: '180px', fontFamily: 'var(--font-mono)', textAlign: 'center', letterSpacing: '0.3em' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" onClick={() => { setStep('idle'); setError(null); }} className="cc-btn-ghost">Cancel</button>
              <button type="submit" disabled={busy || code.length !== 6} className="cc-btn-primary">
                {busy ? 'Verifying…' : 'Confirm & enable'}
              </button>
            </div>
          </form>
        </div>
      )}

      {step === 'backupCodes' && (
        <div style={{ display: 'grid', gap: '16px' }}>
          <Notice tone="warning">
            <strong>Save these backup codes now.</strong> Each one works once, and they are the only way back into your
            account if you lose your authenticator app. They will not be shown again.
          </Notice>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
            {backupCodes.map((c) => (
              <code
                key={c}
                style={{
                  fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-primary)', background: 'var(--bg)',
                  border: '1px solid var(--border-2)', borderRadius: '6px', padding: '7px 10px', textAlign: 'center', userSelect: 'all',
                }}
              >
                {c}
              </code>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button onClick={copyCodes} className="cc-btn-ghost">Copy all codes</button>
            <button
              onClick={() => { setStep('idle'); setBackupCodes([]); }}
              disabled={!codesAcknowledged}
              title={codesAcknowledged ? undefined : 'Copy the codes first'}
              className="cc-btn-primary"
            >
              I&apos;ve saved them
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
