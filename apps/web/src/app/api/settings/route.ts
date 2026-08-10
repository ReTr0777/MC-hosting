import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { encryptSecret, maskSecret, tryDecryptSecret } from '@/lib/crypto';

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const settingsList = await prisma.systemSetting.findMany();
    const settingsMap: Record<string, string> = {};
    settingsList.forEach((s) => {
      settingsMap[s.key] = s.value;
    });

    const tokenResult = tryDecryptSecret(settingsMap['CLOUDFLARE_API_TOKEN'] || '');

    // Decrypted under a fallback key — migrate it to the primary key so the fallback
    // can eventually be dropped without stranding the secret.
    if (tokenResult.status === 'ok' && tokenResult.needsReEncryption) {
      await prisma.systemSetting.upsert({
        where: { key: 'CLOUDFLARE_API_TOKEN' },
        update: { value: encryptSecret(tokenResult.value) },
        create: { key: 'CLOUDFLARE_API_TOKEN', value: encryptSecret(tokenResult.value) },
      }).catch(() => {});
    }

    const cloudflareLogs = await prisma.cloudflareLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return NextResponse.json({
      settings: {
        cloudflareApiToken: tokenResult.value, // Returned to authenticated Global Admin for form view
        maskedToken: maskSecret(tokenResult.value),
        cloudflareTokenStatus: tokenResult.status,
        cloudflareTokenError:
          tokenResult.status === 'undecryptable'
            ? 'The stored Cloudflare API Token could not be decrypted — SECRET_ENCRYPTION_KEY (or JWT_SECRET, if you have not set SECRET_ENCRYPTION_KEY) changed since it was saved. Paste the token again to re-save it under the current key.'
            : null,
        cloudflareZoneId: settingsMap['CLOUDFLARE_ZONE_ID'] || '',
        defaultDomain: settingsMap['DEFAULT_DOMAIN'] || 'retr0net.com',
      },
      logs: cloudflareLogs,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { cloudflareApiToken, cloudflareZoneId, defaultDomain } = body;

    const upsertSetting = async (key: string, value: string) => {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    };

    if (cloudflareApiToken !== undefined) {
      const cleanToken = cloudflareApiToken.trim();
      const encryptedToken = cleanToken ? encryptSecret(cleanToken) : '';
      await upsertSetting('CLOUDFLARE_API_TOKEN', encryptedToken);
    }
    if (cloudflareZoneId !== undefined) await upsertSetting('CLOUDFLARE_ZONE_ID', cloudflareZoneId.trim());
    if (defaultDomain !== undefined) await upsertSetting('DEFAULT_DOMAIN', defaultDomain.trim());

    return NextResponse.json({ success: true, message: 'Global system settings updated & encrypted at rest!' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to save settings' }, { status: 500 });
  }
}
