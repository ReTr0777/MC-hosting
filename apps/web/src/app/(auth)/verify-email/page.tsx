'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

function VerifyEmailStatus() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [status, setStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('Missing verification token.');
      return;
    }

    fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Verification failed');
        setStatus('ok');
        setMessage(data.message);
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err.message);
      });
  }, [token]);

  return (
    <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl text-center">
      <div className="w-12 h-12 rounded-xl bg-emerald-500 flex items-center justify-center font-bold text-slate-950 text-2xl mb-3 mx-auto shadow-lg shadow-emerald-500/20">
        M
      </div>
      <h2 className="text-2xl font-bold text-white mb-4">Email Verification</h2>

      {status === 'checking' && <p className="text-slate-400 text-sm">Verifying...</p>}
      {status === 'ok' && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
          {message}
        </div>
      )}
      {status === 'error' && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {message}
        </div>
      )}

      <Link href="/dashboard" className="inline-block mt-6 text-emerald-400 font-medium hover:underline text-sm">
        Go to dashboard
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12 bg-slate-950">
      <Suspense fallback={<div className="text-slate-500 text-sm">Loading...</div>}>
        <VerifyEmailStatus />
      </Suspense>
    </div>
  );
}
