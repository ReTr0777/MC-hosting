import { prisma } from '@/lib/prisma';

export async function writeAudit(params: {
  userId?: string | null;
  action: string;
  details?: Record<string, unknown> | string;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId ?? null,
        action: params.action,
        details:
          typeof params.details === 'string'
            ? params.details
            : params.details
            ? JSON.stringify(params.details)
            : null,
      },
    });
  } catch {
    // Audit logging must never break the request it's attached to.
  }
}
