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

    const { name, host, port, apiKey, offloadPriority, totalMemory, totalCpu } = body;

    const updatedNode = await prisma.node.update({
      where: { id: nodeId },
      data: {
        name: name !== undefined ? name : existingNode.name,
        host: host !== undefined ? host : existingNode.host,
        port: port !== undefined ? port : existingNode.port,
        apiKey: apiKey !== undefined ? apiKey : existingNode.apiKey,
        offloadPriority: offloadPriority !== undefined ? offloadPriority : existingNode.offloadPriority,
        totalMemory: totalMemory !== undefined ? totalMemory : existingNode.totalMemory,
        totalCpu: totalCpu !== undefined ? totalCpu : existingNode.totalCpu,
      }
    });

    await writeAudit({ userId: user.userId, action: 'NODE_UPDATE', details: { nodeId, name: updatedNode.name } });

    return NextResponse.json({ message: 'Node updated successfully', node: updatedNode });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to update node', details: err.message }, { status: 500 });
  }
}
