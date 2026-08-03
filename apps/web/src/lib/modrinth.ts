export interface ModrinthSearchResult {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string;
  downloads: number;
  follows: number;
  categories: string[];
  client_side: string;
  server_side: string;
}

export interface ModrinthSearchResponse {
  hits: ModrinthSearchResult[];
  offset: number;
  limit: number;
  total_hits: number;
}

export interface ModrinthSearchOptions {
  query?: string;
  limit?: number;
  offset?: number;
  index?: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated';
  loader?: string; // e.g. "fabric", "forge", "neoforge"
}

export interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
}

export async function searchModrinthModpacks(options: ModrinthSearchOptions = {}): Promise<ModrinthSearchResponse> {
  const { query = '', limit = 12, offset = 0, index = 'downloads', loader } = options;

  const url = new URL('https://api.modrinth.com/v2/search');
  if (query.trim()) {
    url.searchParams.append('query', query.trim());
  }
  url.searchParams.append('limit', limit.toString());
  url.searchParams.append('offset', offset.toString());
  url.searchParams.append('index', index);

  const facets: string[][] = [['project_type:modpack']];
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  url.searchParams.append('facets', JSON.stringify(facets));

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'CraftControl-Server-Manager/1.0.0 (https://github.com/mc-server-manager)',
    },
  });

  if (!response.ok) {
    throw new Error(`Modrinth API returned status ${response.status}`);
  }

  const data = await response.json();
  return {
    hits: (data.hits || []).map((hit: any) => ({
      project_id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      icon_url: hit.icon_url,
      downloads: hit.downloads,
      follows: hit.follows,
      categories: hit.categories || [],
      client_side: hit.client_side || 'optional',
      server_side: hit.server_side || 'optional',
    })),
    offset: data.offset || 0,
    limit: data.limit || limit,
    total_hits: data.total_hits || 0,
  };
}

export async function getModrinthVersions(slug: string): Promise<ModrinthVersion[]> {
  const url = `https://api.modrinth.com/v2/project/${slug}/version`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'CraftControl-Server-Manager/1.0.0 (https://github.com/mc-server-manager)',
    },
  });

  if (!response.ok) {
    throw new Error(`Modrinth API returned status ${response.status}`);
  }

  const data = await response.json();
  return (data || []).map((v: any) => ({
    id: v.id,
    name: v.name,
    version_number: v.version_number,
    game_versions: v.game_versions || [],
    loaders: v.loaders || [],
    date_published: v.date_published,
  }));
}
