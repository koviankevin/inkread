import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {browserType,browserName,compatibility} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';
import {decodeBackup} from '../src/library-backup.js';

const root=process.cwd(),out=path.join(root,'test-results','product-v180',browserName);
await mkdir(out,{recursive:true});const temporary=await mkdtemp(path.join(out,'pending-import-'));
const server=await serveSites({app:path.join(root,'dist')});
const context=await browserType.launchPersistentContext(path.join(temporary,'profile'),{headless:true,serviceWorkers:'block',...(!compatibility&&process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
context.setDefaultTimeout(30000);const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
const open=async p=>{await p.goto(server.origin+'/app/');await p.locator('#app:not([hidden])').waitFor();await p.locator('#library-status[data-state=saved]').waitFor();};
const file=(name,text)=>({name,mimeType:'text/markdown',buffer:Buffer.from(text)});
try{
 const owner=await context.newPage();await open(owner);await owner.locator('#file-input').setInputFiles(file('B.md','# Saved original'));await owner.locator('#library-status[data-state=saved]').waitFor();
 const pending=await context.newPage();await open(pending);
 await pending.evaluate(()=>{const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(stores,mode,...options){if(mode==='readwrite')throw new DOMException('Simulated quota failure','QuotaExceededError');return original.call(this,stores,mode,...options);};});
 await pending.locator('#file-input').setInputFiles(file('unsaved.md','# UNIQUE_UNSAVED_CONTENT'));
 await pending.locator('#library-status[data-state=error]').waitFor();
 await owner.locator('#manage-library').click();await owner.locator('#manage-name').fill('C.md');await owner.locator('#manage-rename').click();await owner.locator('#manage-dialog').waitFor({state:'hidden'});
 await pending.waitForFunction(()=>document.getElementById('library-retry').disabled===true);
 assert.equal(await pending.locator('#document h1').textContent(),'UNIQUE_UNSAVED_CONTENT');
 assert.equal(await pending.locator('#user-files button').count(),2);
 assert.match(await pending.locator('#library-error-detail').textContent(),/尚未保存的內容仍留在這個分頁/);
 const downloadEvent=pending.waitForEvent('download');await pending.locator('#backup-library').click();const download=await downloadEvent;
 const archive=path.join(temporary,'unsaved-recovery.inkread');await download.saveAs(archive);
 const decoded=await decodeBackup(new Blob([await readFile(archive)]));
 assert.equal(decoded.documents.find(d=>d.path==='unsaved.md').source,'# UNIQUE_UNSAVED_CONTENT');
 await pending.close();await owner.reload();await owner.locator('#library-status[data-state=saved]').waitFor();
 assert.deepEqual(await owner.locator('#user-files .file-name').allTextContents(),['C.md']);
 assert.equal(await owner.locator('#document h1').textContent(),'Saved original');assert.deepEqual(errors,[]);
 const result={browser:browserName,unsavedContentKept:true,recoveryBackupVerified:true,staleFileNotResurrected:true,errors};
 await writeFile(path.join(out,'pending-import-results.json'),JSON.stringify(result,null,2));console.log('PASS Concurrent file edit preserves unsaved content for export without replaying a stale library');
}finally{await context.close();await server.close();}
