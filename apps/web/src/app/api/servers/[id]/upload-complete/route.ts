import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { DaemonClient } from '@/lib/services/daemon-client';
import { writeAudit } from '@/lib/audit';

// Assembling a large modpack — and, for a .mrpack, downloading every mod plus running the loader
// installer — happens inline on the daemon before it responds. Don't let the platform cut us off.
export const maxDuration = 3600;

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

    const { uploadId, fileName, totalChunks, totalBytes, isServerpack = true, targetPath = '', isFullImport = false } = await req.json();

    if (!uploadId || !totalChunks) {
        return NextResponse.json({ error: 'Missing uploadId or totalChunks' }, { status: 400 });
    }

    const daemon = new DaemonClient({
        host: server.node.host,
        port: server.node.port,
        apiKey: server.node.apiKey,
    });

    try {
        const result = await daemon.completeChunkedUpload(params.id, uploadId, fileName || 'uploaded_file', totalChunks, isServerpack, targetPath, isFullImport, totalBytes);
        if (isFullImport) {
            await writeAudit({ userId: user.userId, action: 'SERVER_IMPORT', details: { serverId: server.id, serverName: server.name, fileName } });
        }
        return NextResponse.json(result);
    } catch (err: any) {
        console.error('[API /upload-complete POST error]', err);
        return NextResponse.json({ error: err.message || 'Failed to complete upload' }, { status: 500 });
    }
}
