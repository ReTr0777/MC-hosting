import fs from 'fs';
import path from 'path';

/**
 * Docker Desktop's own settings, for the two that decide whether a node survives a reboot.
 *
 * A machine hosting game servers should bring Docker up on its own and do it quietly: the
 * engine starting at login, and its window not opening on top of whatever the owner is
 * doing. Both live in Docker's settings file, not in anything this app controls.
 *
 * Deliberately narrow. Resource limits, the WSL backend, networking — all of them are
 * reachable from this file and all of them can leave Docker unable to start, on a machine
 * whose owner did not ask us to touch it. Two booleans is the whole of what is worth the
 * risk; everything else stays Docker's own settings screen.
 */

/** Both filenames Docker has used, newest first. 4.34 renamed and re-cased the whole file. */
const SETTINGS_FILES = ['settings-store.json', 'settings.json'];

/** The same setting in the two casings Docker has used for it. */
const AUTO_START_KEYS = ['AutoStart', 'autoStart'];
const NO_UI_KEYS = ['OpenUIOnStartupDisabled', 'openUIOnStartupDisabled'];

export interface DockerSettingsResult {
  ok: boolean;
  detail: string;
  /** True when the file was changed; false when it already said what we wanted. */
  changed: boolean;
}

function settingsPath(): string | null {
  const base = process.env.APPDATA;
  if (!base) return null;
  for (const name of SETTINGS_FILES) {
    const candidate = path.join(base, 'Docker', name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable is not usable.
    }
  }
  return null;
}

/**
 * Sets a key whichever way this Docker version spells it.
 *
 * Only ever writes a key the file already has. Docker ignores names it does not recognise,
 * so inventing one would silently do nothing and report success — worse than saying the
 * setting could not be found.
 */
function patchKey(doc: Record<string, unknown>, names: string[], value: boolean): boolean {
  for (const name of names) {
    if (name in doc) {
      if (doc[name] === value) return false;
      doc[name] = value;
      return true;
    }
  }
  return false;
}

/**
 * Makes Docker Desktop start with Windows, without opening its window.
 *
 * Applied while Docker is stopped wherever possible: it rewrites this file from memory
 * when it exits, so a change made underneath a running instance is liable to be undone at
 * the least convenient moment. The caller says which case it is in, and the message says
 * what that means for the user rather than claiming a success that may not survive.
 */
export function configureDockerAutoStart(dockerRunning: boolean): DockerSettingsResult {
  const file = settingsPath();
  if (!file) {
    return {
      ok: false,
      changed: false,
      detail:
        'Docker Desktop has no settings file on this machine yet. Start it once, then try again — ' +
        'the app will launch Docker for you in the meantime.',
    };
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err: any) {
    return { ok: false, changed: false, detail: `Docker's settings file could not be read: ${err.message}` };
  }

  const startChanged = patchKey(doc, AUTO_START_KEYS, true);
  const uiChanged = patchKey(doc, NO_UI_KEYS, true);

  if (!startChanged && !uiChanged) {
    // Either it already said this, or this Docker version spells them differently. The
    // second is the one worth mentioning, and cannot be told apart from here.
    const known = AUTO_START_KEYS.some((k) => k in doc);
    return {
      ok: known,
      changed: false,
      detail: known
        ? 'Docker Desktop was already set to start with Windows.'
        : 'This version of Docker Desktop keeps those settings elsewhere. Set "Start Docker Desktop when you sign in" in its own settings screen.',
    };
  }

  try {
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  } catch (err: any) {
    return { ok: false, changed: false, detail: `Docker's settings file could not be written: ${err.message}` };
  }

  return {
    ok: true,
    changed: true,
    detail: dockerRunning
      ? 'Docker Desktop will start with Windows. Restart Docker once to be sure it keeps the change — ' +
        'it rewrites this file when it exits.'
      : 'Docker Desktop will start with Windows, with its window closed.',
  };
}
