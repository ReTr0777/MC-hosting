import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/daemon-client';

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

    const { uploadId, fileName, totalChunks, isServerpack = true, targetPath = '', isFullImport = false } = await req.json();

    if (!uploadId || !totalChunks) {
        return NextResponse.json({ error: 'Missing uploadId or totalChunks' }, { status: 400 });
    }

    const daemon = new DaemonClient({
        host: server.node.host,
        port: server.node.port,
        apiKey: server.node.apiKey,
    });

    try {
        const result = await daemon.completeChunkedUpload(params.id, uploadId, fileName || 'uploaded_file', totalChunks, isServerpack, targetPath, isFullImport);
        return NextResponse.json(result);
    } catch (err: any) {
        console.error('[API /upload-complete POST error]', err);
        return NextResponse.json({ error: err.message || 'Failed to complete upload' }, { status: 500 });
    }
}
