import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

export const dynamic = 'force-dynamic';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Walks the whole path from panel to BlueMap and reports the first thing that is wrong,
 * so "Map is offline" stops being a dead end.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: { node: true },
  });
  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const checks: Check[] = [];
  const targetContainerId = server.containerId || `process-${server.id}`;
  const isProcessMode = targetContainerId.startsWith('process-');
  const client = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });

  // 1. Panel-side configuration
  checks.push({
    name: 'Map enabled in panel',
    ok: server.bluemapEnabled,
    detail: server.bluemapEnabled ? 'Enabled' : 'BlueMap has not been installed from the World Map tab yet.',
  });
  checks.push({
    name: 'Map port allocated',
    ok: server.bluemapPort != null,
    detail: server.bluemapPort ? `Host port ${server.bluemapPort}` : 'No port allocated — install BlueMap first.',
  });
  checks.push({
    name: 'Server running',
    ok: server.status === 'RUNNING',
    detail: `Panel status: ${server.status}. BlueMap only serves the map while the server is up.`,
  });

  // 2. Daemon-side reality
  let probe: any = null;
  try {
    const query = new URLSearchParams({ hostPort: String(server.bluemapPort || '') });
    probe = await client.request<any>(`/servers/${targetContainerId}/bluemap/probe?${query}`);
  } catch (err: any) {
    checks.push({ name: 'Daemon reachable', ok: false, detail: err.message });
  }

  if (probe) {
    checks.push({ name: 'Daemon reachable', ok: true, detail: `${server.node.host}:${server.node.port}` });

    if (!isProcessMode) {
      const published = probe.publishedMapPort;
      checks.push({
        name: 'Container publishes map port',
        ok: published != null,
        detail:
          published != null
            ? `8100/tcp → ${published}`
            : `Container publishes only ${(probe.portBindings || []).join(', ') || 'nothing'}. ` +
              'Run the one-time container rebuild in the World Map tab (server must be stopped).',
      });
    }

    checks.push({
      name: 'Something listening on map port',
      ok: !!probe.listening,
      detail: probe.listening
        ? `Accepting connections on port ${probe.publishedMapPort || server.bluemapPort}`
        : probe.listenError ||
          'Nothing is listening. BlueMap may not have loaded — check the console for BlueMap startup lines.',
    });

    if (probe.renderedMaps !== null && probe.renderedMaps !== undefined) {
      checks.push({
        name: 'Map data rendered',
        ok: probe.renderedMaps > 0,
        detail:
          probe.renderedMaps > 0
            ? `${probe.renderedMaps} map(s) present in the BlueMap webroot`
            : 'BlueMap has not written any map data yet. It renders in the background after the server starts — ' +
              'on a large world the first pass can take hours. Until then the BlueMap UI shows ' +
              '"There was an error trying to load this map!".',
      });
    }
  }

  // 3. The exact request the public share link makes
  if (server.bluemapPort) {
    const upstream = `http://${server.node.host}:${server.bluemapPort}/`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(upstream, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);

      checks.push({
        name: 'Panel can fetch the map',
        ok: res.ok,
        detail: `${upstream} → HTTP ${res.status}`,
      });
    } catch (err: any) {
      const reason = err?.name === 'AbortError' ? 'timed out after 5s' : err?.message || 'unknown error';
      checks.push({
        name: 'Panel can fetch the map',
        ok: false,
        detail:
          `${upstream} → ${reason}. If the daemon says the port IS listening, the web container cannot ` +
          'reach the node over the network (Docker network isolation).',
      });
    }
  }

  // 4. When the server isn't up, the map can never work — the useful answer is *why*
  let crashLog: string[] = [];
  let crashHint: string | null = null;

  if (server.status !== 'RUNNING') {
    try {
      const tail = await client.request<{ lines: string[] }>(
        `/servers/${targetContainerId}/logs/tail?lines=80`
      );
      crashLog = tail.lines || [];
      crashHint = detectCrashCause(crashLog);
    } catch {
      // Log tail is best-effort
    }
  }

  const firstFailure = checks.find((c) => !c.ok);

  return NextResponse.json({
    checks,
    summary: firstFailure ? firstFailure.detail : 'All checks passed — the map should load.',
    healthy: !firstFailure,
    crashLog,
    crashHint,
  });
}

/** Turns common startup failures into a plain-language cause. */
function detectCrashCause(lines: string[]): string | null {
  const text = lines.join('\n');

  // Fabric names the unmet dependency explicitly — quote it back rather than guessing
  const hardDep = text.match(/HARD_DEP_NO_CANDIDATE\s+(\S+)[^{]*\{depends\s+([\w-]+)/i);
  if (hardDep) {
    const [, mod, missing] = hardDep;
    const isFabricApi = /^fabric-api(-base)?$/i.test(missing);
    return (
      `'${mod}' needs '${missing}', which is not installed, so the whole server refuses to start. ` +
      (isFabricApi
        ? 'That module ships inside Fabric API — install "Fabric API" from the Mod Browser tab, or reinstall BlueMap so it pulls the dependency in automatically.'
        : `Install '${missing}' from the Mod Browser tab, then start the server again.`)
    );
  }

  if (/fabric-?api|Fabric API/i.test(text) && /(requires|missing|not installed)/i.test(text)) {
    return 'BlueMap on Fabric requires the Fabric API mod, which is not installed. Install "Fabric API" from the Mod Browser tab, then start the server again.';
  }
  if (/Incompatible mods found|Mod resolution failed/i.test(text)) {
    return 'Fabric could not resolve the installed mod set. The console lines below name the offending mod and what it needs — the usual cause is a mod built for a different Minecraft version.';
  }
  if (/requires minecraft|Incompatible mod set|unsupported.*version/i.test(text)) {
    return 'A mod failed version resolution — most likely a build that does not match this Minecraft version. Uninstall it from the World Map or Mod Browser tab and check the console for the exact mismatch.';
  }
  if (/java\.lang\.OutOfMemoryError|Out of memory/i.test(text)) {
    return 'The server ran out of memory. Raise the memory limit before retrying.';
  }
  if (/Address already in use|BindException/i.test(text)) {
    return 'A port is already in use — likely BlueMap\'s map port clashing with something else on the node.';
  }
  if (/You need to agree to the EULA/i.test(text)) {
    return 'The Minecraft EULA has not been accepted for this server.';
  }
  if (/Unsupported class file major version|UnsupportedClassVersionError/i.test(text)) {
    return 'Java version mismatch — this server or mod needs a different Java runtime than the node provides.';
  }
  return null;
}
