import { prisma } from '@/lib/prisma';

export interface CloudflareDnsPayload {
  zoneId?: string;
  apiToken: string;
  subdomain: string;
  domain: string;
  targetHost: string;
  port: number;
  userEmail?: string;
}

export interface CloudflareSyncResult {
  success: boolean;
  message: string;
  srvRecordName?: string;
}

export async function syncCloudflareDns({
  zoneId,
  apiToken,
  subdomain,
  domain,
  targetHost,
  port,
  userEmail,
}: CloudflareDnsPayload): Promise<CloudflareSyncResult> {
  if (!apiToken) {
    const msg = 'Cloudflare API Token is missing in System Settings.';
    await prisma.cloudflareLog.create({
      data: {
        action: 'PROVISION_SRV',
        subdomain: subdomain || 'root',
        domain: domain || 'unknown',
        status: 'FAILED',
        details: msg,
        userEmail: userEmail || 'system',
      },
    }).catch(() => {});
    return {
      success: false,
      message: msg,
    };
  }

  const cleanDomain = domain ? domain.trim().toLowerCase() : 'retr0net.nl';
  const cleanSubdomain = subdomain ? subdomain.trim().toLowerCase() : '';
  const headers = {
    Authorization: `Bearer ${apiToken.trim()}`,
    'Content-Type': 'application/json',
  };

  let effectiveZoneId = (zoneId && /^[a-f0-9]{32}$/i.test(zoneId.trim())) ? zoneId.trim() : undefined;

  // Auto-discover Zone ID if missing or invalid format
  if (!effectiveZoneId) {
    try {
      const zoneSearchRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(cleanDomain)}`, { headers });
      const zoneSearchData = await zoneSearchRes.json();
      if (zoneSearchRes.ok && zoneSearchData.result && zoneSearchData.result.length > 0) {
        effectiveZoneId = zoneSearchData.result[0].id;
      } else {
        const errDetail = zoneSearchData.errors?.[0]?.message || 'No matching domain zone found';
        const msg = `Could not find Cloudflare Zone for '${cleanDomain}': ${errDetail}. Check your Token permissions.`;
        await prisma.cloudflareLog.create({
          data: {
            action: 'PROVISION_SRV',
            subdomain: cleanSubdomain || 'root',
            domain: cleanDomain,
            status: 'FAILED',
            details: msg,
            userEmail: userEmail || 'system',
          },
        }).catch(() => {});
        return { success: false, message: msg };
      }
    } catch (e: any) {
      return { success: false, message: `Failed to search zones: ${e.message}` };
    }
  }

  // Cloudflare SRV targets MUST be a domain name (e.g., mc.retr0net.nl or retr0net.nl), NOT an IP address.
  const isIpAddress = /^[\d\.]+$|^[0-9a-fA-F:]+$/.test(targetHost.trim());
  const srvTargetDomain = isIpAddress ? `mc.${cleanDomain}` : targetHost.trim();

  const srvName = cleanSubdomain ? `_minecraft._tcp.${cleanSubdomain}` : '_minecraft._tcp';
  const url = `https://api.cloudflare.com/client/v4/zones/${effectiveZoneId}/dns_records`;

  try {
    // 1. Check if an SRV record already exists for this server's port or subdomain name
    const searchRes = await fetch(`${url}?type=SRV`, { headers });
    let existingRecordId: string | null = null;
    let duplicateRecordIds: string[] = [];

    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.result && Array.isArray(searchData.result)) {
        // Find any SRV records belonging to this server port (e.g. 24000) or matching target name
        const matches = searchData.result.filter((r: any) => {
          const matchPort = r.data?.port === port;
          const matchName = r.name === `${srvName}.${cleanDomain}` || r.name === srvName;
          return matchPort || matchName;
        });

        if (matches.length > 0) {
          existingRecordId = matches[0].id;
          duplicateRecordIds = matches.slice(1).map((r: any) => r.id);
        }
      }
    }

    const payload = {
      type: 'SRV',
      name: srvName,
      data: {
        service: '_minecraft',
        proto: '_tcp',
        name: cleanSubdomain || '@',
        priority: 0,
        weight: 5,
        port,
        target: srvTargetDomain,
      },
    };

    let res: Response;
    if (existingRecordId) {
      // Overwrite/update existing SRV record for this server port
      res = await fetch(`${url}/${existingRecordId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      });
    } else {
      // Create new SRV record
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    }

    const data = await res.json();

    if (!res.ok || !data.success) {
      const err = data.errors?.[0]?.message || `HTTP ${res.status}`;
      await prisma.cloudflareLog.create({
        data: {
          action: 'PROVISION_SRV',
          subdomain: cleanSubdomain || 'root',
          domain: cleanDomain,
          status: 'FAILED',
          details: `Cloudflare API error: ${err}`,
          userEmail: userEmail || 'system',
        },
      }).catch(() => {});

      return {
        success: false,
        message: `Cloudflare API Error: ${err}`,
      };
    }

    // Clean up any old duplicate records for this port
    for (const dupId of duplicateRecordIds) {
      await fetch(`${url}/${dupId}`, { method: 'DELETE', headers }).catch(() => {});
    }

    const successMsg = `Successfully updated Cloudflare SRV record '${srvName}.${cleanDomain}' -> ${srvTargetDomain}:${port}`;
    await prisma.cloudflareLog.create({
      data: {
        action: existingRecordId ? 'UPDATE_SRV' : 'CREATE_SRV',
        subdomain: cleanSubdomain || 'root',
        domain: cleanDomain,
        status: 'SUCCESS',
        details: successMsg,
        userEmail: userEmail || 'system',
      },
    }).catch(() => {});

    return {
      success: true,
      message: successMsg,
      srvRecordName: `${srvName}.${cleanDomain}`,
    };
  } catch (err: any) {
    await prisma.cloudflareLog.create({
      data: {
        action: 'PROVISION_SRV',
        subdomain: cleanSubdomain || 'root',
        domain: cleanDomain,
        status: 'FAILED',
        details: `Connection exception: ${err.message}`,
        userEmail: userEmail || 'system',
      },
    }).catch(() => {});

    return {
      success: false,
      message: `Failed to connect to Cloudflare API: ${err.message}`,
    };
  }
}
