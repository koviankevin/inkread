import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {browserType,browserName,compatibility} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';

const root=process.cwd(),output=path.join(root,'test-results','tab-selection');await mkdir(output,{recursive:true});
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const temporary=await mkdtemp(path.join(os.tmpdir(),'irtabselect-')),profile=path.join(temporary,'profile'),folder=path.join(temporary,'books');await mkdir(folder);
const books=[{name:'章節 #1+%.md',title:'本機甲',paragraph:6},{name:'第二份.md',title:'本機乙',paragraph:8}];
const body=Array.from({length:18},(_,i)=>`PARA-${String(i).padStart(3,'0')} ${'各分頁保留自己的選檔和閱讀段落，重新整理、複製分頁或離線重開都能自動接續閱讀。'.repeat(8)}`).join('\n\n');
for(const b of books)await writeFile(path.join(folder,b.name),'# '+b.title+'\n\n'+body);
const server=await serveSites({reader:process.env.INKREAD_TEST_DIST||path.join(root,'dist')}),url=process.env.INKREAD_TEST_SITE||server.origin+'/reader/';
const options={headless:true,viewport:{width:1440,height:900},...(!compatibility&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})};
const results=[],errors=[],evidence=[];let context;
const pass=label=>{results.push(label);console.log('PASS '+label);};
async function launch(offline=false){context=await browserType.launchPersistentContext(profile,options);context.setDefaultTimeout(45000);context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));if(offline)await context.setOffline(true);}
async function ready(p,title){await p.locator('#app:not([hidden])').waitFor();assert((await p.locator('.version').textContent()).includes('v'+version));await p.locator('#library-status[data-state=saved]').waitFor();assert.equal(await p.locator('#document h1').textContent(),title);}
async function open(address,title){const p=await context.newPage();await p.goto(address,{waitUntil:'domcontentloaded'});await ready(p,title);return p;}
async function select(p,b){await p.bringToFront();await p.locator('#user-files button').filter({hasText:b.name}).click();await ready(p,b.title);}
const documentPath=address=>decodeURIComponent(new URL(address).hash.slice(9).split('&position=')[0]);
const point=p=>p.evaluate(()=>{const e=[...document.querySelectorAll('#document p')].find(e=>/^PARA-/.test(e.textContent)&&e.getBoundingClientRect().top<=150&&e.getBoundingClientRect().bottom>150),r=e?.getBoundingClientRect();return {paragraph:e?.textContent.match(/^PARA-\d+/)?.[0],fraction:r?(150-r.top)/r.height:null};});
async function move(p,n){await p.bringToFront();await p.evaluate(()=>{window.__qaWheel=false;addEventListener('wheel',()=>window.__qaWheel=true,{once:true});});await p.mouse.move(1000,700);await p.mouse.wheel(0,1);await p.waitForFunction(()=>window.__qaWheel);await p.locator('#document p').filter({hasText:new RegExp('^PARA-'+String(n).padStart(3,'0')+' ')}).evaluate(e=>scrollTo({top:scrollY+e.getBoundingClientRect().top+e.getBoundingClientRect().height*.35-150,behavior:'instant'}));await p.waitForTimeout(650);await p.locator('#library-status[data-state=saved]').waitFor();return point(p);}
function same(actual,expected){assert.equal(actual.paragraph,expected.paragraph);assert(Math.abs(actual.fraction-expected.fraction)<.035);}
try{
 await launch();let a=await context.newPage();await a.goto(url,{waitUntil:'domcontentloaded'});await a.locator('#offline-status[data-state=ready]').waitFor({timeout:120000});await a.locator('#folder-input').setInputFiles(folder);await a.waitForFunction(()=>document.querySelectorAll('#user-files button').length===2);
 await select(a,books[0]);const pa=await move(a,6),ua=a.url();let b=await context.newPage();await b.goto(url,{waitUntil:'domcontentloaded'});await select(b,books[1]);const pb=await move(b,8),ub=b.url();
 assert.notEqual(ua,ub);assert.equal(documentPath(ua),'books/'+books[0].name);assert.equal(documentPath(ub),'books/'+books[1].name);pass('Tab URLs independently encode Unicode, spaces, #, + and % in local filenames');
 await context.setOffline(true);for(const [p,book,pos]of [[a,books[0],pa],[b,books[1],pb]]){await p.reload({waitUntil:'domcontentloaded'});await ready(p,book.title);assert.equal(await p.evaluate(()=>navigator.onLine),false);same(await point(p),pos);}pass('Offline reload automatically restores each tab file and paragraph');
 const duplicate=await open(ua,books[0].title);same(await point(duplicate),pa);await duplicate.close();pass('A duplicated tab URL opens its own file despite a different shared selection');
 await context.close();context=undefined;await launch(true);a=await open(ua,books[0].title);b=await open(ub,books[1].title);same(await point(a),pa);same(await point(b),pb);assert.equal(await a.evaluate(()=>navigator.onLine),false);evidence.push({urls:[ua,ub],positions:[await point(a),await point(b)]});pass('Full persistent browser restart restores both URLs offline without library clicks');
 await a.bringToFront();await a.locator('.skip-link').focus();await a.keyboard.press('Enter');await a.waitForFunction(()=>location.hash.startsWith('#inkread='));assert.equal(documentPath(a.url()),documentPath(ua));assert.equal(await a.locator('#document h1').textContent(),books[0].title);pass('Native skip-to-content navigation preserves the tab file identity');
 // Finish and close A after the skip link changed its position. Its queued
 // shared-selection checkpoint must not race this fixture's last selection B.
 await a.locator('#library-status[data-state=saved]').waitFor();await a.close();
 await select(b,books[1]);const malformed=await open(url+'#inkread=%E0%A4%A',books[1].title);assert.equal(documentPath(malformed.url()),documentPath(ub));pass('Malformed fragment safely falls back to a saved file and normalizes the URL');
 const missing=await open(url+'#inkread='+encodeURIComponent('不存在.md'),books[1].title);assert.equal(documentPath(missing.url()),documentPath(ub));pass('Missing document references safely fall back without creating or importing content');
 await missing.locator('#clear-files').click();await missing.waitForFunction(()=>document.querySelectorAll('#user-files button').length===0);await missing.locator('#library-status[data-state=saved]').waitFor();const guide=missing.url();await b.waitForFunction(()=>document.querySelectorAll('#user-files button').length===0);assert.equal(documentPath(b.url()),documentPath(ub),'The invalidation placeholder must preserve the real tab URL');await b.reload({waitUntil:'domcontentloaded'});await b.locator('#app:not([hidden])').waitFor();await b.locator('#library-status[data-state=saved]').waitFor();assert.equal(b.url(),guide);assert(decodeURIComponent(new URL(guide).hash.slice(9)).startsWith('範例/'));await missing.goto(ua,{waitUntil:'domcontentloaded'});await missing.locator('#app:not([hidden])').waitFor();await missing.locator('#library-status[data-state=saved]').waitFor();assert.equal(await missing.locator('#user-files button').count(),0);assert.equal(missing.url(),guide);await missing.reload({waitUntil:'domcontentloaded'});await missing.locator('#app:not([hidden])').waitFor();assert.equal(missing.url(),guide);pass('Invalidated tabs keep their real URLs until reload; stale URLs cannot resurrect cleared documents');
 assert.deepEqual(errors,[]);assert.equal(results.length,8);await writeFile(path.join(output,browserName+'-results.json'),JSON.stringify({browser:browserName,version,site:url,passed:8,results,evidence,errors,nativeOffline:true,fullBrowserRestart:true,method:'Actual tab URLs are reopened after a persistent browser restart; no app storage injection or post-restart file clicks.'},null,2));
}catch(e){await writeFile(path.join(output,browserName+'-failure.json'),JSON.stringify({error:e.stack,results,errors},null,2));throw e;}
finally{await context?.close();await server.close();assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
