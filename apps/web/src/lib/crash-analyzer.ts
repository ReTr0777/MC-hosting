/**
 * Minecraft crash / startup-failure analyser.
 *
 * Pure functions over log text — no I/O, no daemon calls — so the same rules can run
 * against a live log tail, a stored crash report, or a fixture in a test. The caller
 * supplies the lines (the daemon's `/servers/:id/logs/tail` endpoint already prefers a
 * fresh `crash-reports/*.txt`, then `logs/latest.log`, then raw Docker stdout).
 *
 * Rules are ordered most-specific first and the first match wins: a mod that fails
 * because of a missing dependency also mentions "Mod resolution failed", and naming the
 * actual missing mod is far more useful than the generic message.
 */

export type CrashCategory =
  | 'out-of-memory'
  | 'java-version'
  | 'mod-dependency'
  | 'mod-conflict'
  | 'world-corruption'
  | 'port-conflict'
  | 'eula'
  | 'config-error'
  | 'startup-failure'
  | 'clean-shutdown'
  | 'unknown';

export type CrashSeverity = 'critical' | 'error' | 'warning' | 'info';

/**
 * A fix the panel can offer as a button.
 *
 * `kind: 'mutate'` actions are executed by POSTing `id` to the server's `quick-fix`
 * route, which re-checks permissions. `navigate` actions just switch tab. `manual`
 * actions have no button — they are instructions for something only a human can do.
 */
export interface SuggestedAction {
  id: 'increase-memory' | 'restart-server' | 'repair-world' | 'open-tab' | 'manual';
  kind: 'mutate' | 'navigate' | 'manual';
  label: string;
  description: string;
  /** Extra input for the action: `{ memoryMb }` for increase-memory, `{ tab }` for open-tab. */
  payload?: Record<string, unknown>;
  /** True when running this could lose data or take the server down. */
  destructive?: boolean;
}

export interface CrashAnalysis {
  category: CrashCategory;
  severity: CrashSeverity;
  /** One-line headline, safe to show in a badge. */
  summary: string;
  /** Plain-language explanation of why the server stopped. */
  rootCause: string;
  suggestedActions: SuggestedAction[];
  /** The handful of log lines the verdict is based on. */
  rawSnippet: string[];
  confidence: 'high' | 'medium' | 'low';
  source: 'heuristic' | 'ai';
  /** Rule that fired, for support and debugging. */
  ruleId: string;
}

export interface AnalysisContext {
  memoryMb: number;
  mcVersion: string;
  serverType: string;
  /** Panel status at the time of analysis — distinguishes "crashed" from "stopped on purpose". */
  status?: string;
}

interface Rule {
  id: string;
  category: CrashCategory;
  severity: CrashSeverity;
  /** Matched against the joined log text. */
  pattern: RegExp;
  build: (match: RegExpMatchArray, ctx: AnalysisContext) => Pick<CrashAnalysis, 'summary' | 'rootCause' | 'suggestedActions'>;
}

/** Round a memory bump up to a sensible tier rather than an arbitrary number. */
export function nextMemoryTier(currentMb: number): number {
  const tiers = [2048, 3072, 4096, 6144, 8192, 12288, 16384];
  return tiers.find((t) => t > currentMb) ?? Math.min(currentMb * 2, 32768);
}

function openTab(tab: string, label: string, description: string): SuggestedAction {
  return { id: 'open-tab', kind: 'navigate', label, description, payload: { tab } };
}

const RESTART: SuggestedAction = {
  id: 'restart-server',
  kind: 'mutate',
  label: 'Start the server again',
  description: 'Once the cause is dealt with, bring the server back up.',
};

const RULES: Rule[] = [
  // ── Memory ────────────────────────────────────────────────────────────────
  {
    id: 'oom-heap',
    category: 'out-of-memory',
    severity: 'critical',
    pattern: /java\.lang\.OutOfMemoryError:?\s*(Java heap space|GC overhead limit exceeded|Metaspace|unable to create.*thread)?/i,
    build: (m, ctx) => {
      const detail = m[1] ? m[1].trim() : '';
      const target = nextMemoryTier(ctx.memoryMb);
      const threadExhaustion = /thread/i.test(detail);
      return {
        summary: 'The server ran out of memory',
        rootCause: threadExhaustion
          ? `The JVM could not create a new thread — the node is out of memory or has hit a process limit, not just this server's heap. ` +
            `This server is allocated ${ctx.memoryMb} MB. Check what else is running on the node before raising it further.`
          : `The JVM exhausted its ${ctx.memoryMb} MB heap${detail ? ` (${detail})` : ''} and Minecraft cannot recover from that — ` +
            `it aborts immediately. Modpacks and large view distances are the usual causes; memory use grows with both the ` +
            `mod count and the number of loaded chunks.`,
        suggestedActions: [
          {
            id: 'increase-memory',
            kind: 'mutate',
            label: `Raise memory to ${(target / 1024).toFixed(target % 1024 ? 1 : 0)} GB`,
            description:
              `Increases this server's allocation from ${ctx.memoryMb} MB to ${target} MB. ` +
              'Applies the next time the server starts, and is checked against your quota.',
          },
          openTab('properties', 'Lower the view distance', 'Each step down in view distance cuts loaded chunks — and memory — sharply.'),
          openTab('mods', 'Review installed mods', 'A single leaking mod can exhaust any heap you give it.'),
        ],
      };
    },
  },

  // ── Java runtime ──────────────────────────────────────────────────────────
  {
    id: 'java-class-version',
    category: 'java-version',
    severity: 'critical',
    pattern: /(?:UnsupportedClassVersionError|Unsupported class file major version)\s*:?\s*(?:.*?class file version )?(\d{2})?/i,
    build: (m, ctx) => {
      const major = m[1] ? parseInt(m[1], 10) : NaN;
      // JVM class-file major versions: 52 = Java 8, 61 = Java 17, 65 = Java 21.
      const neededJava = Number.isFinite(major) ? major - 44 : null;
      return {
        summary: 'Java version mismatch',
        rootCause:
          (neededJava
            ? `Something on the classpath was compiled for Java ${neededJava}, but the runtime on the node is older and refuses to load it. `
            : 'A class was compiled for a newer Java release than the runtime on the node can load. ') +
          `The node picks the Java version from the Minecraft version (currently ${ctx.mcVersion}), so this almost always means a mod or ` +
          'plugin built for a newer Minecraft version was installed onto an older server.',
        suggestedActions: [
          openTab('mods', 'Find the mismatched mod', 'Remove the mod built for a newer Minecraft version, or replace it with the build that matches this server.'),
          openTab('update', 'Update the Minecraft version', 'If the mod is the one you want, move the server up to the version it targets. Back up first.'),
        ],
      };
    },
  },

  // ── Mod resolution ────────────────────────────────────────────────────────
  {
    id: 'fabric-hard-dep',
    category: 'mod-dependency',
    severity: 'critical',
    pattern: /HARD_DEP_NO_CANDIDATE\s+(\S+)[^{]*\{depends\s+([\w.-]+)/i,
    build: (m) => {
      const [, mod, missing] = m;
      const isFabricApi = /^fabric-api(-base)?$/i.test(missing);
      return {
        summary: `'${mod}' is missing its dependency '${missing}'`,
        rootCause:
          `Fabric refuses to launch with an unsatisfiable mod set, so one missing dependency stops the whole server. ` +
          `'${mod}' declares a hard dependency on '${missing}', which is not installed. ` +
          (isFabricApi
            ? "That module ships inside Fabric API — installing \"Fabric API\" satisfies it."
            : `Install '${missing}' at a version compatible with this server.`),
        suggestedActions: [
          openTab(
            'mods',
            isFabricApi ? 'Install Fabric API' : `Install '${missing}'`,
            'Search Modrinth from the Mods tab and install the missing dependency, then start the server again.'
          ),
          openTab('mods', `Remove '${mod}' instead`, 'If you do not need this mod, uninstalling it also resolves the conflict.'),
          RESTART,
        ],
      };
    },
  },
  {
    id: 'duplicate-mod-id',
    category: 'mod-conflict',
    severity: 'critical',
    pattern: /[Dd]uplicate mod(?: ID)?[:\s]+['"]?([\w.-]+)/,
    build: (m) => ({
      summary: `Two copies of the mod '${m[1]}' are installed`,
      rootCause:
        `The loader found the mod ID '${m[1]}' declared by more than one jar in the mods folder and cannot choose between them. ` +
        'This is nearly always a leftover old version sitting alongside a newly installed one.',
      suggestedActions: [
        openTab('mods', 'Remove the duplicate', `Delete the older '${m[1]}' jar so only one copy remains.`),
        openTab('files', 'Inspect the mods folder', 'Check mods/ directly if the duplicate is not visible in the Mods tab.'),
        RESTART,
      ],
    }),
  },
  {
    id: 'incompatible-mod-set',
    category: 'mod-conflict',
    severity: 'critical',
    pattern: /(Incompatible mods found|Mod resolution (?:failed|encountered an incompatible mod set)|ModResolutionException)/i,
    build: (_m, ctx) => ({
      summary: 'The installed mods cannot run together',
      rootCause:
        `The mod loader could not resolve the mod set for Minecraft ${ctx.mcVersion}. The log lines below name the offending mod ` +
        'and what it wanted; the usual cause is a jar built for a different Minecraft version or loader.',
      suggestedActions: [
        openTab('mods', 'Review installed mods', 'Remove or replace the mod named in the log, then start the server again.'),
        openTab('backups', 'Restore a working backup', 'If the server ran before the last mod change, rolling back is the quickest fix.'),
      ],
    }),
  },
  {
    id: 'mixin-failure',
    category: 'mod-conflict',
    severity: 'critical',
    pattern: /(MixinApplyError|Mixin (?:apply|prepare|transformation) failed|InvalidInjectionException)/i,
    build: () => ({
      summary: 'A mod failed to patch the game',
      rootCause:
        'A mixin — a mod patching the game at load time — could not be applied. That means the mod expects a different version of ' +
        'Minecraft or of another mod than the one installed. The mod named next to the mixin error in the log is the culprit.',
      suggestedActions: [
        openTab('mods', 'Update or remove the failing mod', 'Match the mod build to this server, or uninstall it.'),
        openTab('backups', 'Restore a working backup', 'Roll back to the state before the last mod change.'),
      ],
    }),
  },

  // ── World data ────────────────────────────────────────────────────────────
  {
    id: 'chunk-corruption',
    category: 'world-corruption',
    severity: 'critical',
    pattern: /(Chunk file at .* is missing|Failed to (?:read|load) chunk|ChunkLoadingException|Invalid Chunk coordinates|region file .* is (?:truncated|corrupt))/i,
    build: () => ({
      summary: 'A region of the world is damaged',
      rootCause:
        'A chunk could not be read back from the region files. This usually follows a hard kill or a node power loss while the world ' +
        'was mid-save, and it will keep crashing the server every time a player loads that area.',
      suggestedActions: [
        {
          id: 'repair-world',
          kind: 'mutate',
          label: 'Run world repair',
          description: 'Resets the world settings the daemon controls and clears the state that blocks a damaged world from loading.',
        },
        openTab('backups', 'Restore the last good backup', 'The only reliable way to recover chunks that are truly gone. Restoring discards changes made since that backup.'),
        openTab('files', 'Inspect region files', 'Advanced: delete the specific .mca file named in the log to have Minecraft regenerate that area.'),
      ],
    }),
  },
  {
    id: 'level-dat-missing',
    category: 'world-corruption',
    severity: 'critical',
    pattern: /(level\.dat.*(?:missing|corrupt|not found)|Failed to load world data|Error reading level data)/i,
    build: () => ({
      summary: 'The world save could not be read',
      rootCause:
        "level.dat holds the world's seed, spawn and game rules. If it is missing or unreadable the server cannot open the world at all — " +
        'Minecraft keeps a level.dat_old alongside it for exactly this case.',
      suggestedActions: [
        openTab('backups', 'Restore the last good backup', 'The safest recovery, and it keeps the world seed intact.'),
        openTab('files', 'Swap in level.dat_old', 'Advanced: rename level.dat_old to level.dat in the world folder to fall back to the previous save.'),
      ],
    }),
  },

  // ── Networking ────────────────────────────────────────────────────────────
  {
    id: 'port-in-use',
    category: 'port-conflict',
    severity: 'critical',
    pattern: /(Address already in use|java\.net\.BindException|FAILED TO BIND TO PORT|Perhaps a server is already running)/i,
    build: () => ({
      summary: 'The server port is already taken',
      rootCause:
        'Another process on the node is already listening on this port. Most often it is the previous run of this same server that ' +
        'has not fully exited yet, or a second server configured on the same port.',
      suggestedActions: [
        RESTART,
        openTab('domain', 'Check the port allocation', 'Confirm no other server on this node is using the same port.'),
      ],
    }),
  },

  // ── Configuration ─────────────────────────────────────────────────────────
  {
    id: 'eula',
    category: 'eula',
    severity: 'error',
    pattern: /You need to agree to the EULA in order to run the server/i,
    build: () => ({
      summary: 'The Minecraft EULA has not been accepted',
      rootCause:
        "Mojang requires eula=true in eula.txt before a server will boot. The panel normally writes this at creation, so seeing it " +
        'here means the file was reset or the server directory was replaced.',
      suggestedActions: [
        openTab('files', 'Set eula=true', 'Open eula.txt in the Files tab and change eula=false to eula=true.'),
        RESTART,
      ],
    }),
  },
  {
    id: 'properties-parse',
    category: 'config-error',
    severity: 'error',
    pattern: /(Failed to load (?:properties|server\.properties)|Could not parse server\.properties|InvalidPropertiesFormatException)/i,
    build: () => ({
      summary: 'server.properties could not be parsed',
      rootCause:
        'A malformed line in server.properties stops the server before it reaches world loading. A stray character or an unescaped ' +
        'backslash in a path is the usual cause.',
      suggestedActions: [
        openTab('properties', 'Review server settings', 'The Settings tab writes valid values, which fixes malformed entries.'),
        openTab('files', 'Edit server.properties directly', 'Open the file and look for the line named in the log.'),
      ],
    }),
  },
  {
    id: 'missing-server-jar',
    category: 'startup-failure',
    severity: 'critical',
    pattern: /(Unable to access jarfile|Error: Could not find or load main class|no main manifest attribute)/i,
    build: () => ({
      summary: 'The server jar is missing or unreadable',
      rootCause:
        'Java could not open the server jar at all, so nothing started. Either the install did not finish, or the jar was moved or ' +
        'deleted from the server directory.',
      suggestedActions: [
        openTab('update', 'Reinstall the server engine', 'Re-running the install writes a fresh, complete jar.'),
        openTab('files', 'Check the server directory', 'Confirm the jar named in the log is actually present.'),
      ],
    }),
  },

  // ── Generic crash, still worth reporting ──────────────────────────────────
  {
    id: 'generic-exception-in-init',
    category: 'startup-failure',
    severity: 'critical',
    pattern: /(Exception in server tick loop|Failed to start the minecraft server|Encountered an unexpected exception|A problem occurred running the Server process)/i,
    build: () => ({
      summary: 'The server crashed during startup',
      rootCause:
        'Minecraft threw an unhandled exception and shut down. The stack trace below names the class that failed — the package name ' +
        'at the top of the trace usually identifies the mod responsible.',
      suggestedActions: [
        openTab('mods', 'Review recent mod changes', 'Undoing the most recent change is the fastest way to isolate the cause.'),
        openTab('backups', 'Restore a working backup', 'Roll back to the last state that started cleanly.'),
      ],
    }),
  },
];

/** Lines worth keeping in the snippet — the exception and its surroundings, not the boot banner. */
function extractSnippet(lines: string[], matchedText: string): string[] {
  const idx = lines.findIndex((l) => matchedText && l.includes(matchedText.split('\n')[0].trim().slice(0, 40)));
  if (idx === -1) return lines.slice(-14);
  const start = Math.max(0, idx - 3);
  return lines.slice(start, start + 14);
}

/**
 * Runs the rule set over a log tail.
 *
 * Returns `null` when nothing matched — the caller decides whether that is worth escalating
 * to an LLM. A clean shutdown is reported explicitly rather than as "unknown", so the UI can
 * say "this server was stopped, it did not crash".
 */
export function analyzeCrashLog(lines: string[], ctx: AnalysisContext): CrashAnalysis | null {
  const cleaned = lines.filter((l) => l && l.trim().length > 0);
  if (cleaned.length === 0) return null;

  const text = cleaned.join('\n');

  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;

    const built = rule.build(match, ctx);
    return {
      category: rule.category,
      severity: rule.severity,
      confidence: 'high',
      source: 'heuristic',
      ruleId: rule.id,
      rawSnippet: extractSnippet(cleaned, match[0]),
      ...built,
    };
  }

  // No rule fired. A log that ends on a clean stop is not a crash at all — say so, because
  // "we found nothing" reads as a failure of the tool when the server simply shut down.
  if (/(Stopping the server|Saving worlds|ThreadedAnvilChunkStorage.*Saved|Closing Server)/i.test(text)) {
    return {
      category: 'clean-shutdown',
      severity: 'info',
      summary: 'The server shut down cleanly',
      rootCause:
        'The log ends with a normal shutdown sequence — the world was saved and the server stopped on request. ' +
        'Nothing here indicates a crash.',
      suggestedActions: [RESTART],
      rawSnippet: cleaned.slice(-10),
      confidence: 'high',
      source: 'heuristic',
      ruleId: 'clean-shutdown',
    };
  }

  return null;
}

/** Fallback shown when neither the rules nor the AI could explain the log. */
export function unknownAnalysis(lines: string[]): CrashAnalysis {
  return {
    category: 'unknown',
    severity: 'warning',
    summary: 'No known crash pattern found',
    rootCause:
      'The log does not match any pattern the analyser recognises, and it does not end in a clean shutdown either. ' +
      'The last lines are shown below — the final stack trace, if there is one, names the component that failed.',
    suggestedActions: [
      openTab('backups', 'Restore a working backup', 'If the server ran before a recent change, rolling back isolates the cause.'),
      openTab('files', 'Read the full log', 'Open logs/latest.log for everything that came before these lines.'),
    ],
    rawSnippet: lines.filter(Boolean).slice(-20),
    confidence: 'low',
    source: 'heuristic',
    ruleId: 'none',
  };
}
