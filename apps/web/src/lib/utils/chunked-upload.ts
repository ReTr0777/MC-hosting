export interface ChunkedUploadOptions {
  serverId: string;
  file: File;
  isServerpack?: boolean;
  targetPath?: string;
  /** Extracts the uploaded .tar.gz over the server's root directory instead of treating it as a serverpack or a plain file. */
  isFullImport?: boolean;
  chunkSizeMB?: number; // Default 20MB per chunk, well below Cloudflare's 100MB payload limit
  onProgress?: (percent: number, uploadedBytes: number, totalBytes: number) => void;
}

export async function uploadFileInChunks(options: ChunkedUploadOptions): Promise<any> {
  const {
    serverId,
    file,
    isServerpack = true,
    targetPath = '',
    isFullImport = false,
    chunkSizeMB = 20,
    onProgress,
  } = options;

  const CHUNK_SIZE = chunkSizeMB * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  let uploadedBytes = 0;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const chunkBlob = file.slice(start, end);
    const chunkBuffer = await chunkBlob.arrayBuffer();

    let retries = 3;
    let success = false;
    let lastErr: any = null;

    while (retries > 0 && !success) {
      try {
        const res = await fetch(`/api/servers/${serverId}/upload-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Upload-Id': uploadId,
            'X-Chunk-Index': String(i),
          },
          body: chunkBuffer,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Chunk ${i + 1}/${totalChunks} failed (HTTP ${res.status}): ${errText}`);
        }
        success = true;
      } catch (err: any) {
        lastErr = err;
        retries--;
        if (retries > 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    if (!success) {
      throw new Error(lastErr?.message || `Failed to upload chunk ${i + 1}/${totalChunks}`);
    }

    uploadedBytes += chunkBlob.size;
    const percent = Math.min(100, Math.round((uploadedBytes / file.size) * 100));
    if (onProgress) {
      onProgress(percent, uploadedBytes, file.size);
    }
  }

  // Finalize assembly on daemon
  const completeRes = await fetch(`/api/servers/${serverId}/upload-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId,
      fileName: file.name,
      totalChunks,
      totalBytes: file.size,
      isServerpack,
      targetPath,
      isFullImport,
    }),
  });

  const text = await completeRes.text();
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Upload assembly failed (HTTP ${completeRes.status}): ${text.substring(0, 150)}`);
  }

  if (!completeRes.ok) {
    throw new Error(data.error || data.details || `Upload completion failed with status ${completeRes.status}`);
  }

  return data;
}
