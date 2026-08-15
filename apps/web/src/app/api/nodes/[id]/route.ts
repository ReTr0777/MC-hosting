import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  try {
    const nodeId = params.id;

    // Check if node exists and has servers
    const node = await prisma.node.findUnique({
      where: { id: nodeId },
      include: {
        _count: {
          select: { servers: true }
        }
      }
    });

    if (!node) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }

    if (node._count.servers > 0) {
      return NextResponse.json({ 
        error: 'Cannot delete node that has active servers. Please delete the servers first.' 
      }, { status: 400 });
    }

    await prisma.node.delete({
      where: { id: nodeId },
    });

    await writeAudit({ userId: user.userId, action: 'NODE_DELETE', details: { nodeId, name: node.name } });

    return NextResponse.json({ message: 'Node deleted successfully' });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to delete node', details: err.message }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUserFromRequest(req);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  try {
    const nodeId = params.id;
    const body = await req.json();
    
    // Check if node exists
    const existingNode = await prisma.node.findUnique({
      where: { id: nodeId }
    });

    if (!existingNode) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }

    const { name, host, port, apiKey, offloadPriority, totalMemory, totalCpu, overcommitRatio, cpuOvercommitRatio } = body;

    // 1.0 means "never promise more than the node has". Anything under that would make the node
    // pretend to be smaller than it is, which is what totalMemory is for; 4x is already reckless.
    if (overcommitRatio !== undefined) {
      const ratio = parseFloat(String(overcommitRatio));
      if (!Number.isFinite(ratio) || ratio < 1 || ratio > 4) {
        return NextResponse.json(
          { error: 'Overcommit ratio must be between 1.0 (no overcommit) and 4.0.' },
          { status: 400 }
        );
      }
    }

    // CPU tolerates far more than RAM does, because cpuLimit caps a burst instead of reserving a
    // core — 16x on a busy shared node is aggressive but not absurd.
    if (cpuOvercommitRatio !== undefined) {
      const ratio = parseFloat(String(cpuOvercommitRatio));
      if (!Number.isFinite(ratio) || ratio < 1 || ratio > 16) {
        return NextResponse.json(
          { error: 'CPU overcommit ratio must be between 1.0 (no overcommit) and 16.0.' },
          { status: 400 }
        );
      }
    }

    // 0 is allowed and means "unmeasured" — capacity checks then let anything through. Negative or
    // non-numeric would silently poison every allocation decision made against this node.
    for (const [label, value] of [['Total memory', totalMemory], ['Total CPU', totalCpu]] as const) {
      if (value === undefined) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: `${label} must be a number of 0 or more.` }, { status: 400 });
      }
    }

    const updatedNode = await prisma.node.update({
      where: { id: nodeId },
      data: {
        ...(overcommitRatio !== undefined ? { overcommitRatio: parseFloat(String(overcommitRatio)) } : {}),
        ...(cpuOvercommitRatio !== undefined ? { cpuOvercommitRatio: parseFloat(String(cpuOvercommitRatio)) } : {}),
        name: name !== undefined ? name : existingNode.name,
        host: host !== undefined ? host : existingNode.host,
        port: port !== undefined ? port : existingNode.port,
        apiKey: apiKey !== undefined ? apiKey : existingNode.apiKey,
        offloadPriority: offloadPriority !== undefined ? offloadPriority : existingNode.offloadPriority,
        totalMemory: totalMemory !== undefined ? Math.round(Number(totalMemory)) : existingNode.totalMemory,
        totalCpu: totalCpu !== undefined ? Math.round(Number(totalCpu)) : existingNode.totalCpu,
      }
    });

    await writeAudit({ userId: user.userId, action: 'NODE_UPDATE', details: { nodeId, name: updatedNode.name } });

    return NextResponse.json({ message: 'Node updated successfully', node: updatedNode });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to update node', details: err.message }, { status: 500 });
  }
}
