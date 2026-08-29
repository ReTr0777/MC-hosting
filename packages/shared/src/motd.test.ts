import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMotd, decodeMotd, motdNotes } from './motd';

/*
 * A MOTD typed as "&f&uDumbfoolery&r&cAɴᴅ&k01101110" reached the server list as that exact
 * text. Three reasons — the wrong introducer, the wrong encoding on disk, and codes the
 * generators emit that a Java client has no letter for — and the tests are grouped by them.
 *
 * ESC is built with String.raw rather than written as a '\u00A7' literal on purpose. The
 * first version of these tests used the literal, an editing layer collapsed the doubled
 * backslash in the source *and* in the assertions, and the suite went green while encodeMotd
 * emitted a raw § — the one thing the escape exists to avoid. Both sides being wrong in the
 * same direction is exactly what an assertion cannot catch, so the byte-level test below
 * checks the character codes instead of comparing against another string.
 */
const ESC = String.raw`\u00A7`;

test('the output is the escape text, not a section character', () => {
  const out = encodeMotd('&aHello');
  assert.equal(out.includes('\u00A7'), false, 'a raw § is what breaks on ISO-8859-1 fallback');
  assert.deepEqual(
    [...out].slice(0, 6).map((c) => c.charCodeAt(0)),
    [92, 117, 48, 48, 65, 55],
    'must be the six characters backslash u 0 0 A 7'
  );
});

test('an ampersand code becomes the escape a properties file understands', () => {
  assert.equal(encodeMotd('&aHello'), `${ESC}aHello`);
  assert.equal(encodeMotd('&f&lBold white'), `${ESC}f${ESC}lBold white`);
});

test('every colour button on the generator produces a colour', () => {
  for (const code of '0123456789abcdef') {
    assert.equal(encodeMotd(`&${code}`), `${ESC}${code}`);
  }
  // Uppercase is what people type holding shift; the client accepts either.
  assert.equal(encodeMotd('&C&L'), `${ESC}C${ESC}L`);
});

test('every format button on the generator produces a format', () => {
  assert.equal(encodeMotd('&u'), `${ESC}n`, 'the generator labels &u underline');
  assert.equal(encodeMotd('&l'), `${ESC}l`);
  assert.equal(encodeMotd('&o'), `${ESC}o`);
  assert.equal(encodeMotd('&m'), `${ESC}m`);
  assert.equal(encodeMotd('&k'), `${ESC}k`);
  assert.equal(encodeMotd('&r'), `${ESC}r`);
});

test('&g becomes yellow, the nearest colour Java actually has', () => {
  // §g is Minecoin Gold and Bedrock-only. Java has §0-§f and no hex in server.properties, so
  // the choice is the nearest colour or the literal text "&g" sitting in the MOTD.
  assert.equal(encodeMotd('&gCoins'), `${ESC}eCoins`);
});

test('&m and &n keep their Java meanings, not their Bedrock ones', () => {
  // Material colours on Bedrock; strikethrough and underline on Java, which is what this
  // file is written for. Remapping them would break two buttons that already worked.
  assert.equal(encodeMotd('&mGone'), `${ESC}mGone`);
  assert.equal(encodeMotd('&nUnder'), `${ESC}nUnder`);
});

test('a letter that is a code on neither edition stays text', () => {
  assert.equal(encodeMotd('&z&y'), '&z&y');
});

test('prose containing an ampersand is not turned into colours', () => {
  assert.equal(encodeMotd('Bob & Alice'), 'Bob & Alice');
  assert.equal(encodeMotd('Survival & Creative'), 'Survival & Creative');
  // The one that would bite: a lowercase word after an ampersand starts with a real code.
  assert.equal(encodeMotd('Bob && Alice'), 'Bob & Alice');
});

test('a section sign pasted in directly gets the same portability', () => {
  assert.equal(encodeMotd('\u00A7aHello'), `${ESC}aHello`);
});

test('what the editor shows is what was typed', () => {
  assert.equal(decodeMotd(`${ESC}aHello`), '&aHello');
  assert.equal(decodeMotd(`${ESC.toLowerCase()}aHello`), '&aHello');
  assert.equal(decodeMotd('\u00A7aHello'), '&aHello');
  assert.equal(decodeMotd('A Minecraft Server'), 'A Minecraft Server');
  assert.equal(decodeMotd('Bob & Alice'), 'Bob && Alice');
});

test('editing a MOTD twice does not mangle it', () => {
  // decode -> the editor -> encode has to land back on the same bytes, or every save drifts.
  for (const typed of ['&aHello', 'Bob & Alice', '&f&lBold', '&uUnder', '&gCoins', 'Plain']) {
    const onDisk = encodeMotd(typed);
    assert.equal(encodeMotd(decodeMotd(onDisk)), onDisk, `round trip failed for ${typed}`);
  }
});

test('the reported MOTD, once fixed', () => {
  // White underlined "Dumbfoolery", reset, red "Aɴᴅ", then red obfuscated digits.
  assert.equal(
    encodeMotd('&f&uDumbfoolery&r&cAɴᴅ&k01101110'),
    `${ESC}f${ESC}nDumbfoolery${ESC}r${ESC}cAɴᴅ${ESC}k01101110`
  );
});

/*
 * The notes are the difference between finding out at the field and finding out from the
 * server list after a restart. They must fire on exactly the surprises and stay quiet
 * otherwise — a warning that fires on ordinary input is noise, and noise gets ignored.
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
  assert.deepEqual(motdNotes('&&g'), []);
});
