'use client';

import React, { useState, useEffect } from 'react';
import { useConfirm } from '@/context/ConfirmContext';

interface SystemUser {
  id: string;
  username: string;
  email: string;
  globalRole: string;
}

interface ServerPermissionItem {
  id: string;
  userId: string;
  role: 'VIEWER' | 'OPERATOR' | 'ADMIN';
  user: SystemUser;
}

interface ServerPermissionsModalProps {
  serverId: string;
  serverName: string;
  isOpen: boolean;
  onClose: () => void;
}

export function ServerPermissionsModal({ serverId, serverName, isOpen, onClose }: ServerPermissionsModalProps) {
  const confirm = useConfirm();
  const [permissions, setPermissions] = useState<ServerPermissionItem[]>([]);
  const [allUsers, setAllUsers] = useState<SystemUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState<'VIEWER' | 'OPERATOR' | 'ADMIN'>('OPERATOR');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError('');
    try {
      const [permRes, usersRes] = await Promise.all([
        fetch(`/api/servers/${serverId}/permissions`),
        fetch('/api/users'),
      ]);

      const permData = await permRes.json();
      const usersData = await usersRes.json();

      if (!permRes.ok) throw new Error(permData.error || 'Failed to load permissions');
      if (!usersRes.ok) throw new Error(usersData.error || 'Failed to load users');

      setPermissions(Array.isArray(permData.permissions) ? permData.permissions : []);
      setAllUsers(Array.isArray(usersData.users) ? usersData.users : []);
    } catch (err: any) {
      setError(err.message);
      setPermissions([]);
      setAllUsers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchData();
    }
  }, [isOpen, serverId]);

  const handleGrantPermission = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId) return;
    setIsSubmitting(true);
    setError('');

    try {
      const res = await fetch(`/api/servers/${serverId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: selectedUserId, role: selectedRole }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to assign permission');

      setSelectedUserId('');
      fetchData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevokePermission = async (permissionId: string) => {
    const ok = await confirm({
      title: 'Revoke access for this user?',
      message: 'They will no longer see or control this server in their dashboard. You can grant access again at any time.',
      confirmLabel: 'Revoke access',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/servers/${serverId}/permissions/${permissionId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to revoke access');

      fetchData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!isOpen) return null;

  const safeUsers = Array.isArray(allUsers) ? allUsers : [];
  const safePermissions = Array.isArray(permissions) ? permissions : [];

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl p-6 shadow-2xl space-y-6">
        
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">Manage User Privileges</h2>
            <p className="text-xs text-slate-400">Control who has access to server <strong className="text-emerald-400">{serverName}</strong></p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white font-bold text-lg">✕</button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs p-3 rounded-xl">
            {error}
          </div>
        )}

        {/* Grant Permission Form */}
        <form onSubmit={handleGrantPermission} className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Grant / Update User Access</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                required
                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500"
              >
                <option value="">Select User...</option>
                {safeUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username} ({u.email}) - Role: {u.globalRole}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as any)}
                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500"
              >
                <option value="VIEWER">VIEWER (Read Only)</option>
                <option value="OPERATOR">OPERATOR (Start/Stop & Files)</option>
                <option value="ADMIN">ADMIN (Full Access)</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={isSubmitting}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition"
            >
              {isSubmitting ? 'Saving...' : 'Grant Access'}
            </button>
          </div>
        </form>

        {/* Current Permissions Table */}
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Active User Access Grants</h3>
          <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden max-h-60 overflow-y-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-900 text-slate-400 uppercase font-semibold">
                <tr>
                  <th className="px-4 py-2.5">User</th>
                  <th className="px-4 py-2.5">Access Role</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {loading ? (
                  <tr>
                    <td colSpan={3} className="text-center py-6 text-slate-500">Loading permissions...</td>
                  </tr>
                ) : (Array.isArray(permissions) ? permissions : []).length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center py-6 text-slate-500">No custom permissions granted yet. Only Global Admins have access.</td>
                  </tr>
                ) : (
                  (Array.isArray(permissions) ? permissions : []).map((p) => (
                    <tr key={p.id} className="hover:bg-slate-900/50">
                      <td className="px-4 py-3">
                        <span className="font-semibold text-white">{p.user?.username || 'Unknown User'}</span>
                        <span className="text-slate-500 text-[10px] block">{p.user?.email || p.userId}</span>
                      </td>
                      <td className="px-4 py-3 font-mono">
                        <span className={`px-2 py-1 rounded text-[10px] font-bold ${
                          p.role === 'ADMIN' ? 'bg-purple-500/20 text-purple-400' :
                          p.role === 'OPERATOR' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                        }`}>
                          {p.role}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRevokePermission(p.id)}
                          className="text-red-400 hover:text-red-300 font-bold"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold px-5 py-2 rounded-xl"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
}
