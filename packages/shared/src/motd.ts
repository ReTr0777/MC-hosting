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
const SECTION_ESCAPE = String.raw`\u00A7`;

/** The section sign itself, for input that already contains one. */
const SECTION = '\u00A7';

/**
 * Codes Java Edition understands: colours 0-9 and a-f, styles k-o, and r to reset.
 */
const JAVA_CODES = '0123456789abcdefklmnor';

/**
 * Codes the MOTD generators emit that the client has no letter for, mapped to the letter it
 * does. Two of them, and they are not the same kind of translation.
 *
 * **`&u` → `§n` is exact.** Generators label it underline, the client's underline is `§n`, and
 * nothing is lost. Written through untouched it becomes `§u`, which on Java Edition is a
 * Bedrock material colour and therefore nothing at all — which is why the mapping is safe:
 * there is no competing meaning to break, so the choice was between underline and silence.
 *
 * **`&g` → `§e` is an approximation, and the only one here.** `§g` is Minecoin Gold, #DDD605,
 * and it is Bedrock-only: Java Edition has `§0`–`§f` and nothing else, and a server.properties
 * MOTD cannot carry a hex colour the way a JSON text component can. So the real choice is
 * between the nearest colour Java has and the literal text "&g" sitting in the MOTD. Yellow is
 * that nearest colour by hue — #DDD605 sits at 58° against yellow's 60° and gold's 40°, so
 * `§6` would read as a different colour where `§e` reads as the same one, lighter. This is
 * lossy on purpose and the field's help says so; it is not silently pretending to be exact.
 */
const CODE_ALIASES: Record<string, string> = { u: 'n', g: 'e' };

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
    .split('&').join('&&')
    .split(SECTION_ESCAPE).join('&')
    .split(SECTION_ESCAPE.toLowerCase()).join('&')
    .split(SECTION).join('&');
}
/** Something a MOTD does that is not quite what was typed, and what it will do instead. */
export interface MotdNote {
  /** The code as typed, e.g. "&g". */
  typed: string;
  /** What it becomes, or null when it is not a code at all and stays as text. */
  becomes: string | null;
  /** One sentence saying why, written for the person who typed it. */
  explanation: string;
}

/**
 * What to warn somebody about before they save a MOTD.
 *
 * Exists because the alternative is finding out from the server list. Two of the codes on the
 * generators people paste from are not what a Java client would do with them, and a third
 * class — `&` followed by a letter that is a code nowhere — is a typo that silently renders as
 * text. Saying so at the field costs nothing and saves a restart to discover.
 *
 * Only genuine surprises are reported. A code that does exactly what it looks like produces
 * nothing here, so an ordinary MOTD shows no notes at all.
 */
export function motdNotes(value: string): MotdNote[] {
  const notes = new Map<string, MotdNote>();

  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '&') continue;

    const next = value[i + 1];
    if (next === undefined) continue;
    if (next === '&') {
      i++;
      continue;
    }

    const typed = `&${next}`;
    const lower = next.toLowerCase();

    if (lower === 'u') {
      notes.set(typed, {
        typed,
        becomes: '&n',
        explanation: 'Underline. Java Edition’s own code for it is &n, so this is written as &n — it will look exactly as you meant.',
      });
    } else if (lower === 'g') {
      notes.set(typed, {
        typed,
        becomes: '&e',
        explanation:
          'Minecoin Gold is a Bedrock colour and Java Edition has no equivalent, so it is shown as yellow (&e), the nearest one. Use &6 instead if you want gold.',
      });
    } else if (!resolveFormattingCode(next)) {
      notes.set(typed, {
        typed,
        becomes: null,
        explanation:
          'Not a formatting code on Java Edition, so it stays as the text “' +
          typed +
          '”. Colours are &0–&9 and &a–&f; styles are &u, &l, &o, &m, &k and &r.',
      });
    }

    i++;
  }

  return [...notes.values()];
}
