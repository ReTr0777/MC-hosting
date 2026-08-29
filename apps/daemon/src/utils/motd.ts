/**
 * Colour codes for `server.properties`, written the way every Minecraft version reads them.
 *
 * Three things stand between what someone types in the panel and coloured text in the server
 * list, and the MOTD field used to fall down all three.
 *
 * **`&` is not Minecraft's formatting character.** The section sign `§` (U+00A7) is. `&` is a
 * Bukkit-era plugin convention that panels translate; the wiki is blunt that it "was used in
 * very early versions" and is no longer valid in vanilla. A `&a` written straight into
 * server.properties reaches the client as the literal text "&a". Since `&` is what everybody
 * types and what every other panel accepts, it is translated here rather than rejected.
 *
 * **A raw `§` is not safe to write either.** server.properties is a Java properties file, and
 * Minecraft reads it as UTF-8 only on recent versions, falling back to ISO-8859-1 — which is
 * what turns a UTF-8 section sign into the "Â§" that older servers display. The `\u00A7`
 * escape avoids the question entirely: Java's properties parser decodes `\uXXXX` before
 * anything sees the bytes, so it means the same thing on 1.7.10 and on 26.2 alike. That is
 * why this writes the escape and not the character.
 *
 * **Not every letter is a code.** Java Edition has 0-9, a-f, k-o and r, and nothing else.
 * `§u` in particular is a Bedrock material colour and does nothing on a Java server, so
 * `&u` is left alone as text rather than turned into a code that cannot work.
 */

/** The escape Java's properties parser turns into `§`, whatever encoding the file is in. */
const SECTION_ESCAPE = '\u00A7';

/** The section sign itself, for input that already contains one. */
const SECTION = '\u00A7';

/**
 * Codes Java Edition understands: colours 0-9 and a-f, styles k-o, and r to reset.
 */
const JAVA_CODES = '0123456789abcdefklmnor';

/**
 * Codes MOTD generators emit that the client has no equivalent letter for, mapped to the
 * letter it does understand.
 *
 * `&u` for underline is the one that matters. Generators emit it, people paste it in, and the
 * client's own underline is `§n` — so written through untouched it produces `§u`, which on
 * Java Edition is nothing at all (it is a Bedrock material colour). Mapping it is safe
 * precisely because of that: there is no competing meaning for `§u` on a Java server to
 * break, so the choice is between underline and silence.
 */
const CODE_ALIASES: Record<string, string> = { u: 'n' };

/**
 * The code letter to write for what somebody typed, or null if it is not a code at all.
 * Case is preserved for real codes — the client accepts either — and normalised for aliases,
 * since there is no original to preserve.
 */
export function resolveFormattingCode(ch: string): string | null {
  if (ch.length !== 1) return null;
  const lower = ch.toLowerCase();
  if (lower in CODE_ALIASES) return CODE_ALIASES[lower];
  return JAVA_CODES.includes(lower) ? ch : null;
}

/**
 * Turns what a person typed into what belongs in server.properties.
 *
 * `&&` is how a literal ampersand is written, so "Bob && Alice" survives as "Bob & Alice".
 * A lone `&` that introduces nothing a Java client understands — "Bob & Alice", "&u", "&z" —
 * is passed through untouched, so ordinary prose does not silently become a colour code.
 */
export function encodeMotd(value: string): string {
  let out = '';

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    // Somebody who pasted a real section sign gets the same portability as everyone else.
    if (ch === SECTION) {
      out += SECTION_ESCAPE;
      continue;
    }

    if (ch !== '&') {
      out += ch;
      continue;
    }

    const next = value[i + 1];
    if (next === '&') {
      out += '&';
      i++;
    } else if (next !== undefined && resolveFormattingCode(next)) {
      out += SECTION_ESCAPE + resolveFormattingCode(next);
      i++;
    } else {
      out += '&';
    }
  }

  return out;
}

/**
 * The inverse, for showing a stored MOTD back in the editor.
 *
 * Without it the panel would display `\u00A7aHello` at the person who typed `&aHello`, and
 * saving twice would be enough to mangle it. A literal `&` already in the file is doubled on
 * the way out so that re-saving what the editor shows is a no-op.
 */
export function decodeMotd(value: string): string {
  return value
    .replace(/&/g, '&&')
    .replace(/\u00a7/gi, '&')
    .replace(new RegExp(SECTION, 'g'), '&');
}
