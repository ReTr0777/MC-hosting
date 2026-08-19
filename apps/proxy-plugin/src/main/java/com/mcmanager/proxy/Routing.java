package com.mcmanager.proxy;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Who is trying to reach which backend.
 *
 * Two questions, and the proxy previously answered neither. The first is which server a
 * connecting player actually wants: they typed a hostname, and something has to turn that
 * into one of the registered backends. The second is which server a player parked in limbo
 * is waiting for, so they are sent to that one and not to whichever backend happened to be
 * first in the list — with a single server that mistake is invisible, and with two it throws
 * people at each other's worlds.
 *
 * Backends are registered by the panel under their server id, which no player will ever
 * type, so the hostnames arrive with the registration and are kept here alongside it.
 */
final class Routing {

    /** Lowercased hostname -> registered server name (the panel's server id). */
    private final Map<String, String> hostnames = new ConcurrentHashMap<>();

    /** Player -> the backend they are waiting in limbo for. */
    private final Map<UUID, Waiting> waiting = new ConcurrentHashMap<>();

    static final class Waiting {
        final String serverName;
        /**
         * When to give up.
         *
         * Not final, because how long this player should wait depends on something not
         * known when they arrive. A server whose port is held by the sleeper is starting
         * and deserves the full boot timeout; one that answers nothing at all is off, with
         * no mechanism in reach that will change that, and making someone stare at a limbo
         * world for ten minutes over it is a worse answer than telling them.
         */
        volatile long deadline;

        /**
         * Whether the sleeper has already been asked to start this server. Asking once is
         * enough — a second request while it is booting is at best ignored, and every player
         * arriving during the same boot would otherwise send one.
         */
        volatile boolean wakeRequested;

        Waiting(String serverName, long deadline) {
            this.serverName = serverName;
            this.deadline = deadline;
        }
    }

    /**
     * Points a set of hostnames at a backend, and drops any this backend no longer answers
     * for — a server whose subdomain changed must stop being reachable at the old one.
     */
    void setHostnames(String serverName, Collection<String> names) {
        hostnames.entrySet().removeIf((entry) -> entry.getValue().equals(serverName));
        for (String name : names) {
            if (name != null && !name.isBlank()) {
                hostnames.put(name.toLowerCase(Locale.ROOT), serverName);
            }
        }
    }

    void forget(String serverName) {
        hostnames.entrySet().removeIf((entry) -> entry.getValue().equals(serverName));
    }

    /** The backend for a hostname the client connected with, or null if nothing claims it. */
    String serverForHost(String host) {
        if (host == null) return null;
        // Clients hand over whatever was in the address bar, and a trailing dot is a valid
        // way to write a fully qualified name that would otherwise miss every entry here.
        String cleaned = host.toLowerCase(Locale.ROOT).trim();
        if (cleaned.endsWith(".")) cleaned = cleaned.substring(0, cleaned.length() - 1);
        return hostnames.get(cleaned);
    }

    void await(UUID player, String serverName, long deadline) {
        waiting.put(player, new Waiting(serverName, deadline));
    }

    void arrived(UUID player) {
        waiting.remove(player);
    }

    Waiting waitingFor(UUID player) {
        return waiting.get(player);
    }

    /**
     * The players waiting, grouped by the backend they want.
     *
     * Grouped rather than iterated per player so that ten people waiting on one server
     * produce one status ping per round and not ten, aimed at a machine that is busy
     * starting a server.
     */
    Map<String, List<UUID>> byServer() {
        Map<String, List<UUID>> grouped = new java.util.HashMap<>();
        for (Map.Entry<UUID, Waiting> entry : waiting.entrySet()) {
            grouped.computeIfAbsent(entry.getValue().serverName, (k) -> new ArrayList<>()).add(entry.getKey());
        }
        return grouped;
    }
}
