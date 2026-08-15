import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { DaemonClient } from '@/lib/services/daemon-client';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const server = await prisma.server.findUnique({
        where: { id: params.id },
        include: {
            node: true,
            permissions: { where: { userId: user.userId } },
        },
    });

    if (!server) return NextResponse.json({ error: 'Server not found' }, { status: 404 });

    const isGlobalAdmin = user.globalRole === 'GLOBAL_ADMIN';
    const userRole = server.permissions[0]?.role;

    if (!isGlobalAdmin && (!userRole || userRole === 'VIEWER')) {
        return NextResponse.json({ error: 'Forbidden: OPERATOR or ADMIN role required' }, { status: 403 });
    }

    const uploadId = req.headers.get('x-upload-id');
    const chunkIndex = req.headers.get('x-chunk-index');

    if (!uploadId || !chunkIndex) {
        return NextResponse.json({ error: 'Missing upload ID or chunk index' }, { status: 400 });
    }

    const daemon = new DaemonClient({
        host: server.node.host,
        port: server.node.port,
        apiKey: server.node.apiKey,
    });

    try {
        const chunk = await req.arrayBuffer();
        await daemon.uploadChunk(params.id, uploadId, parseInt(chunkIndex, 10), Buffer.from(chunk));
        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('[API /upload-chunk POST error]', err);
        return NextResponse.json({ error: err.message || 'Failed to upload chunk' }, { status: 500 });
    }
}
