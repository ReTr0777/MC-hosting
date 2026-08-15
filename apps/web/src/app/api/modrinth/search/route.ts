import { NextRequest, NextResponse } from 'next/server';
import { searchModrinthModpacks } from '@/lib/services/modrinth';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q') || '';
  const limit = parseInt(searchParams.get('limit') || '12', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);
  const index = (searchParams.get('index') || 'downloads') as any;
  const loader = searchParams.get('loader') || undefined;

  try {
    const result = await searchModrinthModpacks({ query, limit, offset, index, loader });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to query Modrinth API', details: err.message }, { status: 500 });
  }
}
