import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinAddress } from './join-address';

/*
 * The console header used to show node.host:serverPort — where the server is running, not
 * where a player connects. On a node at home that is a LAN address, so the one field on the
 * page whose entire job is "paste this into Minecraft" was handing out something that only
 * works from inside the owner's house.
 */

const NODE = { node: { host: '192.168.50.6' }, serverPort: 24007 };

test('a server with a subdomain is reached by name, with no port', () => {
  // The proxy binds :25565, which is the port a client assumes, and routes on the hostname.
  // Appending 24007 here would send the player past the proxy to a port it does not serve.
  assert.equal(
    joinAddress({ ...NODE, subdomain: 'survival', domain: 'example.com' }, 'retr0net.nl'),
    'survival.example.com'
  );
});

test('a server with no domain of its own falls back to the installation default', () => {
  assert.equal(
    joinAddress({ ...NODE, subdomain: 'survival', domain: null }, 'retr0net.nl'),
    'survival.retr0net.nl'
  );
});

test('a server with no subdomain still gets a usable direct address', () => {
  // There is genuinely no name pointing at it, so host and port is not a fallback for a
  // failure — it is the only way in, and the port matters here.
  assert.equal(joinAddress({ ...NODE, subdomain: null, domain: 'example.com' }, 'retr0net.nl'), '192.168.50.6:24007');
  assert.equal(joinAddress({ ...NODE, subdomain: '   ', domain: null }, 'retr0net.nl'), '192.168.50.6:24007');
});

test('the address is lowercased, because hostnames are', () => {
  assert.equal(
    joinAddress({ ...NODE, subdomain: 'SurVival', domain: 'Example.COM' }, 'retr0net.nl'),
    'survival.example.com'
  );
});
