import fs from 'fs';
import { execSync } from 'child_process';

/**
 * Picking an archive tool that actually worked.
 *
 * Every extractor here is a program that may or may not exist on the node, and their exit codes
 * do not agree on what "worked" means, so this module decides on evidence instead: what the tool
 * left in the directory.
 */

// execSync buffers a child's entire stdout/stderr in memory and defaults to only 1MB. Extraction
// tools print a line per extracted file, so a large modpack (thousands of entries) overflows that
// buffer, gets SIGTERM'd with ENOBUFS partway through, and looks to us like a failed extraction —
// sending us on to a weaker fallback tool on top of a half-extracted directory. 512MB of headroom
// plus the callers' quiet flags means output size can never decide whether an extraction succeeds.
export const EXTRACT_EXEC_OPTS = {
  stdio: 'pipe' as const,
  encoding: 'utf8' as const,
  maxBuffer: 512 * 1024 * 1024,
};

/** Renders why an extraction command failed, including the details execSync hides on the error object. */
export function describeExecFailure(e: any): string {
  const parts = [`exit=${e.status ?? 'n/a'}`];
  if (e.signal) parts.push(`signal=${e.signal}`);
  if (e.code) parts.push(`code=${e.code}`);
  const stderr = String(e.stderr || '').trim();
  const stdout = String(e.stdout || '').trim();
  if (stderr) parts.push(`stderr: ${stderr.slice(-2000)}`);
  else if (stdout) parts.push(`stdout: ${stdout.slice(-2000)}`);
  else parts.push(e.message);
  return parts.join(' | ');
}

/**
 * Whether the shell could not find the tool at all, rather than the tool rejecting the archive.
 *
 * This has to be told apart from a real failure because of what a missing program looks like on
 * Windows, where cmd.exe answers one with exit code 1 — the very code unzip and unrar use for
 * "finished, with warnings". The desktop node runs the daemon natively against the system PATH,
 * which has no unzip on it, so "'unzip' is not recognized as an internal or external command" read
 * as a successful extraction, and every uploaded pack landed as an empty server directory.
 */
export function isCommandMissing(e: any): boolean {
  if (e.code === 'ENOENT') return true;
  // 127 is a POSIX shell's "command not found"; 9009 is cmd.exe's, on the occasions it uses it.
  if (e.status === 127 || e.status === 9009) return true;
  const output = `${e.stderr || ''}\n${e.stdout || ''}`;
  return /is not recognized as an internal or external command|command not found|: not found/i.test(output);
}

/** unrar and unzip alone use exit code 1 for warnings they still extracted through. */
function warnsWithExitOne(tool: string): boolean {
  return tool === 'unrar' || tool === 'unzip';
}

/**
 * Runs extraction candidates in order until one actually puts files in `destDir`.
 *
 * An exit code on its own cannot decide that — see isCommandMissing — so the directory itself is
 * checked after every attempt, and a tool that claims success while leaving it untouched hands
 * over to the next candidate instead of ending the search. That check is the same measure the
 * caller uses to declare the whole extraction failed, so carrying on here can only rescue an
 * upload that was already headed for that error.
 *
 * @param entriesBefore Entry count of `destDir` taken before the first attempt.
 * @param attempts Collects one line per tool that did not work, for the error the user sees.
 */
export function runExtractors(
  commands: string[],
  destDir: string,
  entriesBefore: number,
  kind: string,
  attempts: string[],
  run: (cmd: string) => void = (cmd) => { execSync(cmd, EXTRACT_EXEC_OPTS); }
): boolean {
  for (const cmd of commands) {
    const tool = cmd.split(' ')[0];
    try {
      run(cmd);
    } catch (e: any) {
      if (isCommandMissing(e)) {
        attempts.push(`${tool}: not installed on this node`);
        console.log(`[Daemon Archive Extractor] ${tool} is not installed on this node — trying the next tool`);
        continue;
      }
      // Exit code 1 means "non-fatal warning(s)" — e.g. failing to restore file ownership or
      // timestamps when running as a non-root container user. The archive's actual file data
      // still gets extracted correctly, unlike a real failure (exit code >= 2). Treating this
      // warning as fatal was sending every RAR extraction straight to 7z/7za's much weaker RAR5
      // decoder instead, which is what was actually corrupting uploads.
      if (!(warnsWithExitOne(tool) && e.status === 1)) {
        attempts.push(`${tool}: ${describeExecFailure(e)}`);
        console.log(`[Daemon Archive Extractor] Failed with ${tool}: ${describeExecFailure(e)}`);
        continue;
      }
      console.log(`[Daemon Archive Extractor] ${tool} exited 1 (warnings only) — checking what it left behind`);
    }

    const entriesAfter = fs.readdirSync(destDir).length;
    if (entriesAfter > entriesBefore) {
      console.log(`[Daemon Archive Extractor] Extracted ${kind} using: ${tool}`);
      return true;
    }

    attempts.push(`${tool}: reported success but extracted nothing`);
    console.log(`[Daemon Archive Extractor] ${tool} reported success but left the directory unchanged — trying the next tool`);
  }

  return false;
}
