import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMotd, decodeMotd } from './motd';

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
  assert.equal(encodeMotd('&z&y&q'), '&z&y&q');
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
