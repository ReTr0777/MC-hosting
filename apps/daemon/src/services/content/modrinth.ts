import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';

const MODRINTH_API = 'https://api.modrinth.com/v2';

/** A single entry of a .mrpack's `modrinth.index.json` `files[]` array. */
export interface MrpackManifestFile {
  path: string;
  hashes?: { sha1?: string; sha512?: string };
  env?: { client?: string; server?: string };
  downloads?: string[];
  fileSize?: number;
}

export function verifyHash(buffer: Buffer, hashes?: { sha1?: string; sha512?: string }): boolean {
  if (!hashes) return true;

  if (hashes.sha1) {
    const calcSha1 = crypto.createHash('sha1').update(buffer).digest('hex').toLowerCase();
    if (calcSha1 !== hashes.sha1.toLowerCase()) return false;
  }

  if (hashes.sha512) {
    const calcSha512 = crypto.createHash('sha512').update(buffer).digest('hex').toLowerCase();
    if (calcSha512 !== hashes.sha512.toLowerCase()) return false;
  }

  return true;
}

/**
 * Joins an archive-supplied relative path onto a base directory, refusing anything that would
 * escape it. Manifest and override paths come straight out of an uploaded archive, so a crafted
 * pack could otherwise use `../` (or an absolute path) to write anywhere the daemon can reach.
 */
export function resolveInsideDir(baseDir: string, relPath: string): string | null {
  if (!relPath || path.isAbsolute(relPath) || relPath.includes('\0')) return null;
  const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = path.resolve(baseDir, normalized);
  const baseWithSep = path.resolve(baseDir) + path.sep;
  if (resolved !== path.resolve(baseDir) && !resolved.startsWith(baseWithSep)) return null;
  return resolved;
}

/** True unless the manifest explicitly marks the file as unusable on a server. */
export function isServerRelevant(file: MrpackManifestFile): boolean {
  return parseModrinthEnv(file.env?.server) !== 'unsupported';
}

export interface ManifestDownloadResult {
  downloaded: number;
  skipped: string[];
  failed: string[];
}

/**
 * Downloads a manifest's `files[]` into targetDir, in bounded-concurrency batches, verifying each
 * file against its declared SHA hashes and retrying on mismatch or transport error.
 */
export async function downloadManifestFiles(
  files: MrpackManifestFile[],
  targetDir: string,
  options: { concurrency?: number; maxAttempts?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<ManifestDownloadResult> {
  const { concurrency = 8, maxAttempts = 3, onProgress } = options;
  const result: ManifestDownloadResult = { downloaded: 0, skipped: [], failed: [] };

  const queue = files.filter((f) => Array.isArray(f.downloads) && f.downloads.length > 0);
  let completed = 0;

  for (let i = 0; i < queue.length; i += concurrency) {
    const batch = queue.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (file) => {
        const destPath = resolveInsideDir(targetDir, file.path);
        if (!destPath) {
          console.warn(`[Modrinth Downloader] Refusing manifest entry with unsafe path: '${file.path}'`);
          result.skipped.push(file.path);
          completed++;
          return;
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });

        let ok = false;
        for (let attempt = 1; attempt <= maxAttempts && !ok; attempt++) {
          // Mirrors are listed in preference order; walk them before burning a retry.
          for (const url of file.downloads!) {
            try {
              const res = await fetch(url);
              if (!res.ok) continue;
              const buf = Buffer.from(await res.arrayBuffer());
              if (!verifyHash(buf, file.hashes)) {
                console.warn(`[Modrinth Downloader] Hash mismatch for '${file.path}' from ${url} (attempt ${attempt}/${maxAttempts})`);
                continue;
              }
              fs.writeFileSync(destPath, buf);
              ok = true;
              break;
            } catch (e: any) {
              console.warn(`[Modrinth Downloader] Error fetching '${file.path}' (attempt ${attempt}/${maxAttempts}): ${e.message}`);
            }
          }
        }

        if (ok) result.downloaded++;
        else {
          console.error(`[Modrinth Downloader] Gave up on '${file.path}' after ${maxAttempts} attempts`);
          result.failed.push(file.path);
        }

        completed++;
        if (onProgress && (completed % 15 === 0 || completed === queue.length)) {
          onProgress(completed, queue.length);
        }
      })
    );
  }

  return result;
}

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

/**
 * Substring matching against paths & bundled jars in overrides/mods/.
 *
 * The single source of truth for "this mod cannot run on a dedicated server", shared by every
 * install path. It used to be duplicated — a three-entry copy here for daemon-side mrpack
 * builds and a much longer one in docker.ts for the itzg image — and the two drifted, so a mod
 * one path knew to exclude would sail through the other and crash the boot.
 *
 * Entries are matched as substrings of the jar filename, so keep them specific enough not to
 * collide with unrelated mods.
 */
export const DENYLIST_PATH_SUBSTRINGS = [
  // Open a GUI or otherwise assume a display, and die on HeadlessException.
  'missingmodschecker',
  'missing-mods-checker',
  'bettercompatibilitychecker',
  'better-compatibility-checker',
  'bcc',
  'crashexploitfixer',
  'crash-exploit-fixer',
  // Client config / menu UI.
  'modmenu',
  'mod-menu',
  'forgeconfigscreens',
  'forge-config-screens',
  'catalogue',
  'configured',
  'controlify',
  'serverbrowser',
  'server-browser',
  // Client rendering and input.
  'iris',
  'sodium',
  'oculus',
  'rubidium',
  'entityculling',
  '3dskinlayers',
  'zoomify',
  'freecam',
  'soundphysics',
  'sound_physics',
  // Client inventory / QoL.
  'item-group-extra',
  'inventorytabs',
  'inventory-tabs',
  'client-sort',
  'smooth-swapping',
  // Rich presence integrations.
  'discord-rpc',
  'presence',
  'craftpresence',
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

/**
 * Finds the newest .mrpack for a modpack project.
 *
 * `loader` is optional on purpose. Filtering by `loaders: ["fabric"]` — which this used to do
 * unconditionally — makes every Forge, NeoForge and Quilt pack resolve to "No matching
 * versions found", because their versions are not tagged fabric. The loader a pack needs is
 * declared inside its own `modrinth.index.json` and is detected when the pack is
 * materialized, so there is nothing to gain by guessing it here.
 */
export async function resolveMrpackDetails(slug: string, options: { gameVersion?: string; loader?: string } = {}): Promise<ModrinthVersionDetails> {
  const { gameVersion, loader } = options;
  const params = new URLSearchParams();
  if (loader) params.set('loaders', JSON.stringify([loader]));
  // 'LATEST' is the panel's own placeholder, not a Minecraft version Modrinth knows.
  if (gameVersion && gameVersion.toUpperCase() !== 'LATEST') {
    params.set('game_versions', JSON.stringify([gameVersion]));
  }

  const query = params.toString();
  const res = await fetch(`${MODRINTH_API}/project/${slug}/version${query ? `?${query}` : ''}`, {
    headers: { 'User-Agent': 'CraftControl-Daemon/1.0.0 (https://github.com/mc-server-manager)' },
  });

  if (!res.ok) throw new Error(`Modrinth version lookup failed for ${slug}: ${res.status}`);
  const versions = await res.json();
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(
      `No published versions of '${slug}'` +
        (gameVersion && gameVersion.toUpperCase() !== 'LATEST' ? ` for Minecraft ${gameVersion}` : '') +
        (loader ? ` on ${loader}` : '') +
        '. Check the version and loader on the modpack page.'
    );
  }

  // The API returns newest first. Skip any version whose primary file is not a .mrpack
  // rather than failing on it — some projects attach extra artefacts.
  const chosen = pickMrpackVersion(versions);
  if (!chosen) {
    throw new Error(`No version of '${slug}' ships a .mrpack file, so there is nothing to build a server from.`);
  }

  const primaryFile = chosen.files.find((f: any) => f.primary && f.url?.endsWith('.mrpack'))
    ?? chosen.files.find((f: any) => f.url?.endsWith('.mrpack'));

  return {
    url: primaryFile.url,
    versionId: chosen.id,
    versionNumber: chosen.version_number,
    modrinthPageUrl: `https://modrinth.com/modpack/${slug}/version/${chosen.id}`,
  };
}

export function pickMrpackVersion(versions: any[]): any | null {
  for (const version of versions) {
    const files: any[] = Array.isArray(version?.files) ? version.files : [];
    if (files.some((f) => typeof f?.url === 'string' && f.url.endsWith('.mrpack'))) return version;
  }
  return null;
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

/**
 * Reverse-looks-up jar files on Modrinth by their SHA1. This is how we identify mods that a
 * modpack bundled directly into overrides/mods/ rather than listing in the manifest — those jars
 * arrive with no env metadata of their own, so the project record is the only way to learn
 * whether they're client-only. Returns a map of sha1 -> version object (unknown hashes omitted).
 */
export async function lookupVersionsByHashes(sha1Hashes: string[]): Promise<Map<string, any>> {
  const found = new Map<string, any>();
  const batchSize = 100;

  for (let i = 0; i < sha1Hashes.length; i += batchSize) {
    const batch = sha1Hashes.slice(i, i + batchSize);
    try {
      const res = await fetch(`${MODRINTH_API}/version_files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'CraftControl-Daemon/1.0.0 (https://github.com/mc-server-manager)',
        },
        body: JSON.stringify({ hashes: batch, algorithm: 'sha1' }),
      });
      if (!res.ok) {
        console.warn(`[modrinth-api] Hash lookup batch failed: ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const [hash, version] of Object.entries(data || {})) {
        found.set(hash.toLowerCase(), version);
      }
    } catch (err: any) {
      console.warn(`[modrinth-api] Hash lookup batch errored: ${err.message}`);
    }
  }

  return found;
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

export interface ModrinthSearchResult {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  categories: string[];
  client_side: ModrinthEnvType;
  server_side: ModrinthEnvType;
  downloads: number;
  follows: number;
  icon_url: string;
  versions: string[];
  loaders: string[];
  game_versions: string[];
}

/**
 * Search Modrinth for mods/modpacks
 */
export async function searchModrinth(query: string, options: {
  gameVersion?: string;
  loader?: string;
  limit?: number;
  offset?: number;
  facets?: string[][];
  projectType?: 'mod' | 'modpack';
} = {}): Promise<{ hits: ModrinthSearchResult[]; total_hits: number }> {
  const { gameVersion, loader, limit = 20, offset = 0, facets = [], projectType = 'mod' } = options;
  
  const params = new URLSearchParams();
  params.set('query', query);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  
  if (gameVersion) {
    facets.push(['versions:' + gameVersion]);
  }
  if (loader) {
    facets.push(['categories:' + loader]);
  }
  
  // Filter by project type (mod vs modpack) - default to mods only
  facets.push(['project_type:' + projectType]);
  
  // Add default facets for server-side mods
  facets.push(['server_side:required', 'server_side:optional']);
  params.set('facets', JSON.stringify(facets));

  const res = await fetch(`${MODRINTH_API}/search?${params}`, {
    headers: { 'User-Agent': 'CraftControl-Daemon/1.0.0 (https://github.com/mc-server-manager)' },
  });

  if (!res.ok) throw new Error(`Modrinth search failed: ${res.status}`);
  return res.json();
}

/**
 * Get available versions for a mod project
 */
export async function getModrinthProjectVersions(projectId: string, options: {
  gameVersion?: string;
  loader?: string;
} = {}): Promise<any[]> {
  const { gameVersion, loader } = options;
  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  if (loader) params.set('loaders', JSON.stringify([loader]));

  const res = await fetch(`${MODRINTH_API}/project/${projectId}/version?${params}`, {
    headers: { 'User-Agent': 'CraftControl-Daemon/1.0.0 (https://github.com/mc-server-manager)' },
  });

  if (!res.ok) throw new Error(`Failed to fetch versions: ${res.status}`);
  return res.json();
}

/**
 * Download a specific mod file
 */
export async function downloadModrinthFile(fileUrl: string, outputPath: string): Promise<void> {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to download mod file: ${res.status}`);
  
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buf);
}
