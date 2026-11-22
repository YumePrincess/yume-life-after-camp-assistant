import { describe, it, expect, afterEach } from 'vitest';
import { computed } from 'vue';
import { setLocale, formatTime, formatDate, formatDateTime, parseDateValue } from '../chat/frontend/src/i18n.js';
import { setSiteTimezone, messageTimestampParts, initializeSiteTimezone, siteTimezone } from '../chat/frontend/src/site-timezone.js';
import { chatDatabase } from './helpers/chat-db.mjs';
import { keyedHash } from '../src/crypto.ts';
import chatApp from '../chat/worker/src/index.js';
import { handleChatAdmin } from '../src/chat-admin.ts';

afterEach(()=>setSiteTimezone('UTC+08:00'));
describe('configured interaction-center timezone',()=>{
 it('formats SQL UTC and ISO instants identically and follows configured offsets instead of the browser clock',async()=>{
  await setLocale('en-US',{persist:false});setSiteTimezone('UTC+08:00');
  const options={hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'};
  expect(formatTime('2026-10-21 23:38:06',options)).toBe('07:38:06');
  expect(formatTime('2026-10-21T23:38:06Z',options)).toBe('07:38:06');
  expect(formatDate('2026-10-21 23:38:06',{year:'numeric',month:'2-digit',day:'2-digit'})).toBe('10/22/2026');
  expect(formatDateTime('2026-10-21 23:38:06',{...options,timeZoneName:'shortOffset'})).toContain('UTC+8');
  setSiteTimezone('UTC-05:30');expect(formatTime('2026-10-21T23:38:06Z',options)).toBe('18:08:06');
 });
 it.each([
  ['UTC+08:00','2026/10/22','07:38:06 (UTC+8)'],
  ['UTC-05:00','2026/10/21','18:38:06 (UTC-5)'],
  ['UTC+05:30','2026/10/22','05:08:06 (UTC+05:30)'],
  ['UTC+00:00','2026/10/21','23:38:06 (UTC+0)'],
  ['UTC+14:00','2026/10/22','13:38:06 (UTC+14)']
 ])('renders a two-line timestamp using %s and the homepage UTC label rule', (zone,date,time)=>{
  setSiteTimezone(zone);expect(messageTimestampParts(parseDateValue('2026-10-21 23:38:06'))).toEqual({date,time});
 });
 it('reactively updates existing timestamps and inherits live timezone changes from the host page',()=>{
  let changed,disconnected=false;const root={dataset:{timezone:'UTC+08:00'}};
  const stop=initializeSiteTimezone({document:{documentElement:{dataset:{}}},parent:{document:{documentElement:root}},MutationObserver:class{constructor(callback){changed=callback;}observe(target,options){expect(target).toBe(root);expect(options.attributeFilter).toEqual(['data-timezone']);}disconnect(){disconnected=true;}}});
  const timestamp=computed(()=>messageTimestampParts(parseDateValue('2026-10-21T23:38:06Z')));
  expect(timestamp.value.date).toBe('2026/10/22');root.dataset.timezone='UTC-05:00';changed();
  expect(timestamp.value).toEqual({date:'2026/10/21',time:'18:38:06 (UTC-5)'});
  setSiteTimezone('invalid');expect(siteTimezone.value).toBe('UTC-05:00');stop();expect(disconnected).toBe(true);
 });
 it('supplies the same base-settings timezone through authenticated frontend and admin APIs, including after a setting change',async()=>{
  const db=await chatDatabase();try{
   db.env.SESSION_SECRET='timezone-session-secret-at-least-32-characters';
   db.sqlite.prepare("UPDATE identity_codes SET password_hash='test' WHERE id='a'").run();
   const token=crypto.randomUUID()+crypto.randomUUID();
   db.sqlite.prepare('INSERT INTO identity_web_sessions(token_hash,identity_code_id,code_hash,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .run(await keyedHash(db.env,'identity-web-session',token),'a','a','test',new Date(Date.now()+60000).toISOString(),new Date().toISOString());
   const room=db.createRoom('public');db.message(room,{createdAt:'2026-10-21 23:38:06',attachmentKey:'timezone-fixture.png'});
   for(const zone of ['UTC+08:00','UTC-05:30']){
    db.sqlite.prepare("UPDATE settings SET value=? WHERE key='camp_config'").run(JSON.stringify({timezone:zone}));
    for(const path of ['/auth/session','/bootstrap','/site']){
     const response=await chatApp.fetch(new Request('https://site.test/api'+path,{headers:{Cookie:`__Host-mrzh_identity=${token}`}}),db.env);
     expect(response.status).toBe(200);const payload=await response.json();expect(payload.timezone||payload.site.timezone).toBe(zone);
    }
    for(const path of ['',`/rooms/${room.id}/messages`,'/files','/policy']){
     const response=await handleChatAdmin(new Request('https://site.test/api/admin/chat'+path),db.env,{auth_method:'oidc'});
     expect(response.status).toBe(200);expect((await response.json()).timezone).toBe(zone);
    }
   }
  }finally{db.close();}
 });
});
