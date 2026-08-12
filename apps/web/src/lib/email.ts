import nodemailer from 'nodemailer';
import { prisma } from './prisma';
import { tryDecryptSecret } from './crypto';

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'] } },
  });
  const map: Record<string, string> = {};
  rows.forEach((r) => (map[r.key] = r.value));

  if (!map.SMTP_HOST) return null;

  return {
    host: map.SMTP_HOST,
    port: parseInt(map.SMTP_PORT || '587', 10),
    user: map.SMTP_USER || '',
    pass: tryDecryptSecret(map.SMTP_PASS || '').value,
    from: map.SMTP_FROM || map.SMTP_USER || 'no-reply@localhost',
    secure: map.SMTP_SECURE === 'true',
  };
}

/** True when SMTP is configured and mail can actually be sent. */
export async function isEmailConfigured(): Promise<boolean> {
  return (await getSmtpConfig()) !== null;
}

async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  const config = await getSmtpConfig();
  if (!config) {
    console.warn('[email] SMTP not configured — skipping send:', subject);
    return false;
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });

  await transport.sendMail({ from: config.from, to, subject, html });
  return true;
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<boolean> {
  return sendMail(
    to,
    'Reset your CraftControl password',
    `<p>A password reset was requested for your CraftControl account.</p>
     <p><a href="${resetUrl}">Click here to reset your password</a>. This link expires in 30 minutes.</p>
     <p>If you didn't request this, you can safely ignore this email.</p>`
  );
}

export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<boolean> {
  return sendMail(
    to,
    'Verify your CraftControl email',
    `<p>Please confirm this is your email address.</p>
     <p><a href="${verifyUrl}">Click here to verify your email</a>. This link expires in 24 hours.</p>`
  );
}
