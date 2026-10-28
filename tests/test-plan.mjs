import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {selectTests, allSuites, compatibleSuites, canReuse, createPlan, reviewedImpact} from '../scripts/test-plan.mjs';
import {runSelected} from '../scripts/run-selected.mjs';

test('documentation, license and Unicode handoff select no browsers', () => {
  const p = selectTests(['README.md', 'TESTING.md', 'AGENTS.md', '交接文件.md', 'LICENSE']);
  assert.deepEqual(p.browsers, []); assert.equal(p.ci, false); assert.equal(p.audit, false);
});

test('reviewed accessibility scope requires every exact changed blob and baseline',()=>{
  const base='a'.repeat(40),sha='b'.repeat(40),before='c'.repeat(40),after='d'.repeat(40);
  const paths=['src/app.js','src/index.html','src/accessibility.js','src/accessibility.css','tests/accessibility.mjs','tests/accessibility-impact.json'];
  const profile={version:1,base,suite:'accessibility',files:paths.slice(0,-1).map(path=>({path,before:path.includes('/accessibility.')?null:before,after}))};
  const readGit=(cmd,ref)=>{
    if(cmd==='show')return JSON.stringify(profile);
    const [commit,...parts]=ref.split(':'),file=profile.files.find(f=>f.path===parts.join(':'));
    if(!file || commit===base && !file.before)throw Error('Missing blob');
    return commit===base?file.before:file.after;
  };
  assert(reviewedImpact(paths,{base,sha,readGit}));
  assert.equal(reviewedImpact([...paths,'src/library-store.js'],{base,sha,readGit}),null);
  assert.equal(reviewedImpact(paths,{base:'e'.repeat(40),sha,readGit}),null);
  assert.equal(reviewedImpact(paths,{base,sha,readGit:(cmd,ref)=>cmd==='rev-parse' && ref===`${sha}:src/app.js`?'e'.repeat(40):readGit(cmd,ref)}),null);
  profile.files.push(profile.files[0]);assert.equal(reviewedImpact(paths,{base,sha,readGit}),null);
});

test('reviewed drag-import scope selects Chromium only and rejects unrelated changes',()=>{
  const base='a'.repeat(40),sha='b'.repeat(40),before='c'.repeat(40),after='d'.repeat(40);
  const paths=['src/app.js','src/drop-import.js','tests/drop-import.mjs','tests/drop-import-impact.json'];
  const profile={version:1,base,suite:'drop-import',files:paths.slice(0,-1).map(path=>({path,before:path==='src/app.js'?before:null,after}))};
  const readGit=(cmd,ref)=>{
    if(cmd==='show')return JSON.stringify(profile);
    const [commit,...parts]=ref.split(':'),file=profile.files.find(f=>f.path===parts.join(':'));
    if(!file || commit===base&&!file.before)throw Error('Missing blob');return commit===base?file.before:file.after;
  };
  assert.equal(reviewedImpact(paths,{base,sha,readGit}).suite,'drop-import');
  assert.equal(reviewedImpact([...paths,'src/library-store.js'],{base,sha,readGit}),null);
  assert.equal(reviewedImpact([...paths,'tests/accessibility-impact.json'],{base,sha,readGit}),null);
  assert.deepEqual(selectTests(['src/drop-import.js']).browsers,['chromium']);
});
test('reviewed sidebar scope is bound to every blob and selects all three engines',()=>{
  const base='a'.repeat(40),sha='b'.repeat(40),before='c'.repeat(40),after='d'.repeat(40);
  const paths=['src/app.js','src/index.html','src/sidebar-resize.js','src/sidebar-resize.css','tests/sidebar-resize.mjs','tests/sidebar-resize-impact.json'];
  const profile={version:1,base,suite:'sidebar-resize',files:paths.slice(0,-1).map(path=>({path,before:path.startsWith('src/sidebar-')?null:before,after}))};
  const readGit=(cmd,ref)=>{
    if(cmd==='show')return JSON.stringify(profile);
    const [commit,...parts]=ref.split(':'),file=profile.files.find(f=>f.path===parts.join(':'));
    if(!file || commit===base&&!file.before)throw Error('Missing blob');return commit===base?file.before:file.after;
  };
  assert.equal(reviewedImpact(paths,{base,sha,readGit}).suite,'sidebar-resize');
  assert.equal(reviewedImpact([...paths,'src/library-store.js'],{base,sha,readGit}),null);
  assert.equal(reviewedImpact([...paths,'tests/drop-import-impact.json'],{base,sha,readGit}),null);
  assert.equal(reviewedImpact(paths,{base:'f'.repeat(40),sha,readGit}),null);
  assert.equal(reviewedImpact(paths,{base,sha,readGit:(cmd,ref)=>cmd==='rev-parse'&&ref===`${sha}:src/app.js`?'f'.repeat(40):readGit(cmd,ref)}),null);
  assert.deepEqual(selectTests(['src/sidebar-resize.js','src/sidebar-resize.css']).chromium,['sidebar-resize']);
  assert.deepEqual(selectTests(['tests/sidebar-resize.mjs']).browsers,['chromium','firefox','webkit']);
});
test('CI changes run contracts without functional suites or audit', () => {
  const p = selectTests(['.github/workflows/pages.yml', 'scripts/test-plan.mjs', 'scripts/run-selected.mjs', 'tests/test-plan.mjs', 'tests/ci-contract.mjs']);
  assert.deepEqual(p.browsers, []); assert.equal(p.ci, true); assert.equal(p.audit, false);
});
test('one test selects only itself and its supported engines', () => {
  assert.deepEqual(selectTests(['tests/backup.mjs']).chromium, ['backup']);
  assert.deepEqual(selectTests(['tests/backup.mjs']).compatible, ['backup']);
  assert.deepEqual(selectTests(['tests/lazy-features.mjs']).browsers, ['chromium']);
  assert.deepEqual(selectTests(['samples/開始閱讀.md']).chromium, ['verify', 'offline-cache']);
});
test('backup and storage changes select dependent persistence behavior', () => {
  assert.deepEqual(selectTests(['src/library-backup.js']).chromium, ['backup', 'merge']);
  const p = selectTests(['src/library-store.js']);
  for (const s of ['checkpoint-storage', 'multitab-progress', 'same-document-progress', 'backup']) assert(p.chromium.includes(s));
  assert(!p.chromium.includes('lazy-features')); assert(!p.chromium.includes('offline-cache'));
});
test('document management and health changes select their integration coverage',()=>{
  const management=selectTests(['src/library-management.js']);
  assert.equal(management.ci,true);assert(management.compatible.includes('product-library'));
  assert(management.chromium.includes('backup'));assert(!management.chromium.includes('lazy-features'));
  assert.deepEqual(selectTests(['tests/library-management.mjs']).browsers,[]);
  assert.equal(selectTests(['tests/library-management.mjs']).ci,true);
  assert(selectTests(['src/library-health.js']).compatible.includes('product-library'));
});
test('layout, media and offline changes include paragraph restoration', () => {
  for (const path of ['src/style.css', 'src/renderer.js', 'src/math-engine.js', 'src/diagram-engine.js', 'src/service-worker.js']) {
    assert(selectTests([path]).compatible.includes('same-document-progress'), path);
  }
  assert(selectTests(['src/service-worker.js']).chromium.includes('offline-cache'));
});
test('duplicates coalesce, package and unknown source changes widen deliberately', () => {
  assert.deepEqual(selectTests(['src/library-backup.js', 'tests/backup.mjs']).chromium, ['backup', 'merge']);
  for (const path of ['package-lock.json', 'scripts/build.mjs', 'tests/site-server.mjs', 'src/new-module.js', 'src/app.js']) {
    assert.deepEqual(selectTests([path]).chromium, allSuites, path);
  }
  assert.equal(selectTests(['package-lock.json']).audit, true);
  assert.deepEqual(selectTests([], true).compatible, compatibleSuites);
});

const repository = 'owner/inkread', sha = 'a'.repeat(40), base = 'b'.repeat(40), head = 'c'.repeat(40);
const fixture = () => ({
  repository, sha, tree: 'new-tree', beforeTree: 'old-tree', headTree: 'new-tree', baseTree: 'old-tree',
  pr: {merged_at: '2026-10-24', merge_commit_sha: sha, base: {ref: 'main', sha: base, repo: {full_name: repository}}, head: {sha: head, repo: {full_name: repository}}},
  run: {repository: {full_name: repository}, head_repository: {full_name: repository}, event: 'pull_request', head_sha: head, path: '.github/workflows/pages.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/inkread/actions/runs/7'},
});
test('squash commit with identical complete tree and base reuses PR validation', () => assert.equal(canReuse(fixture()), true));
const rejected = {
  'same version but different source': f => { f.headTree = 'different-tree'; },
  'different merge base': f => { f.baseTree = 'different-base'; },
  'unmerged PR': f => { f.pr.merged_at = null; },
  'different merge commit': f => { f.pr.merge_commit_sha = head; },
  'different branch': f => { f.pr.base.ref = 'release'; },
  'different head revision': f => { f.run.head_sha = base; },
  'fork PR': f => { f.pr.head.repo.full_name = 'fork/inkread'; },
  'deleted fork': f => { f.pr.head.repo = null; },
  'different run repository': f => { f.run.repository.full_name = 'fork/inkread'; },
  'different run head repository': f => { f.run.head_repository.full_name = 'fork/inkread'; },
  'different workflow': f => { f.run.path = '.github/workflows/other.yml'; },
  'push run': f => { f.run.event = 'push'; },
  'running tests': f => { f.run.status = 'in_progress'; },
  'failed tests': f => { f.run.conclusion = 'failure'; },
  'cancelled tests': f => { f.run.conclusion = 'cancelled'; },
  'skipped tests': f => { f.run.conclusion = 'skipped'; },
};
for (const [name, mutate] of Object.entries(rejected)) test(`reuse rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.equal(canReuse(f), false);
});

test('planner API flow: main reuses, PR never reuses, API failure and full mode run affected tests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkread-plan-'));
  try {
    const file = join(dir, 'event.json'), f = fixture();
    const env = {GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_TOKEN: 'test-token'};
    const readGit = (...args) => args[0] === 'diff' ? 'src/library-backup.js\0交接文件.md\0' : ({HEAD: sha, 'HEAD^{tree}': f.tree, [`${base}^{tree}`]: f.baseTree, [`${head}^{tree}`]: f.headTree}[args[1]]);
    let calls = 0;
    const request = async url => {
      calls++; assert(url.startsWith('https://api.github.com/repos/owner/inkread/'));
      return {ok: true, json: async () => url.includes('/pulls') ? [f.pr] : {workflow_runs: [f.run]}};
    };
    await writeFile(file, JSON.stringify({before: base}));
    let p = await createPlan(env, request, readGit);
    assert.equal(p.reuse, true); assert.equal(calls, 2); assert.equal(p.reusedRun, f.run.html_url);
    assert.deepEqual(p.chromium, ['backup', 'merge']); assert.equal(p.reasons[1].path, '交接文件.md');
    p = await createPlan(env, async () => { throw Error('API unavailable'); }, readGit);
    assert.equal(p.reuse, false); assert.deepEqual(p.chromium, ['backup', 'merge']);
    await writeFile(file, JSON.stringify({pull_request: {base: {sha: base}}}));
    p = await createPlan({...env, GITHUB_EVENT_NAME: 'pull_request'}, () => assert.fail('PR must not query reuse'), readGit);
    assert.equal(p.reuse, false);
    await writeFile(file, JSON.stringify({before: base, inputs: {full: true}}));
    p = await createPlan(env, () => assert.fail('Full mode must not reuse'), readGit);
    assert.equal(p.reuse, false); assert.deepEqual(p.chromium, allSuites);
    await writeFile(file, JSON.stringify({before: '0'.repeat(40)}));
    p = await createPlan(env, () => assert.fail('Missing base must not reuse'), readGit);
    assert.equal(p.reuse, false); assert.deepEqual(p.chromium, allSuites);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('selected runner rejects injected paths and unsupported browser suites', () => {
  for (const [browser, suites] of [['unknown', ['backup']], ['webkit', ['verify']], ['chromium', ['../../malicious']], ['chromium', []], ['chromium', ['backup', 'backup']]]) {
    const result = spawnSync(process.execPath, ['scripts/run-selected.mjs'], {env: {...process.env, INKREAD_BROWSER: browser, INKREAD_TEST_SUITES: JSON.stringify(suites)}, encoding: 'utf8'});
    assert.notEqual(result.status, 0);
  }
});

test('selected runner preserves engine and executes selected suites, stopping on failure', () => {
  const env = {...process.env, INKREAD_BROWSER: 'firefox', INKREAD_TEST_SUITES: '["backup","merge"]'};
  const calls = [];
  runSelected(env, (node, args, options) => { calls.push(args[0]); assert.equal(node, process.execPath); assert.equal(options.env.INKREAD_BROWSER, 'firefox'); return {status: 0}; });
  assert.deepEqual(calls, ['tests/backup.mjs', 'tests/merge.mjs']);
  calls.length = 0;
  assert.throws(() => runSelected(env, (_, args) => { calls.push(args[0]); return {status: 7}; }), /Suite failed: backup/);
  assert.deepEqual(calls, ['tests/backup.mjs']);
});
