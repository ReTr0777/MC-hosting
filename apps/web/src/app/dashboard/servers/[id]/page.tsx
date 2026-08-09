'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { ConsoleViewer } from '@/components/ConsoleViewer';
import { FileExplorer } from '@/components/FileExplorer';
import { ServerPermissionsModal } from '@/components/ServerPermissionsModal';
import AnalyticsWidget from '@/components/AnalyticsWidget';
import PlayersTab from '@/components/PlayersTab';
import PropertiesTab from '@/components/PropertiesTab';
import BackupsTab from '@/components/BackupsTab';
import SubdomainTab from '@/components/SubdomainTab';
import UpdateCenterTab from '@/components/UpdateCenterTab';
import { SchedulesTab } from '@/components/SchedulesTab';

interface ServerDetail {
  id: string;
  name: string;
  description?: string;
  nodeId: string;
  containerId?: string;
  status: string;
  serverType: string;
  mcVersion: string;
  serverPort: number;
  memoryMb: number;
  cpuLimit: number;
  modpackSlug?: string;
  eulaAccepted: boolean;
  node: {
    name: string;
    host: string;
    port: number;
    apiKey: string;
    isOnline: boolean;
  };
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'RUNNING' ? 'cc-badge-running' :
    status === 'STARTING' ? 'cc-badge-starting' :
    status === 'ERROR' ? 'cc-badge-error' :
    'cc-badge-offline';
  return <span className={cls}>{status}</span>;
}

const TABS = [
  { key: 'console', label: 'Console' },
  { key: 'players', label: 'Players & Admin' },
  { key: 'properties', label: 'Server Properties' },
  { key: 'update', label: 'Update Centre' },
  { key: 'schedules', label: 'Automated Schedules' },
  { key: 'backups', label: 'Backups' },
  { key: 'domain', label: 'Domain Routing' },
  { key: 'files', label: 'File Explorer' },
] as const;

type TabKey = typeof TABS[number]['key'];

export default function ServerConsolePage() {
  const params = useParams();
  const serverId = params.id as string;
  const { user } = useAuth();

  const [server, setServer] = useState<ServerDetail | null>(null);
  const [nodes, setNodes] = useState<any[]>([]);
  const [userRole, setUserRole] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [migrationDestId, setMigrationDestId] = useState('');
  const [error, setError] = useState('');

  const [activeTab, setActiveTab] = useState<TabKey>('console');
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);

  const [iconKey, setIconKey] = useState<number>(Date.now());
  const [uploadingIcon, setUploadingIcon] = useState(false);

  const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingIcon(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/icon`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });

      if (res.ok) {
        setIconKey(Date.now());
        alert('Server icon updated! Minecraft will display server-icon.png in the multiplayer server list.');
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to upload server icon');
      }
    } catch (err) {
      alert('Network error uploading icon');
    } finally {
      setUploadingIcon(false);
    }
  };

  const fetchServerDetails = async () => {
    try {
      const [serverRes, nodesRes] = await Promise.all([
        fetch(`/api/servers/${serverId}`),
        fetch(`/api/nodes`)
      ]);
      
      if (serverRes.ok) {
        const data = await serverRes.json();
        setServer(data.server);
        setUserRole(data.role);
      } else {
        const errData = await serverRes.json();
        setError(errData.error || 'Failed to fetch server details');
      }

      if (nodesRes.ok) {
        const data = await nodesRes.json();
        setNodes(Array.isArray(data.nodes) ? data.nodes : []);
      } else {
        setNodes([]);
      }
    } catch (e: any) {
      setError('Network error retrieving server instance');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (serverId) {
      fetchServerDetails();
    }
  }, [serverId]);

  const handleMigrate = async () => {
    if (!migrationDestId) return alert('Select a destination node');
    if (!confirm('WARNING: If the server is currently running, it will gracefully shut down with a 10 second countdown. Once it shuts down, it will migrate to the new node. Your server will be offline during the transfer. Are you sure you want to proceed?')) return;
    
    setActionLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationNodeId: migrationDestId }),
      });
      const data = await res.json();
      if (res.ok) {
        alert('Migration process has started! Your server is currently migrating in the background.');
        setTimeout(() => window.location.reload(), 2000);
      } else {
        alert(data.error || 'Failed to trigger migration');
      }
    } catch (e) {
      alert('Network error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAction = async (action: string) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const data = await res.json();
      if (res.ok) {
        await fetchServerDetails();
      } else {
        const fullErr = data.details ? `${data.error}: ${data.details}` : (data.error || `Failed to ${action} server`);
        alert(fullErr);
      }
    } catch (e: any) {
      alert(`Network error executing ${action}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>
        Loading server console...
      </div>
    );
  }

  if (error || !server) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px', fontFamily: 'var(--font-ui)' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Error Loading Server</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: '24px' }}>{error || 'Server instance not found'}</p>
        <Link href="/dashboard" style={{ background: 'var(--surface)', color: 'var(--text-primary)', padding: '8px 20px', borderRadius: '6px', border: '1px solid var(--border-2)', fontSize: '0.8125rem', textDecoration: 'none' }}>
          ← Return to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column' }}>

      {/* ── Top Header Bar ── */}
      <header className="cc-header-responsive" style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        padding: '0 24px',
        minHeight: '52px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        {/* Left: logo + breadcrumb + status */}
        <div className="cc-header-row" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <Link href="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: '6px',
              background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '13px', fontWeight: 800, color: '#0d1117',
            }}>C</div>
            <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>CraftControl</span>
          </Link>
          <span style={{ color: 'var(--border-2)', fontSize: '1.1rem', fontWeight: 300 }}>&gt;</span>

          {/* Clickable Server Icon */}
          <label
            htmlFor="server-icon-upload-input"
            title="Click to upload/change server-icon.png"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '28px', height: '28px', borderRadius: '6px',
              background: 'var(--surface-2)', border: '1px solid var(--border-2)',
              cursor: 'pointer', overflow: 'hidden', flexShrink: 0,
            }}
          >
            <img
              src={`/api/servers/${server.id}/icon?v=${iconKey}`}
              alt="Icon"
              style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <span style={{ fontSize: '0.6rem', fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>MC</span>
          </label>
          <input
            id="server-icon-upload-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleIconUpload}
            style={{ display: 'none' }}
          />
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>{server.name}</span>
          <StatusBadge status={server.status} />
        </div>

        {/* Right: action buttons */}
        <div className="cc-actions-row" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {server.status === 'RUNNING' ? (
            <>
              <button
                onClick={() => handleAction('restart')}
                disabled={actionLoading}
                className="cc-btn-warning"
                style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
              >
                ↺ Restart
              </button>
              <button
                onClick={() => handleAction('stop')}
                disabled={actionLoading}
                className="cc-btn-danger"
              >
                ■ Stop
              </button>
              <button
                onClick={() => handleAction('kill')}
                disabled={actionLoading}
                style={{ background: 'rgba(248,81,73,0.1)', color: 'var(--danger)', border: '1px solid rgba(248,81,73,0.2)', borderRadius: '6px', padding: '5px 12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
              >
                ✕ Kill
              </button>
            </>
          ) : (
            <button
              onClick={() => handleAction('start')}
              disabled={actionLoading}
              className="cc-btn-primary"
              style={{ padding: '6px 18px' }}
            >
              ▶ Start Server
            </button>
          )}
        </div>
      </header>

      {/* ── Tab Navigation ── */}
      <div className="cc-tab-nav no-scrollbar" style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        overflowX: 'auto',
      }}>
        <div style={{ display: 'flex', gap: '20px', flexShrink: 0 }}>
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`cc-tab${activeTab === tab.key ? ' cc-tab-active' : ''}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {user?.globalRole === 'GLOBAL_ADMIN' && (
          <button
            onClick={() => setShowPermissionsModal(true)}
            style={{
              background: 'rgba(139,92,246,0.12)', color: '#a78bfa',
              border: '1px solid rgba(139,92,246,0.25)', borderRadius: '6px',
              padding: '4px 12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0, marginLeft: '12px',
            }}
          >
            👤 Access &amp; Privileges
          </button>
        )}
      </div>

      {/* ── Main Content ── */}
      <main className="cc-main-content" style={{ flex: 1, maxWidth: '1280px', width: '100%', margin: '0 auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {activeTab === 'console' && (
          <div className="animate-fadeIn" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Modrinth notice */}
            {server.serverType === 'MODRINTH' && server.modpackSlug && (
              <div style={{ background: 'rgba(0,217,126,0.06)', border: '1px solid var(--accent-border)', borderRadius: '10px', padding: '14px 18px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '1.1rem', marginTop: '2px' }}>ℹ️</div>
                <div>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--accent)', marginBottom: '4px' }}>Client Compatibility Requirement</div>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
                    This server runs the official <strong style={{ color: 'var(--text-primary)' }}>Modrinth Build ({server.mcVersion})</strong>.
                    Players <strong>MUST install this modpack</strong> from the{' '}
                    <a href={`https://modrinth.com/modpack/${server.modpackSlug}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
                      Modrinth App
                    </a>.
                  </p>
                </div>
              </div>
            )}

            {/* Analytics */}
            <AnalyticsWidget serverId={server.id} memoryLimitMb={server.memoryMb} />

            {/* Console */}
            <div>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Live Terminal & Output
              </div>
              <ConsoleViewer
                serverId={server.id}
                containerId={server.containerId || `mc-server-${server.id}`}
                daemonHost={server.node.host}
                daemonPort={server.node.port}
                apiKey={server.node.apiKey}
              />
            </div>

            {/* Migration */}
            <div className="cc-card" style={{ padding: '20px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>Server Migration</span>
              </div>
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                Instantly transfer this server and all of its files to a different node.
              </p>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  value={migrationDestId}
                  onChange={(e) => setMigrationDestId(e.target.value)}
                  className="cc-input"
                  style={{ maxWidth: '260px' }}
                >
                  <option value="">Select Destination Node...</option>
                  {nodes
                    .filter(n => n.id !== server.nodeId)
                    .map(n => (
                      <option key={n.id} value={n.id}>
                        {n.name} (Priority {n.offloadPriority}) {n.isOnline ? '' : '- OFFLINE'}
                      </option>
                    ))}
                </select>
                <button
                  onClick={handleMigrate}
                  disabled={actionLoading || !migrationDestId}
                  style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '6px', padding: '8px 18px', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer', opacity: (actionLoading || !migrationDestId) ? 0.5 : 1 }}
                >
                  {actionLoading ? 'Migrating...' : 'Start Migration'}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'players' && <PlayersTab serverId={server.id} />}
        {activeTab === 'properties' && <PropertiesTab serverId={server.id} />}
        {activeTab === 'update' && <UpdateCenterTab server={server} onUpdateSuccess={fetchServerDetails} />}
        {activeTab === 'schedules' && <SchedulesTab serverId={server.id} />}
        {activeTab === 'backups' && <BackupsTab serverId={server.id} />}
        {activeTab === 'domain' && <SubdomainTab serverId={server.id} />}
        {activeTab === 'files' && (
          <div className="animate-fadeIn">
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Server File Explorer
            </div>
            <FileExplorer
              serverId={server.id}
              canManageFiles={user?.globalRole === 'GLOBAL_ADMIN' || userRole === 'OPERATOR' || userRole === 'ADMIN'}
            />
          </div>
        )}

        <ServerPermissionsModal
          serverId={server.id}
          serverName={server.name}
          isOpen={showPermissionsModal}
          onClose={() => setShowPermissionsModal(false)}
        />
      </main>
    </div>
  );
}
