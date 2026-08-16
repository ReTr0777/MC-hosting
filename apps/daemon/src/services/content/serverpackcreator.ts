import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import { resolveMrpackDetails, parseModrinthEnv, downloadManifestFiles, isServerRelevant } from './modrinth';
import { provisioningManager } from './provisioning';

export interface ServerPackCreatorConfig {
  serverId: string;
  slug: string;
  mcVersion?: string;
  loader?: string;
  targetServerDir: string;
}

/**
 * Template string for serverpackcreator.properties configuration file.
 * Enables autodiscovery for automatic client-side mod filtering.
 */
export function generateServerPackCreatorProperties(options: {
  modpackDir: string;
  outputDir: string;
  mcVersion?: string;
  loader?: string;
}): string {
  const cleanModpackDir = options.modpackDir.replace(/\\/g, '/');
  const cleanOutputDir = options.outputDir.replace(/\\/g, '/');

  return `
# ServerPackCreator Configuration File
de.griefed.serverpackcreator.serverpack.autodiscovery.enabled=true
de.griefed.serverpackcreator.serverpack.modpack.dir=${cleanModpackDir}
de.griefed.serverpackcreator.serverpack.output.dir=${cleanOutputDir}
de.griefed.serverpackcreator.serverpack.minecraft.version=${options.mcVersion || '1.20.1'}
de.griefed.serverpackcreator.serverpack.modloader=${options.loader || 'Fabric'}
de.griefed.serverpackcreator.serverpack.clientmods.include=false
de.griefed.serverpackcreator.serverpack.java.args=-Xms2G -Xmx4G
`.trim();
}

export function sanitizeModJarsAndLangFiles(dir: string) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sanitizeModJarsAndLangFiles(fullPath);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) {
      try {
        let modified = false;
        const zip = new AdmZip(fullPath);
        const zipEntries = zip.getEntries();

        for (const zipEntry of zipEntries) {
          if (/\/lang\/[^/]+\.json$/i.test(zipEntry.entryName)) {
            const raw = zipEntry.getData().toString('utf8').trim();
            let isBroken = false;

            if (raw.length === 0) {
              isBroken = true;
            } else {
              try {
                const parsed = JSON.parse(raw);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  isBroken = true;
                }
              } catch (err) {
                isBroken = true;
              }
            }

            if (isBroken) {
              console.warn(`[Mod Sanitizer] Repairing broken lang JSON '${zipEntry.entryName}' in '${entry.name}' -> '{}'`);
              zip.updateFile(zipEntry.entryName, Buffer.from('{}'));
              modified = true;
            }
          }
        }

        if (modified) {
          zip.writeZip(fullPath);
        }
      } catch (err: any) {
        // ignore unreadable jars
      }
    }
  }
}

/**
 * Node.js Daemon Modrinth Workflow with ServerPackCreator CLI:
 * 1. Download Client Pack (.mrpack) & extract to temporary build directory (/tmp/modpack-build).
 * 2. Download all mod JAR files specified in modrinth.index.json into build directory mods/ folder.
 * 3. Execute ServerPackCreator CLI (-feelinglucky) with autodiscovery enabled to filter client mods.
 * 4. Move generated server pack zip contents into target server root directory & clean up /tmp build files.
 */
export async function buildServerWithServerPackCreator(config: ServerPackCreatorConfig): Promise<{ expectedModCount: number }> {
  let expectedModCount = 0;
  const tmpBase = path.join(os.tmpdir(), 'modpack-build', config.serverId);
  const modpackDir = path.join(tmpBase, 'client-pack');
  const outputDir = path.join(tmpBase, 'server-output');

  if (fs.existsSync(tmpBase)) {
    fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  fs.mkdirSync(modpackDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    // Step 1: Download the Client Pack (.mrpack)
    const details = await resolveMrpackDetails(config.slug, { gameVersion: config.mcVersion, loader: config.loader });
    const msg1 = `[Daemon Build] Step 1: Resolved Modrinth build '${details.versionNumber}' (ID: ${details.versionId}) for '${config.slug}'...`;
    console.log(msg1);
    provisioningManager.emitLog(config.serverId, 'daemon', msg1);

    const res = await fetch(details.url);
    if (!res.ok) throw new Error(`Failed to fetch Modrinth pack archive: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    const mrpackZip = new AdmZip(Buffer.from(arrayBuffer));

    // Extract archive to temporary build directory
    mrpackZip.extractAllTo(modpackDir, true);

    // CRITICAL STEP: Download all mod files specified in modrinth.index.json into client-pack/mods/
    const indexFile = path.join(modpackDir, 'modrinth.index.json');
    if (fs.existsSync(indexFile)) {
      const indexContent = fs.readFileSync(indexFile, 'utf-8');
      const indexJson = JSON.parse(indexContent);

      if (Array.isArray(indexJson.files)) {
        indexJson.files.forEach((file: any) => {
          if (file.env) {
            file.env.client = parseModrinthEnv(file.env.client);
            file.env.server = parseModrinthEnv(file.env.server);
          }
        });
        fs.writeFileSync(indexFile, JSON.stringify(indexJson, null, 2));

        const queue = indexJson.files.filter((f: any) => f.downloads?.length > 0 && isServerRelevant(f));
        expectedModCount = queue.length;
        const msg2 = `[Daemon Build] Step 2: Downloading ${queue.length} mod files with SHA hash verification...`;
        console.log(msg2);
        provisioningManager.emitLog(config.serverId, 'daemon', msg2);

        await downloadManifestFiles(queue, modpackDir, {
          onProgress: (done, total) => {
            const progMsg = `[Daemon Build] Progress: Downloaded & verified ${done}/${total} mods`;
            console.log(progMsg);
            provisioningManager.emitLog(config.serverId, 'daemon', progMsg);
          },
        });
      }
    }

    // Step 2: Execute ServerPackCreator CLI (-feelinglucky)
    const propsPath = path.join(tmpBase, 'serverpackcreator.properties');
    const propsContent = generateServerPackCreatorProperties({
      modpackDir,
      outputDir,
      mcVersion: config.mcVersion,
      loader: config.loader,
    });
    fs.writeFileSync(propsPath, propsContent);

    console.log(`[ServerPackCreator] Step 2: Executing ServerPackCreator CLI (-feelinglucky)...`);
    const spcJarPath = process.env.SERVERPACKCREATOR_JAR || '/opt/serverpackcreator/serverpackcreator.jar';

    if (fs.existsSync(spcJarPath)) {
      await new Promise<void>((resolve, reject) => {
        console.log(`[ServerPackCreator] Executing: java -jar ${spcJarPath} -feelinglucky ${modpackDir} --destination ${outputDir}`);
        const child = spawn('java', ['-jar', spcJarPath, '-feelinglucky', modpackDir, '--destination', outputDir], {
          cwd: tmpBase,
          env: process.env,
        });

        child.stdout.on('data', (data) => console.log(`[SPC CLI] ${data.toString().trim()}`));
        child.stderr.on('data', (data) => console.warn(`[SPC CLI WARN] ${data.toString().trim()}`));

        // See the matching handler in curseforge.ts: the jar is checked for, the JVM
        // that runs it is not, and a node without Java is ordinary on Windows.
        child.on('error', (err: NodeJS.ErrnoException) => {
          reject(new Error(err.code === 'ENOENT' ? 'Java is not installed on this node, so the modpack could not be prepared' : `ServerPackCreator CLI could not start: ${err.message}`));
        });

        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ServerPackCreator CLI exited with status code ${code}`));
        });
      });
    } else {
      console.warn(`[ServerPackCreator] ServerPackCreator CLI jar at '${spcJarPath}' not found. Utilizing extracted client pack files.`);
    }

    // Step 3: Move to Production & Clean Up Build Files
    console.log(`[ServerPackCreator] Step 3: Moving generated server pack files into target directory...`);
    const generatedZips = fs.readdirSync(outputDir).filter((f) => f.endsWith('.zip'));

    if (generatedZips.length > 0) {
      const zipPath = path.join(outputDir, generatedZips[0]);
      console.log(`[ServerPackCreator] Extracting generated server pack ZIP: ${zipPath}`);
      const generatedZip = new AdmZip(zipPath);
      generatedZip.extractAllTo(config.targetServerDir, true);
    } else {
      console.warn(`[ServerPackCreator] No server zip generated by SPC. Falling back to direct client pack extract.`);
      mrpackZip.extractAllTo(config.targetServerDir, true);
    }

    // Step 4: Scan and repair truncated or broken lang/*.json entries in all installed mod JARs
    console.log(`[ServerPackCreator] Step 4: Scanning installed mod JARs for broken/truncated lang assets...`);
    sanitizeModJarsAndLangFiles(path.join(config.targetServerDir, 'mods'));

    console.log(`[ServerPackCreator] Modpack server build complete.`);
    return { expectedModCount };
  } finally {
    // Clean up temporary build files
    if (fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
