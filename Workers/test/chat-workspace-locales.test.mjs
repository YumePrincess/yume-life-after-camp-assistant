import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import english from '../chat/frontend/src/locales/en-US.js';
import {setLocale,t,localizeServerError} from '../chat/frontend/src/i18n.js';
const categories=/^(messages|voice|composer|members|group|chat|conversation|conversationList|notifications|contacts|profile|common|presence|titles|quickActions|roomHeader|mobile|nav)\./;
describe('complete active chat workspace translations',()=>{
 it.each(['ja-JP','fr-FR'])('defines every workspace key directly in %s rather than silently inheriting English',async locale=>{
  const source=readFileSync(new URL(`../chat/frontend/src/locales/${locale}.js`,import.meta.url),'utf8');
  const explicit=new Set([...source.matchAll(/["']([\w.]+)["']\s*:/g)].map(match=>match[1]));
  expect(Object.keys(english).filter(key=>categories.test(key)&&!explicit.has(key))).toEqual([]);
  await setLocale(locale,{persist:false});
  for(const key of Object.keys(english).filter(key=>categories.test(key))){
   expect(t(key)).not.toBe(key);
   expect([...t(key).matchAll(/\{(\w+)\}/g)].map(x=>x[1]).sort()).toEqual([...english[key].matchAll(/\{(\w+)\}/g)].map(x=>x[1]).sort());
  }
  expect(t('messages.recalled')).not.toBe(english['messages.recalled']);
  expect(localizeServerError('群组不存在')).not.toBe('群组不存在');
  expect(localizeServerError('文件大小不能超过 20MB')).toContain('20');
  expect(localizeServerError('文件大小不能超过 20MB')).not.toContain('文件');
 });
});
