import { NextRequest, NextResponse } from 'next/server';
import { getModrinthVersions } from '@/lib/services/modrinth';
import { getCurseForgeVersions } from '@/lib/services/curseforge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get('slug');
  const source = searchParams.get('source');

  if (!slug) {
    return NextResponse.json({ error: 'Missing required query parameter: slug' }, { status: 400 });
  }

  try {
    const versions = source === 'CURSEFORGE'
      ? await getCurseForgeVersions(slug)
      : await getModrinthVersions(slug);
    return NextResponse.json({ versions });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to fetch modpack versions', details: err.message }, { status: 500 });
  }
}
