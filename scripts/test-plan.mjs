import {execFileSync} from 'node:child_process';
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const allSuites = ['verify', 'audit', 'lazy-features', 'offline-cache', 'library', 'backup', 'merge', 'font-progress', 'reading-controls', 'media-switch', 'multitab-progress', 'checkpoint-storage', 'tab-selection', 'same-document-progress', 'product-library', 'product-conflict', 'accessibility', 'drop-import', 'sidebar-resize', 'printing'];
export const compatibleSuites = ['backup', 'merge', 'font-progress', 'reading-controls', 'media-switch', 'multitab-progress', 'checkpoint-storage', 'tab-selection', 'same-document-progress', 'product-library', 'product-conflict', 'accessibility', 'sidebar-resize', 'printing'];
const reading = ['font-progress', 'reading-controls', 'media-switch', 'multitab-progress', 'tab-selection', 'same-document-progress'];
const storage = ['library', 'backup', 'merge', 'checkpoint-storage', 'multitab-progress', 'tab-selection', 'same-document-progress', 'product-library', 'product-conflict'];
const rules = {
  'src/printing.js': ['printing'],
  'src/sidebar-resize.js': ['sidebar-resize'],
  'src/sidebar-resize.css': ['sidebar-resize'],
  'src/drop-import.js': ['drop-import'],
  'src/accessibility.js': ['accessibility'],
  'src/accessibility.css': ['accessibility'],
  'src/app.js': allSuites,
  'src/library-store.js': storage,
  'src/library-management.js': ['backup','merge','tab-selection','same-document-progress','product-library','product-conflict'],
  'src/library-health.js': ['library','backup','product-library','product-conflict'],
  'src/library-ui.css': ['verify',...reading,'product-library','product-conflict'],
  'src/library-backup.js': ['backup', 'merge'],
  'src/library-restore.js': ['backup', 'merge', ...storage],
  'src/style.css': ['verify', ...reading,'product-library','product-conflict'],
  'src/index.html': ['verify', 'audit', ...reading,'product-library','product-conflict'],
  'src/renderer.js': ['verify', 'audit', 'lazy-features', 'media-switch', 'merge', 'same-document-progress'],
  'src/paths.js': ['verify', 'audit', ...storage],
  'src/document-links.js': ['verify', 'library', 'backup', 'merge','product-library'],
  'src/limits.js': ['verify', 'audit', ...storage],
  'src/offline.js': ['offline-cache', 'library', 'media-switch', ...reading],
  'src/service-worker.js': ['offline-cache', ...reading],
  'src/vendor-loader.js': ['lazy-features', 'offline-cache', 'media-switch', 'same-document-progress'],
  'src/math-engine.js': ['verify', 'audit', 'lazy-features', 'media-switch', 'same-document-progress'],
  'src/diagram-engine.js': ['verify', 'audit', 'lazy-features', 'media-switch', 'same-document-progress'],
  'src/elk-engine.js': ['lazy-features', 'media-switch', 'same-document-progress'],
  'src/lazy-elk.js': ['lazy-features', 'media-switch', 'same-document-progress'],
  'src/favicon.svg': ['verify'],
};

export function selectTests(paths, full = false) {
  const selected = new Set(full ? allSuites : []), reasons = [];
  let ci = full, audit = full;
  for (const path of paths) {
    let suites = [];
    if (/^(?:\.github\/|scripts\/(?:test-plan|run-selected)\.mjs$|tests\/(?:ci-contract|test-plan|library-management)\.mjs$)/.test(path)) ci = true;
    else if (rules[path]) suites = rules[path];
    else if (path.startsWith('samples/')) suites = ['verify', 'offline-cache'];
    else if (path === 'tests/startup.mjs') suites = ['startup'];
    else if (path.startsWith('tests/') && allSuites.includes(path.slice(6, -4)) && path.endsWith('.mjs')) suites = [path.slice(6, -4)];
    else if (/\.(?:md|txt)$/i.test(path) || /^(?:LICENSE|NOTICE|\.gitignore)$/.test(path)) { /* Documentation only. */ }
    else { suites = allSuites; ci = true; }
    if (['package.json', 'package-lock.json'].includes(path)) audit = true;
    if (['src/library-management.js','src/library-restore.js','src/document-links.js'].includes(path)) ci = true;
    suites.forEach(s => selected.add(s));
    reasons.push({path, suites: [...new Set(suites)]});
  }
  const chromium = [...allSuites, 'startup'].filter(s => selected.has(s));
  const compatible = compatibleSuites.filter(s => selected.has(s));
  return {ci, audit, chromium, compatible, browsers: chromium.length ? (compatible.length ? ['chromium', 'firefox', 'webkit'] : ['chromium']) : [], reasons};
}

// This reviewed release scope is valid only for the exact complete change set.
// Any extra path, changed blob or later base falls back to normal dependency rules.
export function reviewedImpact(paths,{base,sha,readGit}) {
  const candidates=[
    {path:'tests/accessibility-impact.json',suite:'accessibility',sources:['src/app.js','src/index.html','src/accessibility.js','src/accessibility.css','tests/accessibility.mjs']},
    {path:'tests/drop-import-impact.json',suite:'drop-import',sources:['src/app.js','src/drop-import.js','tests/drop-import.mjs']},
    {path:'tests/sidebar-resize-impact.json',suite:'sidebar-resize',sources:['src/app.js','src/index.html','src/sidebar-resize.js','src/sidebar-resize.css','tests/sidebar-resize.mjs']},
    {path:'tests/printing-impact.json',suite:'printing',sources:['src/app.js','src/index.html','src/printing.js','tests/printing.mjs']},
  ].filter(scope=>paths.includes(scope.path));
  if(candidates.length!==1)return null;
  const scope=candidates[0],profilePath=scope.path;
  try {
    const profile=JSON.parse(readGit('show',`${sha}:${profilePath}`));
    if(profile.version!==1 || profile.base!==base || !Array.isArray(profile.files) || profile.suite!==scope.suite)return null;
    const expected=paths.filter(p=>p!==profilePath),files=new Map(profile.files.map(f=>[f.path,f]));
    if(files.size!==profile.files.length || files.size!==expected.length || !scope.sources.every(p=>files.has(p)))return null;
    const blob=(commit,path)=>{try{return readGit('rev-parse',`${commit}:${path}`);}catch{return null;}};
    for(const path of expected){
      const f=files.get(path);if(!f || !/^[a-f0-9]{40}$/.test(f.after) || f.before!==null && !/^[a-f0-9]{40}$/.test(f.before) || blob(base,path)!==f.before || blob(sha,path)!==f.after)return null;
    }
    return {suite:scope.suite,reason:`Reviewed ${scope.suite} scope; every changed Git blob and the baseline are bound to ${profilePath}`};
  }catch{return null;}
}

// Reuse only a successful PR run for precisely this source and pre-merge base.
export function canReuse({pr, run, repository, sha, tree, beforeTree, headTree, baseTree}) {
  return Boolean(pr.merged_at && pr.merge_commit_sha === sha && pr.base.ref === 'main' &&
    pr.base.repo.full_name === repository && pr.head.repo?.full_name === repository &&
    headTree === tree && baseTree === beforeTree &&
    run.repository.full_name === repository && run.head_repository?.full_name === repository &&
    run.event === 'pull_request' && run.head_sha === pr.head.sha &&
    run.path === '.github/workflows/pages.yml' && run.status === 'completed' && run.conclusion === 'success');
}

const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();
export async function createPlan(env = process.env, request = fetch, readGit = git) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const full = event.inputs?.full === true || event.inputs?.full === 'true';
  const sha = readGit('rev-parse', 'HEAD'), tree = readGit('rev-parse', 'HEAD^{tree}');
  const base = event.pull_request?.base.sha || event.before || readGit('rev-parse', 'HEAD^');
  const validBase = /^[0-9a-f]{40}$/.test(base) && !/^0+$/.test(base);
  const paths = validBase ? readGit('diff', '--name-only', '-z', '--no-renames', base, sha).split('\0').filter(Boolean) : ['unknown-change'];
  const plan = {...selectTests(paths, full), sha, tree, base, reuse: false};
  const reviewed=!full && validBase && reviewedImpact(paths,{base,sha,readGit});
  if(reviewed){
    Object.assign(plan,selectTests([`tests/${reviewed.suite}.mjs`]),{ci:true,audit:false,reviewedScope:reviewed.reason,reasons:paths.map(path=>({path,suites:[reviewed.suite],reason:reviewed.reason}))});
  }
  const api = async path => {
    const response = await request(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
      headers: {Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response.json();
  };
  if (!full && validBase && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main') {
    try {
      const beforeTree = readGit('rev-parse', `${base}^{tree}`);
      const prs = await api(`commits/${sha}/pulls?per_page=100`);
      for (const pr of prs) {
        if (!pr.merged_at || pr.merge_commit_sha !== sha || pr.head.repo?.full_name !== env.GITHUB_REPOSITORY) continue;
        const headTree = readGit('rev-parse', `${pr.head.sha}^{tree}`), baseTree = readGit('rev-parse', `${pr.base.sha}^{tree}`);
        const data = await api(`actions/workflows/pages.yml/runs?event=pull_request&head_sha=${pr.head.sha}&status=success&per_page=100`);
        const run = data.workflow_runs.find(run => canReuse({pr, run, repository: env.GITHUB_REPOSITORY, sha, tree, beforeTree, headTree, baseTree}));
        if (run) { plan.reuse = true; plan.reusedRun = run.html_url; break; }
      }
    } catch (error) { plan.reuseReason = `Fresh affected tests: ${error.message}`; }
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = await createPlan();
  writeFileSync('test-plan.json', JSON.stringify(plan, null, 2));
  const values = {reuse: plan.reuse, ci: plan.ci && !plan.reuse, audit: plan.audit && !plan.reuse, browser: !plan.reuse && plan.browsers.length > 0, browsers: JSON.stringify(plan.browsers), chromium: JSON.stringify(plan.chromium), compatible: JSON.stringify(plan.compatible)};
  for (const [key, value] of Object.entries(values)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Affected tests\n\nSource tree: \`${plan.tree}\`\n\n${plan.reuse ? `Reusing successful PR validation: ${plan.reusedRun}` : `Chromium: ${plan.chromium.join(', ') || 'none'}\n\nFirefox / WebKit: ${plan.compatible.join(', ') || 'none'}`}\n\nCI contracts: ${values.ci}; dependency audit: ${values.audit}\n\n${plan.reuseReason || ''}\n\n\`\`\`json\n${JSON.stringify(plan.reasons, null, 2)}\n\`\`\`\n`);
  console.log(JSON.stringify({...values, tree: plan.tree, reusedRun: plan.reusedRun}));
}
