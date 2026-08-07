package com.mcmanager.proxy;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import com.velocitypowered.api.proxy.server.ServerInfo;
import fi.iki.elonen.NanoHTTPD;
import org.slf4j.Logger;

import javax.inject.Inject;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import com.velocitypowered.api.event.player.KickedFromServerEvent;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import com.velocitypowered.api.proxy.Player;

@Plugin(id = "mcmanager-proxy", name = "MCManager Proxy Rest API", version = "1.0", authors = {"ReTr0777"})
public class VelocityRestPlugin {

    private final ProxyServer server;
    private final Logger logger;
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

        // Health polling task: auto-transfer any player sitting in Limbo to an active backend server!
        server.getScheduler().buildTask(this, () -> {
            for (Player player : server.getAllPlayers()) {
                player.getCurrentServer().ifPresent(currentConn -> {
                    String currentServerName = currentConn.getServerInfo().getName();
                    if ("nanolimbo".equalsIgnoreCase(currentServerName) || "limbo".equalsIgnoreCase(currentServerName)) {
                        for (RegisteredServer targetServer : server.getAllServers()) {
                            String targetName = targetServer.getServerInfo().getName();
                            if (!"nanolimbo".equalsIgnoreCase(targetName) && !"limbo".equalsIgnoreCase(targetName)) {
                                player.sendMessage(Component.text("Connecting you to server...").color(NamedTextColor.GREEN));
                                player.createConnectionRequest(targetServer).fireAndForget();
                                break;
                            }
                        }
                    }
                });
            }
        }).repeat(3, TimeUnit.SECONDS).schedule();
    }

    @Subscribe
    public void onKickedFromServer(KickedFromServerEvent event) {
        Optional<RegisteredServer> nanolimbo = server.getServer("nanolimbo");
        if (nanolimbo.isPresent() && !event.getServer().getServerInfo().getName().equals("nanolimbo")) {
            event.setResult(KickedFromServerEvent.RedirectPlayer.create(nanolimbo.get(), 
                Component.text("Server is booting, sending you to Limbo!").color(NamedTextColor.YELLOW)));
        }
    }

    @Subscribe
    public void onProxyShutdown(ProxyShutdownEvent event) {
        if (httpServer != null) {
            httpServer.stop();
            logger.info("MCManager Proxy REST API stopped");
        }
    }

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
                        String postData = files.get("postData");
                        JsonObject body = JsonParser.parseString(postData).getAsJsonObject();

                        String name = body.get("name").getAsString();
                        String address = body.get("address").getAsString();
                        int port = body.get("port").getAsInt();

                        ServerInfo serverInfo = new ServerInfo(name, new InetSocketAddress(address, port));

                        Optional<RegisteredServer> existing = server.getServer(name);
                        if (existing.isPresent()) {
                            server.unregisterServer(existing.get().getServerInfo());
                        }

                        server.registerServer(serverInfo);
                        logger.info("Dynamically registered server: " + name + " -> " + address + ":" + port);

                        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"message\": \"Server registered\"}");
                    } else if (Method.DELETE.equals(method)) {
                        Map<String, String> parms = session.getParms();
                        String name = parms.get("name");

                        if (name != null) {
                            Optional<RegisteredServer> existing = server.getServer(name);
                            if (existing.isPresent()) {
                                server.unregisterServer(existing.get().getServerInfo());
                                logger.info("Dynamically unregistered server: " + name);
                                return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"message\": \"Server unregistered\"}");
                            }
                        }
                        return newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json", "{\"error\": \"Server not found\"}");
                    }
                } else if (uri.contains("/players/title")) {
                    if (Method.POST.equals(method)) {
                        Map<String, String> files = new HashMap<>();
                        session.parseBody(files);
                        String postData = files.get("postData");
                        JsonObject body = JsonParser.parseString(postData).getAsJsonObject();

                        String serverName = body.has("server") ? body.get("server").getAsString() : "nanolimbo";
                        String titleText = body.has("title") ? body.get("title").getAsString() : "";
                        String subtitleText = body.has("subtitle") ? body.get("subtitle").getAsString() : "";

                        Optional<RegisteredServer> targetServer = server.getServer(serverName);
                        if (targetServer.isPresent()) {
                            net.kyori.adventure.title.Title title = net.kyori.adventure.title.Title.title(
                                Component.text(titleText), 
                                Component.text(subtitleText)
                            );
                            for (Player p : targetServer.get().getPlayersConnected()) {
                                p.showTitle(title);
                            }
                        }
                        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"message\": \"Title broadcasted\"}");
                    }
                }
            } catch (Exception e) {
                logger.error("API Error in NanoHTTPD", e);
                return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json", "{\"error\": \"Internal server error\"}");
            }

            return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, "application/json", "{\"error\": \"Method not allowed\"}");
        }
    }
}
