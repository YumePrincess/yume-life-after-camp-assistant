import { decryptAttachment, decryptAttachmentChunk, ATTACHMENT_CHUNK_OVERHEAD } from './encryption.js';
import { storageObjectKey } from './storage-path.js';

// Single byte ranges cover browser media seeking and resumable downloads. Reject
// multipart ranges rather than buffering several potentially enormous responses.
export function parseAttachmentRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}

function decryptedStream(source, env, key, manifest, range, first, last) {
  const reader = source.getReader();
  let pending = null, pendingOffset = 0, index = first;
  return new ReadableStream({
    async pull(controller) {
      try {
        const plainSize = Math.min(manifest.chunk_size, manifest.size - index * manifest.chunk_size);
        const frame = new Uint8Array(plainSize + ATTACHMENT_CHUNK_OVERHEAD);
        let filled = 0;
        while (filled < frame.length) {
          if (!pending || pendingOffset === pending.length) {
            const read = await reader.read();
            if (read.done) throw new Error('Encrypted attachment is truncated');
            pending = read.value;
            pendingOffset = 0;
          }
          const length = Math.min(frame.length - filled, pending.length - pendingOffset);
          frame.set(pending.subarray(pendingOffset, pendingOffset + length), filled);
          filled += length;
          pendingOffset += length;
        }
        const plain = await decryptAttachmentChunk(env, frame, key, manifest, index + 1);
        const offset = index * manifest.chunk_size;
        controller.enqueue(plain.subarray(Math.max(0, range.start - offset), Math.min(plain.length, range.end - offset + 1)));
        if (index++ === last) { controller.close(); await reader.cancel(); }
      } catch (error) { controller.error(error); await reader.cancel(error); }
    },
    cancel(reason) { return reader.cancel(reason); }
  }, { highWaterMark: 0 });
}

export async function readAttachment(env, key, rangeHeader = null) {
  const manifest = await env.DB.prepare(`SELECT c.chunk_size,c.key_id,f.size FROM chat_file_chunks c
    JOIN uploaded_files f ON f.object_key=c.object_key WHERE c.object_key=?`).bind(key).first();
  const physicalKey = storageObjectKey(env, key);
  if (!manifest) {
    const object = await env.FILES.get(physicalKey);
    if (!object) return null;
    const { bytes } = await decryptAttachment(env, await object.arrayBuffer(), key);
    const range = parseAttachmentRange(rangeHeader, bytes.length);
    const headers = responseHeaders(object, bytes.length, range);
    return { object, headers, status: !range ? 416 : range.partial ? 206 : 200,
      body: range ? bytes.subarray(range.start, range.end + 1) : null };
  }
  const range = parseAttachmentRange(rangeHeader, manifest.size);
  if (!range) {
    const object = await env.FILES.head(physicalKey);
    return object ? { object, headers: responseHeaders(object, manifest.size, null), status: 416, body: null } : null;
  }
  const first = Math.floor(range.start / manifest.chunk_size);
  const last = Math.floor(range.end / manifest.chunk_size);
  const offset = first * (manifest.chunk_size + ATTACHMENT_CHUNK_OVERHEAD);
  const end = Math.min(manifest.size, (last + 1) * manifest.chunk_size) + (last + 1) * ATTACHMENT_CHUNK_OVERHEAD;
  const object = await env.FILES.get(physicalKey, { range: { offset, length: end - offset } });
  if (!object) return null;
  return { object, headers: responseHeaders(object, manifest.size, range), status: range.partial ? 206 : 200,
    body: decryptedStream(object.body, env, key, manifest, range, first, last) };
}
function responseHeaders(object, size, range) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Length', String(range ? Math.max(0, range.end - range.start + 1) : 0));
  if (!range) headers.set('Content-Range', `bytes */${size}`);
  else if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  return headers;
}
