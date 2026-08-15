import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest, hashPassword } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { validatePassword } from '@/lib/auth/password-policy';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await getUserFromRequest(req);
  if (!admin || admin.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { password, globalRole, maxServers, maxMemoryMb, maxCpu, maxServerMemoryMb, maxServerCpu } =
    await req.json();

  const dataToUpdate: any = {};
  // An omitted password means "leave it alone"; a supplied one still has to meet the policy.
  if (password) {
    const passwordProblem = validatePassword(password);
    if (passwordProblem) {
      return NextResponse.json({ error: passwordProblem }, { status: 400 });
    }
    dataToUpdate.passwordHash = await hashPassword(password);
  }
  if (globalRole) {
    dataToUpdate.globalRole = globalRole;
  }
  // Quota fields: explicit null (or an empty string) clears the quota — unlimited. undefined
  // leaves the stored value untouched, so a partial PATCH can't wipe quotas by accident.
  const quotaNumber = (raw: any, label: string, parse: (s: string) => number): number | null => {
    if (raw === null || raw === '') return null;
    const value = parse(String(raw));
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive number, or blank for unlimited.`);
    }
    return value;
  };

  try {
    if (maxServers !== undefined) dataToUpdate.maxServers = quotaNumber(maxServers, 'Max servers', (s) => parseInt(s, 10));
    if (maxMemoryMb !== undefined) dataToUpdate.maxMemoryMb = quotaNumber(maxMemoryMb, 'Total RAM', (s) => parseInt(s, 10));
    if (maxCpu !== undefined) dataToUpdate.maxCpu = quotaNumber(maxCpu, 'Total CPU', parseFloat);
    if (maxServerMemoryMb !== undefined) dataToUpdate.maxServerMemoryMb = quotaNumber(maxServerMemoryMb, 'RAM per server', (s) => parseInt(s, 10));
    if (maxServerCpu !== undefined) dataToUpdate.maxServerCpu = quotaNumber(maxServerCpu, 'CPU per server', parseFloat);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  // A per-server ceiling above the total allowance is unreachable, and almost always a typo.
  if (dataToUpdate.maxServerMemoryMb != null && dataToUpdate.maxMemoryMb != null && dataToUpdate.maxServerMemoryMb > dataToUpdate.maxMemoryMb) {
    return NextResponse.json({ error: 'RAM per server cannot exceed the total RAM allowance.' }, { status: 400 });
  }
  if (dataToUpdate.maxServerCpu != null && dataToUpdate.maxCpu != null && dataToUpdate.maxServerCpu > dataToUpdate.maxCpu) {
    return NextResponse.json({ error: 'CPU per server cannot exceed the total CPU allowance.' }, { status: 400 });
  }

  try {
    const user = await prisma.user.update({
      where: { id: params.id },
      data: dataToUpdate,
      select: {
        id: true,
        email: true,
        username: true,
        globalRole: true,
        maxServers: true,
        maxMemoryMb: true,
        maxCpu: true,
        maxServerMemoryMb: true,
        maxServerCpu: true,
      }
    });
    const changedFields = Object.keys(dataToUpdate).map((f) => (f === 'passwordHash' ? 'password' : f));
    await writeAudit({
      userId: admin.userId,
      action: 'USER_UPDATE',
      details: { targetUserId: params.id, changedFields },
    });
    return NextResponse.json(user);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await getUserFromRequest(req);
  if (!admin || admin.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (admin.userId === params.id) {
    return NextResponse.json({ error: 'You cannot delete yourself' }, { status: 400 });
  }

  try {
    await prisma.user.delete({
      where: { id: params.id }
    });
    await writeAudit({ userId: admin.userId, action: 'USER_DELETE', details: { targetUserId: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
