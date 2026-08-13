import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCrashLog, nextMemoryTier, unknownAnalysis, type AnalysisContext } from './crash-analyzer';

/**
 * Rule coverage for the crash analyser, using log fragments in the shape Minecraft
 * actually emits. Run with `npm test` in apps/web.
 */

const ctx: AnalysisContext = {
  memoryMb: 2048,
  mcVersion: '1.20.1',
  serverType: 'FABRIC',
  status: 'ERROR',
};

/** Real logs bury the failure under boot noise; the rules have to find it there. */
function withPreamble(...lines: string[]): string[] {
  return [
    '[12:00:01] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.0',
    '[12:00:02] [main/INFO]: Loading 137 mods:',
    '[12:00:03] [main/INFO]: \t- fabric-api 0.90.0',
    ...lines,
  ];
}

test('detects heap exhaustion and offers the next memory tier', () => {
  const result = analyzeCrashLog(
    withPreamble(
      '[12:04:11] [Server thread/ERROR]: Encountered an unexpected exception',
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat net.minecraft.world.chunk.WorldChunk.<init>(WorldChunk.java:142)'
    ),
    ctx
  );

  assert.ok(result);
  assert.equal(result.category, 'out-of-memory');
  assert.equal(result.severity, 'critical');
  assert.equal(result.source, 'heuristic');

  // The memory rule must win over the generic "unexpected exception" rule that also matches.
  assert.equal(result.ruleId, 'oom-heap');

  const bump = result.suggestedActions.find((a) => a.id === 'increase-memory');
  assert.ok(bump, 'expected a memory increase action');
  assert.match(bump.label, /3 GB/, 'should propose the next tier above 2048 MB');
});

test('reads the required Java release out of the class file version', () => {
  const result = analyzeCrashLog(
    withPreamble(
      'java.lang.UnsupportedClassVersionError: com/example/Mod has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0'
    ),
    ctx
  );

  assert.ok(result);
  assert.equal(result.category, 'java-version');
  // Class-file major 65 is Java 21.
  assert.match(result.rootCause, /Java 21/);
});

test('names the mod and the dependency it is missing', () => {
  const result = analyzeCrashLog(
    withPreamble(
      '[12:00:09] [main/ERROR]: Mod resolution failed',
      "Module resolution HARD_DEP_NO_CANDIDATE journeymap {depends fabric-api @ [>=0.90.0]}"
    ),
    ctx
  );

  assert.ok(result);
  assert.equal(result.category, 'mod-dependency');
  assert.equal(result.ruleId, 'fabric-hard-dep', 'the specific rule must beat the generic resolution-failure rule');
  assert.match(result.summary, /journeymap/);
  assert.match(result.rootCause, /fabric-api/);
  assert.match(result.rootCause, /Fabric API/, 'fabric-api should be explained as shipping inside Fabric API');
});

test('detects a duplicate mod jar', () => {
  const result = analyzeCrashLog(withPreamble("[main/FATAL]: Duplicate mod ID: 'sodium' from sodium-0.4.jar and sodium-0.5.jar"), ctx);

  assert.ok(result);
  assert.equal(result.category, 'mod-conflict');
  assert.match(result.summary, /sodium/);
});

test('falls back to the generic mod-conflict rule when no mod is named', () => {
  const result = analyzeCrashLog(withPreamble('[main/ERROR]: Incompatible mods found! See the log for details.'), ctx);

  assert.ok(result);
  assert.equal(result.ruleId, 'incompatible-mod-set');
  assert.match(result.rootCause, /1\.20\.1/, 'should quote the server version back');
});

test('detects world corruption and offers the repair action', () => {
  const result = analyzeCrashLog(
    withPreamble('[Server thread/ERROR]: Failed to load chunk 12, -8', 'java.io.IOException: region file r.0.-1.mca is truncated'),
    ctx
  );

  assert.ok(result);
  assert.equal(result.category, 'world-corruption');
  assert.ok(result.suggestedActions.some((a) => a.id === 'repair-world'));
});

test('detects a port conflict', () => {
  const result = analyzeCrashLog(
    withPreamble('[Server thread/WARN]: **** FAILED TO BIND TO PORT!', 'java.net.BindException: Address already in use'),
    ctx
  );

  assert.ok(result);
  assert.equal(result.category, 'port-conflict');
});

test('detects an unaccepted EULA', () => {
  const result = analyzeCrashLog(
    ['[main/WARN]: Failed to load eula.txt', '[main/INFO]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.'],
    ctx
  );

  assert.ok(result);
  assert.equal(result.category, 'eula');
});

test('reports a clean shutdown as not-a-crash', () => {
  const result = analyzeCrashLog(
    [
      '[12:40:00] [Server thread/INFO]: Stopping the server',
      '[12:40:01] [Server thread/INFO]: Saving worlds',
      '[12:40:02] [Server thread/INFO]: ThreadedAnvilChunkStorage (world): All chunks are saved',
    ],
    ctx
  );

  assert.ok(result);
  assert.equal(result.category, 'clean-shutdown');
  assert.equal(result.severity, 'info');
});

test('returns null when nothing matches, so the caller can escalate to the model', () => {
  assert.equal(analyzeCrashLog(['[12:00:00] [main/INFO]: Starting minecraft server version 1.20.1'], ctx), null);
  assert.equal(analyzeCrashLog([], ctx), null);
  assert.equal(analyzeCrashLog(['', '   '], ctx), null);
});

test('the snippet carries the failing lines, not just the tail', () => {
  const noise = Array.from({ length: 60 }, (_, i) => `[12:00:00] [main/INFO]: noise line ${i}`);
  const result = analyzeCrashLog(['java.lang.OutOfMemoryError: Java heap space', ...noise], ctx);

  assert.ok(result);
  assert.ok(
    result.rawSnippet.some((l) => l.includes('OutOfMemoryError')),
    'the matched line must appear in the evidence shown to the user'
  );
});

test('memory tiers step up and then double past the top tier', () => {
  assert.equal(nextMemoryTier(2048), 3072);
  assert.equal(nextMemoryTier(4096), 6144);
  assert.equal(nextMemoryTier(16384), 32768);
  // Odd, non-tier allocations still move up rather than sticking.
  assert.ok(nextMemoryTier(2500) > 2500);
});

test('the unknown fallback still returns something displayable', () => {
  const result = unknownAnalysis(['line a', '', 'line b']);
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 'low');
  assert.ok(result.summary.length > 0);
  assert.deepEqual(result.rawSnippet, ['line a', 'line b']);
});
