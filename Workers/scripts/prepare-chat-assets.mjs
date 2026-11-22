import {copyFile,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=resolve(root,'node_modules/vditor');
const target=resolve(root,'chat/frontend/public/vendor/vditor');
await rm(target,{recursive:true,force:true});
for(const file of ['dist/css/content-theme/light.css','dist/js/icons/ant.js','dist/js/i18n/en_US.js','dist/js/i18n/zh_CN.js','dist/js/i18n/zh_TW.js','dist/js/i18n/ja_JP.js','dist/js/i18n/fr_FR.js','dist/js/lute/lute.min.js','LICENSE']){
 const path=resolve(target,file);await mkdir(dirname(path),{recursive:true});await copyFile(resolve(source,file),path);
}
