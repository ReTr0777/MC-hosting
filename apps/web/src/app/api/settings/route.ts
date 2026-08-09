import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { encryptSecret, decryptSecret, maskSecret } from '@/lib/crypto';

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

    const rawToken = decryptSecret(settingsMap['CLOUDFLARE_API_TOKEN'] || '');

    const cloudflareLogs = await prisma.cloudflareLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return NextResponse.json({
      settings: {
        cloudflareApiToken: rawToken, // Returned to authenticated Global Admin for form view
        maskedToken: maskSecret(rawToken),
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
