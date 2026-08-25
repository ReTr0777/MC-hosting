import fs from 'fs';
import path from 'path';
import { runForgeInstaller, serverJarCandidates } from './server-type';

/**
 * Installing a Forge or NeoForge server, which nothing here previously did.
 *
 * The download step had branches for Fabric, Paper and Purpur, and for anything else fell
 * through to a line that fetched a *Fabric* jar. So a server set to Forge quietly became a
 * Fabric server: it started, ignored every Forge mod in the directory, generated an
 * ordinary world, and reported success. Setting the loader correctly and deleting the
 * world changed nothing, because the next start downloaded Fabric again.
 *
 * Forge is not a single jar. The installer has to be fetched and run, and it produces the
 * server — a run.sh and a libraries tree on modern versions, a universal jar plus the
 * vanilla server jar on 1.16 and older.
 */

const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

/**
 * The Forge build to install for a Minecraft version.
 *
 * "recommended" is preferred over "latest" deliberately: modpacks are built against
 * recommended builds, and a pack pinned to one behaves worse on a newer Forge than on the
 * one it was made for. Falls back to latest when a version has no recommended build yet.
 */
export async function resolveForgeBuild(mcVersion: string): Promise<string | null> {
  try {
    const res = await fetch(FORGE_PROMOTIONS);
    if (!res.ok) return null;
    const data = (await res.json()) as { promos?: Record<string, string> };
    const promos = data.promos || {};
    return promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`] || null;
  } catch {
    return null;
  }
}

/** The newest NeoForge build for a Minecraft version, from its Maven metadata. */
export async function resolveNeoForgeBuild(mcVersion: string): Promise<string | null> {
  // NeoForge versions are <minor>.<patch>.<build> derived from the Minecraft version:
  // Minecraft 1.21.1 gives 21.1.x. There is no promotions file, so the Maven listing is
  // the source of truth.
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcVersion);
  if (!match) return null;
  const prefix = `${match[1]}.${match[2] || '0'}.`;

  try {
    const res = await fetch(`${NEOFORGE_MAVEN}/maven-metadata.xml`);
    if (!res.ok) return null;
    const xml = await res.text();
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    const matching = versions.filter((v) => v.startsWith(prefix));
    return matching.length ? matching[matching.length - 1] : null;
  } catch {
    return null;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * Fetches and runs the installer, and reports what should be launched afterwards.
 *
 * Returns the launch target — 'run.sh' or a jar filename — or null when the pack could not
 * be installed. Null must not be papered over by the caller: a Forge server that silently
 * becomes something else is the bug this file exists to remove.
 */
export async function installForgeServer(
  serverDir: string,
  serverType: 'FORGE' | 'NEOFORGE',
  mcVersion: string
): Promise<string | null> {
  const neo = serverType === 'NEOFORGE';
  const build = neo ? await resolveNeoForgeBuild(mcVersion) : await resolveForgeBuild(mcVersion);

  if (!build) {
    console.warn(`[Forge] No ${serverType} build published for Minecraft ${mcVersion}.`);
    return null;
  }

  const installerName = neo
    ? `neoforge-${build}-installer.jar`
    : `forge-${mcVersion}-${build}-installer.jar`;
  const url = neo
    ? `${NEOFORGE_MAVEN}/${build}/${installerName}`
    : `${FORGE_MAVEN}/${mcVersion}-${build}/${installerName}`;

  const installerPath = path.join(serverDir, installerName);

  try {
    console.log(`[Forge] Downloading ${serverType} ${build} for Minecraft ${mcVersion}...`);
    await download(url, installerPath);
  } catch (err: any) {
    console.warn(`[Forge] Could not download the installer: ${err.message}`);
    return null;
  }

  if (!runForgeInstaller(serverDir, installerName)) return null;

  /*
   * What the installer produced, in the order it should be preferred.
   *
   * Modern Forge writes run.sh and expects to be started through it — the classpath is
   * enormous and lives in an args file. Older builds produce a universal jar that runs
   * directly. serverJarCandidates already excludes the installer itself, which is what
   * made this go wrong the first time.
   */
  const runSh = path.join(serverDir, 'run.sh');
  if (fs.existsSync(runSh) && fs.statSync(runSh).size > 0) {
    try {
      fs.chmodSync(runSh, 0o755);
    } catch {
      /* not fatal; the launcher invokes it through bash */
    }
    console.log(`[Forge] Installed ${serverType} ${build}; starting through run.sh.`);
    return 'run.sh';
  }

  const jars = serverJarCandidates(serverDir, ['server.jar']);
  const universal = jars.find((j) => /universal/i.test(j)) || jars[0];
  if (universal) {
    console.log(`[Forge] Installed ${serverType} ${build}; starting ${universal}.`);
    return universal;
  }

  console.warn(`[Forge] The installer ran but produced no run.sh and no runnable jar.`);
  return null;
}

/**
 * The vanilla server jar for a version, from Mojang's own manifest.
 *
 * Vanilla had no branch either, and fell through to the same Fabric fallback — so a server
 * set to VANILLA was quietly a Fabric server too. Nobody noticed because Fabric with no
 * mods behaves almost exactly like vanilla.
 */
export async function resolveVanillaJarUrl(mcVersion: string): Promise<string | null> {
  try {
    const manifestRes = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    if (!manifestRes.ok) return null;
    const manifest = (await manifestRes.json()) as {
      latest: { release: string };
      versions: Array<{ id: string; url: string }>;
    };

    const wanted = !mcVersion || mcVersion === 'LATEST' ? manifest.latest.release : mcVersion;
    const entry = manifest.versions.find((v) => v.id === wanted);
    if (!entry) return null;

    const detailRes = await fetch(entry.url);
    if (!detailRes.ok) return null;
    const detail = (await detailRes.json()) as { downloads?: { server?: { url: string } } };
    return detail.downloads?.server?.url || null;
  } catch {
    return null;
  }
}
