import { NextRequest, NextResponse } from 'next/server';
import { searchCurseForgeModpacks } from '@/lib/services/curseforge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q') || '';
  const limit = parseInt(searchParams.get('limit') || '12', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  try {
    const result = await searchCurseForgeModpacks(query, limit, offset);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to query CurseForge API', details: err.message }, { status: 500 });
  }
}
