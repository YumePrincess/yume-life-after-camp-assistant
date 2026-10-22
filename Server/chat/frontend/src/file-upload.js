// Only one bounded slice is held in memory. Every request stays well below the
// Cloudflare body limit; R2 credentials and encryption keys stay on the server.
export async function uploadChatFile(file, request, { signal, onProgress } = {}) {
  const config = await request('/upload/config', { signal });
  if (file.size > config.maxFileSize)
    throw new Error(`文件大小不能超过 ${Math.round(config.maxFileSize / 1024 / 1024)}MB`);
  if (file.size <= config.multipartThreshold) {
    const body = new FormData();
    body.append('file', file);
    const result = await request('/upload', { method: 'POST', body, signal,
      onUploadProgress: (loaded,total) => onProgress?.(Math.min(file.size, loaded / total * file.size), file.size) });
    onProgress?.(file.size, file.size);
    return result;
  }
  const session = await request('/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: { name: file.name, type: file.type, size: file.size }, signal
  });
  const base = `/uploads/${encodeURIComponent(session.uploadId)}`;
  try {
    const count = Math.ceil(file.size / session.chunkSize);
    for (let index = 0; index < count; index++) {
      const body = file.slice(index * session.chunkSize, Math.min(file.size, (index + 1) * session.chunkSize));
      // A network failure may occur after the part is stored. Re-uploading the
      // same index safely replaces it and saves its new ETag on the server.
      for (let attempt = 0; ; attempt++) {
        try {
          await request(`${base}/parts/${index + 1}`, { method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' }, body, signal,
            onUploadProgress: (loaded,total) => onProgress?.(Math.min(file.size, index * session.chunkSize + loaded / total * body.size), file.size) });
          break;
        } catch (error) {
          if (signal?.aborted || attempt >= 2 || (error.status && error.status < 500 && error.status !== 429)) throw error;
        }
      }
      onProgress?.(Math.min(file.size, (index + 1) * session.chunkSize), file.size);
    }
    // Retry finalization when the response was lost after a successful commit.
    for (let attempt = 0; ; attempt++) {
      try { return await request(`${base}/complete`, { method: 'POST', signal }); }
      catch (error) {
        if (signal?.aborted || attempt >= 2 || (error.status && error.status < 500)) throw error;
      }
    }
  } catch (error) {
    await request(base, { method: 'DELETE', signal: AbortSignal.timeout(10000) }).catch(() => {});
    throw error;
  }
}
