import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrpPreset, validateFrpAddr, FRP_DEFAULT_PORT } from './frp';

/**
 * These two functions decide what an exported node config carries, so the cases below
 * are really about what a node ends up configured with when someone imports it.
 *
 * The address is the deciding field throughout: a tunnel with no server to reach is
 * not a tunnel, and a preset built around a blank address would overwrite settings on
 * a node that was working perfectly well.
 */

test('an address alone is enough to produce a preset', () => {
  const preset = buildFrpPreset('tunnel.example.com', undefined, undefined);
  assert.deepEqual(preset, { serverAddr: 'tunnel.example.com', serverPort: FRP_DEFAULT_PORT, token: '' });
});

test('no address means no preset, so import leaves the node alone', () => {
  assert.equal(buildFrpPreset('', 7000, 'secret'), null);
  assert.equal(buildFrpPreset(null, 7000, 'secret'), null);
  assert.equal(buildFrpPreset(undefined, 7000, 'secret'), null);
  assert.equal(buildFrpPreset('   ', 7000, 'secret'), null);
});

test('surrounding whitespace is not part of the address or token', () => {
  const preset = buildFrpPreset('  tunnel.example.com  ', 7000, '  secret  ');
  assert.equal(preset?.serverAddr, 'tunnel.example.com');
  assert.equal(preset?.token, 'secret');
});

test('a port arrives as a string from the settings table and is still a number', () => {
  assert.equal(buildFrpPreset('host', '7500', '')?.serverPort, 7500);
});

test('an unusable port falls back rather than discarding the address and token', () => {
  for (const port of ['', 'abc', 0, -1, 70000, null, undefined]) {
    const preset = buildFrpPreset('host', port as never, 'secret');
    assert.equal(preset?.serverPort, FRP_DEFAULT_PORT, `port ${JSON.stringify(port)}`);
    assert.equal(preset?.token, 'secret');
  }
});

test('a pasted browser URL is rejected, because frpc wants a bare host', () => {
  for (const url of ['http://panel.example.com', 'https://panel.example.com', 'HTTP://panel.example.com']) {
    const result = validateFrpAddr(url);
    assert.equal(result.ok, false, url);
  }
});

test('a host with a port, a path, or a space is rejected', () => {
  assert.equal(validateFrpAddr('panel.example.com:7000').ok, false);
  assert.equal(validateFrpAddr('panel.example.com/frp').ok, false);
  assert.equal(validateFrpAddr('panel example').ok, false);
});

test('a blank address is legitimate — it means this deployment has no tunnel', () => {
  const result = validateFrpAddr('   ');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, '');
});

test('a plain host or IP passes, trimmed', () => {
  for (const addr of ['panel.example.com', '192.168.50.220', '86.94.201.51']) {
    const result = validateFrpAddr(`  ${addr} `);
    assert.equal(result.ok, true, addr);
    assert.equal(result.ok && result.value, addr);
  }
});
