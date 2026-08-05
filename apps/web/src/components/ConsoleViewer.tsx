'use client';

import React, { useEffect, useRef, useState } from 'react';
import 'xterm/css/xterm.css';

interface ConsoleViewerProps {
  serverId: string;
  containerId: string;
  daemonHost: string;
  daemonPort: number;
  apiKey: string;
}

export const ConsoleViewer: React.FC<ConsoleViewerProps> = ({
  serverId,
  containerId,
  daemonHost,
  daemonPort,
  apiKey,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [status, setStatus] = useState<'disconnected' | 'authenticating' | 'connected' | 'error'>('disconnected');

  useEffect(() => {
    let term: any = null;
    let fitAddon: any = null;
    let isUnmounted = false;
    let reconnectTimeoutId: NodeJS.Timeout;

    // Dynamically import xterm to avoid SSR window errors in Next.js
    const initTerminal = async () => {
      if (!terminalRef.current) return;
      if (isUnmounted) return;

      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      if (!xtermRef.current) {
        term = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: 'Consolas, Monaco, "Courier New", monospace',
          theme: {
            background: '#090d16',
            foreground: '#e2e8f0',
            cursor: '#10b981',
            selectionBackground: '#1e293b',
          },
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(terminalRef.current);
        fitAddon.fit();
        xtermRef.current = term;
      } else {
        term = xtermRef.current;
      }

      const connectWebSocket = () => {
        if (isUnmounted) return;
        term.writeln('\x1b[33m[CraftControl]\x1b[0m Connecting to Daemon node...');

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Connect to our Next.js WS proxy instead of directly to daemon
        const wsUrl = `${wsProtocol}//${window.location.host}/api/ws/console?serverId=${serverId}&containerId=${containerId}`;
        setStatus('authenticating');
        
        if (wsRef.current) {
          wsRef.current.close();
        }
        
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          term.writeln('\x1b[32m[CraftControl]\x1b[0m Connection opened. Sending auth frame...');
          // Handshake: Send initial auth payload immediately
          const authPayload = { auth: apiKey };
          ws.send(JSON.stringify(authPayload));
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.event === 'authenticated') {
              setStatus('connected');
              term.writeln('\x1b[32m[CraftControl]\x1b[0m Authentication successful. Streaming logs...\n');
            } else if (message.event === 'log' && message.data) {
              term.write(message.data.replace(/\n/g, '\r\n'));
            } else if (message.event === 'status') {
              term.writeln(`\x1b[36m[Status]\x1b[0m ${message.data}`);
            } else if (message.event === 'error') {
              setStatus('error');
              term.writeln(`\x1b[31m[Error]\x1b[0m ${message.message || message.data}`);
            }
          } catch (e) {
            term.write(event.data);
          }
        };

        ws.onerror = () => {
          setStatus('error');
          term.writeln('\x1b[31m[CraftControl]\x1b[0m WebSocket error encountered.');
        };

        ws.onclose = () => {
          setStatus('disconnected');
          if (!isUnmounted) {
            term.writeln('\n\x1b[33m[CraftControl]\x1b[0m Connection closed. Reconnecting in 3 seconds...');
            reconnectTimeoutId = setTimeout(() => {
              connectWebSocket();
            }, 3000);
          } else {
            term.writeln('\n\x1b[33m[CraftControl]\x1b[0m Connection closed.');
          }
        };
      };

      connectWebSocket();
    };

    initTerminal();

    const handleResize = () => {
      if (fitAddon) fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      isUnmounted = true;
      clearTimeout(reconnectTimeoutId);
      window.removeEventListener('resize', handleResize);
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
      }
    };
  }, [serverId, containerId, daemonHost, daemonPort, apiKey]);

  const handleSendCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commandInput.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = {
      event: 'command',
      data: commandInput.trim(),
    };

    wsRef.current.send(JSON.stringify(payload));
    if (xtermRef.current) {
      xtermRef.current.writeln(`\x1b[32m>\x1b[0m ${commandInput}`);
    }
    setCommandInput('');
  };

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col h-[520px]">
      {/* Terminal Header Bar */}
      <div className="bg-slate-900 px-5 py-3 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="flex space-x-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
            <div className="w-3 h-3 rounded-full bg-amber-500/80"></div>
            <div className="w-3 h-3 rounded-full bg-emerald-500/80"></div>
          </div>
          <span className="text-xs font-mono text-slate-300">Live Terminal Console</span>
        </div>

        <div className="flex items-center space-x-2">
          <span
            className={`w-2 h-2 rounded-full ${
              status === 'connected'
                ? 'bg-emerald-400 animate-pulse'
                : status === 'authenticating'
                ? 'bg-amber-400 animate-ping'
                : 'bg-red-400'
            }`}
          />
          <span className="text-xs font-semibold text-slate-400 capitalize">{status}</span>
        </div>
      </div>

      {/* Terminal Viewport */}
      <div ref={terminalRef} className="flex-1 p-3 overflow-hidden bg-[#090d16]" />

      {/* Interactive Command Bar */}
      <form onSubmit={handleSendCommand} className="bg-slate-900 p-3 border-t border-slate-800 flex gap-2">
        <span className="text-emerald-400 font-mono font-bold flex items-center px-2 text-sm">&gt;</span>
        <input
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          disabled={status !== 'connected'}
          placeholder={status === 'connected' ? 'Type command (e.g. /op username, /stop, /say Hello)...' : 'Terminal disconnected'}
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm font-mono text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={status !== 'connected' || !commandInput.trim()}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium text-xs px-5 py-2 rounded-xl shadow transition"
        >
          Send
        </button>
      </form>
    </div>
  );
};
