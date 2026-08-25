import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { CreateServerContainerDto, maxJavaMajor } from '@mc-manager/shared';
import { getConfig } from '../../config';
import { provisioningManager, STATUS } from '../content/provisioning';
import { tunnelManager } from '../network/frpc';
import { flattenServerDir } from '../../utils/flatten';
import { synthesizeForgeRunScript } from '../../utils/forgeLaunchScript';
import { gameOfServer, getGame, isNonMinecraftGame } from '../../games';
import {
  JAVA_PREFERENCE,
  requiredJavaMajor,
  javaVersionProblem,
  explainClassVersionError,
} from './java-version';
import {
  findForgeInstaller,
  jarLoader,
  jarSuitsLoader,
  loaderMismatch,
  runForgeInstaller,
  serverJarCandidates,
} from './server-type';
import { installForgeServer, resolveConcreteVersion, resolveVanillaJarUrl } from './forge-install';

export interface ManagedProcess {
  serverId: string;
  process: ChildProcess;
  status: 'STARTING' | 'RUNNING' | 'STOPPING' | 'OFFLINE';
  logBuffer: string[];
  startedAt: Date;
  onlinePlayers: Set<string>;
  statsHistory: Array<{ timestamp: string; cpuPercent: number; memoryMb: number }>;
  /**
   * Console command that shuts this server down gracefully.
   *
   * Optional, and the Minecraft path never sets it: `stopProcess` falls back to
   * `stop`, so an existing process behaves identically whether or not this is
   * populated.
   */
  stopCommand?: string;
}

export function resolveJavaCmd(mcVersion?: string, loader?: string): string {
  /*
   * An explicit JAVA_BIN wins over everything below.
   *
   * The /opt/java layout is the Docker image's, built by apps/daemon/Dockerfile. A
   * node installed any other way — the portable Linux bundle, Termux on a phone, a
   * Raspberry Pi — has its JDK wherever the package manager put it, and without this
   * could only ever use whichever `java` happens to be first on PATH.
   */
  if (process.env.JAVA_BIN) return process.env.JAVA_BIN;

  /*
   * Which Java this version needs is decided in java-version.ts, so the preflight
   * check and this cannot disagree about it. Picking one binary and then vetting it
   * against a different rule would be worse than not checking at all.
   */
  /*
   * Which Java this version needs is decided in java-version.ts, so the preflight
   * check and this cannot disagree about it. Picking one binary and then vetting it
   * against a different rule would be worse than not checking at all.
   *
   * The ceiling has to be applied first. requiredJavaMajor is a floor — "at least 17" —
   * and for Forge up to 1.16 the floor is not the binding constraint: those need Java 8
   * and cannot use anything newer. Consulting only the floor picked Java 17 for every
   * 1.12.2 pack, which is a JVM they can never run on.
   */
  const ceiling = maxJavaMajor(mcVersion, loader);
  const wanted = ceiling ?? requiredJavaMajor(mcVersion);

  for (const major of JAVA_PREFERENCE[wanted] ?? [wanted]) {
    const candidate = `/opt/java/openjdk-${major}/bin/java`;
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'java';
}

class ProcessManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();
  private startingLocks = new Set<string>();

  public getProcess(serverId: string): ManagedProcess | undefined {
    return this.processes.get(serverId);
  }

  public isRunning(serverId: string): boolean {
    const mp = this.processes.get(serverId);
    return mp !== undefined && mp.status !== 'OFFLINE';
  }

  public async ensureServerJar(serverDir: string, dto: CreateServerContainerDto): Promise<string> {
    flattenServerDir(serverDir);

    /*
     * LATEST resolved here, once, rather than in each download branch.
     *
     * Every API downstream wants a real version number: Fabric's meta answers HTTP 400 for
     * "LATEST", and the Forge promotions file has no such key. Resolving it at the single
     * point where the version is read means no branch can forget to.
     *
     * A failed lookup falls back to the string as given, so an offline node with a cached
     * jar still starts instead of being blocked by a manifest it did not need.
     */
    const mcVersion = (await resolveConcreteVersion(dto.mcVersion)) || dto.mcVersion || 'LATEST';
    const serverType = (dto.serverType || 'FABRIC').toUpperCase();
    const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
    const targetJarPath = path.join(serverDir, 'server.jar');

    /*
     * What the directory was last built as, read before anything overwrites it.
     *
     * This used to be merged first — `meta = { ...existing, ...meta }` with the requested
     * version on top — and then compared against the requested version to decide whether
     * the contents were stale. It never differed, because the merge had just made them
     * equal. The rescue below could not fire at all, which is why leftovers from a previous
     * loader kept being launched.
     */
    let existingMeta: any = {};
    if (fs.existsSync(metaPath)) {
      try {
        existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (e) {}
    }
    const recordedVersion = existingMeta.installedVersion || existingMeta.mcVersion;
    const recordedLoader = String(existingMeta.installedLoader || existingMeta.serverType || '').toUpperCase();

    // Always preserve / write metadata to ensure version is never lost on restart
    /*
     * installedVersion is deliberately absent here.
     *
     * It used to be set to the requested version up front, before anything had been
     * installed, and written to disk by the rescue below. So a run that asked for Forge
     * 1.12.2 and then failed still left metadata claiming Forge 1.12.2 was installed —
     * and the next run saw nothing stale in a directory still full of Fabric. It is now
     * written only where an install actually succeeds.
     */
    const meta: any = {
      ...existingMeta,
      mcVersion,
      serverType,
      serverPort: dto.serverPort,
    };

    /*
     * Clear what a previous loader or version left behind, before deciding what to launch.
     *
     * Moved ahead of the detection below, which is loader-blind and takes the first thing
     * it recognises: a fabric-server-launch.jar from an earlier attempt was picked for a
     * Forge server and started Fabric, which then died loading a Minecraft 26.2 bundler on
     * Java 8. Everything is renamed rather than deleted, for the same reason as always —
     * a guess about staleness is not grounds for destroying anyone's files.
     *
     * The world moves only when the Minecraft version changed. A loader change leaves it
     * alone: the preflight offers that separately, as a decision rather than a side effect.
     */
    const versionChanged = Boolean(recordedVersion && recordedVersion !== mcVersion);
    const loaderChanged = Boolean(recordedLoader && recordedLoader !== serverType);

    if (versionChanged || loaderChanged) {
      const reason = [
        versionChanged ? `version ${recordedVersion} -> ${mcVersion}` : null,
        loaderChanged ? `loader ${recordedLoader} -> ${serverType}` : null,
      ]
        .filter(Boolean)
        .join(', ');

      const rescueDir = path.join(serverDir, '.version_mismatch_rescue', `${recordedVersion || recordedLoader}_${Date.now()}`);
      console.log(`[ProcessManager] Server directory is stale (${reason}). Moving old build into '${rescueDir}'.`);
      fs.mkdirSync(rescueDir, { recursive: true });

      const stale = [
        'server.jar',
        'libraries',
        // Fabric's launcher and its marker directory. Left in place, these were preferred
        // over anything Forge produced.
        'fabric-server-launch.jar',
        'fabric-server-launcher.jar',
        'fabric-server-launcher.properties',
        '.fabric',
        // Launch scripts and args files, which name an absolute classpath for a build that
        // is no longer here.
        'run.sh',
        'run.bat',
        'user_args.txt',
        'unix_args.txt',
        'user_jvm_args.txt',
        ...(versionChanged ? ['world'] : []),
      ];

      for (const name of stale) {
        const src = path.join(serverDir, name);
        if (!fs.existsSync(src)) continue;
        try {
          fs.renameSync(src, path.join(rescueDir, name));
        } catch (e) {
          // Cross-device or lock: fall back to a recursive copy+remove so nothing is lost.
          fs.cpSync(src, path.join(rescueDir, name), { recursive: true });
          fs.rmSync(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
      }

      /*
       * Nothing is installed now — the build was just moved away — so the record says so.
       * Claiming the requested version here is what made the previous failure invisible.
       */
      delete meta.installedVersion;
      meta.installedLoader = serverType;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }

    // 1. Check for launch scripts (modpack preferred executables). A 0-byte run.sh is a
    // stray stub (e.g. left over from an earlier failed start) rather than a real script —
    // flattenServerDir above should have already replaced it if a real one existed nested,
    // but guard here too so we never hand bash an empty file and get a silent exit 0.
    const runShPath = path.join(serverDir, 'run.sh');
    if (fs.existsSync(runShPath) && fs.statSync(runShPath).size > 0) {
      console.log(`[ProcessManager] Using run.sh launch script`);
      return 'run.sh';
    }
    const runBatPath = path.join(serverDir, 'run.bat');
    if (fs.existsSync(runBatPath) && fs.statSync(runBatPath).size > 0) {
      console.log(`[ProcessManager] Using run.bat launch script`);
      return 'run.bat';
    }

    // 1b. If the archive's run.sh is missing/corrupt but an intact Forge/NeoForge
    // libraries/ tree survived, reconstruct run.sh from the installer's own args files.
    if ((serverType === 'FORGE' || serverType === 'NEOFORGE') && synthesizeForgeRunScript(serverDir, dto.memoryMb)) {
      return 'run.sh';
    }

    /*
     * 2. Loader-specific launch targets, each only for the loader that produces it.
     *
     * These used to be tested regardless of what the server was set to, so whichever
     * artefact happened to exist won. A Forge server with a leftover fabric-server-launch
     * .jar launched Fabric and reported the loader mismatch as a class-version error.
     */
    if (serverType === 'FABRIC' || serverType === 'QUILT') {
      if (fs.existsSync(path.join(serverDir, 'fabric-server-launch.jar'))) {
        return 'fabric-server-launch.jar';
      }
    }
    if (serverType === 'FORGE' || serverType === 'NEOFORGE') {
      if (fs.existsSync(path.join(serverDir, 'user_args.txt')) || fs.existsSync(path.join(serverDir, 'unix_args.txt'))) {
        return '@user_args.txt';
      }
    }

    /*
     * An existing server.jar, but only if it is the right kind of server.
     *
     * The name says nothing about what is inside. A Fabric download is written here as
     * server.jar, so a directory that once ran Fabric keeps a Fabric launcher under that
     * name — and this check, which used to be unconditional, started it for a Forge server.
     * The metadata could not catch it either, having already been rewritten to say Forge.
     * So the jar's own manifest is asked instead.
     */
    if (fs.existsSync(targetJarPath) && !(dto as any).forceRedownload) {
      if (jarSuitsLoader(targetJarPath, serverType)) {
        return 'server.jar';
      }
      const wrongLoader = jarLoader(targetJarPath);
      console.log(
        `[ProcessManager] server.jar is a ${wrongLoader} jar but this server is ${serverType}; ` +
          `setting it aside and installing ${serverType}.`
      );
      try {
        fs.renameSync(targetJarPath, path.join(serverDir, `.stale-${wrongLoader?.toLowerCase() || 'unknown'}-server.jar`));
      } catch {
        fs.rmSync(targetJarPath, { force: true });
      }
    }

    // Check if any other jar file exists in the root (e.g., fabric-server.jar, forge.jar, etc.)
    if (!fs.existsSync(targetJarPath)) {
      let rootJars = serverJarCandidates(serverDir, ['server.jar']);

      /*
       * Nothing runnable, but an installer sitting there.
       *
       * This is the normal shape of a Forge server pack that has never been started: the
       * installer is the only jar, and first boot is supposed to expand it. Taking it as
       * the server instead — which is what listing every .jar and using the first one did
       * — launches the installer's Swing wizard, and in a container with no display that
       * dies inside FontManagerFactory with a stack trace that names AWT, Swing and fonts
       * and never once names Forge.
       */
      if (rootJars.length === 0) {
        const installer = findForgeInstaller(serverDir);
        if (installer && runForgeInstaller(serverDir, installer)) {
          // Modern Forge installs a run.sh rather than a jar; prefer it if it appeared.
          const producedRunSh = path.join(serverDir, 'run.sh');
          if (fs.existsSync(producedRunSh) && fs.statSync(producedRunSh).size > 0) {
            console.log(`[ProcessManager] Installer produced run.sh, using it`);
            return 'run.sh';
          }
          rootJars = serverJarCandidates(serverDir, ['server.jar']);
        }
      }

      if (rootJars.length > 0) {
        console.log(`[ProcessManager] Using found jar file: ${rootJars[0]}`);
        return rootJars[0];
      }
    }

    // 3. Centralized Bundled & Persistent Cache Resolution
    const config = getConfig();
    const cacheDir = path.join(config.dataDir, 'cache', 'jars');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cacheFileName = `${serverType.toLowerCase()}-${mcVersion}.jar`;
    const cachedJarPath = path.join(cacheDir, cacheFileName);
    const bundledJarPath = path.join('/opt/minecraft-jars', cacheFileName);

    // Option A: Copy from persistent data cache if previously downloaded
    if (fs.existsSync(cachedJarPath)) {
      console.log(`[ProcessManager Cache Hit] Copying cached executable '${cacheFileName}' to server directory...`);
      fs.copyFileSync(cachedJarPath, targetJarPath);
      meta.installedVersion = mcVersion;
      meta.installedLoader = serverType;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      return 'server.jar';
    }

    // Option B: Copy from pre-bundled Docker image assets if available
    if (fs.existsSync(bundledJarPath)) {
      console.log(`[ProcessManager Bundled Hit] Copying pre-bundled executable '${cacheFileName}' to server directory...`);
      fs.copyFileSync(bundledJarPath, targetJarPath);
      fs.copyFileSync(bundledJarPath, cachedJarPath);
      meta.installedVersion = mcVersion;
      meta.installedLoader = serverType;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      return 'server.jar';
    }

    // Option C: Download from API once and save into central persistent cache
    console.log(`[ProcessManager Cache Miss] Pre-downloading server executable for ${serverType} (${mcVersion})...`);

    /*
     * Forge and NeoForge are installed, not downloaded.
     *
     * Handled before the URL table below because there is no single jar to fetch: the
     * installer has to run and build the server out of a libraries tree.
     */
    if (serverType === 'FORGE' || serverType === 'NEOFORGE') {
      const target = await installForgeServer(serverDir, serverType, mcVersion);
      if (!target) {
        // Deliberately fatal. Falling through from here is exactly what used to happen,
        // and it installed Fabric over a Forge modpack without a word.
        throw new Error(
          `Could not install ${serverType} for Minecraft ${mcVersion} on this node. ` +
            `Check that ${serverType} publishes a build for ${mcVersion}, and that this node can reach ` +
            `the internet.`
        );
      }
      meta.installedVersion = mcVersion;
      meta.installedLoader = serverType;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      return target;
    }

    try {
      let downloadUrl = '';
      if (serverType === 'FABRIC') {
        try {
          const fRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
          if (fRes.ok) {
            const fData = await fRes.json();
            const loaderVer = fData[0]?.loader?.version || '0.19.3';
            /*
             * The installer version comes from its own endpoint.
             *
             * fData[0].installer does not exist — the loader response carries only loader,
             * intermediary and launcherMeta — so this always fell back to the hardcoded
             * 1.0.1 while the current installer is 1.1.2. It happened to keep working, which
             * is why nobody noticed a version pinned years ago.
             */
            let installerVer = '1.1.2';
            try {
              const iRes = await fetch('https://meta.fabricmc.net/v2/versions/installer');
              if (iRes.ok) installerVer = (await iRes.json())[0]?.version || installerVer;
            } catch { /* the pinned default is a reasonable last resort */ }
            downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVer}/${installerVer}/server/jar`;
          } else {
            downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/0.19.3/1.0.1/server/jar`;
          }
        } catch (e) {
          downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/0.19.3/1.0.1/server/jar`;
        }
      } else if (serverType === 'PAPER') {
        const vRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}`);
        if (vRes.ok) {
          const vData = await vRes.json();
          const latestBuild = vData.builds[vData.builds.length - 1];
          downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${latestBuild}/downloads/paper-${mcVersion}-${latestBuild}.jar`;
        }
      } else if (serverType === 'PURPUR') {
        downloadUrl = `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest/download`;
      }

      if (serverType === 'VANILLA' || !downloadUrl) {
        /*
         * Vanilla, and anything else with no branch above.
         *
         * This line used to fetch a Fabric jar for every type it did not recognise, which
         * is how a Forge server came to be running Fabric. Vanilla now resolves properly
         * through Mojang's manifest, and an unrecognised type fails loudly instead of
         * quietly becoming a different server than the one that was asked for.
         */
        const vanillaUrl = await resolveVanillaJarUrl(mcVersion);
        if (!vanillaUrl) {
          throw new Error(
            `No download is known for a ${serverType} server on Minecraft ${mcVersion}. ` +
              `Check the version is spelled as Mojang publishes it.`
          );
        }
        downloadUrl = vanillaUrl;
      }

      const res = await fetch(downloadUrl);
      if (!res.ok) {
        throw new Error(`HTTP download failed with status ${res.status}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(cachedJarPath, buffer);
      fs.copyFileSync(cachedJarPath, targetJarPath);
      console.log(`[ProcessManager] Cached and installed server jar successfully (${buffer.length} bytes).`);

      meta.installedVersion = mcVersion;
      meta.installedLoader = serverType;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      return 'server.jar';
    } catch (err: any) {
      /*
       * Rethrown rather than swallowed.
       *
       * Returning 'server.jar' here meant a failed download launched whatever jar happened
       * to be lying around — or nothing at all — and the failure surfaced as a crash
       * minutes later, if at all. The start request should carry the reason.
       */
      console.error(`[ProcessManager] Could not obtain a server jar: ${err.message}`);
      throw new Error(`Could not download the ${serverType} server for Minecraft ${mcVersion}: ${err.message}`);
    }
  }

  /**
   * Refuses the launch when this node's Java is too old for the server.
   *
   * Throwing is what the caller wants: the start request returns the reason instead
   * of reporting success, and the FAILED status carries the same sentence to the
   * panel. Left to proceed, the spawn succeeds and the JVM dies moments later with
   * an UnsupportedClassVersionError stack trace — which reads as a crash, not as a
   * node that was never able to run this.
   */
  /**
   * Refuses to start a modpack under the wrong loader.
   *
   * Reported through the same channel as the Java check, because it is the same kind of
   * problem: knowable before launch, and invisible afterwards. See loaderMismatch for why
   * this one is worse than a crash.
   */
  private assertLoaderMatches(serverId: string, serverDir: string, serverType?: string): void {
    const problem = loaderMismatch(serverDir, serverType);
    if (!problem) return;

    console.error(`[ProcessManager] Cannot start '${serverId}': ${problem}`);
    provisioningManager.emit('status', { serverId, status: STATUS.FAILED, error: problem });
    throw new Error(problem);
  }

  private async assertJavaCanRun(
    serverId: string,
    javaCmd: string,
    mcVersion?: string,
    loader?: string
  ): Promise<void> {
    const problem = await javaVersionProblem(javaCmd, mcVersion, loader);
    if (!problem) return;

    const message = `Cannot start '${serverId}': ${problem}`;
    console.error(`[ProcessManager] ${message}`);
    provisioningManager.emit('status', {
      serverId,
      status: STATUS.FAILED,
      error: problem,
    });
    throw new Error(problem);
  }

  public async startProcess(dto: CreateServerContainerDto): Promise<void> {
    // Touch point 1 of 2 (plan.md §2). Everything below this guard is the
    // original Minecraft body, unchanged. `dto.game` is absent or MINECRAFT for
    // every Minecraft server — including ones whose meta.json predates the
    // field — so Minecraft never enters the branch.
    if (isNonMinecraftGame(dto.game)) {
      return this.startGameProcess(dto);
    }

    if (this.isRunning(dto.serverId) || this.startingLocks.has(dto.serverId)) {
      console.log(`[ProcessManager] Server process '${dto.serverId}' is ALREADY running or starting. Skipping duplicate spawn.`);
      return;
    }

    this.startingLocks.add(dto.serverId);

    try {

    const config = getConfig();
    const serverDir = path.join(config.dataDir, dto.serverId);

    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    // Ensure EULA and server.properties setup
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
    
    // dto.serverPort is always authoritative — always write it to server.properties
    // so the MC server starts on the correct port regardless of what the backup had.
    const propsPath = path.join(serverDir, 'server.properties');
    const effectivePort = dto.serverPort || 25565;

    if (!fs.existsSync(propsPath)) {
      fs.writeFileSync(
        propsPath,
        `server-ip=0.0.0.0\nserver-port=${effectivePort}\nquery.port=${effectivePort}\nenable-rcon=false\n`
      );
    } else {
      let content = fs.readFileSync(propsPath, 'utf8');
      if (content.includes('server-ip=')) {
        content = content.replace(/^server-ip=.*/m, 'server-ip=0.0.0.0');
      } else {
        content += '\nserver-ip=0.0.0.0';
      }
      // Always overwrite the port with the configured value
      if (content.match(/^server-port=\d+/m)) {
        content = content.replace(/^server-port=\d+/m, `server-port=${effectivePort}`);
      } else {
        content += `\nserver-port=${effectivePort}`;
      }
      if (content.match(/^query\.port=\d+/m)) {
        content = content.replace(/^query\.port=\d+/m, `query.port=${effectivePort}`);
      }
      fs.writeFileSync(propsPath, content);
    }

    const jarOrArgs = await this.ensureServerJar(serverDir, dto);

    // Forcefully clear any stray process holding the port on host immediately prior to spawn
    try {
      execSync(`fuser -k -9 ${effectivePort}/tcp 2>/dev/null || true`);
      execSync(`lsof -ti:${effectivePort} | xargs -r kill -9 2>/dev/null || true`);
    } catch (e) {}

    // Short pause for Linux kernel TCP socket TIME_WAIT release
    await new Promise((r) => setTimeout(r, 1000));

    let child: ChildProcess;

    // Handle launch scripts (run.sh, run.bat)
    if (jarOrArgs === 'run.sh' || jarOrArgs === 'run.bat') {
      console.log(`[ProcessManager] Spawning launch script for server ${dto.serverId} in '${serverDir}': ${jarOrArgs}`);
      // Make run.sh executable if it exists
      if (jarOrArgs === 'run.sh') {
        try {
          execSync(`chmod +x "${path.join(serverDir, 'run.sh')}"`);
        } catch (e) {}

        // Strip Windows CRLF line endings from run.sh — when uploaded from a Windows
        // system, \r\n endings cause bash to interpret each command as "command\r" which
        // isn't found, so the script exits silently with code 0 producing no output.
        const runShPath = path.join(serverDir, 'run.sh');
        try {
          const raw = fs.readFileSync(runShPath, 'utf8');
          if (raw.includes('\r')) {
            console.log(`[ProcessManager] Detected CRLF in run.sh — stripping to LF...`);
            fs.writeFileSync(runShPath, raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
          }
          // Log first few lines of run.sh for debugging
          const preview = raw.replace(/\r/g, '').split('\n').slice(0, 5).join(' | ');
          console.log(`[ProcessManager] run.sh preview: ${preview}`);
        } catch (e) {}

        // Also strip CRLF from user_jvm_args.txt and unix_args.txt if present
        for (const argFile of ['user_jvm_args.txt', 'unix_args.txt', 'user_args.txt']) {
          const argFilePath = path.join(serverDir, argFile);
          if (fs.existsSync(argFilePath)) {
            try {
              const raw = fs.readFileSync(argFilePath, 'utf8');
              if (raw.includes('\r')) {
                fs.writeFileSync(argFilePath, raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
                console.log(`[ProcessManager] Stripped CRLF from ${argFile}`);
              }
            } catch (e) {}
          }
        }
      }

      // Resolve the correct Java binary for this server's MC version and inject it into PATH.
      // Modpack run.sh scripts call `java` directly and will silently fail (exit 0) if
      // the binary isn't discoverable on PATH.
      const metaPathForScript = path.join(serverDir, 'craftcontrol-meta.json');
      let scriptMcVersion = dto.mcVersion || '1.20.1';
      if (fs.existsSync(metaPathForScript)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPathForScript, 'utf8'));
          scriptMcVersion = meta.installedVersion || meta.mcVersion || scriptMcVersion;
        } catch (e) {}
      }
      const resolvedJavaCmd = resolveJavaCmd(scriptMcVersion, dto.serverType);
      this.assertLoaderMatches(dto.serverId, serverDir, dto.serverType);
      await this.assertJavaCanRun(dto.serverId, resolvedJavaCmd, scriptMcVersion, dto.serverType);
      const javaDir = path.dirname(resolvedJavaCmd);
      const javaHome = path.dirname(javaDir); // e.g. /opt/java/openjdk-21
      const augmentedPath = `${javaDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
      console.log(`[ProcessManager] Injecting JAVA_HOME=${javaHome} and java dir ${javaDir} into PATH for run.sh`);

      // Strip the trailing empty arg — bash interprets argv[0] as script name when called as `bash <script>`
      const scriptArgs = jarOrArgs === 'run.sh' ? ['run.sh'] : ['/c', 'run.bat'];
      child = spawn(jarOrArgs === 'run.sh' ? '/bin/bash' : 'cmd.exe',
        scriptArgs,
        {
          cwd: serverDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: augmentedPath,
            JAVA_HOME: javaHome,
          },
        }
      );
    } else {
      // Handle Java jar files
      const memoryMb = dto.memoryMb || 4096;
      let javaArgs: string[] = [
        `-Xmx${memoryMb}M`,
        `-Xms1024M`,
        `-Dfile.encoding=UTF-8`,
        `-Djava.awt.headless=true`,
        `-Djava.net.preferIPv4Stack=true`,
      ];

      if (jarOrArgs === '@user_args.txt') {
        javaArgs.push('@user_args.txt', 'nogui');
      } else {
        javaArgs.push('-jar', jarOrArgs, 'nogui');
      }

      const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
      let effectiveMcVersion = dto.mcVersion || '26.2';
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          effectiveMcVersion = meta.installedVersion || meta.mcVersion || effectiveMcVersion;
        } catch (e) {}
      }

      const javaCmd = resolveJavaCmd(effectiveMcVersion, dto.serverType);
      this.assertLoaderMatches(dto.serverId, serverDir, dto.serverType);
      await this.assertJavaCanRun(dto.serverId, javaCmd, effectiveMcVersion, dto.serverType);
      console.log(`[ProcessManager] Spawning standalone Java process using '${javaCmd}' for server ${dto.serverId} in '${serverDir}': ${javaCmd} ${javaArgs.join(' ')}`);

      child = spawn(javaCmd, javaArgs, {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
        },
      });
    }

    const mp: ManagedProcess = {
      serverId: dto.serverId,
      process: child,
      status: 'STARTING',
      logBuffer: [],
      startedAt: new Date(),
      onlinePlayers: new Set<string>(),
      statsHistory: [],
    };

    this.processes.set(dto.serverId, mp);

    // NOTE: Process-mode servers run directly on --network host and are already
    // reachable without tunneling. Registering an FRP tunnel would cause frps to
    // bind to the same port as the MC server, creating an "address already in use"
    // conflict. FRP tunnels are only used for Docker-container-mode servers.
    // (No tunnel registration here)

    /*
     * A server that cannot be launched is a failed server, not a failed node.
     *
     * Both spawn paths above run an interpreter this machine may simply not have —
     * java, or bash on a Windows node. Unhandled, that arrives as an 'error' event
     * with no listener, which throws and takes the daemon down along with every other
     * server it was hosting. Report it the same way any other start failure is
     * reported, so the panel shows why.
     */
    child.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? `Could not start '${dto.serverId}': the runtime it needs is not installed on this node (${err.path ?? 'command not found'}).`
          : `Could not start '${dto.serverId}': ${err.message}`;
      console.error(`[ProcessManager] ${message}`);
      mp.status = 'OFFLINE';
      provisioningManager.emit('status', {
        serverId: dto.serverId,
        status: STATUS.FAILED,
        error: message,
      });
    });

    const handleData = (data: Buffer) => {
      const text = data.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        
        mp.logBuffer.push(line);
        if (mp.logBuffer.length > 300) mp.logBuffer.shift();

        this.emit('log', { serverId: dto.serverId, line, type: 'stdout' });

        /*
         * The preflight check catches the common case before launching, but not every
         * one: a modpack's run.sh can call its own java, and a jar can bundle a library
         * built for something newer than itself. Where that happens the trace still
         * arrives, so translate it in place — the numbers in it are class-file
         * versions, which are not the Java versions anyone would recognise.
         */
        const classVersionHint = explainClassVersionError(line);
        if (classVersionHint) {
          const hint = `[CraftControl] ${classVersionHint}`;
          mp.logBuffer.push(hint);
          this.emit('log', { serverId: dto.serverId, line: hint, type: 'stdout' });
          console.error(`[ProcessManager] ${dto.serverId}: ${classVersionHint}`);
        }

        // Player Join Detection
        const joinMatch = line.match(/(?:\[.*\]:?\s*)?([a-zA-Z0-9_]{2,16}) (?:joined the game|logged in with entity id)/i);
        if (joinMatch) {
          const username = joinMatch[1];
          mp.onlinePlayers.add(username);
          console.log(`[PlayerManager] Player joined on server ${dto.serverId}: ${username}`);
        }

        // Player Leave Detection
        const leaveMatch = line.match(/(?:\[.*\]:?\s*)?([a-zA-Z0-9_]{2,16}) (?:left the game|lost connection)/i);
        if (leaveMatch) {
          const username = leaveMatch[1];
          mp.onlinePlayers.delete(username);
          console.log(`[PlayerManager] Player left server ${dto.serverId}: ${username}`);
        }

        if (line.includes('Done (') && line.includes(')! For help, type "help"')) {
          mp.status = 'RUNNING';
          provisioningManager.emit('status', {
            serverId: dto.serverId,
            status: STATUS.RUNNING,
            reason: 'Standalone process booted cleanly',
          });
        }
      }
    };

    if (child.stdout) child.stdout.on('data', handleData);
    if (child.stderr) child.stderr.on('data', handleData);

    child.on('error', (err) => {
      console.error(`[ProcessManager Fatal] Child process error on server ${dto.serverId}:`, err.message);
      mp.status = 'OFFLINE';
      this.processes.delete(dto.serverId);
      provisioningManager.emit('status', {
        serverId: dto.serverId,
        status: STATUS.FAILED,
        error: err.message,
      });
    });

    child.on('close', (code) => {
      console.log(`[ProcessManager] Standalone process for server ${dto.serverId} exited with code ${code}`);
      mp.status = 'OFFLINE';
      this.processes.delete(dto.serverId);
      // Emitted rather than calling the presence service directly: process.ts is imported by
      // presence.ts, and reaching back the other way would make the cycle load-order sensitive.
      this.emit('exit', { serverId: dto.serverId, code });
      tunnelManager.removeTunnel(dto.serverId).catch(() => {});
      provisioningManager.emit('status', {
        serverId: dto.serverId,
        status: STATUS.OFFLINE,
        reason: `Process exited with code ${code}`,
      });
    });
    } finally {
      this.startingLocks.delete(dto.serverId);
    }
  }

  /**
   * Start a server for a game other than Minecraft.
   *
   * Lives alongside `startProcess` rather than sharing it. The duplication that
   * lands here in Phase 3 (~40 lines: the starting lock, the port clear, the
   * spawn, the stdout wiring) is deliberate — deduplicating it would mean
   * editing the Minecraft path, which plan.md §2 forbids. Revisit at game
   * three, not before.
   *
   * Reuses `writeStdin`, `getProcessStats`, `killProcess`, the `processes` map,
   * the log ring buffer and the `log`/`exit` events exactly as they are — all
   * of those are already game-neutral.
   */
  private async startGameProcess(dto: CreateServerContainerDto): Promise<void> {
    const definition = getGame(dto.game);

    if (!definition) {
      const message =
        `This node has no support installed for ${dto.game}. ` +
        `Its game module is not registered on this daemon.`;
      console.error(`[ProcessManager] Cannot start '${dto.serverId}': ${message}`);
      provisioningManager.emit('status', {
        serverId: dto.serverId,
        status: STATUS.FAILED,
        error: message,
      });
      throw new Error(message);
    }

    if (this.isRunning(dto.serverId) || this.startingLocks.has(dto.serverId)) {
      console.log(`[ProcessManager] Server process '${dto.serverId}' is ALREADY running or starting. Skipping duplicate spawn.`);
      return;
    }

    this.startingLocks.add(dto.serverId);

    let readyTimer: NodeJS.Timeout | undefined;

    try {
      const config = getConfig();
      const serverDir = path.join(config.dataDir, dto.serverId);
      if (!fs.existsSync(serverDir)) {
        fs.mkdirSync(serverDir, { recursive: true });
      }

      const spec = {
        serverId: dto.serverId,
        serverPort: dto.serverPort || 7777,
        memoryMb: dto.memoryMb || definition.defaults.memoryMb,
        cpuLimit: dto.cpuLimit || definition.defaults.cpuLimit,
        gameConfig: dto.gameConfig,
      };

      const binaryPath = await definition.ensureBinary(serverDir, spec);

      // One-time setup such as world generation. Its progress is forwarded to
      // the console so a first start that takes a minute does not look wedged.
      if (definition.prepareWorld) {
        await definition.prepareWorld(serverDir, binaryPath, spec, (line) => {
          console.log(`[${definition.label}] ${dto.serverId}: ${line}`);
          this.emit('log', { serverId: dto.serverId, line, type: 'stdout' });
        });
      }

      // Must happen before the spawn, every time — not only on first create.
      // A Terraria server whose config is incomplete hangs at an interactive
      // prompt forever rather than failing. See plan.md §6.
      await definition.prepareServerDir(serverDir, spec);

      // Same pre-spawn port clear the Minecraft path does.
      try {
        execSync(`fuser -k -9 ${spec.serverPort}/tcp 2>/dev/null || true`);
        execSync(`lsof -ti:${spec.serverPort} | xargs -r kill -9 2>/dev/null || true`);
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 1000));

      const launch = definition.buildLaunch(serverDir, binaryPath, spec);
      console.log(
        `[ProcessManager] Spawning ${definition.label} process for server ${dto.serverId}: ` +
        `${launch.command} ${launch.args.join(' ')}`
      );

      // No `cwd` is passed on purpose. MonoKickstart chdir's to its own
      // directory during startup, so setting one here would be a lie — every
      // path the game module writes into its config is absolute for exactly
      // that reason.
      const child = spawn(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(launch.env || {}) },
      });

      const mp: ManagedProcess = {
        serverId: dto.serverId,
        process: child,
        status: 'STARTING',
        logBuffer: [],
        startedAt: new Date(),
        onlinePlayers: new Set<string>(),
        statsHistory: [],
        // This is what makes stopProcess send `exit` instead of `stop`.
        stopCommand: definition.stopCommand,
      };

      this.processes.set(dto.serverId, mp);

      // Same reasoning as the Minecraft path: a game binary this machine does not
      // have must fail this server, not the daemon hosting the others.
      child.on('error', (err: NodeJS.ErrnoException) => {
        const message =
          err.code === 'ENOENT'
            ? `${definition.label} could not start: '${launch.command}' is not installed on this node.`
            : `${definition.label} could not start: ${err.message}`;
        console.error(`[ProcessManager] ${message} (${dto.serverId})`);
        if (readyTimer) clearTimeout(readyTimer);
        mp.status = 'OFFLINE';
        provisioningManager.emit('status', {
          serverId: dto.serverId,
          status: STATUS.FAILED,
          error: message,
        });
      });

      // The hang this guards against produces no output at all, so a timer is
      // the only thing that can detect it. Fail loudly rather than leaving a
      // server wedged in STARTING forever.
      readyTimer = setTimeout(() => {
        if (mp.status !== 'STARTING') return;
        const message =
          `${definition.label} server did not report ready within ` +
          `${Math.round(definition.readyTimeoutMs / 1000)}s. It may be stuck at an interactive prompt.`;
        console.error(`[ProcessManager] ${message} (${dto.serverId})`);
        provisioningManager.emit('status', {
          serverId: dto.serverId,
          status: STATUS.FAILED,
          error: message,
        });
        try { child.kill('SIGKILL'); } catch (e) {}
      }, definition.readyTimeoutMs);

      const handleData = (data: Buffer) => {
        const text = data.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          // Dropped before anything else sees it. World generation emits tens of
          // thousands of progress lines in seconds and would otherwise evict
          // every real startup line from a 300-line buffer. See plan.md §6.
          if (definition.isNoiseLine(line)) continue;
          if (!line.trim()) continue;

          mp.logBuffer.push(line);
          if (mp.logBuffer.length > 300) mp.logBuffer.shift();

          this.emit('log', { serverId: dto.serverId, line, type: 'stdout' });

          const presence = definition.parsePresenceLine(line);
          if (presence) {
            if (presence.type === 'join') {
              mp.onlinePlayers.add(presence.username);
              console.log(`[PlayerManager] Player joined on server ${dto.serverId}: ${presence.username}`);
            } else {
              mp.onlinePlayers.delete(presence.username);
              console.log(`[PlayerManager] Player left server ${dto.serverId}: ${presence.username}`);
            }
          }

          if (mp.status === 'STARTING' && definition.isReadyLine(line)) {
            mp.status = 'RUNNING';
            if (readyTimer) clearTimeout(readyTimer);
            provisioningManager.emit('status', {
              serverId: dto.serverId,
              status: STATUS.RUNNING,
              reason: `${definition.label} process booted cleanly`,
            });
          }
        }
      };

      if (child.stdout) child.stdout.on('data', handleData);
      if (child.stderr) child.stderr.on('data', handleData);

      child.on('error', (err) => {
        console.error(`[ProcessManager Fatal] Child process error on server ${dto.serverId}:`, err.message);
        if (readyTimer) clearTimeout(readyTimer);
        mp.status = 'OFFLINE';
        this.processes.delete(dto.serverId);
        provisioningManager.emit('status', {
          serverId: dto.serverId,
          status: STATUS.FAILED,
          error: err.message,
        });
      });

      child.on('close', (code) => {
        console.log(`[ProcessManager] ${definition.label} process for server ${dto.serverId} exited with code ${code}`);
        if (readyTimer) clearTimeout(readyTimer);
        mp.status = 'OFFLINE';
        this.processes.delete(dto.serverId);
        this.emit('exit', { serverId: dto.serverId, code });
        provisioningManager.emit('status', {
          serverId: dto.serverId,
          status: STATUS.OFFLINE,
          reason: `Process exited with code ${code}`,
        });
      });
    } catch (err: any) {
      if (readyTimer) clearTimeout(readyTimer);
      console.error(`[ProcessManager] Failed to start ${dto.game} server ${dto.serverId}:`, err.message);
      provisioningManager.emit('status', {
        serverId: dto.serverId,
        status: STATUS.FAILED,
        error: err.message,
      });
      throw err;
    } finally {
      this.startingLocks.delete(dto.serverId);
    }
  }

  public writeStdin(serverId: string, command: string): boolean {
    const mp = this.processes.get(serverId);
    if (!mp || !mp.process || mp.process.killed) return false;

    try {
      mp.process.stdin?.write(`${command}\n`);
      return true;
    } catch (e: any) {
      console.warn(`[ProcessManager Write Error] ${e.message}`);
      return false;
    }
  }

  public async stopProcess(serverId: string): Promise<void> {
    const mp = this.processes.get(serverId);
    if (!mp || !mp.process) return;

    mp.status = 'STOPPING';
    console.log(`[ProcessManager] Stopping standalone process for server ${serverId}...`);

    // Touch point 2 of 2 (plan.md §2). The `?? 'stop'` is what keeps this a
    // no-op for Minecraft: the Minecraft path never populates stopCommand.
    this.writeStdin(serverId, mp.stopCommand ?? 'stop');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.processes.has(serverId)) {
          console.warn(`[ProcessManager] Force killing unresponsive server process ${serverId}...`);
          try { mp.process.kill('SIGKILL'); } catch (e) {}
          this.processes.delete(serverId);
        }
        resolve();
      }, 15000);

      mp.process.on('close', () => {
        clearTimeout(timeout);
        this.processes.delete(serverId);
        resolve();
      });
    });
  }

  public getOnlinePlayers(serverId: string): Array<{ username: string; isOp: boolean; avatarUrl: string }> {
    const mp = this.processes.get(serverId);
    if (!mp) return [];

    const serverDir = path.join(getConfig().dataDir, serverId);
    const opsPath = path.join(serverDir, 'ops.json');
    const opsSet = new Set<string>();

    if (fs.existsSync(opsPath)) {
      try {
        const opsData = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
        if (Array.isArray(opsData)) {
          opsData.forEach((op: any) => {
            if (op.name) opsSet.add(op.name.toLowerCase());
          });
        }
      } catch (e) {}
    }

    // mc-heads renders Minecraft skins, so for any other game it would return a
    // default Steve head for a player who has no Minecraft account at all. An
    // empty url makes the panel fall back to initials instead.
    const isMinecraft = !isNonMinecraftGame(gameOfServer(serverId));

    return Array.from(mp.onlinePlayers).map((username) => ({
      username,
      isOp: isMinecraft && opsSet.has(username.toLowerCase()),
      avatarUrl: isMinecraft ? `https://mc-heads.net/avatar/${username}/64` : '',
    }));
  }

  public getProcessStats(serverId: string): { cpuPercent: number; memoryMb: number; history: Array<{ timestamp: string; cpuPercent: number; memoryMb: number }> } {
    const mp = this.processes.get(serverId);
    if (!mp) {
      return { cpuPercent: 0, memoryMb: 0, history: [] };
    }

    // Attempt RSS memory and CPU sampling
    let cpuPercent = 0;
    let memoryMb = 0;

    if (mp.process && mp.process.pid) {
      try {
        const statStr = execSync(`ps -p ${mp.process.pid} -o %cpu,rss --no-headers 2>/dev/null || true`).toString().trim();
        if (statStr) {
          const parts = statStr.split(/\s+/);
          if (parts.length >= 2) {
            cpuPercent = parseFloat(parts[0]) || 0;
            memoryMb = Math.round((parseInt(parts[1], 10) || 0) / 1024);
          }
        }
      } catch (e) {}
    }

    const currentPoint = {
      timestamp: new Date().toLocaleTimeString(),
      cpuPercent,
      memoryMb,
    };

    mp.statsHistory.push(currentPoint);
    if (mp.statsHistory.length > 20) mp.statsHistory.shift();

    return {
      cpuPercent,
      memoryMb,
      history: mp.statsHistory,
    };
  }

  public async killProcess(serverId: string): Promise<void> {
    const mp = this.processes.get(serverId);
    if (!mp || !mp.process) return;

    console.log(`[ProcessManager] Force killing standalone process ${serverId}...`);
    try { mp.process.kill('SIGKILL'); } catch (e) {}
    this.processes.delete(serverId);
    await tunnelManager.removeTunnel(serverId).catch(() => {});
  }
}

export const processManager = new ProcessManager();
