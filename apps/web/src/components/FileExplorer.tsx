'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { uploadFileInChunks } from '@/lib/chunked-upload';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { apiPost, apiRequest, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { InlineError, Modal } from '@/components/ui';

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

/** Rejects path separators and the specials that would escape the current directory. */
const NAME_PATTERN = /^[^/\\:*?"<>|]+$/;

function isValidName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed !== '.' && trimmed !== '..' && NAME_PATTERN.test(trimmed);
}

const FolderIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
  </svg>
);

const FileIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" />
  </svg>
);

/** One stored version of a config file, newest first as returned by the daemon. */
interface Revision {
  id: string;
  savedAt: string;
  size: number;
  sha1: string;
}

export function FileExplorer({ serverId, canManageFiles }: FileExplorerProps) {
  const toast = useToast();
  const confirm = useConfirm();

  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Editor
  const [editingFilePath, setEditingFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editorError, setEditorError] = useState('');

  // Version history for the file currently open in the editor.
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [previewing, setPreviewing] = useState<{ id: string; content: string } | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [showFolderModal, setShowFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [newName, setNewName] = useState('');

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusMessage, setUploadStatusMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = async (targetPath: string = currentPath) => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest(`/api/servers/${serverId}/files?path=${encodeURIComponent(targetPath)}`);
      setCurrentPath(data?.currentPath || '');
      setFiles(Array.isArray(data?.files) ? data.files : []);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load files'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles(currentPath);
    // currentPath drives navigation; fetchFiles is stable enough for this component's needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, currentPath]);

  // Folders first, then case-insensitive by name — the order every file manager uses.
  const sortedFiles = useMemo(
    () =>
      [...files].sort((a, b) =>
        a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      ),
    [files]
  );

  const editorDirty = editingFilePath !== null && fileContent !== savedContent;

  const handleBreadcrumbClick = (index: number) => {
    const parts = currentPath.split('/').filter(Boolean);
    setCurrentPath(parts.slice(0, index + 1).join('/'));
  };

  const handleOpenFile = async (file: FileItem) => {
    if (file.isDir) {
      setCurrentPath(file.path);
      return;
    }

    setEditorError('');
    setEditingFilePath(file.path);
    setFileContent('');
    setSavedContent('');
    setLoadingContent(true);

    setRevisions([]);
    setShowHistory(false);
    setPreviewing(null);

    try {
      const data = await apiRequest(`/api/servers/${serverId}/files/content?path=${encodeURIComponent(file.path)}`);
      const content = data?.content || '';
      setFileContent(content);
      setSavedContent(content);
    } catch (err) {
      setEditorError(errorMessage(err, 'Failed to read file'));
    } finally {
      setLoadingContent(false);
    }

    // History is a nice-to-have next to the file itself, so a failure here stays silent rather
    // than covering the editor with an error about a feature the user didn't ask for yet.
    loadRevisions(file.path);
  };

  const loadRevisions = async (filePath: string) => {
    try {
      const data = await apiRequest(
        `/api/servers/${serverId}/files/revisions?path=${encodeURIComponent(filePath)}`
      );
      setRevisions(data?.revisions ?? []);
    } catch (err) {
      setRevisions([]);
    }
  };

  const previewRevision = async (revisionId: string) => {
    if (!editingFilePath) return;
    if (previewing?.id === revisionId) {
      setPreviewing(null);
      return;
    }
    try {
      const data = await apiRequest(
        `/api/servers/${serverId}/files/revisions?path=${encodeURIComponent(editingFilePath)}&revisionId=${revisionId}`
      );
      setPreviewing({ id: revisionId, content: data?.content ?? '' });
    } catch (err) {
      toast.error('Could not open that version', errorMessage(err));
    }
  };

  const restoreRevision = async (revision: Revision) => {
    if (!editingFilePath) return;

    const ok = await confirm({
      title: `Restore the version from ${new Date(revision.savedAt).toLocaleString()}?`,
      message: editorDirty
        ? 'This overwrites the file on the server and discards the unsaved edits in this editor. The current file contents are saved as a new version first, so this can be undone.'
        : 'This overwrites the file on the server. The current contents are saved as a new version first, so this can be undone.',
      confirmLabel: 'Restore this version',
      danger: true,
    });
    if (!ok) return;

    setRestoringId(revision.id);
    try {
      await apiPost(`/api/servers/${serverId}/files/revisions`, {
        path: editingFilePath,
        revisionId: revision.id,
      });
      const data = await apiRequest(
        `/api/servers/${serverId}/files/content?path=${encodeURIComponent(editingFilePath)}`
      );
      const content = data?.content || '';
      setFileContent(content);
      setSavedContent(content);
      setPreviewing(null);
      await loadRevisions(editingFilePath);
      toast.success('Version restored', 'Restart the server if it reads this file at startup.');
    } catch (err) {
      toast.error('Could not restore that version', errorMessage(err));
    } finally {
      setRestoringId(null);
    }
  };

  const closeEditor = async () => {
    if (editorDirty) {
      const ok = await confirm({
        title: 'Discard your changes?',
        message: 'This file has unsaved edits. Closing the editor now throws them away.',
        confirmLabel: 'Discard changes',
        danger: true,
      });
      if (!ok) return;
    }
    setEditingFilePath(null);
    setEditorError('');
  };

  const handleSaveFile = async () => {
    if (!editingFilePath) return;
    setIsSaving(true);
    setEditorError('');
    try {
      await apiRequest(`/api/servers/${serverId}/files/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editingFilePath, content: fileContent }),
      });
      setSavedContent(fileContent);
      setEditingFilePath(null);
      toast.success('File saved', 'The previous version is kept in this file’s history if you need to go back.');
      fetchFiles(currentPath);
    } catch (err) {
      setEditorError(errorMessage(err, 'Failed to save file'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!isValidName(name)) {
      toast.error('That folder name isn\'t valid', 'Avoid / \\ : * ? " < > | and the names "." and "..".');
      return;
    }

    try {
      await apiPost(`/api/servers/${serverId}/files`, { action: 'create-folder', path: currentPath, name });
      setShowFolderModal(false);
      setNewFolderName('');
      toast.success(`Created “${name}”`);
      fetchFiles(currentPath);
    } catch (err) {
      toast.error('Could not create the folder', errorMessage(err));
    }
  };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget) return;

    const name = newName.trim();
    if (!isValidName(name)) {
      toast.error('That name isn\'t valid', 'Avoid / \\ : * ? " < > | and the names "." and "..".');
      return;
    }
    if (name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }

    const parts = renameTarget.path.split('/');
    parts[parts.length - 1] = name;

    try {
      await apiPost(`/api/servers/${serverId}/files`, {
        action: 'rename',
        oldPath: renameTarget.path,
        newPath: parts.join('/'),
      });
      setRenameTarget(null);
      setNewName('');
      toast.success(`Renamed to “${name}”`);
      fetchFiles(currentPath);
    } catch (err) {
      toast.error('Could not rename it', errorMessage(err));
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
      await apiRequest(`/api/servers/${serverId}/files?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
      toast.success(`Deleted “${file.name}”`);
      fetchFiles(currentPath);
    } catch (err) {
      toast.error('Could not delete it', errorMessage(err));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);
    setUploadStatusMessage(`Uploading ${file.name}…`);
    setError('');

    try {
      await uploadFileInChunks({
        serverId,
        file,
        isServerpack: false,
        targetPath: currentPath,
        onProgress: (percent) => {
          setUploadProgress(percent);
          setUploadStatusMessage(percent < 100 ? `Uploading ${file.name} (${percent}%)` : `Assembling ${file.name} on the server…`);
        },
      });
      toast.success(`Uploaded ${file.name}`);
      fetchFiles(currentPath);
    } catch (err) {
      setError(`Upload failed: ${errorMessage(err)}`);
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
            setUploadProgress(totalBytes > 0 ? Math.min(100, Math.round((overallBytes / totalBytes) * 100)) : 0);
            setUploadStatusMessage(percent < 100 ? `Uploading ${relPath} (${percent}%)` : `Assembling ${relPath} on the server…`);
          },
        });

        uploadedBytesSoFar += file.size;
      }
      toast.success(`Uploaded ${filesArr.length} file${filesArr.length === 1 ? '' : 's'}`);
      fetchFiles(currentPath);
    } catch (err) {
      setError(`Folder upload failed: ${errorMessage(err)}`);
    } finally {
      setIsUploading(false);
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const breadcrumbs = currentPath.split('/').filter(Boolean);

  const crumbStyle = (active: boolean): React.CSSProperties => ({
    background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer',
    fontSize: '0.8125rem', fontWeight: active ? 700 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
  });

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      {/* Toolbar */}
      <div className="cc-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: '2px', overflowX: 'auto', minWidth: 0 }}>
          <button onClick={() => setCurrentPath('')} style={crumbStyle(currentPath === '')}>root</button>
          {breadcrumbs.map((crumb, idx) => (
            <React.Fragment key={`${crumb}-${idx}`}>
              <span style={{ color: 'var(--border-2)' }}>/</span>
              <button onClick={() => handleBreadcrumbClick(idx)} style={crumbStyle(idx === breadcrumbs.length - 1)}>
                {crumb}
              </button>
            </React.Fragment>
          ))}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={() => fetchFiles(currentPath)} disabled={isUploading || loading} className="cc-btn-ghost">Refresh</button>
          {canManageFiles && (
            <>
              <input type="file" ref={fileInputRef} onChange={handleFileUpload} style={{ display: 'none' }} disabled={isUploading} />
              <input
                type="file"
                ref={folderInputRef}
                onChange={handleFolderUpload}
                style={{ display: 'none' }}
                disabled={isUploading}
                {...({ webkitdirectory: '', directory: '' } as any)}
                multiple
              />
              <button onClick={() => setShowFolderModal(true)} disabled={isUploading} className="cc-btn-ghost">New folder</button>
              <button onClick={() => folderInputRef.current?.click()} disabled={isUploading} className="cc-btn-ghost">Upload folder</button>
              <button onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="cc-btn-primary">Upload file</button>
            </>
          )}
        </div>
      </div>

      {isUploading && (
        <div className="cc-card" style={{ padding: '14px 16px', display: 'grid', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--accent)', fontWeight: 600 }}>
            <span>{uploadStatusMessage}</span>
            <span>{uploadProgress}%</span>
          </div>
          <div className="cc-bar-track">
            <div className="cc-bar-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {error && <InlineError message={error} onRetry={() => fetchFiles(currentPath)} />}

      {/* Listing */}
      <div className="cc-card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '620px' }}>
          <thead>
            <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
              {['Name', 'Size', 'Modified', ''].map((h, i) => (
                <th
                  key={h || i}
                  style={{
                    padding: '10px 16px', textAlign: i === 3 ? 'right' : 'left', fontSize: '0.62rem', fontWeight: 800,
                    letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} style={{ textAlign: 'center', padding: '32px', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Loading files…</td></tr>
            ) : sortedFiles.length === 0 ? (
              <tr><td colSpan={4} style={{ textAlign: 'center', padding: '32px', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>This folder is empty</td></tr>
            ) : (
              sortedFiles.map((file) => (
                <tr key={file.path} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 16px' }}>
                    <button
                      onClick={() => handleOpenFile(file)}
                      title={file.isDir ? `Open ${file.name}` : `Edit ${file.name}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none',
                        cursor: 'pointer', padding: 0, fontSize: '0.8125rem', textAlign: 'left',
                        color: file.isDir ? 'var(--accent)' : 'var(--text-primary)', fontWeight: file.isDir ? 600 : 400,
                      }}
                    >
                      {file.isDir ? <FolderIcon /> : <FileIcon />}
                      <span>{file.name}</span>
                    </button>
                  </td>
                  <td style={{ padding: '10px 16px', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {file.isDir ? '—' : formatBytes(file.size)}
                  </td>
                  <td style={{ padding: '10px 16px', fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {formatDateTime(file.modifiedAt)}
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', gap: '6px' }}>
                      {!file.isDir && (
                        <button onClick={() => handleOpenFile(file)} className="cc-btn-ghost" style={{ padding: '3px 9px' }}>Edit</button>
                      )}
                      {canManageFiles && (
                        <>
                          <button
                            onClick={() => { setRenameTarget(file); setNewName(file.name); }}
                            className="cc-btn-ghost"
                            style={{ padding: '3px 9px' }}
                          >
                            Rename
                          </button>
                          <button onClick={() => handleDelete(file)} className="cc-btn-danger" style={{ padding: '3px 9px' }}>Delete</button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Editor */}
      {editingFilePath && (
        <Modal
          title={editingFilePath}
          onClose={closeEditor}
          width={900}
          footer={
            <>
              <span style={{ marginRight: 'auto', fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {fileContent.length} characters{editorDirty ? ' · unsaved' : ''}
              </span>
              {revisions.length > 0 && (
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="cc-btn-ghost"
                  title="Earlier versions of this file, saved automatically before each edit"
                >
                  {showHistory ? 'Hide history' : `History (${revisions.length})`}
                </button>
              )}
              <button onClick={closeEditor} className="cc-btn-ghost">Cancel</button>
              {canManageFiles && (
                <button onClick={handleSaveFile} disabled={isSaving || loadingContent || !editorDirty} className="cc-btn-primary">
                  {isSaving ? 'Saving…' : 'Save file'}
                </button>
              )}
            </>
          }
        >
          {editorError && <div style={{ marginBottom: '12px' }}><InlineError message={editorError} /></div>}

          {showHistory && (
            <div
              style={{
                marginBottom: '12px',
                border: '1px solid var(--border-2)',
                borderRadius: '8px',
                padding: '10px 12px',
                display: 'grid',
                gap: '8px',
              }}
            >
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Saved automatically before each edit — newest first. Restoring keeps the current contents as a new
                version, so nothing is lost either way.
              </p>
              {revisions.map((revision, index) => (
                <div
                  key={revision.id}
                  style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.75rem' }}
                >
                  <span style={{ minWidth: '150px' }}>{new Date(revision.savedAt).toLocaleString()}</span>
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {revision.size} bytes
                  </span>
                  {index === 0 && <span style={{ color: 'var(--text-muted)' }}>(before the last save)</span>}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => previewRevision(revision.id)}
                      className="cc-btn-ghost"
                      style={{ padding: '3px 9px', fontSize: '0.72rem' }}
                    >
                      {previewing?.id === revision.id ? 'Hide' : 'View'}
                    </button>
                    {canManageFiles && (
                      <button
                        onClick={() => restoreRevision(revision)}
                        disabled={restoringId === revision.id}
                        className="cc-btn-ghost"
                        style={{ padding: '3px 9px', fontSize: '0.72rem' }}
                      >
                        {restoringId === revision.id ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {previewing && (
            <div style={{ marginBottom: '12px' }}>
              <p style={{ margin: '0 0 6px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Viewing the version from{' '}
                {new Date(revisions.find((r) => r.id === previewing.id)?.savedAt ?? '').toLocaleString()} — read-only.
              </p>
              <textarea
                value={previewing.content}
                readOnly
                spellCheck={false}
                aria-label="Previous version contents"
                style={{
                  width: '100%', minHeight: '22vh', background: 'var(--bg)', border: '1px dashed var(--border-2)',
                  borderRadius: '8px', padding: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
                  fontSize: '0.74rem', lineHeight: 1.6, resize: 'vertical', outline: 'none',
                }}
              />
            </div>
          )}

          <textarea
            value={loadingContent ? 'Loading file content…' : fileContent}
            onChange={(e) => setFileContent(e.target.value)}
            disabled={!canManageFiles || loadingContent}
            spellCheck={false}
            aria-label={`Contents of ${editingFilePath}`}
            style={{
              width: '100%', minHeight: '55vh', background: 'var(--bg)', border: '1px solid var(--border-2)',
              borderRadius: '8px', padding: '14px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem', lineHeight: 1.6, resize: 'vertical', outline: 'none',
            }}
          />
        </Modal>
      )}

      {/* New folder */}
      {showFolderModal && (
        <Modal
          title="Create a folder"
          onClose={() => setShowFolderModal(false)}
          width={440}
          footer={
            <>
              <button type="button" onClick={() => setShowFolderModal(false)} className="cc-btn-ghost">Cancel</button>
              <button type="submit" form="new-folder-form" className="cc-btn-primary">Create folder</button>
            </>
          }
        >
          <form id="new-folder-form" onSubmit={handleCreateFolder}>
            <label className="cc-label" htmlFor="folder-name">Folder name</label>
            <input
              id="folder-name"
              required
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="plugins"
              className="cc-input"
            />
            <p className="cc-help">Created inside {currentPath ? `/${currentPath}` : 'the server root'}.</p>
          </form>
        </Modal>
      )}

      {/* Rename */}
      {renameTarget && (
        <Modal
          title={`Rename “${renameTarget.name}”`}
          onClose={() => setRenameTarget(null)}
          width={440}
          footer={
            <>
              <button type="button" onClick={() => setRenameTarget(null)} className="cc-btn-ghost">Cancel</button>
              <button type="submit" form="rename-form" className="cc-btn-primary">Rename</button>
            </>
          }
        >
          <form id="rename-form" onSubmit={handleRename}>
            <label className="cc-label" htmlFor="rename-input">New name</label>
            <input
              id="rename-input"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="cc-input"
            />
            <p className="cc-help">Renaming a config or mod file can stop the server from starting.</p>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default FileExplorer;
