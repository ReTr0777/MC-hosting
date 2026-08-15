import fs from 'fs';
import path from 'path';

/*
 * An installed app has nowhere to print to: Electron on Windows is a GUI binary with
 * no attached console, so anything written to stdout is simply lost. Without a file
 * on disk there is no way to find out why a node failed to come up on someone
 * else's machine.
 */

const MAX_BYTES = 2 * 1024 * 1024;

export class FileLogger {
  private readonly file: string;

  constructor(userDataPath: string) {
    const dir = path.join(userDataPath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'node.log');
    this.rotateIfLarge();
  }

  get path(): string {
    return this.file;
  }

  private rotateIfLarge(): void {
    try {
      if (fs.statSync(this.file).size > MAX_BYTES) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
    } catch {
      // No log yet, or it vanished under us. Either way there is nothing to rotate.
    }
  }

  write(scope: string, message: string): void {
    const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
    try {
      fs.appendFileSync(this.file, line);
    } catch {
      // Logging must never be the thing that takes the app down.
    }
  }
}
