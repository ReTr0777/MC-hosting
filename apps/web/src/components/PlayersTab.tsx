'use client';

import React, { useEffect, useState } from 'react';

interface Player {
  username: string;
  isOp: boolean;
  avatarUrl: string;
}

export default function PlayersTab({ serverId }: { serverId: string }) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fetchPlayers = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/players`);
      if (res.ok) {
        const data = await res.json();
        setPlayers(data.players || []);
      }
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlayers();
    const interval = setInterval(fetchPlayers, 5000);
    return () => clearInterval(interval);
  }, [serverId]);

  const handleAction = async (username: string, action: 'op' | 'deop' | 'kick' | 'ban') => {
    setActionLoading(`${username}-${action}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, action }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(`Successfully executed ${action.toUpperCase()} on ${username}`);
        fetchPlayers();
      } else {
        setMessage(`Error: ${data.error}`);
      }
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <span>🎮 Online Players</span>
            <span className="bg-emerald-500/20 text-emerald-400 text-xs px-2.5 py-0.5 rounded-full border border-emerald-500/30">
              {players.length} Active
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">Live connected player roster and administrator privilege controls.</p>
        </div>

        <button
          onClick={fetchPlayers}
          className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-xl border border-slate-700 transition"
        >
          🔄 Refresh Roster
        </button>
      </div>

      {message && (
        <div className={`p-4 rounded-xl text-xs font-semibold ${message.startsWith('Error') ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
          {message}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-500 text-sm animate-pulse">Scanning server for online players...</div>
      ) : players.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center">
          <div className="text-4xl mb-3">👻</div>
          <h3 className="text-base font-bold text-white mb-1">No Players Currently Online</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            When players log in to this Minecraft server, their skin avatars and admin privilege tools will automatically show up here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {players.map((player) => (
            <div key={player.username} className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 flex items-center justify-between transition">
              <div className="flex items-center space-x-3">
                <img
                  src={player.avatarUrl}
                  alt={player.username}
                  className="w-12 h-12 rounded-xl bg-slate-950 border border-slate-800 shadow-md"
                  onError={(e) => {
                    (e.target as any).src = 'https://mc-heads.net/avatar/MHF_Steve/64';
                  }}
                />
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-white text-sm">{player.username}</span>
                    {player.isOp && (
                      <span className="bg-amber-500/20 text-amber-300 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border border-amber-500/30">
                        OP
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-emerald-400 flex items-center space-x-1 mt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>Connected</span>
                  </span>
                </div>
              </div>

              {/* Quick Actions Menu */}
              <div className="flex items-center space-x-1.5">
                {player.isOp ? (
                  <button
                    onClick={() => handleAction(player.username, 'deop')}
                    disabled={!!actionLoading}
                    title="De-OP Player"
                    className="p-2 bg-slate-800 hover:bg-slate-700 text-amber-400 rounded-lg border border-slate-700 text-xs font-bold transition"
                  >
                    ⭐ De-OP
                  </button>
                ) : (
                  <button
                    onClick={() => handleAction(player.username, 'op')}
                    disabled={!!actionLoading}
                    title="Grant OP Operator Privileges"
                    className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 text-xs font-bold transition"
                  >
                    ⭐ OP
                  </button>
                )}

                <button
                  onClick={() => handleAction(player.username, 'kick')}
                  disabled={!!actionLoading}
                  title="Kick Player from Server"
                  className="p-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 rounded-lg border border-amber-500/20 text-xs font-bold transition"
                >
                  👢 Kick
                </button>

                <button
                  onClick={() => handleAction(player.username, 'ban')}
                  disabled={!!actionLoading}
                  title="Ban Player from Server"
                  className="p-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg border border-red-500/20 text-xs font-bold transition"
                >
                  🔨 Ban
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
