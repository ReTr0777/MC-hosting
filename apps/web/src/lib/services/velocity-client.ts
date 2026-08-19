export interface VelocityNodeCredentials {
  host: string;
  port: number; // usually 3001
}

export class VelocityClient {
  private baseUrl: string;

  constructor(node: VelocityNodeCredentials) {
    this.baseUrl = `http://${node.host}:${node.port}`;
  }

  // Overriding baseUrl for plugin
  public setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  /**
   * @param hostnames Addresses this backend answers for, e.g. `survival.example.com`. The
   *   proxy registers servers under their id, which nobody types, so without these there is
   *   nothing to turn a player's address into a destination.
   */
  public async registerServer(
    name: string,
    address: string,
    port: number,
    hostnames: string[] = []
  ): Promise<void> {
    const url = `${this.baseUrl}/api/servers`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, address, port, hostnames }),
    });

    if (!res.ok) {
      throw new Error(`Velocity error registering server: ${res.status}`);
    }
  }

  public async unregisterServer(name: string): Promise<void> {
    const url = `${this.baseUrl}/api/servers?name=${name}`;
    const res = await fetch(url, {
      method: 'DELETE',
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Velocity error unregistering server: ${res.status}`);
    }
  }
}
