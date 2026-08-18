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

        console.log(`[Migration] Export stream established. Piping to destination...`);
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

        console.log(`[Migration] Stream transfer complete. Updating database...`);

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

        // 5. Cleanup Source Daemon
        console.log(`[Migration] Cleaning up source daemon...`);
        try {
          await sourceClient.request(`/servers/${server.id}`, {
            method: 'DELETE',
            body: JSON.stringify({ deleteData: true, serverId: server.id })
          });
        } catch (e: any) {
          console.warn(`[Migration Warning] Failed to cleanup source daemon: ${e.message}`);
        }

        console.log(`[Migration] Migration of ${server.id} completed successfully!`);
        await updateLimboTitle('<green>Ready!</green>', '<gray>Server is offline, ready to boot</gray>');

      } catch (err: any) {
        console.error(`[Migration Error] Background migration failed:`, err);
        // Revert status on failure
        await prisma.server.update({
          where: { id: server.id },
          data: { status: 'ERROR' }
        }).catch(() => {});
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
