import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const MODRINTH_API = 'https://api.modrinth.com/v2';

export type ModrinthEnvType = 'required' | 'optional' | 'unsupported' | 'unknown';

export function parseModrinthEnv(value: string | undefined): ModrinthEnvType {
  if (!value) return 'unknown';
  const lower = value.toLowerCase().trim();
  if (['required', 'optional', 'unsupported', 'unknown'].includes(lower)) {
    return lower as ModrinthEnvType;
  }
  return 'unknown';
}

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  client_side: ModrinthEnvType;
  server_side: ModrinthEnvType;
}

export interface ModrinthModDownload {
  projectId: string;
  fileUrl: string;
  filename: string;
}

// Known-problematic Modrinth project slugs — resolved to file hashes at
// runtime so exclusion survives version bumps / filename changes.
export const DENYLIST_PROJECT_SLUGS = [
  'missing-mods-checker', // real slug on Modrinth
  'modmenu',
];

// Substring matching against paths & bundled jars in overrides/mods/
export const DENYLIST_PATH_SUBSTRINGS = [
  'missingmodschecker',
  'missing-mods-checker',
  'modmenu',
];

function pathMatchesDenylist(lowerPath: string): boolean {
  return DENYLIST_PATH_SUBSTRINGS.some((s) => lowerPath.includes(s));
}

export interface ModrinthVersionDetails {
  url: string;
  versionId: string;
  versionNumber: string;
  modrinthPageUrl: string;
}

export async function resolveMrpackDetails(slug: string, options: { gameVersion?: string; loader?: string } = {}): Promise<ModrinthVersionDetails> {
  const { gameVersion, loader = 'fabric' } = options;
  const params = new URLSearchParams();
  if (loader) params.set('loaders', JSON.stringify([loader]));
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));

  const res = await fetch(`${MODRINTH_API}/project/${slug}/version?${params}`, {
    headers: { 'User-Agent': 'CraftControl-Daemon/1.0.0 (https://github.com/mc-server-manager)' },
  });

  if (!res.ok) throw new Error(`Modrinth version lookup failed for ${slug}: ${res.status}`);
  const versions = await res.json();
  if (!versions.length) throw new Error(`No matching versions found for ${slug}`);

  const chosen = versions[0];
  const primaryFile = chosen.files.find((f: any) => f.primary) ?? chosen.files[0];
  if (!primaryFile?.url?.endsWith('.mrpack')) {
    throw new Error(`Resolved version for ${slug} has no .mrpack file`);
  }

  return {
    url: primaryFile.url,
    versionId: chosen.id,
    versionNumber: chosen.version_number,
    modrinthPageUrl: `https://modrinth.com/modpack/${slug}/version/${chosen.id}`,
  };
}

/**
 * Resolves the primary .mrpack download URL for a modpack project.
 */
export async function resolveMrpackUrl(slug: string, options: { gameVersion?: string; loader?: string } = {}): Promise<string> {
  const details = await resolveMrpackDetails(slug, options);
  return details.url;
}

/**
 * Fetches SHA1 & SHA512 hashes for denylisted project slugs across all versions.
 */
export async function buildDenylistHashSet(projectSlugs: string[]): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const slug of projectSlugs) {
    try {
      const res = await fetch(`${MODRINTH_API}/project/${slug}/version`, {
        headers: { 'User-Agent': 'CraftControl-Daemon/1.0.0 (https://github.com/mc-server-manager)' },
      });
      if (!res.ok) continue;
      const versions = await res.json();
      for (const v of versions) {
        for (const f of v.files || []) {
          if (f.hashes?.sha1) hashes.add(f.hashes.sha1.toLowerCase());
          if (f.hashes?.sha512) hashes.add(f.hashes.sha512.toLowerCase());
        }
      }
    } catch (err: any) {
      console.warn(`[modrinth-api] Couldn't fetch hashes for ${slug}: ${err.message}`);
    }
  }
  return hashes;
}

/**
 * Downloads a modpack by slug, strips denylisted mods from both the
 * files[] manifest (CDN-hosted mods) and any overrides/mods/ directory,
 * and writes a sanitized .mrpack to outputPath.
 */
export async function sanitizeMrpack(slug: string, outputPath: string, options: { gameVersion?: string; loader?: string } = {}): Promise<{ outputPath: string; removedManifestEntries: number; removedOverrideEntries: number }> {
  const [mrpackUrl, denylistHashes] = await Promise.all([
    resolveMrpackUrl(slug, options),
    buildDenylistHashSet(DENYLIST_PROJECT_SLUGS),
  ]);

  const res = await fetch(mrpackUrl);
  if (!res.ok) throw new Error(`Failed to download mrpack: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const zip = new AdmZip(buf);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('modrinth.index.json not found in mrpack archive');
  const index = JSON.parse(zip.readAsText(indexEntry));

  // 1. Strip from files[] (CDN-hosted entries)
  const beforeFiles = index.files.length;
  index.files = index.files.filter((file: any) => {
    const lowerPath = (file.path || '').toLowerCase();
    const hashHit =
      (file.hashes?.sha1 && denylistHashes.has(file.hashes.sha1.toLowerCase())) ||
      (file.hashes?.sha512 && denylistHashes.has(file.hashes.sha512.toLowerCase()));
    const nameHit = pathMatchesDenylist(lowerPath);
    if (hashHit || nameHit) {
      console.log(`[sanitizer] Stripping manifest entry: ${file.path} (${hashHit ? 'hash match' : 'name match'})`);
    }
    return !hashHit && !nameHit;
  });
  console.log(`[sanitizer] files[]: removed ${beforeFiles - index.files.length} of ${beforeFiles}`);
  zip.updateFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)));

  // 2. Strip from overrides/, overrides-server/, client-overrides/ etc.
  const overrideHits = zip.getEntries().filter((e) => {
    const p = e.entryName.toLowerCase();
    const inOverrides = /^(overrides|overrides-server|server-overrides)\//.test(p);
    return inOverrides && p.includes('/mods/') && pathMatchesDenylist(p);
  });

  for (const entry of overrideHits) {
    console.log(`[sanitizer] Stripping bundled override: ${entry.entryName}`);
    zip.deleteFile(entry.entryName);
  }
  console.log(`[sanitizer] overrides: removed ${overrideHits.length} bundled jar(s)`);

  zip.writeZip(outputPath);
  return { outputPath, removedManifestEntries: beforeFiles - index.files.length, removedOverrideEntries: overrideHits.length };
}

export async function getModrinthProjects(projectIdsOrSlugs: string[]): Promise<Map<string, ModrinthProject>> {
  if (projectIdsOrSlugs.length === 0) return new Map();

  const url = `${MODRINTH_API}/projects?ids=${encodeURIComponent(JSON.stringify(projectIdsOrSlugs))}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CraftControl-Daemon/1.0.0 (https://github.com/mc-server-manager)' },
  });

  if (!response.ok) {
    throw new Error(`Modrinth API request failed with status ${response.status}`);
  }

  const projects: ModrinthProject[] = await response.json();
  const projectMap = new Map<string, ModrinthProject>();
  for (const project of projects) {
    projectMap.set(project.id, project);
    projectMap.set(project.slug, project);
  }
  return projectMap;
}

export async function filterServerCompatibleMods(downloads: ModrinthModDownload[]): Promise<ModrinthModDownload[]> {
  const projectIds = Array.from(new Set(downloads.map((d) => d.projectId)));
  try {
    const projectMap = await getModrinthProjects(projectIds);
    const compatibleDownloads: ModrinthModDownload[] = [];

    for (const item of downloads) {
      const project = projectMap.get(item.projectId);
      if (project) {
        if (project.server_side === 'unsupported' || DENYLIST_PATH_SUBSTRINGS.some((d) => project.slug.includes(d))) {
          console.warn(`[Modrinth] Skipped downloading '${project.title || project.slug || item.projectId}' as it is marked as client-only.`);
          continue;
        }
      }
      compatibleDownloads.push(item);
    }
    return compatibleDownloads;
  } catch (err: any) {
    console.error(`[Modrinth Error] Failed to fetch project metadata for compatibility check:`, err.message);
    return downloads;
  }
}
