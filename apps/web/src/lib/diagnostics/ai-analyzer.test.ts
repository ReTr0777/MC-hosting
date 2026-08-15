import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAiUsable, isLocalEndpoint } from './ai-analyzer';

/**
 * The panel normally runs in a bridged container, so "local" has to mean the operator's
 * whole network — not just loopback. Getting this wrong silently disables the fallback.
 */

test('recognises self-hosted endpoints reachable from a bridged container', () => {
  for (const url of [
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
    'http://host.docker.internal:11434/v1',
    'http://192.168.50.220:11434/v1', // Unraid host on the LAN
    'http://10.0.0.5:11434/v1',
    'http://172.17.0.4:11434/v1',     // docker bridge subnet
    'http://ollama:11434/v1',         // container name on a shared network
    'http://tower.local:11434/v1',
  ]) {
    assert.equal(isLocalEndpoint(url), true, `${url} should count as local`);
  }
});

test('treats public endpoints as remote', () => {
  for (const url of [
    'https://api.openai.com/v1',
    'https://openrouter.ai/api/v1',
    'http://172.32.0.1:11434/v1', // just outside the private 172.16-31 range
    'http://8.8.8.8:11434/v1',
    'not a url',
  ]) {
    assert.equal(isLocalEndpoint(url), false, `${url} should count as remote`);
  }
});

test('a key is required for remote endpoints but not for self-hosted ones', () => {
  const base = { enabled: true, model: 'qwen2.5:7b-instruct', apiKey: '' };

  assert.equal(isAiUsable({ ...base, baseUrl: 'http://192.168.50.220:11434/v1' }), true);
  assert.equal(isAiUsable({ ...base, baseUrl: 'https://api.openai.com/v1' }), false);
  assert.equal(isAiUsable({ ...base, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' }), true);

  // Disabled always wins, however it is configured.
  assert.equal(isAiUsable({ ...base, enabled: false, baseUrl: 'http://192.168.50.220:11434/v1' }), false);
});
