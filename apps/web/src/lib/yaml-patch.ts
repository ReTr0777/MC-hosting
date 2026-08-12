/**
 * Minimal line-based YAML editor for shallow configs (top-level scalars, or one level of
 * nesting like `bedrock.port`). Deliberately not a full YAML parser: it only ever touches
 * the single line matching a known dot-path and leaves everything else — comments, unknown
 * keys, deeper structures — byte-for-byte untouched. Good enough for patching a handful of
 * known settings in a plugin/mod config without a YAML dependency or risking a corrupt
 * round-trip on files this app doesn't fully understand.
 */

function stripQuotes(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

const KEY_LINE = /^([A-Za-z0-9_.-]+):(\s*)(.*)$/;

export function getYamlValue(text: string, dotPath: string): string | undefined {
  const [parent, child] = dotPath.includes('.') ? dotPath.split('.') : [null, dotPath];
  const lines = text.split(/\r?\n/);
  let inParent = parent === null;
  let parentIndent = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(KEY_LINE);
    if (!m) continue;
    const indent = line.length - line.trimStart().length;

    if (parent) {
      if (indent === 0) {
        inParent = m[1] === parent;
        parentIndent = indent;
        continue;
      }
      if (inParent && indent > parentIndent && m[1] === child) {
        return stripQuotes(m[3]);
      }
      if (inParent && indent <= parentIndent) {
        inParent = false;
      }
    } else if (indent === 0 && m[1] === child) {
      return stripQuotes(m[3]);
    }
  }
  return undefined;
}

/** Mutates `lines` in place, replacing the value on the matched line. Returns whether a match was found. */
export function setYamlValue(lines: string[], dotPath: string, value: string): boolean {
  const [parent, child] = dotPath.includes('.') ? dotPath.split('.') : [null, dotPath];
  let inParent = parent === null;
  let parentIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(KEY_LINE);
    if (!m) continue;
    const indent = line.length - line.trimStart().length;

    if (parent) {
      if (indent === 0) {
        inParent = m[1] === parent;
        parentIndent = indent;
        continue;
      }
      if (inParent && indent > parentIndent && m[1] === child) {
        const leadingWhitespace = line.slice(0, line.length - line.trimStart().length);
        lines[i] = `${leadingWhitespace}${child}: ${value}`;
        return true;
      }
      if (inParent && indent <= parentIndent) {
        inParent = false;
      }
    } else if (indent === 0 && m[1] === child) {
      lines[i] = `${child}: ${value}`;
      return true;
    }
  }
  return false;
}

export function setYamlValues(text: string, updates: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  for (const [dotPath, value] of Object.entries(updates)) {
    setYamlValue(lines, dotPath, value);
  }
  return lines.join('\n');
}
