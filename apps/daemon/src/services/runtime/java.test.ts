import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJavaCmd } from './process';

/**
 * JAVA_BIN is how a node that is not the Docker image says where its JDK is.
 *
 * The version-based selection underneath looks for /opt/java/openjdk-NN, which only
 * the Docker image has. A portable node — Termux on a phone, a Pi, a plain VPS —
 * has its JDK wherever the package manager put it, so these cases are really about
 * such a node being able to name its own Java at all.
 */

function withJavaBin(value: string | undefined, run: () => void) {
  const previous = process.env.JAVA_BIN;
  if (value === undefined) delete process.env.JAVA_BIN;
  else process.env.JAVA_BIN = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.JAVA_BIN;
    else process.env.JAVA_BIN = previous;
  }
}

test('JAVA_BIN is used whatever the Minecraft version asks for', () => {
  withJavaBin('/data/data/com.termux/files/usr/bin/java', () => {
    for (const version of ['1.16.5', '1.20.1', '1.21.4', '26.2', undefined]) {
      assert.equal(resolveJavaCmd(version), '/data/data/com.termux/files/usr/bin/java', `version ${version}`);
    }
  });
});

test('without JAVA_BIN the node still names a runnable command', () => {
  withJavaBin(undefined, () => {
    // Off the Docker image none of the /opt/java paths exist, so this is PATH lookup.
    // The point is that it is never empty — an empty command spawns nothing.
    assert.ok(resolveJavaCmd('1.20.1').length > 0);
  });
});

test('an empty JAVA_BIN is ignored rather than spawning nothing', () => {
  let unset = '';
  withJavaBin(undefined, () => {
    unset = resolveJavaCmd('1.20.1');
  });

  // Compared against the unset result rather than a literal: the fallback depends on
  // which /opt/java directories the host has, and this is about JAVA_BIN='' being
  // treated as "not set" on any of them.
  withJavaBin('', () => {
    assert.equal(resolveJavaCmd('1.20.1'), unset);
  });
});
