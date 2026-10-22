import {describe,it,expect,vi,afterEach} from 'vitest';
import {effectScope,nextTick,ref} from 'vue';
import {useMessageRecall} from '../chat/frontend/src/composables/useMessageRecall.js';

afterEach(()=>vi.useRealTimers());
function setup(age=0,sender=1) {
 const scope=effectScope(), message=ref({sender:{kind:'local',id:sender},createdAt:new Date(Date.now()-age).toISOString()}),userId=ref(1);
 const allowed=scope.run(()=>useMessageRecall(message,userId));
 return {scope,message,userId,allowed};
}
describe('recall permission while a context menu remains open',()=>{
 it('removes the action immediately after 120 seconds even without a message update',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T08:00:00Z'));
  const ui=setup(119000);expect(ui.allowed.value).toBe(true);
  vi.advanceTimersByTime(1000);expect(ui.allowed.value).toBe(true);
  vi.advanceTimersByTime(1);expect(ui.allowed.value).toBe(false);
  ui.scope.stop();expect(vi.getTimerCount()).toBe(0);
 });
 it('never exposes recall for another sender or an already expired message',async()=>{
  vi.useFakeTimers();const ui=setup(0,2);expect(ui.allowed.value).toBe(false);
  ui.message.value={sender:{kind:'local',id:1},createdAt:new Date(Date.now()-120001).toISOString()};
  await nextTick();expect(ui.allowed.value).toBe(false);expect(vi.getTimerCount()).toBe(0);ui.scope.stop();
 });
 it('cancels the deadline timer when closing and recomputes when reopening another message',async()=>{
  vi.useFakeTimers();const ui=setup();expect(ui.allowed.value).toBe(true);
  ui.message.value=null;await nextTick();expect(ui.allowed.value).toBe(false);expect(vi.getTimerCount()).toBe(0);
  ui.message.value={sender:{kind:'local',id:1},createdAt:new Date(Date.now()-120001).toISOString()};
  await nextTick();expect(ui.allowed.value).toBe(false);ui.scope.stop();
 });
});
