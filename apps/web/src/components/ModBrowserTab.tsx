'use client';

import React, { useState, useEffect } from 'react';

interface ModBrowserTabProps {
  serverId: string;
  serverType: string;
  mcVersion: string;
  canManageFiles: boolean;
}

interface ModSearchResult {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  categories: string[];
  client_side: string;
  server_side: string;
  downloads: number;
  follows: number;
  icon_url: string;
  versions: string[];
  loaders: string[];
  game_versions: string[];
}

interface ModVersion {
  id: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  files: Array<{
    url: string;
    filename: string;
    primary: boolean;
    hashes: { sha1: string; sha512: string };
  }>;
  date_published: string;
}

interface InstalledMod {
  fileName: string;
  size: number;
  modifiedAt: string;
}

export default function ModBrowserTab({ serverId, serverType, mcVersion, canManageFiles }: ModBrowserTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ModSearchResult[]>([]);
  const [selectedMod, setSelectedMod] = useState<ModSearchResult | null>(null);
  const [modVersions, setModVersions] = useState<ModVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<ModVersion | null>(null);
  const [installedMods, setInstalledMods] = useState<InstalledMod[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [backupBeforeInstall, setBackupBeforeInstall] = useState(true);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [totalHits, setTotalHits] = useState(0);
  const [activeTab, setActiveTab] = useState<'search' | 'installed'>('search');
  const [projectType, setProjectType] = useState<'mod' | 'modpack'>('mod');

  // Load installed mods on mount
  useEffect(() => {
    fetchInstalledMods();
  }, [serverId]);

  const fetchInstalledMods = async () => {
    try {
      const res = await fetch(`/api/servers/${serverId}/mods/list`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load installed mods');
      setInstalledMods(data.mods || []);
    } catch (err: any) {
      console.error('Failed to fetch installed mods:', err);
    }
  };

  const handleSearch = async (newQuery: string, newPage = 0) => {
    setSearchQuery(newQuery);
    setPage(newPage);
    
    if (!newQuery.trim()) {
      setSearchResults([]);
      setTotalHits(0);
      return;
    }

    setSearchLoading(true);
    setError('');

    try {
      const params = new URLSearchParams({
        q: newQuery,
        gameVersion: mcVersion,
        loader: serverType.toLowerCase(),
        limit: '20',
        offset: String(newPage * 20),
        projectType: projectType,
      });

      const res = await fetch(`/api/servers/${serverId}/mods/search?${params}`);
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Search failed');
      
      setSearchResults(data.hits || []);
      setTotalHits(data.total_hits || 0);
    } catch (err: any) {
      setError(err.message);
      setSearchResults([]);
      setTotalHits(0);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleModSelect = async (mod: ModSearchResult) => {
    setSelectedMod(mod);
    setSelectedVersion(null);
    setModVersions([]);
    setVersionsLoading(true);

    try {
      const params = new URLSearchParams({
        gameVersion: mcVersion,
        loader: serverType.toLowerCase(),
      });

      const res = await fetch(`/api/servers/${serverId}/mods/versions/${mod.project_id}?${params}`);
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Failed to fetch versions');
      
      setModVersions(data.versions || []);
      
      // Auto-select the first compatible version
      if (data.versions && data.versions.length > 0) {
        setSelectedVersion(data.versions[0]);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleInstall = async () => {
    if (!selectedMod || !selectedVersion) return;

    const primaryFile = selectedVersion.files.find(f => f.primary) || selectedVersion.files[0];
    if (!primaryFile) {
      setError('No downloadable file found for this version');
      return;
    }

    setInstalling(selectedMod.project_id);
    setError('');

    try {
      const res = await fetch(`/api/servers/${serverId}/mods/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedMod.project_id,
          versionId: selectedVersion.id,
          fileUrl: primaryFile.url,
          fileName: primaryFile.filename,
          createBackup: backupBeforeInstall,
        }),
      });

      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Install failed');
      
      alert(`✅ ${data.message}`);
      fetchInstalledMods();
      setSelectedMod(null);
      setSelectedVersion(null);
      setModVersions([]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async (fileName: string) => {
    if (!confirm(`Are you sure you want to uninstall ${fileName}?`)) return;

    setUninstalling(fileName);
    setError('');

    try {
      const res = await fetch(`/api/servers/${serverId}/mods/${encodeURIComponent(fileName)}`, {
        method: 'DELETE',
      });

      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Uninstall failed');
      
      alert(`✅ ${data.message}`);
      fetchInstalledMods();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUninstalling(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!canManageFiles) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: '3rem', marginBottom: '16px' }}>🔒</div>
        <h3 style={{ marginBottom: '8px', color: 'var(--text-primary)' }}>Insufficient Permissions</h3>
        <p>You need OPERATOR or ADMIN role to manage mods.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', minHeight: '500px' }}>
      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
        <button
          onClick={() => setActiveTab('search')}
          className={`cc-tab ${activeTab === 'search' ? 'cc-tab-active' : ''}`}
          style={{ padding: '8px 16px', fontSize: '0.8125rem' }}
        >
          🔍 Browse Mods
        </button>
        <button
          onClick={() => setActiveTab('installed')}
          className={`cc-tab ${activeTab === 'installed' ? 'cc-tab-active' : ''}`}
          style={{ padding: '8px 16px', fontSize: '0.8125rem' }}
        >
          📦 Installed Mods ({installedMods.length})
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)', borderRadius: '8px', padding: '12px 16px', color: 'var(--danger)', fontSize: '0.8125rem' }}>
          {error}
        </div>
      )}

      {activeTab === 'search' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, overflow: 'hidden' }}>
          {/* Search Bar */}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: '200px' }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search Modrinth for mods... (e.g. 'journey map', 'jei', 'sodium')"
                className="cc-input"
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span>MC: {mcVersion}</span>
              <span>•</span>
              <span>Loader: {serverType}</span>
            </div>
            {/* Project Type Filter */}
            <div style={{ display: 'flex', gap: '4px', background: 'var(--surface-2)', borderRadius: '6px', padding: '4px', border: '1px solid var(--border)' }}>
              <button
                onClick={() => { setProjectType('mod'); handleSearch(searchQuery, 0); }}
                className={`cc-tab ${projectType === 'mod' ? 'cc-tab-active' : ''}`}
                style={{ padding: '6px 12px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
              >
                🧩 Mods
              </button>
              <button
                onClick={() => { setProjectType('modpack'); handleSearch(searchQuery, 0); }}
                className={`cc-tab ${projectType === 'modpack' ? 'cc-tab-active' : ''}`}
                style={{ padding: '6px 12px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
              >
                📦 Modpacks
              </button>
            </div>
          </div>

          {searchLoading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <div className="cc-spinner" style={{ width: '24px', height: '24px', borderWidth: '2px' }} />
              <span style={{ marginLeft: '12px' }}>Searching Modrinth...</span>
            </div>
          )}

          {!searchLoading && searchQuery.trim() && searchResults.length === 0 && !error && (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '3rem', marginBottom: '16px' }}>🔍</div>
              <p>No mods found for "{searchQuery}"</p>
            </div>
          )}

          {/* Search Results */}
          {!searchLoading && searchResults.length > 0 && (
            <div style={{ flex: 1, overflow: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
                {searchResults.map((mod) => (
                  <div
                    key={mod.project_id}
                    onClick={() => handleModSelect(mod)}
                    style={{
                      background: 'var(--surface)',
                      border: `1px solid ${selectedMod?.project_id === mod.project_id ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: '12px',
                      padding: '16px',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      display: 'flex',
                      gap: '12px',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
                    onMouseLeave={(e) => e.currentTarget.style.borderColor = selectedMod?.project_id === mod.project_id ? 'var(--accent)' : 'var(--border)'}
                  >
                    <img
                      src={mod.icon_url || 'https://cdn.modrinth.com/data/cached_images/0000/0000/default.png'}
                      alt={mod.title}
                      style={{ width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {mod.title}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '8px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {mod.description}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        <span style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa', padding: '2px 8px', borderRadius: '4px', fontSize: '0.625rem', fontWeight: 600 }}>
                          {mod.server_side === 'required' ? '✓ Server Required' : mod.server_side === 'optional' ? '⚠ Server Optional' : '✗ Client Only'}
                        </span>
                        <span style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.625rem' }}>
                          {mod.downloads.toLocaleString()} downloads
                        </span>
                        {mod.categories.slice(0, 2).map((cat) => (
                          <span key={cat} style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.625rem' }}>
                            {cat}
                          </span>
                        ))}
                      </div>
                    </div>
                    {selectedMod?.project_id === mod.project_id && (
                      <div style={{ color: 'var(--accent)', fontSize: '1.5rem', marginTop: '4px' }}>▶</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalHits > 20 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
                  <button
                    onClick={() => handleSearch(searchQuery, page - 1)}
                    disabled={page === 0 || searchLoading}
                    className="cc-btn-secondary"
                    style={{ padding: '6px 16px' }}
                  >
                    ← Previous
                  </button>
                  <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                    Page {page + 1} of {Math.ceil(totalHits / 20)} ({totalHits} results)
                  </span>
                  <button
                    onClick={() => handleSearch(searchQuery, page + 1)}
                    disabled={(page + 1) * 20 >= totalHits || searchLoading}
                    className="cc-btn-secondary"
                    style={{ padding: '6px 16px' }}
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Mod Version Selection */}
          {selectedMod && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                <img
                  src={selectedMod.icon_url || 'https://cdn.modrinth.com/data/cached_images/0000/0000/default.png'}
                  alt={selectedMod.title}
                  style={{ width: '56px', height: '56px', borderRadius: '8px', objectFit: 'cover' }}
                />
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>{selectedMod.title}</h3>
                  <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{selectedMod.description}</p>
                </div>
                <button
                  onClick={() => { setSelectedMod(null); setSelectedVersion(null); setModVersions([]); }}
                  style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 12px', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  ← Back to Results
                </button>
              </div>

              {versionsLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', color: 'var(--text-muted)' }}>
                  <div className="cc-spinner" style={{ width: '20px', height: '20px', borderWidth: '2px' }} />
                  <span style={{ marginLeft: '12px' }}>Loading versions...</span>
                </div>
              ) : modVersions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
                  No compatible versions found for {mcVersion} / {serverType}
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Available Versions ({modVersions.length})
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '8px', maxHeight: '300px', overflow: 'auto' }}>
                    {modVersions.map((version) => {
                      const primaryFile = version.files.find(f => f.primary) || version.files[0];
                      const isSelected = selectedVersion?.id === version.id;
                      return (
                        <button
                          key={version.id}
                          onClick={() => setSelectedVersion(version)}
                          disabled={installing === selectedMod?.project_id}
                          style={{
                            background: isSelected ? 'rgba(139,92,246,0.15)' : 'var(--surface-2)',
                            border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                            borderRadius: '8px',
                            padding: '12px',
                            textAlign: 'left',
                            cursor: installing === selectedMod?.project_id ? 'not-allowed' : 'pointer',
                            transition: 'all 0.2s ease',
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)', marginBottom: '4px' }}>
                            {version.version_number}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            <span>MC: {version.game_versions.join(', ')}</span>
                            <span>Loader: {version.loaders.join(', ')}</span>
                            {primaryFile && <span>{primaryFile.filename}</span>}
                          </div>
                          <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            Released: {new Date(version.date_published).toLocaleDateString()}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {selectedVersion && (
                    <div style={{ marginTop: '16px', padding: '16px', background: 'var(--surface-2)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                      {(() => {
                        const primaryFile = selectedVersion.files.find(f => f.primary) || selectedVersion.files[0];
                        if (!primaryFile) return null;
                        return (
                          <>
                            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
                              Ready to Install: {primaryFile.filename}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                              Size: {formatBytes(0)} • SHA1: {primaryFile.hashes?.sha1?.substring(0, 16)}...
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '12px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={backupBeforeInstall}
                                onChange={(e) => setBackupBeforeInstall(e.target.checked)}
                              />
                              Backup before installing
                            </label>
                            <button
                              onClick={handleInstall}
                              disabled={installing === selectedMod?.project_id}
                              className="cc-btn-primary"
                              style={{ width: '100%' }}
                            >
                              {installing === selectedMod?.project_id ? 'Installing...' : `Install ${primaryFile.filename}`}
                            </button>
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'installed' && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          {installedMods.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '4rem', marginBottom: '16px' }}>📦</div>
              <h3 style={{ marginBottom: '8px', color: 'var(--text-primary)' }}>No Mods Installed</h3>
              <p>Use the "Browse Mods" tab to search and install mods from Modrinth.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
              {installedMods.map((mod) => (
                <div key={mod.fileName} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '6px', background: 'linear-gradient(135deg, var(--accent), #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', flexShrink: 0 }}>
                      📦
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {mod.fileName}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: '12px', marginTop: '4px' }}>
                        <span>{formatBytes(mod.size)}</span>
                        <span>{formatDate(mod.modifiedAt)}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleUninstall(mod.fileName)}
                    disabled={uninstalling === mod.fileName}
                    style={{
                      background: 'rgba(248,81,73,0.1)', color: 'var(--danger)',
                      border: '1px solid rgba(248,81,73,0.2)', borderRadius: '6px',
                      padding: '6px 12px', fontSize: '0.75rem', fontWeight: 600,
                      cursor: uninstalling === mod.fileName ? 'not-allowed' : 'pointer',
                      opacity: uninstalling === mod.fileName ? 0.5 : 1,
                      whiteSpace: 'nowrap', flexShrink: 0,
                    }}
                  >
                    {uninstalling === mod.fileName ? 'Removing...' : '🗑 Uninstall'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}