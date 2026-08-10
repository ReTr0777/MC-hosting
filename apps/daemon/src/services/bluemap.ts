import fs from 'fs';
import path from 'path';

const GITHUB_RELEASES = 'https://api.github.com/repos/BlueMap-Minecraft/BlueMap/releases/latest';

/** BlueMap ships a separate artifact per mod loader. */
export type BlueMapPlatform = 'paper' | 'spigot' | 'fabric' | 'forge' | 'neoforge';

export interface BlueMapArtifact {
  platform: BlueMapPlatform;
  fileName: string;
  downloadUrl: string;
  version: string;
}

/**
 * Maps a CraftControl server type onto the BlueMap artifact that can load in it.
 * Modpack types are resolved by the caller from the pack's actual loader.
 */
export function platformForServerType(serverType: string, loaderHint?: string): BlueMapPlatform | null {
  const hint = (loaderHint || '').toUpperCase();
  const type = (serverType || '').toUpperCase();

  const resolve = (value: string): BlueMapPlatform | null => {
    if (value === 'PAPER' || value === 'PURPUR') return 'paper';
    if (value === 'SPIGOT' || value === 'BUKKIT') return 'spigot';
    if (value === 'FABRIC' || value === 'QUILT') return 'fabric';
    if (value === 'NEOFORGE') return 'neoforge';
    if (value === 'FORGE') return 'forge';
    return null;
  };

  // MODRINTH/CURSEFORGE packs carry their real loader in the hint
  if (type === 'MODRINTH' || type === 'CURSEFORGE') return resolve(hint);

  // Vanilla has no plugin/mod loader at all — BlueMap cannot be installed
  if (type === 'VANILLA') return null;

  return resolve(type);
}

/** Where the jar goes, and where its config lives, differ between plugins and mods. */
export function layoutForPlatform(platform: BlueMapPlatform): { jarDir: string; configDir: string } {
  if (platform === 'paper' || platform === 'spigot') {
    return { jarDir: 'plugins', configDir: path.join('plugins', 'BlueMap') };
  }
  return { jarDir: 'mods', configDir: path.join('config', 'bluemap') };
}

/**
 * Resolves the newest BlueMap build for a platform straight from GitHub releases,
 * so a new BlueMap version does not require a CraftControl update.
 */
export async function resolveLatestArtifact(
  platform: BlueMapPlatform,
  mcVersion?: string
): Promise<BlueMapArtifact> {
  const res = await fetch(GITHUB_RELEASES, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CraftControl' },
  });

  if (!res.ok) {
    throw new Error(`Could not reach the BlueMap release feed (HTTP ${res.status})`);
  }

  const release: any = await res.json();
  const assets: any[] = Array.isArray(release.assets) ? release.assets : [];

  // Exact suffix match: a plain `includes('forge')` would also match neoforge builds
  const candidates = assets.filter((a) =>
    String(a.name || '').toLowerCase().endsWith(`-${platform}.jar`)
  );

  if (candidates.length === 0) {
    throw new Error(`BlueMap ${release.tag_name} publishes no '${platform}' build`);
  }

  // Newer BlueMap releases ship one jar per Minecraft version; prefer an exact match
  const exact = mcVersion && candidates.find((a) => String(a.name).includes(mcVersion));
  const chosen = exact || candidates[0];

  return {
    platform,
    fileName: chosen.name,
    downloadUrl: chosen.browser_download_url,
    version: String(release.tag_name || '').replace(/^v/, ''),
  };
}

export async function downloadArtifact(artifact: BlueMapArtifact, destPath: string): Promise<void> {
  const res = await fetch(artifact.downloadUrl, { headers: { 'User-Agent': 'CraftControl' } });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${artifact.fileName}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
}

/**
 * Writes BlueMap's config up front so the web server binds correctly on first boot.
 * BlueMap would otherwise generate defaults with the web server on 8100/localhost and
 * `accept-download: false`, which blocks the texture download it needs to render.
 */
export function writeConfig(configDir: string, port: number): void {
  fs.mkdirSync(configDir, { recursive: true });

  const core = [
    '# Managed by CraftControl',
    'accept-download: true',
    'data: "bluemap"',
    'render-thread-count: 1',
    'metrics: false',
    '',
  ].join('\n');

  const webserver = [
    '# Managed by CraftControl',
    'enabled: true',
    'webroot: "bluemap/web"',
    '# 0.0.0.0 so the panel can reach it from outside the container',
    'ip: "0.0.0.0"',
    `port: ${port}`,
    '',
  ].join('\n');

  const webapp = [
    '# Managed by CraftControl',
    'enabled: true',
    'webroot: "bluemap/web"',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(configDir, 'core.conf'), core, 'utf8');
  fs.writeFileSync(path.join(configDir, 'webserver.conf'), webserver, 'utf8');
  fs.writeFileSync(path.join(configDir, 'webapp.conf'), webapp, 'utf8');
}

/**
 * Mods BlueMap hard-depends on but does not bundle.
 *
 * The Fabric build declares `depends fabric-api-base`, which ships inside Fabric API;
 * without it the server dies at startup with HARD_DEP_NO_CANDIDATE rather than simply
 * failing to load BlueMap. Forge/NeoForge and the Bukkit plugins are self-contained.
 */
export function requiredDependencies(platform: BlueMapPlatform): Array<{ slug: string; name: string }> {
  if (platform === 'fabric') {
    return [{ slug: 'fabric-api', name: 'Fabric API' }];
  }
  return [];
}

/** True when a jar for this Modrinth project already sits in the mods folder. */
export function dependencyInstalled(serverDir: string, slug: string): boolean {
  const modsDir = path.join(serverDir, 'mods');
  if (!fs.existsSync(modsDir)) return false;

  // Fabric API publishes as "fabric-api-<version>.jar"
  const needle = slug.replace(/-/g, '[-_]?');
  const pattern = new RegExp(`^${needle}`, 'i');
  return fs.readdirSync(modsDir).some((f) => f.endsWith('.jar') && pattern.test(f));
}

/** Finds an installed BlueMap jar, if any. */
export function findInstalledJar(serverDir: string, platform: BlueMapPlatform): string | null {
  const { jarDir } = layoutForPlatform(platform);
  const dir = path.join(serverDir, jarDir);
  if (!fs.existsSync(dir)) return null;

  const match = fs.readdirSync(dir).find((f) => /^bluemap.*\.jar$/i.test(f));
  return match ? path.join(dir, match) : null;
}
