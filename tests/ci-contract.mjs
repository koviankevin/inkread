import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {parse} from 'yaml';

const root = new URL('../', import.meta.url);
const pages = parse(await readFile(new URL('.github/workflows/pages.yml', root), 'utf8'));
const compatibility = parse(await readFile(new URL('.github/workflows/compatibility.yml', root), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const action = (job, name) => job.steps.find(step => step.uses?.startsWith(`${name}@`));
const commands = job => job.steps.filter(step => step.run).map(step => step.run);
const results = ['success', 'failure', 'cancelled', 'skipped'];

// Evaluate the condition read from YAML, rather than a second copy of the gate.
function allowsDeploy(workflow, build, compat, event = 'push', ref = 'refs/heads/main', cancelled = false) {
  const expression = workflow.jobs.deploy.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return runInNewContext(expression, {
    github: {event_name: event, ref},
    needs: {build: {result: build}, compatibility: {result: compat}},
    cancelled: () => cancelled,
    success: () => !cancelled && build === 'success' && compat === 'success',
  }, {timeout: 100});
}

function contract(p, c) {
  assert.deepEqual(Object.keys(p.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(p.on.push.branches, ['main']);
  assert.deepEqual(Object.keys(c.on), ['workflow_call']);
  assert.deepEqual(Object.keys(p.jobs).sort(), ['build', 'compatibility', 'deploy']);
  assert.deepEqual(Object.keys(c.jobs), ['library']);
  assert.equal(p.jobs.compatibility.uses, './.github/workflows/compatibility.yml');
  assert.equal(p.jobs.compatibility.if, undefined);
  assert.equal(c.concurrency, undefined); // Caller owns cancellation; no self-cancellation.
  assert.deepEqual(p.concurrency, {group: 'pages-${{ github.ref }}', 'cancel-in-progress': true});
  assert.deepEqual(p.permissions, {contents: 'read'});
  assert.deepEqual(c.permissions, {contents: 'read'});
  assert.deepEqual(p.jobs.deploy.permissions, {contents: 'read', pages: 'write', 'id-token': 'write'});
  assert.deepEqual(p.jobs.deploy.needs, ['build', 'compatibility']);
  assert.deepEqual(c.jobs.library.strategy, {'fail-fast': false, matrix: {browser: ['firefox', 'webkit']}});
  assert.equal(p.jobs.build['timeout-minutes'], 35);
  assert.equal(c.jobs.library['timeout-minutes'], 35);
  assert.equal(c.jobs.library.env.INKREAD_BROWSER, '${{ matrix.browser }}');
  for (const job of [p.jobs.build, p.jobs.compatibility, c.jobs.library]) {
    assert.equal(job.if, undefined);
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.permissions, undefined);
    for (const step of job.steps ?? []) {
      assert.equal(step['continue-on-error'], undefined);
      if (step.run) assert.equal(step.if, undefined);
    }
  }
  for (const job of [p.jobs.build, c.jobs.library]) {
    assert.deepEqual(action(job, 'actions/checkout').with, {ref: '${{ github.sha }}'});
    assert.equal(job.steps[0].uses, 'actions/checkout@v4');
    const report = action(job, 'actions/upload-artifact');
    assert.equal(report.if, 'always()');
    assert.equal(report.with.path, 'test-results/');
    assert.equal(report.with['retention-days'], 7);
  }
  assert.deepEqual(commands(p.jobs.build), [
    'npm ci', 'npm run test:ci', 'npm audit --audit-level=low',
    'npx playwright-core install --with-deps chromium', 'npm run build', 'npm test',
    'cd dist && zip -r inkread-offline.zip .',
  ]);
  assert.deepEqual(commands(c.jobs.library), [
    'npm ci', 'npx playwright-core install --with-deps ${{ matrix.browser }}',
    'npm run build', 'npm run test:compat',
  ]);
  const upload = action(p.jobs.build, 'actions/upload-pages-artifact');
  assert.deepEqual(upload.with, {path: 'dist'});
  assert.equal(upload.if, undefined); // Success-only upload after tests and ZIP.
  assert.equal(p.jobs.build.steps.at(-1), upload);
  assert.deepEqual(p.jobs.deploy.steps.map(s => s.uses), ['actions/configure-pages@v5', 'actions/deploy-pages@v4']);
  assert.equal(action(p.jobs.deploy, 'actions/deploy-pages').with, undefined); // Current run, default artifact.
  for (const build of results) for (const compat of results) {
    for (const event of ['push', 'workflow_dispatch', 'pull_request', 'workflow_run']) {
      for (const ref of ['refs/heads/main', 'refs/heads/topic', 'refs/pull/3/merge']) {
        const expected = build === 'success' && compat === 'success' && ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(event);
        assert.equal(allowsDeploy(p, build, compat, event, ref), expected, `${build}/${compat}/${event}/${ref}`);
        assert.equal(allowsDeploy(p, build, compat, event, ref, true), false);
      }
    }
  }
}

test('release graph, source, artifacts and fail-closed deployment condition (384 scenarios)', () => {
  contract(pages, compatibility);
  assert.equal(pkg.scripts['test:ci'], 'node --test tests/ci-contract.mjs');
  assert.equal(pkg.scripts['test:compat'], 'node tests/backup.mjs && node tests/merge.mjs && node tests/font-progress.mjs && node tests/reading-controls.mjs && node tests/media-switch.mjs && node tests/multitab-progress.mjs && node tests/checkpoint-storage.mjs && node tests/tab-selection.mjs && node tests/same-document-progress.mjs');
  assert.equal(pkg.scripts.test.split(' && ').length, 14);
});

const mutations = {
  'missing compatibility prerequisite': (p) => { p.jobs.deploy.needs = ['build']; },
  'failure allowed by gate': (p) => { p.jobs.deploy.if = "${{ !cancelled() && github.ref == 'refs/heads/main' && github.event_name != 'pull_request' }}"; },
  'PR deployment allowed': (p) => { p.jobs.deploy.if = "${{ !cancelled() && needs.build.result == 'success' && needs.compatibility.result == 'success' }}"; },
  'cancelled run allowed': (p) => { p.jobs.deploy.if = p.jobs.deploy.if.replace('!cancelled() &&', ''); },
  'stale reusable workflow': (p) => { p.jobs.compatibility.uses += '@main'; },
  'stale source checkout': (p) => { p.jobs.build.steps[0].with.ref = 'main'; },
  'independent main trigger': (_, c) => { c.on.push = {branches: ['main']}; },
  'skipped compatibility job': (_, c) => { c.jobs.library.if = 'false'; },
  'ignored compatibility failure': (_, c) => { c.jobs.library['continue-on-error'] = true; },
  'ignored test failure': (_, c) => { c.jobs.library.steps.find(s => s.run === 'npm run test:compat')['continue-on-error'] = true; },
  'missing WebKit': (_, c) => { c.jobs.library.strategy.matrix.browser = ['firefox']; },
  'artifact from another run': (p) => { p.jobs.deploy.steps.at(-1).with = {artifact_name: 'old-pages'}; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, () => {
    const p = structuredClone(pages), c = structuredClone(compatibility);
    mutate(p, c);
    assert.throws(() => contract(p, c), assert.AssertionError);
  });
}
