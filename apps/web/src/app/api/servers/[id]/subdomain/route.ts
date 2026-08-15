import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { syncCloudflareDns } from '@/lib/services/cloudflare';
import { encryptSecret, tryDecryptSecret } from '@/lib/auth/crypto';
import { writeAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const settingsList = await prisma.systemSetting.findMany();
    const defaultDomainSetting = settingsList.find((s) => s.key === 'DEFAULT_DOMAIN');
    const defaultDomain = defaultDomainSetting?.value || 'retr0net.nl';

    const subdomain = server.subdomain || '';
    const domain = server.domain || defaultDomain || 'retr0net.nl';
    const fullAddress = subdomain ? `${subdomain}.${domain}` : `${server.node.host}:${server.serverPort}`;
    const srvRecord = `_minecraft._tcp.${subdomain || 'survival'}.${domain} SRV 0 5 ${server.serverPort} ${server.node.host}.`;

    return NextResponse.json({
      subdomain,
      domain,
      serverPort: server.serverPort,
      nodeHost: server.node.host,
      fullAddress,
      srvRecord,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch subdomain configuration' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: { node: true },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const body = await request.json();
    const { subdomain, domain, cloudflareToken, cloudflareZoneId } = body;

    // Save token to SystemSettings if provided explicitly
    if (cloudflareToken && cloudflareToken.trim()) {
      const encrypted = encryptSecret(cloudflareToken.trim());
      await prisma.systemSetting.upsert({
        where: { key: 'CLOUDFLARE_API_TOKEN' },
        update: { value: encrypted },
        create: { key: 'CLOUDFLARE_API_TOKEN', value: encrypted },
      }).catch(() => {});
    }

    if (cloudflareZoneId && cloudflareZoneId.trim() && /^[a-f0-9]{32}$/i.test(cloudflareZoneId.trim())) {
      await prisma.systemSetting.upsert({
        where: { key: 'CLOUDFLARE_ZONE_ID' },
        update: { value: cloudflareZoneId.trim() },
        create: { key: 'CLOUDFLARE_ZONE_ID', value: cloudflareZoneId.trim() },
      }).catch(() => {});
    }

    // Fetch system settings for Cloudflare API Token & Zone ID if not provided explicitly
    const settingsList = await prisma.systemSetting.findMany();
    const settingsMap: Record<string, string> = {};
    settingsList.forEach((s) => {
      settingsMap[s.key] = s.value;
    });

    const defaultDomain = settingsMap['DEFAULT_DOMAIN'] || 'retr0net.nl';
    const cleanSubdomain = (subdomain || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
    const cleanDomain = (domain || defaultDomain).toLowerCase().trim();

    // Update in database
    await prisma.server.update({
      where: { id: params.id },
      data: {
        subdomain: cleanSubdomain || null,
        domain: cleanDomain || null,
      },
    });

    // Notify Daemon node to update tunnel/proxy routing rules
    try {
      const daemonClient = new DaemonClient({
        host: server.node.host,
        port: server.node.port,
        apiKey: server.node.apiKey,
      });
      const targetContainerId = server.containerId || `process-${server.id}`;
      await daemonClient.request(`/servers/${targetContainerId}/subdomain`, {
        method: 'POST',
        body: JSON.stringify({ subdomain: cleanSubdomain, domain: cleanDomain, port: server.serverPort }),
      }).catch(() => {});
    } catch (e) {}

    // Cloudflare Auto-DNS Provisioning
    let cloudflareResult = null;
    const storedToken = tryDecryptSecret(settingsMap['CLOUDFLARE_API_TOKEN'] || '');
    const cfToken = (cloudflareToken && cloudflareToken.trim()) || storedToken.value || process.env.CLOUDFLARE_API_TOKEN;
    const cfZone = (cloudflareZoneId && cloudflareZoneId.trim()) || settingsMap['CLOUDFLARE_ZONE_ID'] || process.env.CLOUDFLARE_ZONE_ID;

    if (cfToken && cleanSubdomain) {
      console.log(`[Cloudflare DNS] Auto-provisioning SRV record for ${cleanSubdomain}.${cleanDomain}...`);
      cloudflareResult = await syncCloudflareDns({
        apiToken: cfToken,
        zoneId: cfZone || undefined,
        subdomain: cleanSubdomain,
        domain: cleanDomain,
        targetHost: server.node.host,
        port: server.serverPort,
        userEmail: user.email,
      });
    }

    const fullAddress = cleanSubdomain ? `${cleanSubdomain}.${cleanDomain}` : `${server.node.host}:${server.serverPort}`;
    const srvRecord = `_minecraft._tcp.${cleanSubdomain || 'survival'}.${cleanDomain} SRV 0 5 ${server.serverPort} ${server.node.host}.`;

    let finalMessage = '✅ Subdomain proxy route updated in database!';
    if (!cfToken) {
      finalMessage =
        storedToken.status === 'undecryptable'
          ? '⚠️ Subdomain saved in DB, but the stored Cloudflare API Token could not be decrypted — the encryption key changed since it was saved. Paste your token into the Cloudflare box below to re-save it.'
          : '⚠️ Subdomain saved in DB! Cloudflare API Token was not found. Please paste your token into the Cloudflare box below.';
    } else if (cloudflareResult) {
      if (cloudflareResult.success) {
        finalMessage = `✅ Subdomain saved & Cloudflare SRV record (${cloudflareResult.srvRecordName}) provisioned successfully!`;
      } else {
        finalMessage = `⚠️ Subdomain saved in DB, but Cloudflare API failed: ${cloudflareResult.message}`;
      }
    }

    await writeAudit({
      userId: user.userId,
      action: 'SUBDOMAIN_CHANGE',
      details: { serverId: server.id, subdomain: cleanSubdomain, domain: cleanDomain },
    });

    return NextResponse.json({
      success: true,
      subdomain: cleanSubdomain,
      domain: cleanDomain,
      fullAddress,
      srvRecord,
      cloudflareResult,
      message: finalMessage,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update subdomain configuration' }, { status: 500 });
  }
}
