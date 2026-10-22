import { describe, it, expect, vi } from 'vitest';
import { attachmentLabel } from '../chat/frontend/src/components/chat/attachment-utils.js';
import { formatMediaTime, mediaSeekTime } from '../chat/frontend/src/media-playback.js';
import { uploadWithProgress } from '../chat/frontend/src/upload-transport.js';
import { uploadChatFile } from '../chat/frontend/src/file-upload.js';
import { setLocale, t } from '../chat/frontend/src/i18n.js';
import { notificationContent } from '../chat/shared/notification-content.js';

describe('media labels and playback controls', () => {
 it.each(['zh-CN','zh-TW','en-US','ja-JP','fr-FR'])('replaces machine-generated filenames in visible labels and notification previews in %s', async locale => {
  await setLocale(locale,{persist:false});
  for(const [type,key]of [['image/jpeg','attachments.typeImage'],['video/mp4','attachments.typeVideo'],['audio/mpeg','attachments.typeAudio'],['application/pdf','attachments.typeFile']]) {
   const attachment={type,name:'machine-generated-uuid-'.repeat(80)+'.pdf'};
   expect(attachmentLabel(attachment,t)).toBe(t(key));
   expect(attachmentLabel(attachment,t)).not.toContain('machine-generated');
   const result=notificationContent({room:{kind:'dm',name:'Alice'},attachment},t);
   expect(result.preview).not.toContain(attachment.name);
  }
  for(const key of ['media.preview','media.play','media.pause','media.seek','media.mute','media.unmute','media.fullscreen','media.unavailable'])expect(t(key)).not.toBe(key);
 });
 it('formats the video timeline and clamps seeking for metadata not yet loaded or invalid values', () => {
  expect(formatMediaTime(NaN)).toBe('0:00');expect(formatMediaTime(3723)).toBe('1:02:03');
  expect(formatMediaTime(61.9)).toBe('1:01');expect(formatMediaTime(Infinity)).toBe('0:00');
  expect(mediaSeekTime(500,40)).toBe(20);expect(mediaSeekTime(-5,40)).toBe(0);expect(mediaSeekTime(2000,40)).toBe(40);
  expect(mediaSeekTime(500,Infinity)).toBe(0);expect(mediaSeekTime(500,NaN)).toBe(0);
 });
});
class FakeXhr {
 static last;
 constructor(){FakeXhr.last=this;this.upload={};this.headers={};this.status=200;this.statusText='OK';this.responseText='{"file":{"key":"test"}}';}
 open(method,url){this.method=method;this.url=url;}
 setRequestHeader(key,value){this.headers[key]=value;}
 getAllResponseHeaders(){return 'Content-Type: application/json\r\n';}
 send(body){this.body=body;}
 abort(){this.onabort();}
}
describe('attachment byte upload progress', () => {
 it('reports real upload bytes, preserves request headers and returns normal HTTP responses for shared auth handling', async () => {
  const onUploadProgress=vi.fn(),body=new Blob(['test']);
  const pending=uploadWithProgress('https://camp.test/chat/api/upload',{method:'POST',headers:{Authorization:'Bearer test'},body,onUploadProgress},FakeXhr);
  const xhr=FakeXhr.last;xhr.upload.onprogress({lengthComputable:true,loaded:2,total:4});xhr.onload();
  const response=await pending;expect(onUploadProgress).toHaveBeenCalledWith(2,4);expect(xhr.body).toBe(body);expect(xhr.headers.Authorization).toBe('Bearer test');
  expect(response.headers.get('content-type')).toBe('application/json');expect(await response.json()).toEqual({file:{key:'test'}});
 });
 it('cancels an in-flight browser upload and rejects network errors', async () => {
  const controller=new AbortController();const pending=uploadWithProgress('/upload',{body:new Blob(['x']),signal:controller.signal,onUploadProgress:()=>{}},FakeXhr);
  controller.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});
  const failed=uploadWithProgress('/upload',{onUploadProgress:()=>{}},FakeXhr);FakeXhr.last.onerror();await expect(failed).rejects.toThrow('Upload connection failed');
 });
 it('reports partial progress for small files and for individual parts, rather than only on completion', async () => {
  const progress=vi.fn();
  const request=async(path,options={})=>{
   if(path==='/upload/config')return {maxFileSize:100,multipartThreshold:4};
   if(path==='/uploads')return {uploadId:'one',chunkSize:4};
   options.onUploadProgress?.(1,2);
   return {file:{key:'test'}};
  };
  await uploadChatFile(new File(['abc'],'small.txt'),request,{onProgress:progress});
  expect(progress).toHaveBeenCalledWith(1.5,3);
  progress.mockClear();await uploadChatFile(new File(['abcdefgh'],'large.txt'),request,{onProgress:progress});
  expect(progress).toHaveBeenCalledWith(2,8);expect(progress).toHaveBeenCalledWith(6,8);expect(progress).toHaveBeenLastCalledWith(8,8);
 });
});
