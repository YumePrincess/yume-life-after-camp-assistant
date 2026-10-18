import { describe, expect, it, vi } from 'vitest';
import { setLocale, t } from '../chat/frontend/src/i18n.js';
import { notificationRoomName } from '../chat/frontend/src/notification-room.ts';
import { useInAppNotifications } from '../chat/frontend/src/composables/useInAppNotifications.ts';
import { useBrowserNotifications } from '../chat/frontend/src/composables/useBrowserNotifications.js';

describe('localized general group notifications', () => {
  it.each(['zh-cn','zh-tw','en','fr','ja'])('localizes legacy realtime events in %s for in-app and system notifications', async language => {
    await setLocale(language,{persist:false});
    const event = {room:{id:1,kind:'public',name:'general'},sender:{displayName:'Alice'},contentPreview:'hello'};
    const inApp = useInAppNotifications({setTimer:()=>0,clearTimer:()=>{}});
    inApp.showInAppNotification(event);
    expect(inApp.inAppNotifications.value[0].roomName).toBe(t('chat.generalGroup'));
    const native = {checkPermission:vi.fn(async()=>'granted'),showNotification:vi.fn(async()=>{})};
    const system = useBrowserNotifications({browserWindow:null,notificationApi:null,nativeNotifications:native,
      storage:{getItem:()=>JSON.stringify({enabled:true,mutedRooms:[]}),setItem:vi.fn()}});
    for(const attention of [{},{mentionsMe:true},{replyToMe:true}]) {
      system.notifyRoom({...event,...attention});
      expect(native.showNotification.mock.lastCall[0].title).toContain(t('chat.generalGroup'));
      expect(native.showNotification.mock.lastCall[0].title).not.toContain('general');
    }
  });
  it('keeps real group and DM names, including a player named general',()=>{
    const translate=key=>({ 'chat.generalGroup':'全体成员群','camp.center':'互动中心'})[key];
    expect(notificationRoomName({id:1,kind:'private',name:'Raid'},translate)).toBe('Raid');
    expect(notificationRoomName({id:2,kind:'dm',name:'general'},translate)).toBe('general');
    expect(notificationRoomName({id:3,kind:'public',name:'',isGeneral:true},translate)).toBe('全体成员群');
  });
});
