import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMotd, decodeMotd, motdNotes } from './motd';

/*
 * The reported symptom: a MOTD typed as "&f&uDumbfoolery&r&cAɴᴅ&k01101110" arrived in the
 * server list as that exact text, ampersands and all. Three separate reasons, and the tests
 * are grouped by them — the wrong introducer, the wrong encoding on disk, and a code that
 * only exists on Bedrock.
 */

test('an ampersand code becomes the escape a properties file understands', () => {
  // Not the § character itself: server.properties is read as UTF-8 only on recent versions,
  // with ISO-8859-1 as the fallback, and that fallback is what renders a raw § as "Â§".
  assert.equal(encodeMotd('&aHello'), '\u00A7aHello');
  assert.equal(encodeMotd('&f&lBold white'), '\u00A7f\u00A7lBold white');
});

test('every Java code is recognised and nothing else is', () => {
  for (const code of '0123456789abcdefklmnor') {
    assert.equal(encodeMotd(`&${code}`), `\u00A7${code}`, `&${code} should be a code`);
  }
  // Uppercase is what people type when they hold shift; the client accepts it.
  assert.equal(encodeMotd('&C&L'), '\u00A7C\u00A7L');
});

test('&u underlines, because that is what people paste in expecting', () => {
  // Generators emit &u for underline; the client's underline is §n. Written through
  // untouched it becomes §u, which on Java Edition is nothing at all — it is a Bedrock
  // material colour. That is exactly why translating it is safe: there is no competing
  // meaning to break, so the choice is between underline and silence.
  assert.equal(encodeMotd('&uDumbfoolery'), '\u00A7nDumbfoolery');
  assert.equal(encodeMotd('&U'), '\u00A7n');
  // The client's own letter keeps working, and both land on the same thing.
  assert.equal(encodeMotd('&nDumbfoolery'), '\u00A7nDumbfoolery');
});

test('a letter that is a code on neither edition stays text', () => {
  assert.equal(encodeMotd('&z&y&8x'), '&z&y\u00A78x');
});

test('prose containing an ampersand is not turned into colours', () => {
  assert.equal(encodeMotd('Bob & Alice'), 'Bob & Alice');
  assert.equal(encodeMotd('Survival & Creative'), 'Survival & Creative');
  // The one that would bite: a lowercase word after an ampersand starts with a real code.
  assert.equal(encodeMotd('Bob && Alice'), 'Bob & Alice');
});

test('a section sign pasted in directly gets the same portability', () => {
  assert.equal(encodeMotd('\u00A7aHello'), '\u00A7aHello');
});

test('what the editor shows is what was typed', () => {
  assert.equal(decodeMotd('\u00A7aHello'), '&aHello');
  assert.equal(decodeMotd('\u00a7aHello'), '&aHello');
  assert.equal(decodeMotd('\u00A7aHello'), '&aHello');
  assert.equal(decodeMotd('A Minecraft Server'), 'A Minecraft Server');
});

test('editing a MOTD twice does not mangle it', () => {
  // decode -> the editor -> encode has to land back on the same bytes, or every save drifts.
  for (const typed of ['&aHello', 'Bob & Alice', '&f&lBold', '&uDumbfoolery', 'Plain text']) {
    const onDisk = encodeMotd(typed);
    assert.equal(encodeMotd(decodeMotd(onDisk)), onDisk, `round trip failed for ${typed}`);
  }
});

test('the reported MOTD, once fixed', () => {
  // White underlined "Dumbfoolery", reset, red "Aɴᴅ", then red obfuscated digits — which is
  // the render that was expected and the one the server list now produces.
  assert.equal(
    encodeMotd('&f&uDumbfoolery&r&cAɴᴅ&k01101110'),
    '\u00A7f\u00A7nDumbfoolery\u00A7r\u00A7cAɴᴅ\u00A7k01101110'
  );
});
/*
 * The generator people are pasting from offers sixteen colours, &g, and six format buttons.
 * These walk that palette button by button, because "make sure these work" is only answerable
 * against the actual set of them.
 */

test('every colour button on the generator produces a colour', () => {
  for (const code of '0123456789abcdef') {
    assert.equal(encodeMotd(`&${code}`), `\u00A7${code}`);
  }
});

test('every format button on the generator produces a format', () => {
  // &u is the generator's underline; the rest are the client's own letters.
  assert.equal(encodeMotd('&u'), '\u00A7n');
  assert.equal(encodeMotd('&l'), '\u00A7l');
  assert.equal(encodeMotd('&o'), '\u00A7o');
  assert.equal(encodeMotd('&m'), '\u00A7m');
  assert.equal(encodeMotd('&k'), '\u00A7k');
  assert.equal(encodeMotd('&r'), '\u00A7r');
});

test('&g becomes yellow, the nearest colour Java actually has', () => {
  // §g is Minecoin Gold and Bedrock-only. Java has §0-§f and no hex in server.properties, so
  // the choice is the nearest colour or the literal text "&g" in the MOTD.
  assert.equal(encodeMotd('&gCoins'), '\u00A7eCoins');
});

test('&m and &n keep their Java meanings, not their Bedrock ones', () => {
  // On Bedrock these two are material colours; on Java they are strikethrough and underline,
  // and this writes server.properties for a Java server. Remapping them would break the two
  // format buttons that were already working.
  assert.equal(encodeMotd('&mGone'), '\u00A7mGone');
  assert.equal(encodeMotd('&nUnder'), '\u00A7nUnder');
});
/*
 * The notes are the difference between finding out at the field and finding out from the
 * server list after a restart. They must fire on exactly the surprises and stay quiet
 * otherwise — a MOTD that does what it looks like should say nothing at all.
 */

test('an ordinary MOTD raises nothing', () => {
  assert.deepEqual(motdNotes('&aWelcome &lhome'), []);
  assert.deepEqual(motdNotes('Bob && Alice'), []);
  assert.deepEqual(motdNotes('A Minecraft Server'), []);
});

test('&u is reported as the harmless rewrite it is', () => {
  const [note] = motdNotes('&uUnderlined');
  assert.equal(note.typed, '&u');
  assert.equal(note.becomes, '&n');
});

test('&g says what it becomes and what to use for real gold', () => {
  const [note] = motdNotes('&gCoins');
  assert.equal(note.typed, '&g');
  assert.equal(note.becomes, '&e');
  assert.match(note.explanation, /&6/);
});

test('a letter that is no code at all is called out as text', () => {
  const [note] = motdNotes('&zNope');
  assert.equal(note.typed, '&z');
  assert.equal(note.becomes, null);
});

test('each code is reported once, however often it appears', () => {
  assert.equal(motdNotes('&g&g&g').length, 1);
});

test('an escaped ampersand is not read as the code after it', () => {
  // "&&g" is a literal & followed by the letter g, not the &g colour.
  assert.deepEqual(motdNotes('&&g'), []);
});
