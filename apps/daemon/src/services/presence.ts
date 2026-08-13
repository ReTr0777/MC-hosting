import { EventEmitter } from 'events';
import { getContainerByIdOrName } from './docker';
import { processManager } from './process';

/**
 * Who is on each server, and for how long.
 *
 * The existing roster lived inside processManager, so it only ever worked for PROCESS-mode servers
 * — Docker servers had no roster at all, and the panel fell back to the Server List Ping sample.
 * That sample is capped at twelve names and shuffled by the vanilla server, so diffing it between
 * polls invents joins and leaves that never happened. Playtime has to come from the log.
 *
 * This service owns a long-lived log stream per running container (independent of whether anyone
 * has the console open) and listens to processManager's existing log events for the other mode, so
 * both paths produce the same sessions.
 */

/** `[12:34:56] [Server thread/INFO]: Notch joined the game` */
const JOIN_RE = /(?:^|\]:?\s*)([a-zA-Z0-9_]{2,16})\s+(?:joined the game|logged in with entity id)/i;
const LEAVE_RE = /(?:^|\]:?\s*)([a-zA-Z0-9_]{2,16})\s+(?:left the game|lost connection)/i;
/** `UUID of player Notch is 069a79f4-44e9-4726-a5be-fca90e38aaf5` */
const UUID_RE = /UUID of player ([a-zA-Z0-9_]{2,16}) is ([0-9a-f-]{32,36})/i;

export interface PlayerSession {
  serverId: string;
  username: string;
  uuid: string | null;
  joinedAt: string;
  leftAt: string;
  seconds: number;
}

interface OpenSession {
  username: string;
  joinedAt: Date;
}

interface ServerPresence {
  online: Map<string, OpenSession>;
  uuids: Map<string, string>;
  stream: NodeJS.ReadableStream | null;
  /** Set while a reattach is pending, so a flapping container can't stack up streams. */
  reattachTimer: NodeJS.Timeout | null;
  stopped: boolean;
}

/**
 * Completed sessions wait here until the panel drains them. Bounded so a panel that is down for a
 * week can't grow the daemon's heap without limit — losing the oldest sessions is strictly better
 * than losing the daemon.
 */
const MAX_PENDING_SESSIONS = 2000;

class PresenceService extends EventEmitter {
  private servers = new Map<string, ServerPresence>();
  private pending: PlayerSession[] = [];
  private processHooked = false;

  private stateFor(serverId: string): ServerPresence {
    let state = this.servers.get(serverId);
    if (!state) {
      state = { online: new Map(), uuids: new Map(), stream: null, reattachTimer: null, stopped: false };
      this.servers.set(serverId, state);
    }
    return state;
  }

  /** Feeds one console line through join/leave/uuid detection. Safe to call with any text. */
  public ingestLine(serverId: string, line: string): void {
    if (!line) return;
    const state = this.stateFor(serverId);

    const uuidMatch = line.match(UUID_RE);
    if (uuidMatch) state.uuids.set(uuidMatch[1], uuidMatch[2].toLowerCase());

    const joinMatch = line.match(JOIN_RE);
    if (joinMatch) {
      const username = joinMatch[1];
      // A duplicate join without a leave means we missed the disconnect (log gap, stream
      // reattach). Keep the earlier start rather than resetting it — an over-long session is a
      // less misleading number than one that silently restarts every reattach.
      if (!state.online.has(username)) {
        state.online.set(username, { username, joinedAt: new Date() });
        this.emit('join', { serverId, username });
      }
      return;
    }

    const leaveMatch = line.match(LEAVE_RE);
    if (leaveMatch) this.closeSession(serverId, leaveMatch[1]);
  }

  private closeSession(serverId: string, username: string, at = new Date()): void {
    const state = this.stateFor(serverId);
    const open = state.online.get(username);
    if (!open) return;

    state.online.delete(username);
    const seconds = Math.max(0, Math.round((at.getTime() - open.joinedAt.getTime()) / 1000));

    this.pending.push({
      serverId,
      username,
      uuid: state.uuids.get(username) ?? null,
      joinedAt: open.joinedAt.toISOString(),
      leftAt: at.toISOString(),
      seconds,
    });
    if (this.pending.length > MAX_PENDING_SESSIONS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_SESSIONS);
    }

    this.emit('leave', { serverId, username, seconds });
  }

  /**
   * Attaches to a container's log stream and keeps it attached.
   *
   * Idempotent — calling it for a server that is already tracked does nothing, so it is safe to
   * call from every start path and from the daemon's boot-time sweep.
   */
  public async trackContainer(serverId: string): Promise<void> {
    const state = this.stateFor(serverId);
    state.stopped = false;
    if (state.stream) return;

    try {
      const container = await getContainerByIdOrName(serverId);
      const stream = (await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 })) as NodeJS.ReadableStream;
      state.stream = stream;

      let carry = '';
      stream.on('data', (chunk: Buffer) => {
        // Docker multiplexes stdout/stderr with an 8-byte header per frame when the container
        // has no TTY; the payload starts after it.
        let text =
          chunk.length > 8 && (chunk[0] === 1 || chunk[0] === 2) && chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0
            ? chunk.slice(8).toString('utf-8')
            : chunk.toString('utf-8');

        // A chunk can split mid-line, which would hide a join from the regex.
        text = carry + text;
        const lines = text.split(/\r?\n/);
        carry = lines.pop() ?? '';
        for (const line of lines) this.ingestLine(serverId, line);
      });

      const reattach = () => {
        state.stream = null;
        if (state.stopped || state.reattachTimer) return;
        state.reattachTimer = setTimeout(() => {
          state.reattachTimer = null;
          this.trackContainer(serverId).catch(() => {});
        }, 3000);
      };

      stream.on('end', reattach);
      stream.on('error', reattach);
    } catch (e: any) {
      state.stream = null;
      // The container may simply not exist yet; the caller's next start attempt will retry.
    }
  }

  /**
   * A stopped server has no players. Without this, everyone online at shutdown would keep an open
   * session and accumulate playtime for as long as the server stayed down.
   */
  public serverStopped(serverId: string): void {
    const state = this.stateFor(serverId);
    state.stopped = true;
    for (const username of Array.from(state.online.keys())) this.closeSession(serverId, username);

    if (state.reattachTimer) {
      clearTimeout(state.reattachTimer);
      state.reattachTimer = null;
    }
    if (state.stream) {
      try {
        (state.stream as any).destroy?.();
      } catch (e) {
        // Already gone.
      }
      state.stream = null;
    }
  }

  public getOnline(serverId: string): Array<{ username: string; uuid: string | null; sinceSeconds: number }> {
    const state = this.servers.get(serverId);
    if (!state) return [];
    const now = Date.now();
    return Array.from(state.online.values()).map((s) => ({
      username: s.username,
      uuid: state.uuids.get(s.username) ?? null,
      sinceSeconds: Math.max(0, Math.round((now - s.joinedAt.getTime()) / 1000)),
    }));
  }

  /**
   * Hands over every completed session and forgets them. The caller owns them from here — if it
   * fails to persist them they are lost, which is why the web side writes them before returning.
   */
  public drainSessions(): PlayerSession[] {
    const drained = this.pending;
    this.pending = [];
    return drained;
  }

  /** Mirrors process-mode log events into the same pipeline. Called once at daemon startup. */
  public hookProcessManager(): void {
    if (this.processHooked) return;
    this.processHooked = true;
    processManager.on('log', (payload: any) => {
      if (payload?.serverId && typeof payload.line === 'string') {
        this.ingestLine(payload.serverId, payload.line);
      }
    });
    // The child process exiting is the only event guaranteed to fire on every process-mode stop
    // path — graceful shutdown, SIGKILL and crash alike.
    processManager.on('exit', (payload: any) => {
      if (payload?.serverId) this.serverStopped(payload.serverId);
    });
  }
}

export const presenceService = new PresenceService();
