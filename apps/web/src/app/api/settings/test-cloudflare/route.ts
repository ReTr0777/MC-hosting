import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const { token, zoneId } = await request.json();

    if (!token) {
      return NextResponse.json({ error: 'Missing Cloudflare API Token' }, { status: 400 });
    }

    const cleanToken = token.trim();
    const headers = {
      Authorization: `Bearer ${cleanToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Direct Zone API test (does not require User.Read permissions)
    const zonesRes = await fetch('https://api.cloudflare.com/client/v4/zones', { headers });
    const zonesData = await zonesRes.json();

    if (zonesRes.ok && zonesData.success && zonesData.result) {
      if (zonesData.result.length > 0) {
        const foundZones = zonesData.result.map((z: any) => `${z.name} (Zone ID: ${z.id})`).join(', ');
        const matchedZone = zoneId ? zonesData.result.find((z: any) => z.id === zoneId.trim()) : zonesData.result[0];

        return NextResponse.json({
          success: true,
          message: `🟢 Success! Token verified for domain '${matchedZone?.name || zonesData.result[0].name}' (Zone ID: ${matchedZone?.id || zonesData.result[0].id})!`,
          autoZoneId: matchedZone?.id || zonesData.result[0].id,
          domain: matchedZone?.name || zonesData.result[0].name,
          allZones: foundZones,
        });
      }

      return NextResponse.json({
        success: true,
        message: '🟢 Success! Token authenticated with Cloudflare API.',
      });
    }

    // Fallback: Check token verify endpoint if zones list returned empty policy
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers });
    const verifyData = await verifyRes.json();

    if (verifyRes.ok && verifyData.success) {
      return NextResponse.json({
        success: true,
        message: '🟢 Success! Cloudflare API Token is valid and active!',
      });
    }

    const errorDetails = zonesData.errors?.[0]?.message || verifyData.errors?.[0]?.message || 'Invalid token or unauthorized';
    return NextResponse.json({
      success: false,
      message: `Cloudflare API Token Error: ${errorDetails}. Please double-check that you copied the generated Token string, not your Account ID or Secret Name.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Cloudflare test failed' }, { status: 500 });
  }
}
