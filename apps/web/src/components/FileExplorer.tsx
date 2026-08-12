'use client';

import React, { useState, useEffect, useRef } from 'react';
import { uploadFileInChunks } from '@/lib/chunked-upload';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';

interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: string;
}

interface FileExplorerProps {
  serverId: string;
  canManageFiles: boolean;
}

export function FileExplorer({ serverId, canManageFiles }: FileExplorerProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Editor Modal State
  const [editingFilePath, setEditingFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [editorError, setEditorError] = useState('');

  // Create Folder Modal State
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // Rename Modal State
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [newName, setNewName] = useState('');

  // Upload State
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusMessage, setUploadStatusMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = async (targetPath: string = currentPath) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(targetPath)}`);
      const text = await res.text();
      let data: any = {};
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('[FileExplorer Raw Response]', text);
        throw new Error(`[v1.0.5] Server returned non-JSON response (HTTP ${res.status}): ${text.substring(0, 80)}`);
      }

      if (!res.ok) throw new Error(data.error || 'Failed to load files');

      setCurrentPath(data.currentPath || '');
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles(currentPath);
  }, [serverId, currentPath]);

  const handleOpenFolder = (folderPath: string) => {
    setCurrentPath(folderPath);
  };

  const handleBreadcrumbClick = (index: number) => {
    const parts = currentPath.split('/').filter(Boolean);
    const newPath = parts.slice(0, index + 1).join('/');
    setCurrentPath(newPath);
  };

  const handleOpenFile = async (file: FileItem) => {
    if (file.isDir) {
      handleOpenFolder(file.path);
      return;
    }

    // Read text file for editing
    setEditorError('');
    setEditingFilePath(file.path);
    setFileContent('Loading file content...');

    try {
      const res = await fetch(`/api/servers/${serverId}/files/content?path=${encodeURIComponent(file.path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to read file');

      setFileContent(data.content || '');
    } catch (err: any) {
      setEditorError(err.message);
      setFileContent('');
    }
  };

  const handleSaveFile = async () => {
    if (!editingFilePath) return;
    setIsSaving(true);
    setEditorError('');

    try {
      const res = await fetch(`/api/servers/${serverId}/files/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editingFilePath, content: fileContent }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save file');

      setEditingFilePath(null);
      fetchFiles(currentPath);
    } catch (err: any) {
      setEditorError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName) return;

    try {
      const res = await fetch(`/api/servers/${serverId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-folder', path: currentPath, name: newFolderName }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create folder');

      setShowFolderModal(false);
      setNewFolderName('');
      fetchFiles(currentPath);
    } catch (err: any) {
      toast.error('Could not create the folder', err.message);
    }
  };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget || !newName) return;

    const parts = renameTarget.path.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');

    try {
      const res = await fetch(`/api/servers/${serverId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', oldPath: renameTarget.path, newPath }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to rename');

      setRenameTarget(null);
      setNewName('');
      fetchFiles(currentPath);
    } catch (err: any) {
      toast.error('Could not rename it', err.message);
    }
  };

  const handleDelete = async (file: FileItem) => {
    const ok = await confirm({
      title: file.isDir ? 'Delete this folder?' : 'Delete this file?',
      message: (
        <>
          <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{file.name}</code> will be removed from
          the server{file.isDir ? ', along with everything inside it' : ''}. Deleting the wrong file here can stop the server
          from starting.
        </>
      ),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(file.path)}`, {
        method: 'DELETE',
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete file');

      fetchFiles(currentPath);
    } catch (err: any) {
      toast.error('Could not delete it', err.message);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);
    setUploadStatusMessage(`Uploading ${file.name} (0%)...`);
    setError('');

    try {
      await uploadFileInChunks({
        serverId,
        file,
        isServerpack: false,
        targetPath: currentPath,
        onProgress: (percent) => {
          setUploadProgress(percent);
          if (percent < 100) {
            setUploadStatusMessage(`Uploading ${file.name} (${percent}%)...`);
          } else {
            setUploadStatusMessage(`Assembling ${file.name} on server...`);
          }
        },
      });

      fetchFiles(currentPath);
    } catch (err: any) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const filesArr = Array.from(fileList);
    const totalBytes = filesArr.reduce((sum, f) => sum + f.size, 0);
    let uploadedBytesSoFar = 0;

    setIsUploading(true);
    setUploadProgress(0);
    setError('');

    try {
      for (const file of filesArr) {
        // webkitRelativePath looks like "topFolder/sub/file.ext" — everything but the
        // last segment is where the file needs to land relative to the current directory.
        const relPath = (file as any).webkitRelativePath || file.name;
        const relDir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
        const targetPath = currentPath ? (relDir ? `${currentPath}/${relDir}` : currentPath) : relDir;

        await uploadFileInChunks({
          serverId,
          file,
          isServerpack: false,
          targetPath,
          onProgress: (percent, fileUploadedBytes) => {
            const overallBytes = uploadedBytesSoFar + fileUploadedBytes;
            const overallPercent = totalBytes > 0 ? Math.min(100, Math.round((overallBytes / totalBytes) * 100)) : 0;
            setUploadProgress(overallPercent);
            setUploadStatusMessage(
              percent < 100 ? `Uploading ${relPath} (${percent}%)...` : `Assembling ${relPath} on server...`
            );
          },
        });

        uploadedBytesSoFar += file.size;
      }

      fetchFiles(currentPath);
    } catch (err: any) {
      setError(`Folder upload failed: ${err.message}`);
    } finally {
      setIsUploading(false);
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '--';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const safePath = typeof currentPath === 'string' ? currentPath : '';
  const breadcrumbs = safePath.split('/').filter(Boolean);
  const safeFiles = Array.isArray(files) ? files : [];

  return (
    <div className="space-y-4">
      {/* File Explorer Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        
        {/* Breadcrumb Navigation */}
        <div className="flex items-center space-x-1 text-sm overflow-x-auto max-w-full">
          <button
            onClick={() => setCurrentPath('')}
            className={`font-semibold transition hover:text-emerald-400 ${currentPath === '' ? 'text-emerald-400' : 'text-slate-400'}`}
          >
            /root
          </button>
          {breadcrumbs.map((crumb, idx) => (
            <React.Fragment key={idx}>
              <span className="text-slate-600">/</span>
              <button
                onClick={() => handleBreadcrumbClick(idx)}
                className={`font-medium transition hover:text-emerald-400 ${idx === breadcrumbs.length - 1 ? 'text-white font-bold' : 'text-slate-400'}`}
              >
                {crumb}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* Action Buttons */}
        {canManageFiles && (
          <div className="flex items-center space-x-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
              disabled={isUploading}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-2 rounded-lg transition disabled:opacity-50 flex items-center gap-1"
            >
              Upload File
            </button>
            <input
              type="file"
              ref={folderInputRef}
              onChange={handleFolderUpload}
              className="hidden"
              disabled={isUploading}
              {...({ webkitdirectory: '', directory: '' } as any)}
              multiple
            />
            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={isUploading}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-2 rounded-lg transition disabled:opacity-50 flex items-center gap-1"
            >
              Upload Folder
            </button>
            <button
              onClick={() => setShowFolderModal(true)}
              disabled={isUploading}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-700 transition"
            >
              + New Folder
            </button>
            <button
              onClick={() => fetchFiles(currentPath)}
              disabled={isUploading}
              className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-xs font-semibold px-3 py-2 rounded-lg border border-emerald-500/30 transition"
            >
              Refresh
            </button>
          </div>
        )}
      </div>

      {isUploading && (
        <div className="bg-slate-900/90 border border-emerald-500/30 p-4 rounded-xl space-y-2">
          <div className="flex justify-between text-xs text-emerald-400 font-semibold">
            <span>{uploadStatusMessage}</span>
            <span>{uploadProgress}%</span>
          </div>
          <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
            <div
              className="bg-emerald-500 h-full transition-all duration-300 rounded-full"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm p-4 rounded-xl">
          {error}
        </div>
      )}

      {/* File List Table */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <table className="w-full text-left text-sm text-slate-300">
          <thead className="bg-slate-950/80 text-xs font-semibold uppercase text-slate-400 border-b border-slate-800">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3">Modified</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {loading ? (
              <tr>
                <td colSpan={4} className="text-center py-8 text-slate-500 text-sm">
                  Loading files...
                </td>
              </tr>
            ) : safeFiles.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center py-8 text-slate-500 text-sm">
                  Directory is empty
                </td>
              </tr>
            ) : (
              safeFiles.map((file) => (
                <tr key={file.path} className="hover:bg-slate-800/40 transition">
                  <td className="px-4 py-3 font-medium">
                    <button
                      onClick={() => handleOpenFile(file)}
                      className="flex items-center space-x-2 text-slate-200 hover:text-emerald-400 transition"
                    >
                      <span className="text-lg">
                        {file.isDir ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg>
                        )}
                      </span>
                      <span className={file.isDir ? 'font-bold text-emerald-300' : ''}>{file.name}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 font-mono">
                    {file.isDir ? '--' : formatSize(file.size)}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {new Date(file.modifiedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    {!file.isDir && (
                      <button
                        onClick={() => handleOpenFile(file)}
                        className="text-xs font-semibold text-emerald-400 hover:underline"
                      >
                        Edit
                      </button>
                    )}
                    {canManageFiles && (
                      <>
                        <button
                          onClick={() => {
                            setRenameTarget(file);
                            setNewName(file.name);
                          }}
                          className="text-xs font-semibold text-indigo-400 hover:underline"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => handleDelete(file)}
                          className="text-xs font-semibold text-red-400 hover:underline"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Text Editor Modal */}
      {editingFilePath && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950">
              <div className="flex items-center space-x-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg>
                <span className="font-mono text-sm font-bold text-white">{editingFilePath}</span>
              </div>
              <button
                onClick={() => setEditingFilePath(null)}
                className="text-slate-400 hover:text-white font-bold"
              >
                ✕
              </button>
            </div>

            {editorError && (
              <div className="bg-red-500/10 border-b border-red-500/30 text-red-400 text-xs px-6 py-2">
                {editorError}
              </div>
            )}

            <div className="flex-1 p-4 overflow-hidden">
              <textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                disabled={!canManageFiles}
                className="w-full h-full min-h-[400px] bg-slate-950 font-mono text-sm text-slate-200 border border-slate-800 rounded-xl p-4 focus:outline-none focus:border-emerald-500 resize-none"
              />
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-950">
              <span className="text-xs text-slate-500 font-mono">
                {fileContent.length} characters
              </span>
              <div className="flex space-x-3">
                <button
                  onClick={() => setEditingFilePath(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition"
                >
                  Cancel
                </button>
                {canManageFiles && (
                  <button
                    onClick={handleSaveFile}
                    disabled={isSaving}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-6 py-2 rounded-xl transition"
                  >
                    {isSaving ? 'Saving...' : 'Save File'}
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* New Folder Modal */}
      {showFolderModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <form onSubmit={handleCreateFolder} className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">Create New Folder</h3>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Folder Name</label>
              <input
                type="text"
                required
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="e.g. plugins or mods"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex justify-end space-x-3 pt-2">
              <button
                type="button"
                onClick={() => setShowFolderModal(false)}
                className="px-4 py-2 text-xs text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-5 py-2 rounded-xl"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rename Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <form onSubmit={handleRename} className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">Rename '{renameTarget.name}'</h3>
            <div>
              <label className="block text-xs text-slate-400 mb-1">New Name</label>
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex justify-end space-x-3 pt-2">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="px-4 py-2 text-xs text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-5 py-2 rounded-xl"
              >
                Rename
              </button>
            </div>
          </form>
        </div>
      )}

    </div>
  );
}
