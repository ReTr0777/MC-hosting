import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { getUserFromRequest } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return NextResponse.json({ error: 'Forbidden: Global Admin access required' }, { status: 403 });
  }

  try {
    const { host, port, smtpUser, pass, from, secure } = await request.json();

    if (!host) {
      return NextResponse.json({ error: 'Missing SMTP host' }, { status: 400 });
    }

    const transport = nodemailer.createTransport({
      host: host.trim(),
      port: parseInt(port, 10) || 587,
      secure: !!secure,
      auth: smtpUser ? { user: smtpUser.trim(), pass } : undefined,
    });

    await transport.verify();
    await transport.sendMail({
      from: from?.trim() || smtpUser?.trim() || 'no-reply@localhost',
      to: user.email,
      subject: 'CraftControl SMTP test',
      html: '<p>Your CraftControl SMTP configuration is working.</p>',
    });

    return NextResponse.json({ success: true, message: `🟢 Test email sent to ${user.email}!` });
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      message: `SMTP test failed: ${err.message}`,
    });
  }
}
