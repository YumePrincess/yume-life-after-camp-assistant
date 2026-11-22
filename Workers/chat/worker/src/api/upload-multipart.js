import { validateUpload } from '../upload-validation.js';
import { ApiError } from '../errors.js';
import { loadEncryptionKeyring, encryptAttachmentChunk, ATTACHMENT_CHUNK_OVERHEAD } from '../encryption.js';
import { normalizeContentType, sanitizeFilename } from '../attachment-metadata.js';
import { storageObjectKey } from '../storage-path.js';

export const LEGACY_UPLOAD_LIMIT = 25 * 1024 * 1024;
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_MULTIPART_FILE_SIZE = 50 * 1024 * 1024 * 1024;
const SESSION_SECONDS = 24 * 60 * 60;
const asFile = row => ({ key: row.object_key, name: row.filename, type: row.content_type,
  size: row.size, url: `/chat/files/${encodeURIComponent(row.object_key)}` });
const now = () => Math.floor(Date.now() / 1000);
const multipart = (env, row) => env.FILES.resumeMultipartUpload(storageObjectKey(env, row.object_key), row.r2_upload_id);
async function abortMultipart(env, row) {
  try { await multipart(env, row).abort(); }
  catch (error) {
    // R2 may already have completed or expired the upload. The unpublished
    // object/session must still be cleaned up in that case.
    if (!/10024|NoSuchUpload/.test(String(error?.message || error))) throw error;
  }
}

async function ownedSession(c) {
  const row = await c.env.DB.prepare('SELECT * FROM chat_upload_sessions WHERE id=? AND owner_user_id=?')
    .bind(c.req.param('id'), c.get('session').userId).first();
  if (!row) throw new ApiError('上传任务不存在', 404);
  if (row.expires_at <= now()) throw new ApiError('上传任务已过期，请重新上传', 410);
  if (!c.env.FILES) throw new ApiError('当前部署没有绑定 R2，无法上传附件', 503);
  return row;
}
function validateCurrentPolicy(env, row) {
  try { validateUpload(env, { size: row.size, type: row.content_type }); }
  catch (error) { throw new ApiError(error.message, 413); }
}

export function registerMultipartUploadRoutes(app) {
  app.get('/api/upload/config', c => c.json({
    maxFileSize: Math.min(Number(c.env.MAX_FILE_SIZE || 20971520), MAX_MULTIPART_FILE_SIZE),
    multipartThreshold: UPLOAD_CHUNK_SIZE,
    chunkSize: UPLOAD_CHUNK_SIZE,
    multipartAvailable: Boolean(c.env.FILES)
  }));
  app.post('/api/uploads', async c => {
    if (!c.env.FILES) throw new ApiError('当前部署没有绑定 R2，无法上传附件', 503);
    const payload = await c.req.json();
    const size = Number(payload.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MULTIPART_FILE_SIZE)
      throw new ApiError('文件大小无效');
    validateCurrentPolicy(c.env, { size, content_type: payload.type });
    const owner = c.get('session').userId;
    // Expired sessions are periodically aborted; they do not block a new attempt.
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM chat_upload_sessions WHERE owner_user_id=? AND status!='completed' AND expires_at>?")
      .bind(owner, now()).first();
    if (count.count >= 3) throw new ApiError('同时上传的文件过多，请稍后重试', 429);
    const id = crypto.randomUUID();
    const filename = sanitizeFilename(payload.name);
    const extension = filename.match(/\.[a-z0-9]{1,12}$/i)?.[0] || '';
    const key = `${owner}/${id}${extension}`;
    const contentType = normalizeContentType(payload.type) || 'application/octet-stream';
    const keyId = loadEncryptionKeyring(c.env).activeKeyId;
    const upload = await c.env.FILES.createMultipartUpload(storageObjectKey(c.env, key), {
      httpMetadata: { contentType, cacheControl: 'private, no-store' },
      customMetadata: { filename, edgechatEncryption: 'v2-chunked', uploadSession: id }
    });
    try {
      await c.env.DB.prepare(`INSERT INTO chat_upload_sessions
        (id,owner_user_id,object_key,r2_upload_id,filename,content_type,size,chunk_size,key_id,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id, owner, key, upload.uploadId, filename, contentType,
          size, UPLOAD_CHUNK_SIZE, keyId, now() + SESSION_SECONDS).run();
    } catch (error) { await upload.abort(); throw error; }
    return c.json({ uploadId: id, chunkSize: UPLOAD_CHUNK_SIZE });
  });
  app.put('/api/uploads/:id/parts/:part', async c => {
    const row = await ownedSession(c);
    if (row.status !== 'open') throw new ApiError('上传任务已结束', 409);
    validateCurrentPolicy(c.env, row);
    const index = Number(c.req.param('part'));
    const count = Math.ceil(row.size / row.chunk_size);
    if (!Number.isInteger(index) || index < 1 || index > count) throw new ApiError('上传分块无效');
    const expected = Math.min(row.chunk_size, row.size - (index - 1) * row.chunk_size);
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength !== expected) throw new ApiError('上传分块大小不匹配');
    const encrypted = await encryptAttachmentChunk(c.env, bytes, row.object_key, row, index);
    const part = await multipart(c.env, row).uploadPart(index, encrypted);
    await c.env.DB.prepare(`INSERT INTO chat_upload_parts(upload_id,part_number,etag) VALUES(?,?,?)
      ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag`)
      .bind(row.id, index, part.etag).run();
    return c.json({ partNumber: index });
  });
  app.post('/api/uploads/:id/complete', async c => {
    const row = await ownedSession(c);
    if (row.status === 'completed') return c.json({ file: asFile(row) });
    validateCurrentPolicy(c.env, row);
    await c.env.DB.prepare("UPDATE chat_upload_sessions SET status='completing' WHERE id=? AND status='open'")
      .bind(row.id).run();
    try {
      const { results } = await c.env.DB.prepare('SELECT part_number,etag FROM chat_upload_parts WHERE upload_id=? ORDER BY part_number')
        .bind(row.id).all();
      const count = Math.ceil(row.size / row.chunk_size);
      if (results.length !== count || results.some((part, index) => part.part_number !== index + 1))
        throw new ApiError('文件尚未上传完成', 409);
      // A completed R2 object also makes a retried finalization safe after a DB failure.
      let object = await c.env.FILES.head(storageObjectKey(c.env, row.object_key));
      if (!object) object = await multipart(c.env, row).complete(results.map(part => ({ partNumber: part.part_number, etag: part.etag })));
      if (object.size !== row.size + count * ATTACHMENT_CHUNK_OVERHEAD || object.customMetadata?.uploadSession !== row.id)
        throw new Error('Multipart object metadata mismatch');
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO uploaded_files(object_key,owner_user_id,filename,content_type,size)
          VALUES(?,?,?,?,?) ON CONFLICT(object_key) DO NOTHING`)
          .bind(row.object_key, row.owner_user_id, row.filename, row.content_type, row.size),
        c.env.DB.prepare(`INSERT INTO chat_file_chunks(object_key,chunk_size,key_id) VALUES(?,?,?)
          ON CONFLICT(object_key) DO NOTHING`).bind(row.object_key, row.chunk_size, row.key_id),
        c.env.DB.prepare("UPDATE chat_upload_sessions SET status='completed' WHERE id=?").bind(row.id)
      ]);
      return c.json({ file: asFile(row) });
    } catch (error) {
      await c.env.DB.prepare("UPDATE chat_upload_sessions SET status='open' WHERE id=? AND status='completing'").bind(row.id).run();
      throw error;
    }
  });
  app.delete('/api/uploads/:id', async c => {
    const row = await ownedSession(c);
    if (row.status === 'completed') return c.json({ ok: true });
    // If completion succeeded in R2 but not D1, remove the unpublished object too.
    await abortMultipart(c.env, row);
    await c.env.FILES.delete(storageObjectKey(c.env, row.object_key));
    await c.env.DB.prepare('DELETE FROM chat_upload_sessions WHERE id=?').bind(row.id).run();
    return c.json({ ok: true });
  });
}

export async function cleanupExpiredUploads(env, budget) {
  if (!env.FILES || !budget.spend({ d1ApiCalls: 1, d1Statements: 1 })) return;
  const { results } = await env.DB.prepare('SELECT * FROM chat_upload_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 5').bind(now()).all();
  for (const row of results) {
    if (!budget.spend({ d1ApiCalls: 1, d1Statements: 1, r2Operations: row.status === 'completed' ? 0 : 2 })) break;
    try {
      if (row.status !== 'completed') {
        await abortMultipart(env, row);
        await env.FILES.delete(storageObjectKey(env, row.object_key));
      }
      await env.DB.prepare('DELETE FROM chat_upload_sessions WHERE id=?').bind(row.id).run();
    } catch (error) { console.warn('Expired multipart upload cleanup failed', { id: row.id, message: String(error?.message) }); }
  }
}
