import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredJavaMajor,
  parseJavaMajor,
  explainClassVersionError,
  javaVersionProblem,
  clearJavaVersionCache,
  evaluateJava,
  JAVA_PREFERENCE,
} from './java-version';

/**
 * The case this exists for: a phone running Termux, whose newest available JDK is 21,
 * being asked to start Minecraft 26.2. That launch cannot work, and the only signal
 * it used to give was a Fabric loader stack trace ending in two class-file numbers.
 */

test('the versions that need Java 25', () => {
  for (const v of ['26.2', '26.1', '25.0', '1.22']) {
    assert.equal(requiredJavaMajor(v), 25, v);
  }
});

test('1.21 and later need Java 21', () => {
  for (const v of ['1.21', '1.21.4', '1.99.0']) {
    assert.equal(requiredJavaMajor(v), 21, v);
  }
});

test('older versions need Java 17', () => {
  for (const v of ['1.16.5', '1.18.2', '1.20.1']) {
    assert.equal(requiredJavaMajor(v), 17, v);
  }
});

test('an unknown version assumes the newest rather than the oldest', () => {
  // Guessing low would launch a modern jar on an old JVM, which is the failure this
  // is here to prevent. Guessing high at worst refuses a server that might have run.
  assert.equal(requiredJavaMajor(undefined), 25);
  assert.equal(requiredJavaMajor(''), 25);
});

test('every requirement has a JDK preference, best first', () => {
  for (const required of [17, 21, 25]) {
    const preference = JAVA_PREFERENCE[required];
    assert.ok(preference?.length, `no preference for ${required}`);
    assert.equal(preference[0], required, `${required} should prefer its own JDK`);
    // A newer JVM runs older jars, never the reverse.
    for (const fallback of preference.slice(1)) assert.ok(fallback > required);
  }
});

test('the JVM version is read from the properties output', () => {
  assert.equal(parseJavaMajor('    java.specification.version = 21'), 21);
  assert.equal(parseJavaMajor('java.specification.version = 25\n'), 25);
});

test('the version banner is read when properties are absent', () => {
  assert.equal(parseJavaMajor('openjdk version "21.0.5" 2024-10-15'), 21);
  assert.equal(parseJavaMajor('java version "17.0.9" 2023-10-17'), 17);
});

test('Java 8 and earlier report their major second', () => {
  assert.equal(parseJavaMajor('java version "1.8.0_402"'), 8);
  assert.equal(parseJavaMajor('java.specification.version = 1.8'), 8);
});

test('output with no version in it yields nothing rather than a wrong number', () => {
  assert.equal(parseJavaMajor(''), null);
  assert.equal(parseJavaMajor('bash: java: command not found'), null);
});

test('a class-version error is translated into Java versions', () => {
  // The real line, from a Galaxy S10 running Termux's Java 21 against Fabric 26.2.
  const line =
    'Caused by: java.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been ' +
    'compiled by a more recent version of the Java Runtime (class file version 69.0), this ' +
    'version of the Java Runtime only recognizes class file versions up to 65.0';

  assert.equal(explainClassVersionError(line), 'This file needs Java 25, but the JVM running it is Java 21.');
});

test('an ordinary log line is not mistaken for one', () => {
  assert.equal(explainClassVersionError('[Server thread/INFO]: Done (12.3s)! For help, type "help"'), null);
  assert.equal(explainClassVersionError(''), null);
});

test('the S10 case: Java 21 asked for Minecraft 26.2', () => {
  const problem = evaluateJava('/data/data/com.termux/files/usr/bin/java', '26.2', 21);

  assert.ok(problem);
  assert.match(problem, /requires Java 25/);
  assert.match(problem, /has Java 21/);
  // The remedies matter as much as the diagnosis — this is read by whoever owns the
  // node, who can install a JDK or pick another version but cannot read source.
  assert.match(problem, /JAVA_BIN/);
  assert.match(problem, /runs on Java 21/);
});

test('a Java new enough for the version is no problem', () => {
  assert.equal(evaluateJava('/opt/java/openjdk-25/bin/java', '26.2', 25), null);
  assert.equal(evaluateJava('java', '1.20.1', 17), null);
});

test('a newer Java than needed is fine, since it runs older jars', () => {
  assert.equal(evaluateJava('java', '1.20.1', 25), null);
  assert.equal(evaluateJava('java', '1.21.4', 25), null);
});

test('an unreadable version does not block the launch', () => {
  // The probe failing is not evidence the JDK is wrong, and a node that cannot be
  // vetted should still be allowed to try.
  assert.equal(evaluateJava('java', '26.2', null), null);
});

test('a node whose Java is too old is told which version it needs', async () => {
  clearJavaVersionCache();
  // `node --version` prints "v20.x", which carries no Java version — the probe then
  // reports nothing and the check must not block on a JDK it could not read.
  const unreadable = await javaVersionProblem(process.execPath, '26.2');
  assert.equal(unreadable, null);
});

test('a JDK that cannot be run at all does not block the launch', async () => {
  clearJavaVersionCache();
  // The real spawn reports a missing runtime with a message written for it. Failing
  // here instead would replace that with a version complaint about nothing.
  const problem = await javaVersionProblem('definitely-not-a-real-java-binary', '26.2');
  assert.equal(problem, null);
});
