package com.mcmanager.proxy;

import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Asks a sleeping backend to wake up, by starting a login it never finishes.
 *
 * The daemon's sleeper holds a stopped server's port and starts the real server the moment
 * something attempts to log in (next-state 2). A status ping — next-state 1 — deliberately
 * does not, so that a server list refresh cannot boot every server on the node. That leaves
 * the proxy with nothing to say except the login attempt itself.
 *
 * So that is what this sends: a handshake announcing an intent to log in, and then a closed
 * socket. The sleeper has already started the server by the time it notices nobody is there,
 * and the player it is really being woken for is sitting in limbo waiting to be transferred.
 *
 * Nothing is read back. A server that is genuinely off has nothing listening and the connect
 * fails, which is the correct outcome — there is no sleeper to ask.
 */
final class WakeRequest {

    /** Any recent protocol number works; the sleeper reads the next-state field and no more. */
    private static final int PROTOCOL = 767;
    private static final int CONNECT_TIMEOUT_MS = 3_000;
    private static final int NEXT_STATE_LOGIN = 2;

    private WakeRequest() {}

    static void send(InetSocketAddress address) throws Exception {
        try (Socket socket = new Socket()) {
            socket.connect(address, CONNECT_TIMEOUT_MS);
            OutputStream out = socket.getOutputStream();
            out.write(handshake(address.getHostString(), address.getPort()));
            out.flush();
        }
    }

    /** Handshake: packet 0x00, protocol, server address, port, next state. */
    private static byte[] handshake(String host, int port) throws Exception {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        writeVarInt(body, 0x00);
        writeVarInt(body, PROTOCOL);

        byte[] hostBytes = host.getBytes(StandardCharsets.UTF_8);
        writeVarInt(body, hostBytes.length);
        body.write(hostBytes);

        body.write((port >> 8) & 0xFF);
        body.write(port & 0xFF);
        writeVarInt(body, NEXT_STATE_LOGIN);

        // Every packet is length-prefixed. Compression is negotiated later in login, so
        // there is none to account for here.
        ByteArrayOutputStream packet = new ByteArrayOutputStream();
        byte[] payload = body.toByteArray();
        writeVarInt(packet, payload.length);
        packet.write(payload);
        return packet.toByteArray();
    }

    private static void writeVarInt(ByteArrayOutputStream out, int value) {
        while ((value & ~0x7F) != 0) {
            out.write((value & 0x7F) | 0x80);
            value >>>= 7;
        }
        out.write(value);
    }
}
