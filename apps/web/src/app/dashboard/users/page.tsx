'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';

interface UserItem {
  id: string;
  email: string;
  username: string;
  globalRole: string;
  createdAt: string;
}

interface InviteItem {
  id: string;
  code: string;
  uses: number;
  maxUses: number | null;
  createdAt: string;
  creator?: { username: string };
}

export default function UsersDashboardPage() {
  const { user, logout, loading } = useAuth();
  const [users, setUsers] = useState<UserItem[]>([]);
  const [invites, setInvites] = useState<InviteItem[]>([]);
  
  const [activeTab, setActiveTab] = useState<'users' | 'invites'>('users');
  const [error, setError] = useState('');
  
  // Create User State
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('USER');
  
  // Edit User State
  const [editingUser, setEditingUser] = useState<UserItem | null>(null);
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState('USER');
  
  // Create Invite State
  const [showCreateInvite, setShowCreateInvite] = useState(false);
  const [maxUses, setMaxUses] = useState<number | ''>('');

  useEffect(() => {
    if (user?.globalRole === 'GLOBAL_ADMIN') {
      fetchUsers();
      fetchInvites();
    }
  }, [user]);

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/users');
      if (res.ok) {
        const data = await res.json();
        setUsers(Array.isArray(data.users) ? data.users : Array.isArray(data) ? data : []);
      }
    } catch (e) { console.error(e); }
  };

  const fetchInvites = async () => {
    try {
      const res = await fetch('/api/invites');
      if (res.ok) {
        const data = await res.json();
        setInvites(Array.isArray(data.invites) ? data.invites : Array.isArray(data) ? data : []);
      }
    } catch (e) { console.error(e); }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, username: newUsername, password: newPassword, globalRole: newRole }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create user');
      setShowCreateUser(false);
      setNewEmail(''); setNewUsername(''); setNewPassword(''); setNewRole('USER');
      fetchUsers();
    } catch (err: any) { setError(err.message); }
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setError('');
    try {
      const res = await fetch(`/api/users/${editingUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: editPassword || undefined, globalRole: editRole }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to update user');
      setEditingUser(null);
      setEditPassword('');
      fetchUsers();
    } catch (err: any) { setError(err.message); }
  };

  const handleDeleteUser = async (id: string) => {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
      const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
      if (!res.ok) alert((await res.json()).error || 'Failed to delete user');
      fetchUsers();
    } catch (e) { console.error(e); }
  };

  const handleGenerateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxUses: maxUses === '' ? null : maxUses }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to generate invite');
      setShowCreateInvite(false);
      setMaxUses('');
      fetchInvites();
    } catch (err: any) { setError(err.message); }
  };

  const handleRevokeInvite = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this invite code?')) return;
    try {
      const res = await fetch(`/api/invites/${id}`, { method: 'DELETE' });
      if (!res.ok) alert('Failed to revoke invite');
      fetchInvites();
    } catch (e) { console.error(e); }
  };

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">Loading...</div>;
  if (!user || user.globalRole !== 'GLOBAL_ADMIN') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4 text-center">
        <h2 className="text-2xl font-bold text-white mb-2">Unauthorized</h2>
        <p className="text-slate-400 mb-6">Only Global Admins can access this page.</p>
        <Link href="/dashboard" className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-2.5 rounded-xl">Back to Dashboard</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur px-8 py-4 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center space-x-4">
          <Link href="/dashboard" className="flex items-center space-x-3 group">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20 group-hover:scale-105 transition">
              M
            </div>
            <span className="font-bold text-lg text-white">CraftControl</span>
          </Link>
          <span className="text-xs px-2.5 py-1 rounded bg-slate-800 text-slate-300 border border-slate-700 font-mono">
            Users & Invites
          </span>
          <Link href="/dashboard" className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3 py-1.5 rounded-lg font-medium transition">
            Back to Dashboard
          </Link>
        </div>
        <div className="flex items-center space-x-4">
          <div className="text-right">
            <div className="text-sm font-semibold text-white">{user.username}</div>
            <div className="text-xs text-slate-400">{user.email}</div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-8 py-8 space-y-8">
        <div className="flex space-x-4 border-b border-slate-800">
          <button
            onClick={() => setActiveTab('users')}
            className={`pb-3 text-sm font-medium border-b-2 transition ${activeTab === 'users' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            User Management
          </button>
          <button
            onClick={() => setActiveTab('invites')}
            className={`pb-3 text-sm font-medium border-b-2 transition ${activeTab === 'invites' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Invite Codes
          </button>
        </div>

        {activeTab === 'users' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-white">Registered Users</h2>
              <button onClick={() => setShowCreateUser(true)} className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2 rounded-xl transition">
                + Create User
              </button>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-800/50 text-xs uppercase text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="px-6 py-4">Username</th>
                    <th className="px-6 py-4">Email</th>
                    <th className="px-6 py-4">Role</th>
                    <th className="px-6 py-4">Created</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {(Array.isArray(users) ? users : []).map(u => (
                    <tr key={u.id} className="hover:bg-slate-800/20 transition">
                      <td className="px-6 py-4 font-medium text-white">{u.username}</td>
                      <td className="px-6 py-4">{u.email}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded text-xs font-mono ${u.globalRole === 'GLOBAL_ADMIN' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-800 text-slate-300 border border-slate-700'}`}>
                          {u.globalRole}
                        </span>
                      </td>
                      <td className="px-6 py-4">{new Date(u.createdAt).toLocaleDateString()}</td>
                      <td className="px-6 py-4 text-right space-x-3">
                        <button onClick={() => { setEditingUser(u); setEditRole(u.globalRole); setEditPassword(''); }} className="text-indigo-400 hover:text-indigo-300 font-medium">Edit</button>
                        {u.id !== user.id && (
                          <button onClick={() => handleDeleteUser(u.id)} className="text-red-400 hover:text-red-300 font-medium">Delete</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'invites' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-white">Active Invite Codes</h2>
              <button onClick={() => setShowCreateInvite(true)} className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2 rounded-xl transition">
                + Generate Invite
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {(Array.isArray(invites) ? invites : []).length === 0 && <div className="col-span-full text-slate-500 text-sm">No active invites.</div>}
              {(Array.isArray(invites) ? invites : []).map(inv => {
                const inviteUrl = `${window.location.origin}/register?invite=${inv.code}`;
                return (
                  <div key={inv.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 relative">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <div className="text-xs text-slate-400 mb-1">Invite Code</div>
                        <div className="font-mono text-emerald-400 font-bold tracking-wider">{inv.code}</div>
                      </div>
                      <button onClick={() => handleRevokeInvite(inv.id)} className="text-xs bg-red-500/10 text-red-400 px-2 py-1 rounded hover:bg-red-500/20 transition">Revoke</button>
                    </div>
                    <div className="flex items-center space-x-2 mb-4">
                      <input type="text" readOnly value={inviteUrl} className="w-full bg-slate-950 text-slate-300 text-xs px-3 py-2 rounded border border-slate-800 focus:outline-none" />
                      <button onClick={() => { navigator.clipboard.writeText(inviteUrl); alert('Copied!'); }} className="bg-slate-800 text-slate-300 hover:text-white px-3 py-2 rounded text-xs transition border border-slate-700">Copy</button>
                    </div>
                    <div className="flex justify-between text-xs text-slate-500">
                      <span>Uses: {inv.uses} / {inv.maxUses || '∞'}</span>
                      <span>By: {inv.creator?.username || 'System'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </main>

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-4">Edit {editingUser.username}</h3>
            {error && <div className="mb-4 text-sm text-red-400 bg-red-500/10 p-3 rounded">{error}</div>}
            <form onSubmit={handleEditUser} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">New Password (Leave blank to keep)</label>
                <input type="password" value={editPassword} onChange={e => setEditPassword(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-white" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">Role</label>
                <select value={editRole} onChange={e => setEditRole(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-white">
                  <option value="USER">User</option>
                  <option value="GLOBAL_ADMIN">Global Admin</option>
                </select>
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button type="button" onClick={() => setEditingUser(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
                <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2 rounded-xl transition">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Generate Invite Modal */}
      {showCreateInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-4">Generate Invite Link</h3>
            {error && <div className="mb-4 text-sm text-red-400 bg-red-500/10 p-3 rounded">{error}</div>}
            <form onSubmit={handleGenerateInvite} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">Max Uses (Optional)</label>
                <input type="number" min="1" placeholder="Unlimited" value={maxUses} onChange={e => setMaxUses(e.target.value ? parseInt(e.target.value) : '')} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-white" />
                <p className="text-xs text-slate-500 mt-1">Leave blank for unlimited uses</p>
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button type="button" onClick={() => setShowCreateInvite(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
                <button type="submit" className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-4 py-2 rounded-xl transition">Generate Link</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {showCreateUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-4">Create New User</h3>
            {error && <div className="mb-4 text-sm text-red-400 bg-red-500/10 p-3 rounded">{error}</div>}
            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">Email</label>
                <input required type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-white" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">Username</label>
                <input required type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-white" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">Password</label>
                <input required type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-white" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">Role</label>
                <select value={newRole} onChange={e => setNewRole(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-white">
                  <option value="USER">User</option>
                  <option value="GLOBAL_ADMIN">Global Admin</option>
                </select>
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button type="button" onClick={() => setShowCreateUser(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
                <button type="submit" className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-4 py-2 rounded-xl transition">Create User</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
