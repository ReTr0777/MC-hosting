import fs from 'fs';
import path from 'path';
import { Game, isGame } from '@mc-manager/shared';
import { getConfig } from '../config';
import { GameDefinition } from './types';
import { terraria } from './terraria';

export * from './types';

/**
 * Registry of non-Minecraft game modules.
 *
 * Minecraft is deliberately absent — it is served by the original
 * `startProcess` body, and this registry must never be able to redirect it.
 */
const registry = new Map<string, GameDefinition>();

export function registerGame(definition: GameDefinition): void {
  registry.set(definition.id, definition);
}

/**
 * The definition for a game, or undefined for Minecraft and for anything not
 * registered.
 *
 * Minecraft always returns undefined by design — it is served by the original
 * `startProcess` body, which this registry must never be able to redirect.
 */
export function getGame(game: string | undefined): GameDefinition | undefined {
  if (!game || game === Game.MINECRAFT) return undefined;
  return registry.get(game);
}

/**
 * True when this DTO should be dispatched away from the Minecraft path.
 *
 * Absent, empty and unrecognised all mean Minecraft, so a DTO written by an
 * older panel — or a `craftcontrol-meta.json` written before the field existed
 * — can never be read as "some other game".
 */
export function isNonMinecraftGame(game: string | undefined): boolean {
  return isGame(game) && game !== Game.MINECRAFT;
}

export function registeredGames(): string[] {
  return [...registry.keys()];
}

/**
 * The game a server belongs to, read from the metadata written at create time.
 *
 * Returns undefined for Minecraft and for anything unreadable, so callers can
 * pass the result straight to `getGame` and fall through to the Minecraft path.
 */
export function gameOfServer(serverId: string): string | undefined {
  const metaPath = path.join(getConfig().dataDir, serverId, 'craftcontrol-meta.json');
  if (!fs.existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')).game;
  } catch {
    return undefined;
  }
}

registerGame(terraria);
