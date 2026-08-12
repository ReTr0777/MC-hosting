'use client';

import React, { useEffect, useState } from 'react';

interface QuotaData {
  unlimited: boolean;
  maxServers?: number | null;
  maxMemoryMb?: number | null;
  usedServers?: number;
  usedMemoryMb?: number;
}

export default function QuotaUsageBadge() {
  const [quota, setQuota] = useState<QuotaData | null>(null);

  useEffect(() => {
    fetch('/api/account/quota')
      .then((res) => res.json())
      .then(setQuota)
      .catch(() => {});
  }, []);

  if (!quota || quota.unlimited) return null;

  const parts: string[] = [];
  if (quota.maxServers != null) parts.push(`${quota.usedServers}/${quota.maxServers} servers`);
  if (quota.maxMemoryMb != null) parts.push(`${quota.usedMemoryMb}/${quota.maxMemoryMb} MB`);
  if (parts.length === 0) return null;

  return (
    <span className="text-[11px] text-slate-400 font-mono border border-slate-700 bg-slate-900 px-2.5 py-1.5 rounded-md">
      {parts.join(' · ')}
    </span>
  );
}
