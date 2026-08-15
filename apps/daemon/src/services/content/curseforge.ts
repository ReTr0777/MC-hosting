import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import { generateServerPackCreatorProperties } from './serverpackcreator';

export interface CurseForgeFileDetail {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  downloadUrl: string;
  serverPackFileId?: number;
}

export interface CurseForgeInstallConfig {
  serverId: string;
  modId: number;
  fileId: number;
  mcVersion?: string;
  loader?: string;
  targetServerDir: string;
}

const CURSEFORGE_API_BASE = 'https://api.curseforge.com/v1';

/**
 * Fetches file details from CurseForge Core API with x-api-key header.
 */
export async function getCurseForgeFileDetail(modId: number, fileId: number): Promise<CurseForgeFileDetail> {
  const apiKey = process.env.CURSEFORGE_API_KEY || '$2a$10$bL4bWg56Bw3aFz';
  const url = `${CURSEFORGE_API_BASE}/mods/${modId}/files/${fileId}`;

  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'User-Agent': 'CraftControl-Daemon/1.0.0 (https://github.com/mc-server-manager)',
    },
  });

  if (!res.ok) {
    throw new Error(`CurseForge API failed to fetch file details (modId: ${modId}, fileId: ${fileId}): HTTP ${res.status}`);
  }

  const json = await res.json();
  const data = json.data;

  if (!data) {
    throw new Error(`CurseForge API returned empty data payload for fileId ${fileId}`);
  }

  return {
    id: data.id,
    modId: data.modId,
    displayName: data.displayName,
    fileName: data.fileName,
    downloadUrl: data.downloadUrl,
    serverPackFileId: data.serverPackFileId || 0,
  };
}

/**
 * CurseForge Modpack Installation Workflow:
 * 1. Inspect serverPackFileId property on the target file object.
 * 2. Primary Route (Server Pack): If serverPackFileId exists & is > 0, fetch serverPackFileId details,
 *    download the dedicated server pack zip, extract directly into targetServerDir, and bypass client-mod filtering.
 * 3. Fallback Route (Client Pack): If serverPackFileId is 0 or null, download main client pack,
 *    extract to /tmp/cf-build, execute ServerPackCreator CLI (-cli), extract output to targetServerDir,
 *    and clean up /tmp.
 */
export async function installCurseForgeModpack(config: CurseForgeInstallConfig): Promise<void> {
  console.log(`[CurseForge Workflow] Checking target file details for ModID ${config.modId}, FileID ${config.fileId}...`);
  const initialFile = await getCurseForgeFileDetail(config.modId, config.fileId);

  // 1. Primary Route: Dedicated Server Pack Available
  if (initialFile.serverPackFileId && initialFile.serverPackFileId > 0) {
    console.log(`[CurseForge Primary Route] Found dedicated serverPackFileId: ${initialFile.serverPackFileId}. Fetching details...`);
    const serverPackFile = await getCurseForgeFileDetail(config.modId, initialFile.serverPackFileId);

    if (!serverPackFile.downloadUrl) {
      throw new Error(`CurseForge server pack fileId ${initialFile.serverPackFileId} has no valid downloadUrl.`);
    }

    console.log(`[CurseForge Primary Route] Downloading pre-built server pack from ${serverPackFile.downloadUrl}...`);
    const res = await fetch(serverPackFile.downloadUrl);
    if (!res.ok) throw new Error(`Failed to download server pack zip: HTTP ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const zip = new AdmZip(Buffer.from(arrayBuffer));

    console.log(`[CurseForge Primary Route] Extracting pre-built server pack to ${config.targetServerDir}...`);
    zip.extractAllTo(config.targetServerDir, true);
    console.log(`[CurseForge Primary Route] Server pack deployment complete.`);
    return;
  }

  // 2. Fallback Route: Client Pack + ServerPackCreator CLI
  console.warn(`[CurseForge Fallback Route] No dedicated serverPackFileId found (serverPackFileId is 0 or null). Falling back to Client Pack + ServerPackCreator CLI.`);

  const tmpBase = path.join(os.tmpdir(), 'cf-build', config.serverId);
  const clientPackDir = path.join(tmpBase, 'client-pack');
  const outputDir = path.join(tmpBase, 'server-output');

  if (fs.existsSync(tmpBase)) {
    fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  fs.mkdirSync(clientPackDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    if (!initialFile.downloadUrl) {
      throw new Error(`CurseForge client pack fileId ${config.fileId} has no valid downloadUrl.`);
    }

    console.log(`[CurseForge Fallback Route] Downloading main client pack from ${initialFile.downloadUrl}...`);
    const res = await fetch(initialFile.downloadUrl);
    if (!res.ok) throw new Error(`Failed to download client pack zip: HTTP ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const clientZip = new AdmZip(Buffer.from(arrayBuffer));
    clientZip.extractAllTo(clientPackDir, true);

    // Execute ServerPackCreator CLI in headless mode (-cli)
    const propsPath = path.join(tmpBase, 'serverpackcreator.properties');
    const propsContent = generateServerPackCreatorProperties({
      modpackDir: clientPackDir,
      outputDir,
      mcVersion: config.mcVersion,
      loader: config.loader,
    });
    fs.writeFileSync(propsPath, propsContent);

    console.log(`[CurseForge Fallback Route] Executing ServerPackCreator CLI (-cli)...`);
    const spcJarPath = process.env.SERVERPACKCREATOR_JAR || '/opt/serverpackcreator/serverpackcreator.jar';

    if (fs.existsSync(spcJarPath)) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('java', ['-jar', spcJarPath, '-cli', `-properties=${propsPath}`], {
          cwd: tmpBase,
          env: process.env,
        });

        child.stdout.on('data', (data) => console.log(`[SPC CLI] ${data.toString().trim()}`));
        child.stderr.on('data', (data) => console.warn(`[SPC CLI WARN] ${data.toString().trim()}`));

        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ServerPackCreator CLI exited with status code ${code}`));
        });
      });
    } else {
      console.warn(`[CurseForge Fallback Route] ServerPackCreator CLI jar at '${spcJarPath}' not found. Utilizing extracted client pack files.`);
    }

    // Move generated files into production server directory
    const generatedZips = fs.readdirSync(outputDir).filter((f) => f.endsWith('.zip'));

    if (generatedZips.length > 0) {
      const zipPath = path.join(outputDir, generatedZips[0]);
      const generatedZip = new AdmZip(zipPath);
      generatedZip.extractAllTo(config.targetServerDir, true);
    } else {
      clientZip.extractAllTo(config.targetServerDir, true);
    }

    console.log(`[CurseForge Fallback Route] Fallback modpack deployment complete.`);
  } finally {
    // Clean up temporary build folder in /tmp
    if (fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
