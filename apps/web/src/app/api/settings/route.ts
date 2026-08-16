import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { encryptSecret, maskSecret, tryDecryptSecret } from '@/lib/auth/crypto';
import { writeAudit } from '@/lib/audit';
import { AI_DEFAULT_BASE_URL, AI_DEFAULT_MODEL } from '@/lib/diagnostics/ai-analyzer';
import { PUBLIC_URL_SETTING_KEY, validatePublicUrl } from '@/lib/utils/public-url';
import { FRP_ADDR_KEY, FRP_PORT_KEY, FRP_TOKEN_KEY, FRP_DEFAULT_PORT, validateFrpAddr } from '@/lib/servers/frp';

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

    const smtpPassResult = tryDecryptSecret(settingsMap['SMTP_PASS'] || '');
    const aiKeyResult = tryDecryptSecret(settingsMap['AI_API_KEY'] || '');
    // Encrypted like any other shared secret: it is what authorises a machine to open
    // tunnels through the frps server.
    const frpTokenResult = tryDecryptSecret(settingsMap[FRP_TOKEN_KEY] || '');

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
        smtpHost: settingsMap['SMTP_HOST'] || '',
        smtpPort: settingsMap['SMTP_PORT'] || '587',
        smtpUser: settingsMap['SMTP_USER'] || '',
        smtpPass: smtpPassResult.value,
        maskedSmtpPass: maskSecret(smtpPassResult.value),
        smtpFrom: settingsMap['SMTP_FROM'] || '',
        smtpSecure: settingsMap['SMTP_SECURE'] === 'true',
        publicAppUrl: settingsMap[PUBLIC_URL_SETTING_KEY] || '',
        // An environment variable outranks the stored value, so the form has to say when
        // editing the field will have no effect.
        publicAppUrlFromEnv: (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim(),
        aiAnalysisEnabled: settingsMap['AI_ANALYSIS_ENABLED'] === 'true',
        aiBaseUrl: settingsMap['AI_BASE_URL'] || AI_DEFAULT_BASE_URL,
        aiModel: settingsMap['AI_MODEL'] || AI_DEFAULT_MODEL,
        aiApiKey: aiKeyResult.value,
        maskedAiApiKey: maskSecret(aiKeyResult.value),
        frpServerAddr: settingsMap[FRP_ADDR_KEY] || '',
        frpServerPort: settingsMap[FRP_PORT_KEY] || String(FRP_DEFAULT_PORT),
        frpToken: frpTokenResult.value,
        maskedFrpToken: maskSecret(frpTokenResult.value),
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
    const {
      cloudflareApiToken, cloudflareZoneId, defaultDomain,
      smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpSecure,
      aiAnalysisEnabled, aiBaseUrl, aiModel, aiApiKey,
      publicAppUrl,
      frpServerAddr, frpServerPort, frpToken,
    } = body;

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

    if (smtpHost !== undefined) await upsertSetting('SMTP_HOST', smtpHost.trim());
    if (smtpPort !== undefined) await upsertSetting('SMTP_PORT', String(smtpPort).trim());
    if (smtpUser !== undefined) await upsertSetting('SMTP_USER', smtpUser.trim());
    if (smtpPass !== undefined) {
      const cleanPass = smtpPass.trim();
      await upsertSetting('SMTP_PASS', cleanPass ? encryptSecret(cleanPass) : '');
    }
    if (smtpFrom !== undefined) await upsertSetting('SMTP_FROM', smtpFrom.trim());
    if (smtpSecure !== undefined) await upsertSetting('SMTP_SECURE', String(!!smtpSecure));

    if (publicAppUrl !== undefined) {
      const checked = validatePublicUrl(String(publicAppUrl));
      if (!checked.ok) {
        return NextResponse.json({ error: checked.error }, { status: 400 });
      }
      await upsertSetting(PUBLIC_URL_SETTING_KEY, checked.value);
    }

    /*
     * The tunnel preset every node shares. Rejecting a pasted URL here rather than at
     * the node is deliberate: frpc wants a bare host, and given one it cannot use it
     * simply never connects, which is a silent failure on someone else's machine.
     */
    if (frpServerAddr !== undefined) {
      const checked = validateFrpAddr(String(frpServerAddr));
      if (!checked.ok) {
        return NextResponse.json({ error: checked.error }, { status: 400 });
      }
      await upsertSetting(FRP_ADDR_KEY, checked.value);
    }
    if (frpServerPort !== undefined) await upsertSetting(FRP_PORT_KEY, String(frpServerPort).trim());
    if (frpToken !== undefined) {
      const cleanFrpToken = String(frpToken).trim();
      await upsertSetting(FRP_TOKEN_KEY, cleanFrpToken ? encryptSecret(cleanFrpToken) : '');
    }

    if (aiAnalysisEnabled !== undefined) await upsertSetting('AI_ANALYSIS_ENABLED', String(!!aiAnalysisEnabled));
    if (aiBaseUrl !== undefined) await upsertSetting('AI_BASE_URL', aiBaseUrl.trim() || AI_DEFAULT_BASE_URL);
    if (aiModel !== undefined) await upsertSetting('AI_MODEL', aiModel.trim() || AI_DEFAULT_MODEL);
    if (aiApiKey !== undefined) {
      const cleanKey = aiApiKey.trim();
      await upsertSetting('AI_API_KEY', cleanKey ? encryptSecret(cleanKey) : '');
    }

    const changedKeys = [
      cloudflareApiToken !== undefined && 'CLOUDFLARE_API_TOKEN',
      cloudflareZoneId !== undefined && 'CLOUDFLARE_ZONE_ID',
      defaultDomain !== undefined && 'DEFAULT_DOMAIN',
      smtpHost !== undefined && 'SMTP_HOST',
      smtpPort !== undefined && 'SMTP_PORT',
      smtpUser !== undefined && 'SMTP_USER',
      smtpPass !== undefined && 'SMTP_PASS',
      smtpFrom !== undefined && 'SMTP_FROM',
      smtpSecure !== undefined && 'SMTP_SECURE',
      publicAppUrl !== undefined && PUBLIC_URL_SETTING_KEY,
      aiAnalysisEnabled !== undefined && 'AI_ANALYSIS_ENABLED',
      aiBaseUrl !== undefined && 'AI_BASE_URL',
      aiModel !== undefined && 'AI_MODEL',
      aiApiKey !== undefined && 'AI_API_KEY',
      frpServerAddr !== undefined && FRP_ADDR_KEY,
      frpServerPort !== undefined && FRP_PORT_KEY,
      frpToken !== undefined && FRP_TOKEN_KEY,
    ].filter(Boolean);
    await writeAudit({ userId: user.userId, action: 'SETTINGS_UPDATE', details: { keys: changedKeys } });

    return NextResponse.json({ success: true, message: 'Global system settings updated & encrypted at rest!' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to save settings' }, { status: 500 });
  }
}
