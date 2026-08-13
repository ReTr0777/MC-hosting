import { prisma } from '@/lib/prisma';
import { tryDecryptSecret } from '@/lib/crypto';
import type { AnalysisContext, CrashAnalysis, CrashCategory, CrashSeverity } from '@/lib/crash-analyzer';

/**
 * Optional LLM fallback for logs the rule set does not recognise.
 *
 * Speaks the OpenAI chat-completions protocol, which is also what Ollama (/v1),
 * OpenRouter, LM Studio, vLLM and Azure OpenAI expose — so one code path covers both
 * hosted and fully local models, and the operator only configures a base URL, a key and
 * a model name.
 *
 * Everything here is best-effort: any failure returns null and the caller falls back to
 * the heuristic verdict. A crash diagnosis must never depend on a third party being up.
 */

const SETTING_KEYS = {
  enabled: 'AI_ANALYSIS_ENABLED',
  baseUrl: 'AI_BASE_URL',
  apiKey: 'AI_API_KEY',
  model: 'AI_MODEL',
} as const;

export const AI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const AI_DEFAULT_MODEL = 'gpt-4o-mini';

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function loadAiConfig(): Promise<AiConfig> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: Object.values(SETTING_KEYS) } },
  });
  const map: Record<string, string> = {};
  rows.forEach((r) => {
    map[r.key] = r.value;
  });

  const key = tryDecryptSecret(map[SETTING_KEYS.apiKey] || '');

  return {
    enabled: map[SETTING_KEYS.enabled] === 'true',
    baseUrl: (map[SETTING_KEYS.baseUrl] || AI_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: key.status === 'ok' ? key.value : '',
    model: map[SETTING_KEYS.model] || AI_DEFAULT_MODEL,
  };
}

/**
 * True when the endpoint is somewhere on the operator's own network.
 *
 * This matters twice: a self-hosted model needs no API key, and it is far slower than a
 * hosted one so it earns a longer timeout. Loopback alone is not enough — the panel
 * usually runs in a bridged container, so an Ollama box on the LAN is reached by its
 * private address or its container name, never by localhost.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (host === 'localhost' || host === '::1' || host === 'host.docker.internal') return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // A bare name with no dots is a Docker service/container on a shared network.
  if (!host.includes('.') && !host.includes(':')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }

  return false;
}

/** A self-hosted model needs no key; a hosted endpoint does. */
export function isAiUsable(config: AiConfig): boolean {
  if (!config.enabled) return false;
  return isLocalEndpoint(config.baseUrl) || config.apiKey.length > 0;
}

const SYSTEM_PROMPT = `You diagnose Minecraft server crashes for a hosting control panel.

You are given the tail of a server log that a rule-based analyser could not classify.
Reply with ONLY a JSON object, no markdown fence, matching exactly:

{
  "category": one of "out-of-memory" | "java-version" | "mod-dependency" | "mod-conflict" | "world-corruption" | "port-conflict" | "eula" | "config-error" | "startup-failure" | "clean-shutdown" | "unknown",
  "severity": one of "critical" | "error" | "warning" | "info",
  "summary": one sentence, under 80 characters, naming what went wrong,
  "rootCause": 2-4 sentences of plain language explaining why the server stopped, naming the specific mod, file or setting if the log identifies one,
  "actions": array of 1-3 strings, each a concrete step the server owner should take, most likely fix first
}

Rules:
- Only state what the log supports. If the log is inconclusive, say so in rootCause and use category "unknown".
- Never invent mod names, file paths or version numbers that do not appear in the log.
- Write for someone who runs a server but does not read Java stack traces.`;

interface AiJson {
  category?: string;
  severity?: string;
  summary?: string;
  rootCause?: string;
  actions?: unknown;
}

const VALID_CATEGORIES: CrashCategory[] = [
  'out-of-memory', 'java-version', 'mod-dependency', 'mod-conflict', 'world-corruption',
  'port-conflict', 'eula', 'config-error', 'startup-failure', 'clean-shutdown', 'unknown',
];
const VALID_SEVERITIES: CrashSeverity[] = ['critical', 'error', 'warning', 'info'];

/**
 * Asks the configured model to explain a log tail.
 * Returns null on any error, misconfiguration or unparseable reply.
 */
export async function analyzeWithAi(
  lines: string[],
  ctx: AnalysisContext,
  config: AiConfig
): Promise<CrashAnalysis | null> {
  if (!isAiUsable(config)) return null;

  // Cap what leaves the network: the tail is where the failure is, and a huge prompt is
  // both slow and expensive.
  const snippet = lines.filter(Boolean).slice(-120).join('\n').slice(-12000);
  if (!snippet.trim()) return null;

  const userPrompt =
    `Server: ${ctx.serverType} ${ctx.mcVersion}, ${ctx.memoryMb} MB allocated` +
    (ctx.status ? `, panel status ${ctx.status}` : '') +
    `\n\nLog tail:\n${snippet}`;

  // A hosted model answers in seconds. A 7B running on a home server — especially without a
  // GPU — can take minutes for the same 700 tokens, and cutting it off at the hosted budget
  // would make a correctly configured local setup look permanently broken.
  const timeoutMs = isLocalEndpoint(config.baseUrl) ? 180_000 : 30_000;

  let payload: any;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[AI analyzer] ${config.baseUrl} returned HTTP ${res.status}`);
      return null;
    }
    payload = await res.json();
  } catch (err: any) {
    console.warn(`[AI analyzer] request failed: ${err?.message || err}`);
    return null;
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;

  let parsed: AiJson;
  try {
    // Some models still wrap JSON in a fence despite response_format.
    parsed = JSON.parse(content.replace(/^\s*```(?:json)?|```\s*$/g, '').trim());
  } catch {
    return null;
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const rootCause = typeof parsed.rootCause === 'string' ? parsed.rootCause.trim() : '';
  if (!summary || !rootCause) return null;

  const actions = Array.isArray(parsed.actions)
    ? parsed.actions.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 3)
    : [];

  return {
    category: VALID_CATEGORIES.includes(parsed.category as CrashCategory) ? (parsed.category as CrashCategory) : 'unknown',
    severity: VALID_SEVERITIES.includes(parsed.severity as CrashSeverity) ? (parsed.severity as CrashSeverity) : 'error',
    summary: summary.slice(0, 160),
    rootCause: rootCause.slice(0, 1200),
    // Model-suggested steps are advice, never buttons — nothing the LLM writes gets to
    // trigger a mutation against the server.
    suggestedActions: actions.map((label) => ({
      id: 'manual' as const,
      kind: 'manual' as const,
      label: label.slice(0, 200),
      description: '',
    })),
    rawSnippet: lines.filter(Boolean).slice(-20),
    confidence: 'medium',
    source: 'ai',
    ruleId: `ai:${config.model}`,
  };
}
