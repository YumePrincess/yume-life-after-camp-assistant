import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('vditor',()=>({default:class {}}));
import {loadVditorRuntime} from '../chat/frontend/src/vditor-runtime.ts';
afterEach(()=>vi.unstubAllGlobals());
describe('rich editor uses the selected workspace language',()=>{
 it.each([['zh-CN','zh_CN'],['zh-TW','zh_TW'],['en-US','en_US'],['ja-JP','ja_JP'],['fr-FR','fr_FR']])('loads the bundled %s toolbar',async(locale,file)=>{
  const browser={};const scripts=[];
  vi.stubGlobal('window',browser);
  vi.stubGlobal('document',{
   getElementById:()=>null,
   createElement:()=>{const events={};return {addEventListener:(name,callback)=>events[name]=callback,events};},
   head:{appendChild:(script)=>{
    scripts.push({src:script.src});
    if(script.src.includes('/i18n/')) runInNewContext(readFileSync(new URL(`../node_modules/vditor/dist/js/i18n/${file}.js`,import.meta.url),'utf8'),{window:browser});
    script.events.load();
   }}
  });
  const runtime=await loadVditorRuntime(locale);
  expect(scripts.some(script=>script.src.endsWith(`/i18n/${file}.js`))).toBe(true);
  expect(runtime.i18n).toEqual(browser.VditorI18n);
  expect(Object.keys(runtime.i18n).length).toBeGreaterThan(20);
 });
});
