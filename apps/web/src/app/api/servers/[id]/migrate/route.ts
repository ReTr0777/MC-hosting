import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { CreateServerContainerDto, javaSupportViolation } from '@mc-manager/shared';
import { VelocityClient } from '@/lib/services/velocity-client';
import { writeAudit } from '@/lib/audit';
import { nodeCapacity, capacityViolation } from '@/lib/servers/node-capacity';

async function updateLimboTitle(title: string, subtitle: string) {
  try {
    const proxyUrl = process.env.PROXY_API_URL || 'http://proxy:3001';
    await fetch(`${proxyUrl}/api/players/title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'nanolimbo', title, subtitle })
    });
  } catch (e) {
    console.warn(`[Migration] Failed to update Limbo title:`, e);
  }
}

/**
 * A migration stopped on purpose, with the source copy still intact. Distinct from an
 * unexpected throw only in what it says — both land in the same handler, which keeps
 * the server on its original node either way.
 */
class MigrationAborted extends Error {}

interface TransferStats {
  files: number;
  bytes: number;
}

/**
 * The two counts from a daemon, or null when either is missing or nonsense.
 *
 * Null means "this end cannot tell me", which is what a daemon older than this feature
 * reports, and it must stay distinguishable from zero — a server directory genuinely
 * containing nothing is a different situation from one nobody counted.
 */
function readStats(files: unknown, bytes: unknown): TransferStats | null {
  const f = Number(files);
  const b = Number(bytes);
  if (!Number.isFinite(f) || !Number.isFinite(b) || f < 0 || b < 0) return null;
  return { files: f, bytes: b };
}

/** How long to let a destination provision before giving up on it. */
const PROVISION_TIMEOUT_MS = 10 * 60_000;
const PROVISION_POLL_MS = 3_000;

/**
 * Waits until the destination has finished turning the imported files into a server.
 *
 * Returns true when it confirmed success, false when the node is too old to have the
 * endpoint — in which case the caller keeps the source copy rather than trusting a
 * silence. Throws when provisioning actually failed, or when the directory is not
 * there at all, since both mean the destination does not have a working server.
 */
async function waitForProvisioning(
  node: { host: string; port: number; apiKey: string; name: string },
  serverId: string
): Promise<boolean> {
  const url = `http://${node.host}:${node.port}/api/v1/servers/${serverId}/verify`;
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let state: any;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${node.apiKey}` } });
      // An older daemon has no such route. Nothing to wait for and nothing to trust.
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state = await res.json();
    } catch (e: any) {
      // A node that drops out mid-provision has not finished, and the source copy is
      // the only thing standing between that and a lost world.
      throw new MigrationAborted(
        `Destination node "${node.name}" stopped responding while provisioning (${e.message}). ` +
          `The source copy has been left untouched.`
      );
    }

    if (state?.provisioning) {
      await new Promise((r) => setTimeout(r, PROVISION_POLL_MS));
      continue;
    }

    if (state?.provisionOk === false) {
      throw new MigrationAborted(
        `Destination node "${node.name}" failed to provision the server: ${state.provisionError || 'no reason given'}. ` +
          `The source copy has been left untouched.`
      );
    }
    if (!state?.exists) {
      throw new MigrationAborted(
        `Destination node "${node.name}" has no data for this server after the import. ` +
          `The source copy has been left untouched.`
      );
    }

    // provisionOk undefined means the node never ran provisioning for this server —
    // the import created no container, which the panel cannot call a success.
    return state.provisionOk === true;
  }

  throw new MigrationAborted(
    `Destination node "${node.name}" was still provisioning after ${PROVISION_TIMEOUT_MS / 60_000} minutes. ` +
      `The source copy has been left untouched.`
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { destinationNodeId } = await req.json();
    if (!destinationNodeId) {
      return NextResponse.json({ error: 'Destination node ID is required' }, { status: 400 });
    }

    const server = await prisma.server.findUnique({
      where: { id: params.id },
      include: {
        node: true,
        permissions: {
          where: { userId: user.userId }
        }
      }
    });

    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    if (user.globalRole !== 'GLOBAL_ADMIN') {
      const perm = server.permissions[0];
      if (!perm || (perm.role !== 'OWNER' && perm.role !== 'ADMIN')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    if (server.nodeId === destinationNodeId) {
      return NextResponse.json({ error: 'Server is already on the destination node' }, { status: 400 });
    }

    const destNode = await prisma.node.findUnique({ where: { id: destinationNodeId } });
    if (!destNode) {
      return NextResponse.json({ error: 'Destination node not found' }, { status: 404 });
    }

    // Migration moves the server's whole allocation onto another machine, so it is a capacity
    // decision like creating one. Checked before the transfer starts — discovering the
    // destination is full after streaming a 20 GB world across the network helps nobody.
    // excludeServerId is harmless here (the server is on the source node) but keeps the call
    // honest if a retry runs after the nodeId has already been switched over.
    const capacity = await nodeCapacity(destNode.id, { excludeServerId: server.id });
    const overCapacity = capacity && capacityViolation(capacity, {
      memoryMb: server.memoryMb,
      cpuLimit: server.cpuLimit,
    });
    if (overCapacity) {
      return NextResponse.json({ error: overCapacity }, { status: 507 });
    }

    /*
     * Memory and cores are not the only way a destination can be wrong for a server.
     *
     * A node whose newest JDK is older than the version needs will accept the whole
     * transfer, take ownership of the world, and then refuse every start — while step 5
     * below deletes the source copy with deleteData: true. The server ends up on the one
     * machine that cannot run it, with nothing to go back to. Java 25 arriving on a phone
     * whose Termux ships 21 is the case this was written for.
     *
     * Asked live rather than read from the node row, because nothing persists the JDK and
     * a node's Java changes the moment someone installs one. It costs one request against
     * a node we are about to stream a world to.
     */
    let destHealth;
    try {
      destHealth = await new DaemonClient(destNode).getHealth(8000);
    } catch (e: any) {
      // The transfer posts to this same daemon. Failing here says so plainly, instead of
      // stopping the server first and discovering it while the export is already open.
      return NextResponse.json(
        { error: `Destination node "${destNode.name}" is not responding (${e.message}). Migration needs it online.` },
        { status: 503 }
      );
    }

    const javaProblem = javaSupportViolation(destNode.name, server.game, server.mcVersion, destHealth.javaMajor);
    if (javaProblem) {
      return NextResponse.json({ error: javaProblem }, { status: 409 });
    }

    // Acknowledge the migration request immediately
    const response = NextResponse.json({ message: 'Migration started successfully' }, { status: 202 });

    // --- BACKGROUND MIGRATION PROCESS ---
    (async () => {
      try {
        console.log(`[Migration] Starting migration of server ${server.id} from node ${server.nodeId} to node ${destNode.id}`);
        
        const sourceClient = new DaemonClient(server.node);
        
        // 1. Graceful Shutdown if running
        try {
          const health = await sourceClient.getHealth();
          // If daemon is reachable, try to gracefully stop
          await sourceClient.request(`/servers/${server.id}/stop?countdown=10`, { method: 'POST' });
          console.log(`[Migration] Sent graceful stop signal to source container. Waiting 15s...`);
          await updateLimboTitle('<yellow>Migration Started</yellow>', '<gray>Waiting for server to stop...</gray>');
          await new Promise(r => setTimeout(r, 15000));
        } catch (e) {
          console.log(`[Migration] Server was likely already offline, proceeding with migration.`);
        }

        // Lock server state
        await prisma.server.update({
          where: { id: server.id },
          data: { status: 'INSTALLING' }
        });

        // 2. Fetch export stream from Source Daemon
        const sourceUrl = `http://${server.node.host}:${server.node.port}/api/v1/servers/${server.id}/export`;
        const exportRes = await fetch(sourceUrl, {
          headers: { 'Authorization': `Bearer ${server.node.apiKey}` }
        });

        if (!exportRes.ok || !exportRes.body) {
          throw new Error(`Source export failed: HTTP ${exportRes.status}`);
        }

        /*
         * What the source says it is about to send, counted on its disk after it synced
         * the container out. Absent from a daemon older than this feature, which leaves
         * the transfer unverifiable — see the comparison below.
         */
        const sent = readStats(exportRes.headers.get('x-server-files'), exportRes.headers.get('x-server-bytes'));

        console.log(`[Migration] Export stream established${sent ? ` (${sent.files} files, ${sent.bytes} bytes)` : ''}. Piping to destination...`);
        await updateLimboTitle('<yellow>Transferring Data</yellow>', '<gray>Piping files to destination node...</gray>');

        // 3. Pipe to Destination Daemon import
        const dto: CreateServerContainerDto = {
          serverId: server.id,
          game: server.game as any,
          gameConfig: (server.gameConfig as any) || undefined,
          serverType: server.serverType as any,
          mcVersion: server.mcVersion,
          modpackSlug: server.modpackSlug || undefined,
          serverPort: server.serverPort,
          memoryMb: server.memoryMb,
          cpuLimit: server.cpuLimit,
          eulaAccepted: server.eulaAccepted,
          isMigration: true
        };

        const destUrl = `http://${destNode.host}:${destNode.port}/api/v1/servers/import?serverId=${server.id}`;
        
        // We use the raw fetch here so we can pass the stream body properly
        const importRes = await fetch(destUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${destNode.apiKey}`,
            'x-create-dto': JSON.stringify(dto)
          },
          body: exportRes.body,
          // @ts-ignore - Required for node-fetch / Next.js fetch when body is a stream
          duplex: 'half' 
        });

        if (!importRes.ok) {
          const errText = await importRes.text();
          throw new Error(`Destination import failed: HTTP ${importRes.status} ${errText}`);
        }

        /*
         * 3a. Prove the copy arrived, before anything is switched over or deleted.
         *
         * The destination measures its own directory in the gap between extraction
         * finishing and provisioning starting, so this compares like with like. A
         * truncated gzip stream usually makes tar exit non-zero on its own, but
         * "usually" is not the standard to apply to the only remaining copy of a
         * world, and nothing at all used to catch an extraction that wrote less than
         * was sent.
         *
         * >= rather than ==: tar restores what it was given, and a destination holding
         * more than arrived is not evidence of loss. Holding less is.
         */
        const body = await importRes.json().catch(() => ({} as any));
        const received = readStats(body?.received?.files, body?.received?.bytes);

        if (sent && received) {
          if (received.files < sent.files || received.bytes < sent.bytes) {
            throw new MigrationAborted(
              `Transfer incomplete: sent ${sent.files} files / ${sent.bytes} bytes, ` +
                `destination has ${received.files} / ${received.bytes}. The source copy has been left untouched.`
            );
          }
          console.log(`[Migration] Transfer verified: ${received.files} files, ${received.bytes} bytes.`);
        } else {
          // One end predates the counts. Say so rather than logging a verification that
          // did not happen — this is the case where the old blind behaviour remains.
          console.warn(
            `[Migration] Transfer could not be verified (node daemons predate file counts). ` +
              `Source data will be kept.`
          );
        }

        // 3b. Wait for the destination to finish making it into a server.
        //
        // The import answers 202 as soon as extraction completes and provisions
        // afterwards, so a success here is not yet a working server. Deleting the
        // source during that window is what turns a failed provision into a lost world.
        await updateLimboTitle('<yellow>Verifying</yellow>', '<gray>Waiting for destination to finish...</gray>');
        const provisioned = await waitForProvisioning(destNode, server.id);

        // Both halves must hold before the source may be deleted: the right bytes
        // arrived, and the destination turned them into a server without failing.
        const verified = !!(sent && received) && provisioned;

        console.log(`[Migration] Stream transfer complete and verified. Updating database...`);

        // 4. Update Database
        await prisma.server.update({
          where: { id: server.id },
          data: {
            nodeId: destNode.id,
            status: 'OFFLINE'
          }
        });

        await writeAudit({
          userId: user.userId,
          action: 'SERVER_MIGRATE',
          details: { serverId: server.id, fromNodeId: server.nodeId, toNodeId: destNode.id },
        });

        await updateLimboTitle('<green>Migration Complete</green>', '<gray>Cleaning up old node...</gray>');
        
        // Update proxy with new node routing
        try {
          const velocity = new VelocityClient({ host: '127.0.0.1', port: 3001 });
          velocity.setBaseUrl(process.env.PROXY_API_URL || 'http://proxy:3001');
          await velocity.registerServer(server.id, destNode.host, server.serverPort);
          console.log(`[Migration] Proxy updated for server ${server.id}`);
        } catch(e) {
          console.warn(`[Migration] Failed to update Proxy routing:`, e);
        }

        /*
         * 5. Delete the source copy — the only irreversible step in the whole flow, and
         * the last one for that reason.
         *
         * Reached only once the destination has the same number of files and bytes and
         * has finished provisioning them. When either could not be established the
         * server is still moved, because the data demonstrably arrived, but the
         * original is kept: disk on the old node is cheap and a world is not.
         */
        if (verified) {
          console.log(`[Migration] Cleaning up source daemon...`);
          try {
            await sourceClient.request(`/servers/${server.id}`, {
              method: 'DELETE',
              body: JSON.stringify({ deleteData: true, serverId: server.id })
            });
          } catch (e: any) {
            console.warn(`[Migration Warning] Failed to cleanup source daemon: ${e.message}`);
          }
        } else {
          console.warn(
            `[Migration] Source copy on node ${server.node.name} kept: the transfer could not be ` +
              `fully verified. Delete it by hand once the server has started on ${destNode.name}.`
          );
        }

        console.log(`[Migration] Migration of ${server.id} completed successfully!`);
        await updateLimboTitle('<green>Ready!</green>', '<gray>Server is offline, ready to boot</gray>');

      } catch (err: any) {
        console.error(`[Migration Error] Background migration failed:`, err);

        /*
         * Every failure path above happens before the database is switched over and
         * before the source is deleted, so the server is still on its original node
         * with its data intact — it is stopped, not broken. OFFLINE says that; ERROR
         * would send someone looking for damage that is not there.
         *
         * The exception is a failure after the switch, where the destination owns the
         * server now and ERROR is the honest state.
         */
        const movedAlready = await prisma.server
          .findUnique({ where: { id: server.id }, select: { nodeId: true } })
          .catch(() => null);
        const onDestination = movedAlready?.nodeId === destNode.id;

        await prisma.server.update({
          where: { id: server.id },
          data: { status: onDestination ? 'ERROR' : 'OFFLINE' }
        }).catch(() => {});

        await writeAudit({
          userId: user.userId,
          action: 'SERVER_MIGRATE_FAILED',
          details: {
            serverId: server.id,
            fromNodeId: server.nodeId,
            toNodeId: destNode.id,
            reason: err.message,
            sourceDataKept: !onDestination,
          },
        });

        await updateLimboTitle(
          '<red>Migration Failed</red>',
          onDestination ? '<gray>See the panel</gray>' : '<gray>Server is unchanged on its original node</gray>'
        );
      }
    })();

    return response;

  } catch (error) {
    console.error('[API] Server migration error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
