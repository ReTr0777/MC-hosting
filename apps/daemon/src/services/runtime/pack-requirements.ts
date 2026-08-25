import fs from 'fs';
import path from 'path';

/**
 * What a pack's own mods say they need.
 *
 * The loader jar in a server directory carries no Minecraft version — `fabric-server-launch
 * .jar` is the same filename whatever it launches — so a Fabric pack left on LATEST looked
 * fine right up until the loader refused it. The mods know, though: every Fabric mod
 * declares `depends.minecraft` in fabric.mod.json, and every Forge mod a `versionRange`
 * against minecraft in mods.toml.
 *
 * Reading them turns "Incompatible mods found" after a failed start into a statement of
 * which version the pack is for, before one.
 */

export interface PackRequirements {
  /** The Minecraft version the pack pins itself to, when its mods agree on one. */
  minecraftVersion: string | null;
  /** How many mods pinned that exact version — the weight behind the answer. */
  pinnedBy: number;
  modsScanned: number;
  /** True when mods depend on the Fabric API and no jar present provides it. */
  fabricApiMissing: boolean;
}

/** Bounded so a 400-mod pack does not turn a preflight into a minute of unzipping. */
const MAX_MODS_SCANNED = 400;

/**
 * The exact version a constraint pins, or null when it allows a range.
 *
 * Only unambiguous pins are used. ">=1.20 <1.20.2-" names two versions and means neither of
 * them specifically; "[1.20.1]" and "1.20.1" mean exactly one. Counting the loose ones
 * would let a mod that supports six versions outvote the one mod that supports a single
 * version — and it is the narrow one that decides what the pack can actually run on.
 */
export function exactVersionPin(constraint: string): string | null {
  const trimmed = constraint.trim();

  // Maven-style single-version range, as Forge writes it.
  const bracketed = /^\[\s*(\d+\.\d+(?:\.\d+)?)\s*\]$/.exec(trimmed);
  if (bracketed) return bracketed[1];

  // A bare version, as Fabric writes it when a mod supports exactly one.
  const bare = /^=?\s*(\d+\.\d+(?:\.\d+)?)$/.exec(trimmed);
  if (bare) return bare[1];

  return null;
}

function readEntry(zip: any, name: string): string | null {
  try {
    const entry = zip.getEntry(name);
    return entry ? entry.getData().toString('utf8') : null;
  } catch {
    return null;
  }
}

/** The minecraft constraint and identity out of one mod jar, in either loader's format. */
function readModMetadata(jarPath: string): {
  minecraft: string | null;
  id: string | null;
  provides: string[];
  needsFabricApi: boolean;
} | null {
  let zip: any;
  try {
    const AdmZip = require('adm-zip');
    zip = new AdmZip(jarPath);
  } catch {
    return null;
  }

  const fabricJson = readEntry(zip, 'fabric.mod.json');
  if (fabricJson) {
    try {
      // Some mods ship fabric.mod.json with trailing commas or comments; a parse failure
      // is one mod's worth of missing information, never a reason to stop.
      const doc = JSON.parse(fabricJson);
      const depends = doc.depends || {};
      const ids = Object.keys(depends);
      return {
        minecraft: typeof depends.minecraft === 'string' ? depends.minecraft : null,
        id: typeof doc.id === 'string' ? doc.id : null,
        provides: Array.isArray(doc.provides) ? doc.provides : [],
        needsFabricApi: ids.includes('fabric') || ids.includes('fabric-api'),
      };
    } catch {
      return null;
    }
  }

  const modsToml = readEntry(zip, 'META-INF/mods.toml') || readEntry(zip, 'META-INF/neoforge.mods.toml');
  if (modsToml) {
    // Only the minecraft dependency's versionRange is wanted, and mods.toml is small
    // enough that a targeted match beats pulling in a TOML parser for one field.
    const block = /modId\s*=\s*["']minecraft["'][\s\S]{0,400}?versionRange\s*=\s*["']([^"']+)["']/i.exec(modsToml);
    return { minecraft: block ? block[1] : null, id: null, provides: [], needsFabricApi: false };
  }

  return null;
}

export function packRequirements(serverDir: string): PackRequirements {
  const modsDir = path.join(serverDir, 'mods');
  let jars: string[] = [];
  try {
    jars = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar')).slice(0, MAX_MODS_SCANNED);
  } catch {
    return { minecraftVersion: null, pinnedBy: 0, modsScanned: 0, fabricApiMissing: false };
  }

  const pins = new Map<string, number>();
  const provided = new Set<string>();
  let wantsFabricApi = false;
  let scanned = 0;

  for (const jar of jars) {
    const meta = readModMetadata(path.join(modsDir, jar));
    if (!meta) continue;
    scanned++;

    if (meta.id) provided.add(meta.id);
    for (const p of meta.provides) provided.add(p);
    if (meta.needsFabricApi) wantsFabricApi = true;

    if (meta.minecraft) {
      const pin = exactVersionPin(meta.minecraft);
      if (pin) pins.set(pin, (pins.get(pin) || 0) + 1);
    }
  }

  let minecraftVersion: string | null = null;
  let pinnedBy = 0;
  for (const [version, count] of pins) {
    if (count > pinnedBy) {
      minecraftVersion = version;
      pinnedBy = count;
    }
  }

  return {
    minecraftVersion,
    pinnedBy,
    modsScanned: scanned,
    // Only claimed when mods were actually read. An unreadable mods folder must not be
    // reported as a missing dependency.
    fabricApiMissing: wantsFabricApi && scanned > 0 && !provided.has('fabric') && !provided.has('fabric-api'),
  };
}
