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
          fontFamily: '"JetBrains Mono", Consolas, Monaco, "Courier New", monospace',
          theme: {
            background: '#0a0d14',
            foreground: '#c9d1d9',
            cursor: '#00d97e',
            cursorAccent: '#0d1117',
            selectionBackground: '#21262d',
            black: '#0d1117',
            brightBlack: '#3b434b',
            red: '#f85149',
            brightRed: '#ff7b72',
            green: '#00d97e',
            brightGreen: '#3fb950',
            yellow: '#f0883e',
            brightYellow: '#d29922',
            blue: '#58a6ff',
            brightBlue: '#79c0ff',
            magenta: '#bc8cff',
            brightMagenta: '#d2a8ff',
            cyan: '#39c5cf',
            brightCyan: '#56d364',
            white: '#b1bac4',
            brightWhite: '#e6edf3',
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

  const statusColor = status === 'connected' ? 'var(--accent)' : status === 'authenticating' ? 'var(--warning)' : 'var(--danger)';

  return (
    <div className="cc-console-log-box" style={{ background: '#0a0d14', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '520px' }}>
      {/* Terminal Header Bar */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '5px' }}>
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#f85149', opacity: 0.8 }} />
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#f0883e', opacity: 0.8 }} />
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#00d97e', opacity: 0.8 }} />
          </div>
          <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontWeight: 500 }}>Live Terminal Console</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="pulse-dot" style={{ width: '7px', height: '7px', borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: statusColor, textTransform: 'capitalize' }}>{status}</span>
        </div>
      </div>

      {/* Terminal Viewport */}
      <div ref={terminalRef} style={{ flex: 1, padding: '6px', overflow: 'hidden', background: '#0a0d14' }} />

      {/* Interactive Command Bar */}
      <form onSubmit={handleSendCommand} className="p-2.5 sm:p-3 bg-[var(--surface)] border-t border-[var(--border)] flex gap-2 items-center">
        <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.875rem', padding: '0 2px' }}>›</span>
        <input
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          disabled={status !== 'connected'}
          placeholder={status === 'connected' ? 'Type command (e.g. /op username, /stop)...' : 'Disconnected'}
          style={{
            flex: 1, background: '#0a0d14', border: '1px solid var(--border-2)',
            borderRadius: '6px', padding: '8px 12px', fontSize: '0.8125rem',
            fontFamily: 'var(--font-mono)', color: 'var(--text-primary)',
            outline: 'none', opacity: status !== 'connected' ? 0.5 : 1,
            minHeight: '38px',
          }}
          onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
          onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-2)')}
        />
        <button
          type="submit"
          disabled={status !== 'connected' || !commandInput.trim()}
          className="cc-btn-primary"
          style={{ opacity: (status !== 'connected' || !commandInput.trim()) ? 0.4 : 1, borderRadius: '6px', padding: '8px 16px', minHeight: '38px', flexShrink: 0 }}
        >
          Send
        </button>
      </form>
    </div>
  );
};
