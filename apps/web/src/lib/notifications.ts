import { prisma } from '@/lib/prisma';

export const NOTIFICATION_EVENT_TYPES = [
  'SERVER_CRASHED',
  'SERVER_STARTED',
  'SERVER_STOPPED',
  'NODE_OFFLINE',
  'NODE_ONLINE',
  'BACKUP_COMPLETED',
  'BACKUP_FAILED',
  'SCHEDULE_RAN',
  'SCHEDULE_FAILED',
  'SERVER_SLEPT',
  'SERVER_WOKE',
  'TEST',
] as const;

export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number];

export type Severity = 'info' | 'warning' | 'critical';

export interface NotificationEvent {
  type: NotificationEventType;
  title: string;
  body: string;
  severity?: Severity;
  /** Rendered as name/value rows in the Discord embed. */
  fields?: Array<{ name: string; value: string }>;
}

const SEVERITY_COLOR: Record<Severity, number> = {
  info: 0x3ba55d,
  warning: 0xfaa61a,
  critical: 0xed4245,
};

const DEFAULT_SEVERITY: Record<NotificationEventType, Severity> = {
  SERVER_CRASHED: 'critical',
  SERVER_STARTED: 'info',
  SERVER_STOPPED: 'info',
  NODE_OFFLINE: 'critical',
  NODE_ONLINE: 'info',
  BACKUP_COMPLETED: 'info',
  BACKUP_FAILED: 'warning',
  SCHEDULE_RAN: 'info',
  SCHEDULE_FAILED: 'warning',
  SERVER_SLEPT: 'info',
  SERVER_WOKE: 'info',
  TEST: 'info',
};

export const EVENT_LABELS: Record<NotificationEventType, string> = {
  SERVER_CRASHED: 'Server crashed',
  SERVER_STARTED: 'Server started',
  SERVER_STOPPED: 'Server stopped',
  NODE_OFFLINE: 'Node went offline',
  NODE_ONLINE: 'Node came back online',
  BACKUP_COMPLETED: 'Backup completed',
  BACKUP_FAILED: 'Backup failed',
  SCHEDULE_RAN: 'Scheduled task ran',
  SCHEDULE_FAILED: 'Scheduled task failed',
  SERVER_SLEPT: 'Server went to sleep',
  SERVER_WOKE: 'Server woke up',
  TEST: 'Test message',
};

function buildDiscordPayload(event: NotificationEvent, severity: Severity) {
  return {
    embeds: [
      {
        title: event.title,
        description: event.body,
        color: SEVERITY_COLOR[severity],
        timestamp: new Date().toISOString(),
        footer: { text: 'CraftControl' },
        ...(event.fields?.length
          ? { fields: event.fields.map((f) => ({ name: f.name, value: f.value, inline: true })) }
          : {}),
      },
    ],
  };
}

function buildGenericPayload(event: NotificationEvent, severity: Severity) {
  return {
    source: 'craftcontrol',
    event: event.type,
    severity,
    title: event.title,
    body: event.body,
    fields: event.fields || [],
    timestamp: new Date().toISOString(),
  };
}

async function postWebhook(url: string, payload: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sends one event to every enabled channel subscribed to it, recording each attempt.
 * Never throws — a broken webhook must not take down the caller (monitor loop, backup route, ...).
 */
export async function dispatchNotification(event: NotificationEvent): Promise<void> {
  const severity = event.severity || DEFAULT_SEVERITY[event.type] || 'info';

  let channels;
  try {
    channels = await prisma.notificationChannel.findMany({ where: { enabled: true } });
  } catch (err) {
    // Table may not exist yet on a panel that hasn't run `prisma db push`
    return;
  }

  const subscribed = channels.filter((c) => c.events.length === 0 || c.events.includes(event.type));
  if (subscribed.length === 0) return;

  await Promise.all(
    subscribed.map(async (channel) => {
      const payload =
        channel.type === 'GENERIC'
          ? buildGenericPayload(event, severity)
          : buildDiscordPayload(event, severity);

      let status = 'SUCCESS';
      let detail: string | null = null;

      try {
        await postWebhook(channel.url, payload);
      } catch (err: any) {
        status = 'FAILED';
        detail = err?.name === 'AbortError' ? 'Timed out after 8s' : err?.message || 'Unknown error';
      }

      await prisma.notificationDelivery.create({
        data: {
          channelId: channel.id,
          eventType: event.type,
          severity,
          title: event.title,
          body: event.body,
          status,
          detail,
        },
      }).catch(() => {});
    })
  );
}

/** Sends to a single channel without persisting it — used by the "Send test" button. */
export async function sendTestNotification(type: string, url: string): Promise<void> {
  const event: NotificationEvent = {
    type: 'TEST',
    title: '✅ CraftControl test alert',
    body: 'If you can read this, your webhook is wired up correctly.',
    severity: 'info',
  };

  const payload = type === 'GENERIC' ? buildGenericPayload(event, 'info') : buildDiscordPayload(event, 'info');
  await postWebhook(url, payload);
}
