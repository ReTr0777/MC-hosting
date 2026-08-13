import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';
import { analyzeCrashLog, unknownAnalysis, type AnalysisContext } from '@/lib/crash-analyzer';
import { analyzeWithAi, isAiUsable, loadAiConfig } from '@/lib/ai-analyzer';

export const dynamic = 'force-dynamic';

/**
 * Explains why a server stopped.
 *
 * Pulls the log tail the daemon already assembles (freshest crash report → logs/latest.log →
 * raw Docker stdout), runs the rule set over it, and only escalates to the configured LLM
 * when no rule matched — so the common cases stay instant, free and offline.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    include: {
      node: true,
      permissions: { where: { userId: user.userId }, select: { role: true } },
    },
  });

  if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

  const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
  const userRole = server.permissions[0]?.role;
  if (!isGlobalAdmin && !userRole) {
    return NextResponse.json({ error: 'Forbidden: You do not have access to this server' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const useAi = body?.useAi !== false;

  const client = new DaemonClient({
    host: server.node.host,
    port: server.node.port,
    apiKey: server.node.apiKey,
  });
  const targetContainerId = server.containerId || `process-${server.id}`;

  let lines: string[] = [];
  let logSource = 'none';
  try {
    // The daemon has to sync files out of the container before it can read them, which is
    // slower than the client's 5s connectivity default.
    const tail = await client.request<{ source: string; lines: string[] }>(
      `/servers/${targetContainerId}/logs/tail?lines=300`,
      {},
      20_000
    );
    lines = tail.lines || [];
    logSource = tail.source || 'none';
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Could not read the server log', details: err.message },
      { status: 502 }
    );
  }

  if (lines.length === 0) {
    return NextResponse.json({
      analysis: null,
      logSource,
      aiAvailable: false,
      aiAttempted: false,
      message:
        'No log output is available for this server yet. Start it once so it writes logs/latest.log, then try again.',
    });
  }

  const ctx: AnalysisContext = {
    memoryMb: server.memoryMb,
    mcVersion: server.mcVersion,
    serverType: server.serverType,
    status: server.status,
  };

  let analysis = analyzeCrashLog(lines, ctx);
  let aiAttempted = false;

  const aiConfig = await loadAiConfig().catch(() => null);
  const aiAvailable = aiConfig ? isAiUsable(aiConfig) : false;

  // The LLM is a fallback, not a second opinion — a matched rule is more reliable than a
  // model, and it costs nothing.
  if (!analysis && useAi && aiConfig && aiAvailable) {
    aiAttempted = true;
    analysis = await analyzeWithAi(lines, ctx, aiConfig);
  }

  return NextResponse.json({
    analysis: analysis ?? unknownAnalysis(lines),
    logSource,
    aiAvailable,
    aiAttempted,
    serverStatus: server.status,
    memoryMb: server.memoryMb,
  });
}
