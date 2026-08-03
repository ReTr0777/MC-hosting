export interface CurseForgeModSearchResult {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string;
  downloads: number;
  authors: string[];
}

export interface CurseForgeSearchResponse {
  hits: CurseForgeModSearchResult[];
  offset: number;
  limit: number;
  total_hits: number;
  error?: string;
}

export interface CurseForgeVersion {
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
}

export async function searchCurseForgeModpacks(query: string = '', limit: number = 12, offset: number = 0): Promise<CurseForgeSearchResponse> {
  const apiKey = process.env.CURSEFORGE_API_KEY;
  let url = 'https://api.curse.tools/v1/cf/mods/search';
  const headers: Record<string, string> = {
    'User-Agent': 'CraftControl-Server-Manager/1.0.0 (https://github.com/mc-server-manager)',
  };

  if (apiKey) {
    url = 'https://api.curseforge.com/v1/mods/search';
    headers['x-api-key'] = apiKey;
    headers['Content-Type'] = 'application/json';
  }

  const reqUrl = new URL(url);
  reqUrl.searchParams.append('gameId', '432');
  if (query.trim()) {
    reqUrl.searchParams.append('searchFilter', query.trim());
  }
  reqUrl.searchParams.append('pageSize', limit.toString());
  reqUrl.searchParams.append('index', offset.toString());

  try {
    let response = await fetch(reqUrl.toString(), { headers });

    // Fallback to free proxy if direct CurseForge API fails
    if (!response.ok && apiKey) {
      console.warn(`[CurseForge API] Direct API returned ${response.status}. Falling back to api.curse.tools proxy...`);
      const fallbackUrl = new URL('https://api.curse.tools/v1/cf/mods/search');
      fallbackUrl.searchParams.append('gameId', '432');
      if (query.trim()) fallbackUrl.searchParams.append('searchFilter', query.trim());
      fallbackUrl.searchParams.append('pageSize', limit.toString());
      fallbackUrl.searchParams.append('index', offset.toString());

      response = await fetch(fallbackUrl.toString(), {
        headers: { 'User-Agent': 'CraftControl-Server-Manager/1.0.0 (https://github.com/mc-server-manager)' },
      });
    }

    if (!response.ok) {
      throw new Error(`CurseForge API returned status ${response.status}`);
    }

    const data = await response.json();
    const hits = (data.data || []).map((item: any) => ({
      project_id: item.id.toString(),
      slug: item.slug,
      title: item.name,
      description: item.summary || '',
      icon_url: item.logo?.thumbnailUrl || item.logo?.url || '',
      downloads: item.downloadCount || 0,
      authors: (item.authors || []).map((a: any) => a.name),
    }));

    return {
      hits,
      offset,
      limit,
      total_hits: data.pagination?.totalCount || hits.length,
    };
  } catch (err: any) {
    return {
      hits: [],
      offset: 0,
      limit,
      total_hits: 0,
      error: err.message,
    };
  }
}

export async function getCurseForgeVersions(modIdOrSlug: string): Promise<CurseForgeVersion[]> {
  const apiKey = process.env.CURSEFORGE_API_KEY;
  let modId = modIdOrSlug;

  // If modId is not numeric, search by slug to get numeric modId
  if (isNaN(Number(modIdOrSlug))) {
    const searchRes = await searchCurseForgeModpacks(modIdOrSlug, 1, 0);
    if (searchRes.hits && searchRes.hits.length > 0) {
      modId = searchRes.hits[0].project_id;
    }
  }

  let url = `https://api.curse.tools/v1/cf/mods/${modId}/files`;
  const headers: Record<string, string> = {
    'User-Agent': 'CraftControl-Server-Manager/1.0.0 (https://github.com/mc-server-manager)',
  };

  if (apiKey) {
    url = `https://api.curseforge.com/v1/mods/${modId}/files`;
    headers['x-api-key'] = apiKey;
    headers['Content-Type'] = 'application/json';
  }

  try {
    let response = await fetch(url, { headers });

    if (!response.ok && apiKey) {
      const fallbackUrl = `https://api.curse.tools/v1/cf/mods/${modId}/files`;
      response = await fetch(fallbackUrl, {
        headers: { 'User-Agent': 'CraftControl-Server-Manager/1.0.0 (https://github.com/mc-server-manager)' },
      });
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch CurseForge versions: ${response.status}`);
    }

    const data = await response.json();
    return (data.data || []).map((file: any) => ({
      id: file.id.toString(),
      name: file.displayName || file.fileName,
      version_number: file.displayName || file.fileName,
      game_versions: file.gameVersions || [],
      loaders: (file.gameVersions || []).filter((v: string) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(v.toLowerCase())),
      date_published: file.fileDate,
    }));
  } catch (err: any) {
    console.error(`[CurseForge] Version fetch failed:`, err.message);
    return [];
  }
}
