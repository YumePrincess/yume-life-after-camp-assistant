import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { chatDatabase } from './helpers/chat-db.mjs';
import { registerUploadRoutes, saveUploadedFile } from '../chat/worker/src/api/upload.js';
import { ApiError } from '../chat/worker/src/errors.js';
import { readAttachment, parseAttachmentRange } from '../chat/worker/src/attachment-reader.js';
import { uploadChatFile } from '../chat/frontend/src/file-upload.js';
import { encryptAttachmentChunk, decryptAttachmentChunk, loadEncryptionKeyring } from '../chat/worker/src/encryption.js';
import { canAccessFile } from '../chat/worker/src/data/uploaded-files.js';
import { storageObjectKey } from '../chat/worker/src/storage-path.js';
import { validateChatPolicy, CHAT_POLICY_DEFAULTS } from '../src/chat-policy.ts';
import { recallRoomMessage } from '../chat/worker/src/message-recall.js';
import { cleanupR2Keys, runScheduledGc } from '../chat/worker/src/gc.js';
import { handleChatAdmin } from '../src/chat-admin.ts';
import { keyedHash } from '../src/crypto.ts';
import chatApp from '../chat/worker/src/index.js';

function bucket() {
 const objects = new Map(), uploads = new Map();
 const object = (entry, range) => {
  const size = entry.parts.reduce((n,p)=>n+p.length,0);
  let offset=range?.offset||0, length=range?.length ?? size;
  const slices=[];
  for (const part of entry.parts) {
   if(offset>=part.length){offset-=part.length;continue;}
   const take=Math.min(length,part.length-offset);
   // Split across irregular stream boundaries, including within nonce/tag bytes.
   for(let n=offset;n<offset+take;n+=73001) slices.push(part.subarray(n,Math.min(n+73001,offset+take)));
   length-=take;offset=0;if(length<=0)break;
  }
  return {size,customMetadata:entry.customMetadata,uploaded:new Date(),
   writeHttpMetadata(headers){for(const [k,v]of Object.entries(entry.httpMetadata||{}))if(k==='contentType')headers.set('content-type',v);},
   body:new ReadableStream({pull(controller){if(slices.length)controller.enqueue(slices.shift());else controller.close();}}),
   arrayBuffer:vi.fn(async()=>{
    if(entry.customMetadata?.edgechatEncryption==='v2-chunked')throw new Error('Whole-file buffering is forbidden for chunked attachments');
    return new Blob(entry.parts).arrayBuffer();
   })};
 };
 const api={ objects,uploads,
  async createMultipartUpload(key,metadata){const uploadId=crypto.randomUUID();uploads.set(uploadId,{key,...metadata,parts:new Map()});return {...api.resumeMultipartUpload(key,uploadId),uploadId};},
  resumeMultipartUpload(key,id){return {
   async uploadPart(number,bytes){const u=uploads.get(id);if(!u||u.key!==key)throw new Error('No such upload');const etag=crypto.randomUUID();u.parts.set(number,{bytes,etag});return {partNumber:number,etag};},
   async complete(parts){const u=uploads.get(id);if(!u)throw new Error('No such upload');if(parts.some(p=>u.parts.get(p.partNumber)?.etag!==p.etag))throw new Error('Invalid etag');
    const entry={...u,parts:parts.map(p=>u.parts.get(p.partNumber).bytes)};objects.set(key,entry);uploads.delete(id);return object(entry);},
   async abort(){if(!uploads.delete(id))throw new Error('NoSuchUpload (10024)');}
  };},
  async head(key){const v=objects.get(key);return v?object(v):null;},
  get:vi.fn(async(key,options)=>{const v=objects.get(key);return v?object(v,options?.range):null;}),
  delete:vi.fn(async key=>{objects.delete(key);}),
  async put(key,bytes,metadata){objects.set(key,{...metadata,parts:[new Uint8Array(bytes)]});}
 };return api;
}
async function setup() {
 const db=await chatDatabase();const FILES=bucket();Object.assign(db.env,{FILES,SESSION_SECRET:'test-session-secret-must-be-at-least-32-characters',MAX_FILE_SIZE:200*1024*1024,ALLOWED_FILE_TYPES:CHAT_POLICY_DEFAULTS.ALLOWED_FILE_TYPES});
 const app=new Hono();let userId=db.users[0].id;
 app.use('/api/*',async(c,next)=>{c.set('session',{userId});await next();});registerUploadRoutes(app);
 app.onError((error,c)=>c.json({error:error.message},error instanceof ApiError?error.status:500));
 const request=async(path,options={})=>{
  const body=options.body instanceof FormData||options.body instanceof Blob?options.body:options.body?JSON.stringify(options.body):undefined;
  const response=await app.request('/api'+path,{...options,body},db.env);const payload=await response.json();
  if(!response.ok){const error=new Error(payload.error);error.status=response.status;throw error;}return payload;
 };
 return {...db,FILES,request,asOther(){userId=db.users[1].id;},asOwner(){userId=db.users[0].id;}};
}
function generatedFile(size,name='large.mp4',type='video/mp4') {
 return {size,name,type,slice(start,end){const bytes=new Uint8Array(end-start);for(let n=0;n<bytes.length;n++)bytes[n]=(start+n)%251;return new Blob([bytes]);}};
}
describe('encrypted R2 multipart attachments',()=>{
 it('uses the real session middleware and enforces a bounded part body even when the overall limit is large',async()=>{
  const db=await setup();try{
   const token=crypto.randomUUID()+crypto.randomUUID();
   db.sqlite.prepare("UPDATE identity_codes SET password_hash='test' WHERE id='a'").run();
   db.sqlite.prepare('INSERT INTO identity_web_sessions(token_hash,identity_code_id,code_hash,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)')
     .run(await keyedHash(db.env,'identity-web-session',token),'a','a','test',new Date(Date.now()+60000).toISOString(),new Date().toISOString());
   const headers={Cookie:`__Host-mrzh_identity=${token}`,Origin:'https://site.test'};
   expect((await chatApp.fetch(new Request('https://site.test/api/upload/config'),db.env)).status).toBe(401);
   const config=await chatApp.fetch(new Request('https://site.test/api/upload/config',{headers}),db.env);
   expect((await config.json()).maxFileSize).toBe(200*1048576);
   const response=await chatApp.fetch(new Request('https://site.test/api/uploads/anything/parts/1',{
     method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:new Uint8Array(8*1048576+1)
   }),db.env);
   expect(response.status).toBe(413);
  }finally{db.close();}
 });
 it.each(['lifeafter','/another-prefix/'])('uses STORAGE_PREFIX=%s for small and multipart uploads, reads and cleanup',async prefix=>{
  const db=await setup();try{
   db.env.STORAGE_PREFIX=prefix;
   const small=await saveUploadedFile(db.env,{userId:db.users[0].id},new File(['small image fixture'],'tiny.png',{type:'image/png'}));
   const large=await uploadChatFile(generatedFile(8*1048576+1),db.request);
   const physicalPrefix=prefix.replace(/^\/+|\/+$/g,'')+'/chat/';
   expect([...db.FILES.objects.keys()].every(k=>k.startsWith(physicalPrefix))).toBe(true);
   const image=await readAttachment(db.env,small.file.key);expect(await new Response(image.body).text()).toBe('small image fixture');
   const video=await readAttachment(db.env,large.file.key,'bytes=1-3');expect([...new Uint8Array(await new Response(video.body).arrayBuffer())]).toEqual([1,2,3]);
   await cleanupR2Keys(db.env,[small.file.key,large.file.key]);expect(db.FILES.objects.size).toBe(0);
   expect(db.FILES.delete.mock.calls.every(([key])=>key.startsWith(physicalPrefix))).toBe(true);
  }finally{db.close();}
 });
 it('accepts 100 MB and larger policy values, preserves the default, and rejects invalid sizes',()=>{
  for(const size of [100*1048576,500*1048576,50*1024**3])expect(validateChatPolicy({...CHAT_POLICY_DEFAULTS,MAX_FILE_SIZE:size}).MAX_FILE_SIZE).toBe(size);
  expect(CHAT_POLICY_DEFAULTS.MAX_FILE_SIZE).toBe(20*1048576);
  for(const size of [NaN,1023,50*1024**3+1])expect(()=>validateChatPolicy({...CHAT_POLICY_DEFAULTS,MAX_FILE_SIZE:size})).toThrow();
 });
 it('uploads a file above 100 MB with only 8 MB requests and serves authenticated plaintext ranges without whole-file buffering',async()=>{
  const db=await setup();try{
   const sizes=[],paths=[],progress=[];
   const request=async(path,options={})=>{paths.push(path);if(options.body instanceof Blob)sizes.push(options.body.size);return db.request(path,options);};
   const result=await uploadChatFile(generatedFile(101*1048576+37),request,{onProgress:(n,total)=>progress.push([n,total])});
   expect(Math.max(...sizes)).toBe(8*1048576);expect(sizes.length).toBe(13);expect(paths).not.toContain('/upload');
   expect(progress.at(-1)).toEqual([101*1048576+37,101*1048576+37]);
   const key=result.file.key,entry=db.FILES.objects.get(storageObjectKey(db.env,key));
   expect(entry.parts[0].length).toBe(8*1048576+28);expect(entry.parts[0].subarray(0,100)).not.toEqual(new Uint8Array(100));
   expect(await canAccessFile(db.env.DB,key,db.users[0].id)).toBe(true);
   expect(await canAccessFile(db.env.DB,key,db.users[1].id)).toBe(false);
   for(const header of ['bytes=8388590-8388640','bytes=-113','bytes=0-29']){
    const response=await readAttachment(db.env,key,header);expect(response.status).toBe(206);
    const range=parseAttachmentRange(header,result.file.size),bytes=new Uint8Array(await new Response(response.body).arrayBuffer());
    expect([...bytes]).toEqual(Array.from({length:range.end-range.start+1},(_,i)=>(range.start+i)%251));
    expect(response.headers.get('content-range')).toBe(`bytes ${range.start}-${range.end}/${result.file.size}`);
   }
   // The full read uses one R2 stream, not one subrequest per encryption frame.
   db.FILES.get.mockClear();const full=await readAttachment(db.env,key);const reader=full.body.getReader();let received=0;
   for(;;){const {done,value}=await reader.read();if(done)break;expect(value[0]).toBe(received%251);received+=value.length;}
   expect(received).toBe(result.file.size);expect(db.FILES.get).toHaveBeenCalledOnce();
   const invalid=await readAttachment(db.env,key,'bytes=999999999-');expect(invalid.status).toBe(416);
   const session=db.sqlite.prepare('SELECT id FROM chat_upload_sessions').get();expect((await db.request(`/uploads/${session.id}/complete`,{method:'POST'})).file).toEqual(result.file);
   const admin=await handleChatAdmin(new Request(`https://site.test/api/admin/chat/file?key=${encodeURIComponent(key)}`,{headers:{Range:'bytes=16-21'}}),db.env,{auth_method:'oidc'});
   expect(admin.status).toBe(206);expect([...new Uint8Array(await admin.arrayBuffer())]).toEqual([16,17,18,19,20,21]);
  }finally{db.close();}
 },30000);
 it('rejects foreign uploads, missing/wrong-size parts, forbidden MIME and policy reductions',async()=>{
  const db=await setup();try{
   const session=await db.request('/uploads',{method:'POST',body:{name:'a.mp4',type:'video/mp4',size:8*1048576+3}});
   db.asOther();await expect(db.request(`/uploads/${session.uploadId}/complete`,{method:'POST'})).rejects.toMatchObject({status:404});db.asOwner();
   await expect(db.request(`/uploads/${session.uploadId}/complete`,{method:'POST'})).rejects.toThrow('文件尚未上传完成');
   await expect(db.request(`/uploads/${session.uploadId}/parts/1`,{method:'PUT',body:new Blob(['bad'])})).rejects.toThrow('上传分块大小不匹配');
   await expect(db.request('/uploads',{method:'POST',body:{name:'x.svg',type:'image/svg+xml',size:99}})).rejects.toThrow('该文件类型不允许上传');
   db.env.MAX_FILE_SIZE=1024;
   await expect(db.request(`/uploads/${session.uploadId}/parts/2`,{method:'PUT',body:new Blob(['abc'])})).rejects.toMatchObject({status:413});
   await db.request(`/uploads/${session.uploadId}`,{method:'DELETE'});expect(db.FILES.uploads.size).toBe(0);
  }finally{db.close();}
 });
 it('authenticates the file key, frame index, total size and ciphertext',async()=>{
  const env={SESSION_SECRET:'x'.repeat(40)},manifest={size:5,chunk_size:8,key_id:loadEncryptionKeyring({SESSION_SECRET:'x'.repeat(40)}).activeKeyId};
  const frame=await encryptAttachmentChunk(env,new Uint8Array([1,2,3,4,5]),'one',manifest,1);
  expect([...await decryptAttachmentChunk(env,frame,'one',manifest,1)]).toEqual([1,2,3,4,5]);
  for(const [key,m,index]of [['two',manifest,1],['one',manifest,2],['one',{...manifest,size:6},1]])await expect(decryptAttachmentChunk(env,frame,key,m,index)).rejects.toThrow();
  frame[15]^=1;await expect(decryptAttachmentChunk(env,frame,'one',manifest,1)).rejects.toThrow();
 });
 it('retries a lost part response and aborts incomplete uploads on failure',async()=>{
  const db=await setup();try{
   let lost=false,lostCompletion=false;const request=async(path,options)=>{const result=await db.request(path,options);if(path.endsWith('/parts/1')&&!lost){lost=true;throw new TypeError('connection lost');}
    if(path.endsWith('/complete')&&!lostCompletion){lostCompletion=true;throw new TypeError('completion response lost');}return result;};
   await uploadChatFile(generatedFile(8*1048576+1),request);expect(lost).toBe(true);expect(lostCompletion).toBe(true);
   const fail=async(path,options)=>{if(path.includes('/parts/'))throw new TypeError('offline');return db.request(path,options);};
   await expect(uploadChatFile(generatedFile(8*1048576+1),fail)).rejects.toThrow('offline');expect(db.FILES.uploads.size).toBe(0);
  }finally{db.close();}
 });
 it('removes an unpublished completed R2 object if database finalization persistently fails',async()=>{
  const db=await setup();try{
   db.env.DB.batch=vi.fn(async()=>{throw new Error('D1 unavailable');});
   await expect(uploadChatFile(generatedFile(8*1048576+1),db.request)).rejects.toThrow('D1 unavailable');
   expect(db.FILES.objects.size).toBe(0);expect(db.FILES.uploads.size).toBe(0);
   expect(db.sqlite.prepare('SELECT count(*) n FROM chat_upload_sessions').get().n).toBe(0);
  }finally{db.close();}
 });
 it.each(['public','dm'])('retains a recalled %s attachment through orphan cleanup and deletes it only when the message expires',async kind=>{
  const db=await setup();try{
   const {file}=await uploadChatFile(generatedFile(8*1048576+1),db.request);const room=db.createRoom(kind);
   const id=Number(db.sqlite.prepare('INSERT INTO messages(channel_id,sender_id,attachment_key,content) VALUES(?,?,?,?)').run(room.id,db.users[0].id,file.key,'audit').lastInsertRowid);
   await recallRoomMessage(db.env,{userId:db.users[0].id},room,id);
   expect(db.sqlite.prepare('SELECT recalled_at,content FROM messages WHERE id=?').get(id)).toMatchObject({recalled_at:expect.any(String),content:'audit'});
   expect(await canAccessFile(db.env.DB,file.key,db.users[1].id)).toBe(false);
   expect(db.FILES.delete).not.toHaveBeenCalled();
   db.sqlite.prepare("UPDATE uploaded_files SET created_at=datetime('now','-2 days')").run();
   db.sqlite.prepare('INSERT INTO pending_r2_delete(object_key) VALUES(?)').run(file.key);
   await runScheduledGc(db.env);expect(db.FILES.objects.size).toBe(1);
   expect(db.sqlite.prepare('SELECT count(*) n FROM pending_r2_delete').get().n).toBe(0);
   const admin=await handleChatAdmin(new Request(`https://site.test/api/admin/chat/file?key=${encodeURIComponent(file.key)}`,{headers:{Range:'bytes=0-2'}}),db.env,{auth_method:'oidc'});
   expect(admin.status).toBe(206);expect([...new Uint8Array(await admin.arrayBuffer())]).toEqual([0,1,2]);
   db.sqlite.prepare("UPDATE messages SET created_at='2000-01-01' WHERE id=?").run(id);
   db.FILES.delete.mockRejectedValueOnce(new Error('R2 unavailable'));
   await runScheduledGc(db.env);
   expect(db.sqlite.prepare('SELECT object_key FROM pending_r2_delete').get().object_key).toBe(file.key);
   db.sqlite.prepare("UPDATE pending_r2_delete SET next_retry_at='2000-01-01'").run();await cleanupR2Keys(db.env,[file.key]);
   expect(db.FILES.objects.size).toBe(0);expect(db.sqlite.prepare('SELECT count(*) n FROM chat_file_chunks').get().n).toBe(0);
  }finally{db.close();}
 });
 it('deletes an admin-removed attachment but preserves files with another live message reference',async()=>{
  const db=await setup();try{
   const {file}=await uploadChatFile(generatedFile(8*1048576+1),db.request);const room=db.createRoom('private');
   const add=()=>Number(db.sqlite.prepare('INSERT INTO messages(channel_id,sender_id,attachment_key,content) VALUES(?,?,?,?)').run(room.id,db.users[0].id,file.key,'audit').lastInsertRowid);
   const first=add(),second=add();
   const remove=id=>handleChatAdmin(new Request(`https://site.test/api/admin/chat/rooms/${room.id}/messages/${id}`,{method:'DELETE'}),db.env,{auth_method:'oidc'});
   expect((await remove(first)).status).toBe(200);expect(db.FILES.objects.size).toBe(1);
   expect((await remove(second)).status).toBe(200);expect(db.FILES.objects.size).toBe(0);
   expect(await canAccessFile(db.env.DB,file.key,db.users[0].id)).toBe(false);
  }finally{db.close();}
 });
 it('aborts expired partial uploads and keeps successfully completed objects during session cleanup',async()=>{
  const db=await setup();try{
   const {file}=await uploadChatFile(generatedFile(8*1048576+1),db.request);
   await db.request('/uploads',{method:'POST',body:{name:'partial.mp4',type:'video/mp4',size:9000000}});
   db.FILES.uploads.clear(); // R2 may have expired the upload independently.
   db.sqlite.prepare('UPDATE chat_upload_sessions SET expires_at=1').run();await runScheduledGc(db.env);
   expect(db.FILES.uploads.size).toBe(0);expect(db.sqlite.prepare('SELECT count(*) n FROM chat_upload_sessions').get().n).toBe(0);
   expect(db.FILES.objects.has(storageObjectKey(db.env,file.key))).toBe(true);
  }finally{db.close();}
 });
});
