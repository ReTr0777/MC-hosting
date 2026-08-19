import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyHostnames } from './proxy-sync';

/**
 * This is what the proxy routes on. Get it wrong and a player typing their own address
 * lands in limbo forever, because nothing there claims the name they used.
 */

test('a server with a subdomain is reachable at subdomain.domain', () => {
  assert.deepEqual(proxyHostnames({ subdomain: 'survival', domain: 'example.com' }, 'fallback.net'), [
    'survival.example.com',
  ]);
});

test('a server with no domain of its own falls back to the system default', () => {
  // The panel only stores a domain when someone overrode it, so this is the common case.
  assert.deepEqual(proxyHostnames({ subdomain: 'survival', domain: null }, 'example.com'), [
    'survival.example.com',
  ]);
});

test('a server with no subdomain claims no hostname at all', () => {
  // Claiming one would be worse than claiming none: an empty subdomain would register the
  // bare domain and swallow every player who typed it, whichever server they wanted.
  assert.deepEqual(proxyHostnames({ subdomain: null, domain: 'example.com' }, 'fallback.net'), []);
  assert.deepEqual(proxyHostnames({ subdomain: '   ', domain: 'example.com' }, 'fallback.net'), []);
});

test('hostnames are lowercased, because what the client sends is whatever was typed', () => {
  assert.deepEqual(proxyHostnames({ subdomain: 'SurVival', domain: 'Example.COM' }, 'fallback.net'), [
    'survival.example.com',
  ]);
});
