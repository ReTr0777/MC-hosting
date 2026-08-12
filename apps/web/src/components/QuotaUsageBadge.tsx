'use client';

import React, { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { Chip } from '@/components/ui';

interface QuotaData {
  unlimited: boolean;
  maxServers?: number | null;
  maxMemoryMb?: number | null;
  usedServers?: number;
  usedMemoryMb?: number;
}

/** Above this fraction of a limit the badge turns amber, so a near-full quota is noticeable. */
const WARN_AT = 0.85;

export default function QuotaUsageBadge() {
  const [quota, setQuota] = useState<QuotaData | null>(null);

  useEffect(() => {
    let active = true;
    apiRequest('/api/account/quota')
      .then((data) => { if (active) setQuota(data); })
      .catch(() => {
        // Purely informational — no quota badge is better than an error here.
      });
    return () => { active = false; };
  }, []);

  if (!quota || quota.unlimited) return null;

  const entries: Array<{ text: string; ratio: number }> = [];
  if (quota.maxServers != null && quota.maxServers > 0) {
    entries.push({
      text: `${quota.usedServers ?? 0}/${quota.maxServers} servers`,
      ratio: (quota.usedServers ?? 0) / quota.maxServers,
    });
  }
  if (quota.maxMemoryMb != null && quota.maxMemoryMb > 0) {
    entries.push({
      text: `${quota.usedMemoryMb ?? 0}/${quota.maxMemoryMb} MB`,
      ratio: (quota.usedMemoryMb ?? 0) / quota.maxMemoryMb,
    });
  }
  if (entries.length === 0) return null;

  const highest = Math.max(...entries.map((e) => e.ratio));
  const tone = highest >= 1 ? 'danger' : highest >= WARN_AT ? 'warning' : 'default';

  return (
    <Chip tone={tone} title="Your resource quota across servers you own">
      {entries.map((e) => e.text).join(' · ')}
    </Chip>
  );
}
