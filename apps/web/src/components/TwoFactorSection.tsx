'use client';

import React, { useState } from 'react';

interface Props {
  enabled: boolean;
  onChanged: () => void;
}

export default function TwoFactorSection({ enabled, onChanged }: Props) {
  const [step, setStep] = useState<'idle' | 'setup' | 'confirm' | 'backupCodes'>('idle');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const startSetup = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/account/2fa/setup', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start setup');
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setSecret(data.secret);
      setStep('setup');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/account/2fa/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid code');
      setBackupCodes(data.backupCodes);
      setStep('backupCodes');
      setCode('');
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/account/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: disablePassword, code: disableCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to disable');
      setShowDisable(false);
      setDisablePassword('');
      setDisableCode('');
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (enabled) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="border-b border-slate-800 pb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-white">Two-Factor Authentication</h2>
            <p className="text-xs text-slate-400 mt-0.5">Your account is protected with an authenticator app.</p>
          </div>
          <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Enabled</span>
        </div>

        {!showDisable ? (
          <button
            onClick={() => setShowDisable(true)}
            className="text-xs text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/40 px-4 py-2 rounded-xl transition"
          >
            Disable 2FA
          </button>
        ) : (
          <form onSubmit={handleDisable} className="space-y-3">
            {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{error}</div>}
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">Current Password</label>
              <input type="password" required value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:border-red-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">Authenticator or Backup Code</label>
              <input type="text" required value={disableCode} onChange={(e) => setDisableCode(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:border-red-500 focus:outline-none" />
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowDisable(false)} className="text-xs text-slate-400 hover:text-slate-200 px-4 py-2">Cancel</button>
              <button type="submit" disabled={busy} className="bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-bold px-4 py-2 rounded-xl transition">
                {busy ? 'Disabling...' : 'Disable 2FA'}
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
      <div className="border-b border-slate-800 pb-4">
        <h2 className="text-base font-bold text-white">Two-Factor Authentication</h2>
        <p className="text-xs text-slate-400 mt-0.5">Add an authenticator app (Google Authenticator, Authy, 1Password, etc.) as a second login step.</p>
      </div>

      {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{error}</div>}

      {step === 'idle' && (
        <button
          onClick={startSetup}
          disabled={busy}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition"
        >
          {busy ? 'Starting...' : 'Set up 2FA'}
        </button>
      )}

      {step === 'setup' && (
        <div className="space-y-4">
          <p className="text-xs text-slate-400">Scan this QR code with your authenticator app, or enter the secret manually.</p>
          <div className="bg-white p-3 rounded-xl inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrCodeDataUrl} alt="2FA QR Code" width={180} height={180} />
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Manual entry secret</div>
            <code className="text-xs text-white font-mono bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 inline-block break-all">{secret}</code>
          </div>

          <form onSubmit={confirmEnable} className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">Enter the 6-digit code to confirm</label>
              <input
                type="text"
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="w-full max-w-[180px] bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white font-mono text-center tracking-widest focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <button type="submit" disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition">
              {busy ? 'Verifying...' : 'Confirm & Enable'}
            </button>
          </form>
        </div>
      )}

      {step === 'backupCodes' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <p className="text-xs font-bold text-emerald-400 mb-2">2FA is now enabled. Save these backup codes somewhere safe — each works once if you lose access to your authenticator app.</p>
            <div className="grid grid-cols-2 gap-2 font-mono text-xs text-white">
              {backupCodes.map((c) => (
                <code key={c} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5">{c}</code>
              ))}
            </div>
          </div>
          <button
            onClick={() => { setStep('idle'); setBackupCodes([]); }}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold px-4 py-2 rounded-xl border border-slate-700 transition"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
