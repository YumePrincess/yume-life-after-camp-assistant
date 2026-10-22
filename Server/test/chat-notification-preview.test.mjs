import {describe,it,expect} from 'vitest';
import {notificationContent} from '../chat/shared/notification-content.js';
import {notificationTranslator} from '../chat/shared/notification-locales.js';
import {pushNotification} from '../chat/worker/src/push.js';
import {setLocale,t} from '../chat/frontend/src/i18n.js';
import {useInAppNotifications} from '../chat/frontend/src/composables/useInAppNotifications.ts';

describe('one bounded message overview for every notification surface',()=>{
 it.each(['zh-CN','zh-TW','en-US','fr-FR','ja-JP'])('uses matching translations and overviews in %s',async locale=>{
  await setLocale(locale,{persist:false});
  for (const kind of ['public','private','dm']) for(const attachment of [null,{kind:'voice'},{type:'image/jpeg'},{type:'video/mp4'},{type:'application/pdf',name:'document.pdf'}]){
   const event={room:{kind,id:3,name:kind==='dm'?'Alice':kind==='public'?'general':'Raid team'},sender:{displayName:'Alice'},contentPreview:attachment?'':'**A short overview** [link](https://example.com)',attachment};
   const front=notificationContent(event,t),back=pushNotification(event,locale);
   expect(back).toMatchObject({title:front.title,body:front.body});
   const inApp=useInAppNotifications({setTimer:()=>0,clearTimer:()=>{}});inApp.showInAppNotification(event);
   expect(inApp.inAppNotifications.value[0]).toMatchObject({senderName:'Alice',roomName:front.roomName,preview:front.preview});
   expect(front.body).not.toContain('**');expect(front.body).not.toContain('https://example.com');
  }
 });
 it('caps previews at 160 Unicode code points and collapses line breaks without carrying the full message',()=>{
  const source='😀'.repeat(500)+' PRIVATE END';
  const content=notificationContent({room:{kind:'private',id:3,name:'Raid'},sender:{displayName:'Alice'},contentPreview:source},notificationTranslator('en'));
  expect(Array.from(content.preview)).toHaveLength(160);expect(content.preview.endsWith('…')).toBe(true);
  expect(content.body).toBe('Alice: '+content.preview);expect(content.body).not.toContain('PRIVATE END');
  expect(notificationContent({room:{kind:'dm',id:4,name:'Alice'},contentPreview:'One\n\nTwo'},notificationTranslator('en')).preview).toBe('One Two');
 });
});
