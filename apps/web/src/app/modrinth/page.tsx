'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';

interface Modpack {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string;
  downloads: number;
  follows: number;
  categories: string[];
}

interface NodeItem {
  id: string;
  name: string;
}

export default function ModrinthExplorerPage() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [modpacks, setModpacks] = useState<Modpack[]>([]);
  const [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<NodeItem[]>([]);

  // Pagination & Filters
  const [offset, setOffset] = useState(0);
  const [limit] = useState(12);
  const [totalHits, setTotalHits] = useState(0);
  const [sortBy, setSortBy] = useState<'downloads' | 'follows' | 'updated' | 'newest'>('downloads');
  const [loaderFilter, setLoaderFilter] = useState<string>('');

  // Deployment modal state
  const [selectedModpack, setSelectedModpack] = useState<Modpack | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('AUTO');
  const [serverName, setServerName] = useState('');
  const [serverPort, setServerPort] = useState(25565);
  const [memoryMb, setMemoryMb] = useState(4096);
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [deployError, setDeployError] = useState('');
  const [deploying, setDeploying] = useState(false);

  const fetchModpacks = async (newOffset = offset) => {
    setLoading(true);
    try {
      const url = new URL('/api/modrinth/search', window.location.origin);
      if (query.trim()) url.searchParams.append('q', query);
      url.searchParams.append('limit', limit.toString());
      url.searchParams.append('offset', newOffset.toString());
      url.searchParams.append('index', sortBy);
      if (loaderFilter) url.searchParams.append('loader', loaderFilter);

      const res = await fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        setModpacks(data.hits || []);
        setTotalHits(data.total_hits || 0);
        setOffset(data.offset || 0);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModpacks(0);
    fetch('/api/nodes')
      .then((r) => r.json())
      .then((data) => {
        if (data.nodes) {
          setNodes(data.nodes);
        }
      });
  }, [sortBy, loaderFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchModpacks(0);
  };

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(totalHits / limit);

  const openDeployModal = (modpack: Modpack) => {
    setSelectedModpack(modpack);
    setServerName(`${modpack.title} Instance`);
    setDeployError('');
  };

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeployError('');

    if (!eulaAccepted) {
      setDeployError('You must agree to the Mojang Minecraft EULA.');
      return;
    }

    setDeploying(true);
    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: serverName,
          nodeId: selectedNodeId,
          serverType: 'MODRINTH',
          modpackSlug: selectedModpack?.slug,
          serverPort,
          memoryMb,
          eulaAccepted: true,
        }),
      });

      const data = await res.json();
      if (!res.ok && res.status !== 207) {
        throw new Error(data.error || 'Failed to deploy modpack server');
      }

      alert(`Modpack server "${serverName}" created successfully!`);
      setSelectedModpack(null);
    } catch (err: any) {
      setDeployError(err.message);
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur px-8 py-4 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center space-x-4">
          <Link href="/dashboard" className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
              M
            </div>
            <span className="font-bold text-lg text-white">CraftControl</span>
          </Link>
          <span className="text-xs px-2.5 py-1 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
            Modrinth Explorer
          </span>
        </div>

        <Link href="/dashboard" className="text-xs bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-slate-200 transition">
          ← Back to Dashboard
        </Link>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-8 py-8 space-y-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <h1 className="text-2xl font-bold mb-2">Modrinth Modpack Repository</h1>
          <p className="text-xs text-slate-400 mb-6">
            Browse thousands of Modrinth modpacks and deploy them directly to your worker nodes with auto-installation.
          </p>

          {/* Search Bar & Filter Bar */}
          <form onSubmit={handleSearchSubmit} className="flex flex-col md:flex-row gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Modrinth (e.g. Cobblemon, All the Mods, Better MC, Valhelsia)..."
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
            >
              <option value="downloads">Most Downloaded</option>
              <option value="follows">Most Followed</option>
              <option value="updated">Recently Updated</option>
              <option value="newest">Newest Modpacks</option>
            </select>

            <select
              value={loaderFilter}
              onChange={(e) => setLoaderFilter(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
            >
              <option value="">All Loaders</option>
              <option value="fabric">Fabric</option>
              <option value="forge">Forge</option>
              <option value="neoforge">NeoForge</option>
              <option value="quilt">Quilt</option>
            </select>

            <button
              type="submit"
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-6 py-3 rounded-xl shadow transition"
            >
              Search
            </button>
          </form>
        </div>

        {/* Results Header */}
        <div className="flex items-center justify-between text-xs text-slate-400 px-1">
          <span>Showing {modpacks.length} modpacks (Total: {totalHits.toLocaleString()})</span>
          <span>Page {currentPage} of {totalPages || 1}</span>
        </div>

        {/* Modpack Cards Grid */}
        {loading ? (
          <div className="text-center text-slate-500 py-20">Fetching Modrinth modpacks...</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {modpacks.map((modpack) => (
              <div key={modpack.project_id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between hover:border-slate-700 transition">
                <div>
                  <div className="flex items-center space-x-3 mb-3">
                    {modpack.icon_url ? (
                      <img src={modpack.icon_url} alt={modpack.title} className="w-12 h-12 rounded-xl object-cover" />
                    ) : (
                      <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center font-bold text-slate-400 text-lg">
                        MP
                      </div>
                    )}
                    <div className="overflow-hidden">
                      <h3 className="font-bold text-white text-base leading-tight truncate">{modpack.title}</h3>
                      <span className="text-xs text-slate-500 font-mono truncate">@{modpack.slug}</span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-400 line-clamp-3 mb-4">{modpack.description}</p>
                </div>

                <div className="flex items-center justify-between border-t border-slate-800 pt-3">
                  <span className="text-xs text-slate-500">{(modpack.downloads / 1000).toFixed(1)}k downloads</span>
                  <button
                    onClick={() => openDeployModal(modpack)}
                    className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-xs font-semibold px-4 py-2 rounded-xl border border-emerald-500/30 transition"
                  >
                    Deploy Server
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination Bar */}
        <div className="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-2xl p-4 mt-6">
          <button
            onClick={() => fetchModpacks(Math.max(0, offset - limit))}
            disabled={offset === 0 || loading}
            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold px-4 py-2 rounded-xl transition"
          >
            ← Previous Page
          </button>

          <span className="text-xs text-slate-400 font-mono">
            Page {currentPage} / {totalPages || 1}
          </span>

          <button
            onClick={() => fetchModpacks(offset + limit)}
            disabled={offset + limit >= totalHits || loading}
            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold px-4 py-2 rounded-xl transition"
          >
            Next Page →
          </button>
        </div>
      </main>

      {/* Deploy Modpack Modal */}
      {selectedModpack && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-2">Deploy {selectedModpack.title}</h3>
            <p className="text-xs text-slate-400 mb-4">
              Container will launch with <code className="text-emerald-400">TYPE=MODRINTH</code> & <code className="text-emerald-400">MODRINTH_MODPACK={selectedModpack.slug}</code>
            </p>

            {deployError && <div className="mb-4 text-xs text-red-400 bg-red-500/10 p-3 rounded-lg">{deployError}</div>}

            <form onSubmit={handleDeploy} className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Server Instance Name</label>
                <input
                  type="text"
                  required
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Smart Node Scheduler</label>
                  <select
                    value={selectedNodeId}
                    onChange={(e) => setSelectedNodeId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="AUTO">⚡ Auto-Select (Smart Offload)</option>
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Memory (MB)</label>
                  <input
                    type="number"
                    required
                    value={memoryMb}
                    onChange={(e) => setMemoryMb(parseInt(e.target.value, 10))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Minecraft EULA Consent */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 flex items-start space-x-3">
                <input
                  type="checkbox"
                  id="eulaModalCheck"
                  checked={eulaAccepted}
                  onChange={(e) => setEulaAccepted(e.target.checked)}
                  className="mt-1 accent-emerald-500 w-4 h-4 rounded"
                />
                <label htmlFor="eulaModalCheck" className="text-xs text-slate-300 cursor-pointer">
                  I agree to the <a href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noreferrer" className="text-emerald-400 underline">Mojang Minecraft EULA</a>.
                </label>
              </div>

              <div className="flex justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedModpack(null)}
                  className="px-4 py-2 text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={deploying}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl shadow"
                >
                  {deploying ? 'Deploying...' : 'Deploy Server'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
