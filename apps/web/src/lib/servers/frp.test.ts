import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrpPreset, validateFrpAddr, FRP_DEFAULT_PORT } from './frp';

/*
 * The preset decides what an exported node config carries. The cases that matter are
 * the ones that would produce a node which looks configured and silently never
 * tunnels: a half-filled preset, or an address pasted out of a browser.
 */

test('no address means no tunnel, whatever else is filled in', () => {
  assert.equal(buildFrpPreset('', 7000, 'secret'), null);
  assert.equal(buildFrpPreset(null, 7000, 'secret'), null);
  assert.equal(buildFrpPreset('   ', 7000, 'secret'), null);
});

test('an address alone is enough to be a tunnel', () => {
  const preset = buildFrpPreset('frp.example.com', null, null);
  assert.deepEqual(preset, { serverAddr: 'frp.example.com', serverPort: FRP_DEFAULT_PORT, token: '' });
});

test('the port falls back rather than sinking the whole preset', () => {
  // Whatever the port is, the address and token were entered deliberately.
  for (const bad of ['', 'abc', '0', '70000', '-1', null, undefined]) {
    const preset = buildFrpPreset('frp.example.com', bad as never, 'tok');
    assert.equal(preset?.serverPort, FRP_DEFAULT_PORT, `port ${String(bad)} should fall back`);
    assert.equal(preset?.token, 'tok');
  }
});

test('a real port is kept, as a number, from either a string or a number', () => {
  assert.equal(buildFrpPreset('frp.example.com', '7100', '')?.serverPort, 7100);
  assert.equal(buildFrpPreset('frp.example.com', 7100, '')?.serverPort, 7100);
});

test('surrounding whitespace never reaches the node', () => {
  const preset = buildFrpPreset('  frp.example.com  ', 7000, '  tok  ');
  assert.equal(preset?.serverAddr, 'frp.example.com');
  assert.equal(preset?.token, 'tok');
});

test('an empty address is accepted — it means this deployment has no tunnel', () => {
  assert.deepEqual(validateFrpAddr(''), { ok: true, value: '' });
  assert.deepEqual(validateFrpAddr('   '), { ok: true, value: '' });
});

test('a browser URL is rejected, because frpc wants a bare host', () => {
  for (const url of ['https://frp.example.com', 'http://frp.example.com', 'tcp://frp.example.com']) {
    const result = validateFrpAddr(url);
    assert.equal(result.ok, false, `${url} should be rejected`);
  }
});

test('a host with a port, a path or a space is rejected with a specific reason', () => {
  assert.match((validateFrpAddr('frp.example.com:7000') as { error: string }).error, /port field/);
  assert.match((validateFrpAddr('frp.example.com/tunnel') as { error: string }).error, /no path/);
  assert.match((validateFrpAddr('frp example com') as { error: string }).error, /spaces/);
});

test('plain hosts and bare IPs pass', () => {
  for (const host of ['frp.example.com', 'localhost', '10.0.0.5', 'node-1.internal']) {
    assert.deepEqual(validateFrpAddr(host), { ok: true, value: host });
  }
});
