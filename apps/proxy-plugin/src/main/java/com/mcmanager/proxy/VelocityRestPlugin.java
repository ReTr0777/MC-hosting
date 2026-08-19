package com.mcmanager.proxy;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.velocitypowered.api.event.EventTask;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.event.player.KickedFromServerEvent;
import com.velocitypowered.api.event.player.PlayerChooseInitialServerEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import com.velocitypowered.api.proxy.server.ServerInfo;
import com.velocitypowered.api.proxy.server.ServerPing;
import fi.iki.elonen.NanoHTTPD;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.slf4j.Logger;

import javax.inject.Inject;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * Routes players to the backend they asked for, and parks them in limbo while it starts.
 *
 * The daemon can already hold a joining player's connection open through a boot
 * (see the sleeper in apps/daemon). That works for anyone connecting straight to a
 * server's own port, but it gives them a loading screen with nothing on it — during
 * login there is no chat, no title and no boss bar, so there is no way to tell them what
 * is happening. This is the other route: come in through the proxy and you land in a real
 * world with a boss bar that says the server is starting, and get moved across when it is.
 *
 * See docs/sleep-wake-plan.md for how the two paths divide up.
 */
@Plugin(id = "mcmanager-proxy", name = "MCManager Proxy Rest API", version = "1.0", authors = {"ReTr0777"})
public class VelocityRestPlugin {

    /** Registered name of the limbo backend, and the alias some configs use for it. */
    private static final String LIMBO = "nanolimbo";
    private static final String LIMBO_ALIAS = "limbo";

    /**
     * How the daemon's sleeper names itself in a status ping. It answers pings while holding
     * a stopped server's port, so a reply is not on its own evidence that anything is running.
     */
    private static final String SLEEPING_VERSION = "Sleeping";

    /** Matches the daemon's own boot timeout: past this, the server is not coming. */
    private static final long BOOT_TIMEOUT_MS = 10 * 60_000L;

    /**
     * How long to wait on a backend that answers nothing at all.
     *
     * Short on purpose. Nothing holding the port means no sleeper, which means nothing here
     * can start that server — it needs the panel. Kept above zero only because a server in
     * the seconds between its own restart and its port coming back looks identical.
     */
    private static final long OFFLINE_TIMEOUT_MS = 30_000L;

    private static final int POLL_SECONDS = 3;

    private final ProxyServer server;
    private final Logger logger;
    private final Routing routing = new Routing();
    private ProxyHttpServer httpServer;
    private final Gson gson = new Gson();

    @Inject
    public VelocityRestPlugin(ProxyServer server, Logger logger) {
        this.server = server;
        this.logger = logger;
    }

    @Subscribe
    public void onProxyInitialization(ProxyInitializeEvent event) {
        try {
            int port = 3001;
            httpServer = new ProxyHttpServer(port);
            logger.info("MCManager Proxy REST API (NanoHTTPD) started on port " + port);
        } catch (Throwable t) {
            logger.error("Failed to start REST API server", t);
        }

        server.getScheduler().buildTask(this, this::pollWaiting).repeat(POLL_SECONDS, TimeUnit.SECONDS).schedule();
    }

    // ---------------------------------------------------------------- routing

    private Optional<RegisteredServer> limbo() {
        Optional<RegisteredServer> found = server.getServer(LIMBO);
        return found.isPresent() ? found : server.getServer(LIMBO_ALIAS);
    }

    private static boolean isLimbo(String name) {
        return LIMBO.equalsIgnoreCase(name) || LIMBO_ALIAS.equalsIgnoreCase(name);
    }

    /** A ping answered by the sleeper means the port is held, not that the server is up. */
    private static boolean isSleeping(ServerPing ping) {
        return ping != null
            && ping.getVersion() != null
            && SLEEPING_VERSION.equalsIgnoreCase(ping.getVersion().getName());
    }

    /** The backend a player asked for, taken from the hostname they connected with. */
    private Optional<RegisteredServer> targetFor(Player player) {
        return player.getVirtualHost()
            .map(InetSocketAddress::getHostString)
            .map(routing::serverForHost)
            .flatMap(server::getServer);
    }

    /**
     * Decides where a joining player goes: their server if it is up, limbo if it is not.
     *
     * Returned as an EventTask because the decision needs a status ping, and blocking a
     * Netty thread on the network is how a proxy stops answering everyone else.
     */
    @Subscribe
    public EventTask onChooseInitialServer(PlayerChooseInitialServerEvent event) {
        Player player = event.getPlayer();
        RegisteredServer target = targetFor(player).orElse(null);

        // No hostname we know: leave Velocity's own `try` list to decide, which is limbo.
        if (target == null) return null;
        if (isLimbo(target.getServerInfo().getName())) {
            event.setInitialServer(target);
            return null;
        }

        return EventTask.resumeWhenComplete(target.ping().handle((ping, error) -> {
            if (error == null && !isSleeping(ping)) {
                event.setInitialServer(target);
                return null;
            }

            RegisteredServer limbo = limbo().orElse(null);
            if (limbo == null) {
                // Nowhere to hold them. Letting the connection through is still better than
                // refusing it: the daemon's sleeper will hold it at login instead.
                logger.warn("No limbo backend registered — sending " + player.getUsername() + " straight through");
                event.setInitialServer(target);
                return null;
            }

            park(player, target, error == null);
            event.setInitialServer(limbo);
            return null;
        }));
    }

    /**
     * Sends a player to limbo to wait for a backend, and asks that backend to start.
     *
     * @param sleeperAnswered whether the status ping was answered by the sleeper. Only then
     *   is there something on the port to ask; a server that is off in some other way has to
     *   be started from the panel, and the player waits until the deadline instead.
     */
    private void park(Player player, RegisteredServer target, boolean sleeperAnswered) {
        long timeout = sleeperAnswered ? BOOT_TIMEOUT_MS : OFFLINE_TIMEOUT_MS;
        routing.await(player.getUniqueId(), target.getServerInfo().getName(), System.currentTimeMillis() + timeout);

        player.sendMessage(Component.text("Your server is starting — you will be moved across automatically.")
            .color(NamedTextColor.YELLOW));

        if (sleeperAnswered) requestWake(player.getUniqueId(), target);
    }

    /** Asks the sleeper holding this port to start the real server. Never blocks the caller. */
    private void requestWake(UUID player, RegisteredServer target) {
        Routing.Waiting waiting = routing.waitingFor(player);
        if (waiting == null || waiting.wakeRequested) return;
        waiting.wakeRequested = true;

        // There is now something starting a server for them, so they get the boot timeout
        // rather than the short one given to a player waiting on a machine that is simply
        // off. This is the case where a player arrived a moment before the sleeper did.
        waiting.deadline = System.currentTimeMillis() + BOOT_TIMEOUT_MS;

        server.getScheduler().buildTask(this, () -> {
            try {
                WakeRequest.send(target.getServerInfo().getAddress());
                logger.info("Asked '" + target.getServerInfo().getName() + "' to wake up");
            } catch (Exception e) {
                logger.warn("Could not ask '" + target.getServerInfo().getName() + "' to wake: " + e.getMessage());
            }
        }).schedule();
    }

    /**
     * Moves anyone waiting in limbo to their own backend once it answers.
     *
     * One ping per backend per round rather than one per player: a server that ten people
     * are waiting on is a server in the middle of starting, and it does not need ten status
     * pings every three seconds while it does it.
     */
    private void pollWaiting() {
        for (Map.Entry<String, List<UUID>> group : routing.byServer().entrySet()) {
            RegisteredServer target = server.getServer(group.getKey()).orElse(null);

            if (target == null) {
                // Unregistered while they waited — deleted, or moved to another node.
                for (UUID id : group.getValue()) {
                    routing.arrived(id);
                    server.getPlayer(id).ifPresent((p) -> p.disconnect(
                        Component.text("That server is no longer available.").color(NamedTextColor.RED)));
                }
                continue;
            }

            target.ping().whenComplete((ping, error) -> {
                boolean ready = error == null && !isSleeping(ping);
                for (UUID id : group.getValue()) resolveWaiting(id, target, ready, error == null);
            });
        }
    }

    private void resolveWaiting(UUID id, RegisteredServer target, boolean ready, boolean answered) {
        Player player = server.getPlayer(id).orElse(null);
        if (player == null) {
            routing.arrived(id); // Gave up and left.
            return;
        }

        Routing.Waiting waiting = routing.waitingFor(id);
        if (waiting == null) return;

        // Only move players who are actually still parked. Anyone who has been sent
        // somewhere else in the meantime is not ours to yank out of it.
        boolean inLimbo = player.getCurrentServer()
            .map((c) -> isLimbo(c.getServerInfo().getName()))
            .orElse(false);
        if (!inLimbo) return;

        if (ready) {
            routing.arrived(id);
            player.sendMessage(Component.text("Connecting you to your server...").color(NamedTextColor.GREEN));
            player.createConnectionRequest(target).fireAndForget();
            return;
        }

        if (answered) requestWake(id, target);

        if (System.currentTimeMillis() > waiting.deadline) {
            routing.arrived(id);
            // Two different failures, and telling them apart is the difference between
            // "wait and try again" and "go and start it in the panel".
            player.disconnect(Component.text(waiting.wakeRequested
                    ? "Your server did not finish starting in time."
                    : "That server is offline, and nothing here can start it. Start it from the panel.")
                .color(NamedTextColor.RED));
        }
    }

    /**
     * A player thrown out of a backend goes to limbo and waits for that same backend.
     *
     * Recording which one is the point: a crash on server A used to drop the player in limbo
     * with no memory of where they had been, and the poll task sent them to whichever backend
     * it found first.
     */
    @Subscribe
    public void onKickedFromServer(KickedFromServerEvent event) {
        String from = event.getServer().getServerInfo().getName();
        if (isLimbo(from)) return;

        RegisteredServer limbo = limbo().orElse(null);
        if (limbo == null) return;

        routing.await(event.getPlayer().getUniqueId(), from, System.currentTimeMillis() + BOOT_TIMEOUT_MS);
        event.setResult(KickedFromServerEvent.RedirectPlayer.create(limbo,
            Component.text("Server is restarting — holding you here until it is back.")
                .color(NamedTextColor.YELLOW)));
    }

    @Subscribe
    public void onDisconnect(DisconnectEvent event) {
        routing.arrived(event.getPlayer().getUniqueId());
    }

    @Subscribe
    public void onProxyShutdown(ProxyShutdownEvent event) {
        if (httpServer != null) {
            httpServer.stop();
            logger.info("MCManager Proxy REST API stopped");
        }
    }

    // ------------------------------------------------------------------- REST

    private class ProxyHttpServer extends NanoHTTPD {
        public ProxyHttpServer(int port) throws IOException {
            super(port);
            start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        }

        @Override
        public Response serve(IHTTPSession session) {
            String uri = session.getUri();
            Method method = session.getMethod();

            try {
                if (uri.contains("/servers")) {
                    if (Method.POST.equals(method)) {
                        Map<String, String> files = new HashMap<>();
                        session.parseBody(files);
                        JsonObject body = JsonParser.parseString(files.get("postData")).getAsJsonObject();

                        String name = body.get("name").getAsString();
                        String address = body.get("address").getAsString();
                        int port = body.get("port").getAsInt();

                        ServerInfo serverInfo = new ServerInfo(name, new InetSocketAddress(address, port));

                        Optional<RegisteredServer> existing = server.getServer(name);
                        if (existing.isPresent()) {
                            // Re-registering is how an address change arrives, so the old
                            // entry has to go even when the name is unchanged.
                            server.unregisterServer(existing.get().getServerInfo());
                        }

                        server.registerServer(serverInfo);
                        routing.setHostnames(name, hostnames(body));

                        logger.info("Registered server: " + name + " -> " + address + ":" + port);
                        return json(Response.Status.OK, "{\"message\": \"Server registered\"}");
                    }

                    if (Method.DELETE.equals(method)) {
                        String name = session.getParms().get("name");
                        if (name != null) {
                            routing.forget(name);
                            Optional<RegisteredServer> existing = server.getServer(name);
                            if (existing.isPresent()) {
                                server.unregisterServer(existing.get().getServerInfo());
                                logger.info("Unregistered server: " + name);
                                return json(Response.Status.OK, "{\"message\": \"Server unregistered\"}");
                            }
                        }
                        return json(Response.Status.NOT_FOUND, "{\"error\": \"Server not found\"}");
                    }
                } else if (uri.contains("/players/title")) {
                    if (Method.POST.equals(method)) {
                        Map<String, String> files = new HashMap<>();
                        session.parseBody(files);
                        JsonObject body = JsonParser.parseString(files.get("postData")).getAsJsonObject();

                        String serverName = body.has("server") ? body.get("server").getAsString() : LIMBO;
                        String titleText = body.has("title") ? body.get("title").getAsString() : "";
                        String subtitleText = body.has("subtitle") ? body.get("subtitle").getAsString() : "";

                        server.getServer(serverName).ifPresent((target) -> {
                            net.kyori.adventure.title.Title title = net.kyori.adventure.title.Title.title(
                                Component.text(titleText), Component.text(subtitleText));
                            for (Player p : target.getPlayersConnected()) p.showTitle(title);
                        });
                        return json(Response.Status.OK, "{\"message\": \"Title broadcasted\"}");
                    }
                }
            } catch (Exception e) {
                logger.error("API Error in NanoHTTPD", e);
                return json(Response.Status.INTERNAL_ERROR, "{\"error\": \"Internal server error\"}");
            }

            return json(Response.Status.METHOD_NOT_ALLOWED, "{\"error\": \"Method not allowed\"}");
        }

        /**
         * The hostnames this backend answers for. Absent in older panels, which registered
         * servers with nothing but an address — those stay reachable through Velocity's own
         * `try` list rather than becoming unroutable.
         */
        private List<String> hostnames(JsonObject body) {
            List<String> names = new ArrayList<>();
            if (!body.has("hostnames") || !body.get("hostnames").isJsonArray()) return names;

            JsonArray array = body.getAsJsonArray("hostnames");
            for (JsonElement element : array) {
                if (!element.isJsonNull()) names.add(element.getAsString().toLowerCase(Locale.ROOT));
            }
            return names;
        }

        private Response json(Response.Status status, String body) {
            return newFixedLengthResponse(status, "application/json", body);
        }
    }
}
