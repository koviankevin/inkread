import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {parse} from 'yaml';
import './test-plan.mjs';
import './library-management.mjs';

const root = new URL('../', import.meta.url);
const pages = parse(await readFile(new URL('.github/workflows/pages.yml', root), 'utf8'));
const compatibility = parse(await readFile(new URL('.github/workflows/compatibility.yml', root), 'utf8'));
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
const statuses = ['success', 'failure', 'cancelled', 'skipped'];
const action = (job, name) => job.steps.find(s => s.uses?.startsWith(`${name}@`));
function deployAllowed(p, status, event, ref, cancelled) {
  return runInNewContext(p.jobs.deploy.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    github: {event_name: event, ref}, needs: {validated: {result: status}}, cancelled: () => cancelled,
  }, {timeout: 100});
}
function validationAllowed(p, plan, build, browser, required) {
  const script = p.jobs.validated.steps[0].run.trim().split('\n').slice(1, -1).join('\n');
  try {
    runInNewContext(script, {process: {env: {PLAN_RESULT: plan, BUILD_RESULT: build, BROWSER_RESULT: browser, BROWSER_REQUIRED: required}}}, {timeout: 100});
    return true;
  } catch { return false; }
}
function contract(p, c) {
  assert.deepEqual(Object.keys(p.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(p.on.push.branches, ['main']);
  assert.equal(p.on.workflow_dispatch.inputs.full.default, false);
  assert.deepEqual(Object.keys(c.on), ['workflow_call']);
  assert.deepEqual(Object.keys(p.jobs).sort(), ['build', 'compatibility', 'deploy', 'plan', 'validated']);
  assert.deepEqual(p.permissions, {contents: 'read'});
  assert.deepEqual(c.permissions, {contents: 'read'});
  assert.deepEqual(p.jobs.plan.permissions, {contents: 'read', actions: 'read', 'pull-requests': 'read'});
  assert.deepEqual(p.jobs.deploy.permissions, {contents: 'read', pages: 'write', 'id-token': 'write'});
  assert.equal(p.jobs.plan.steps[0].with['fetch-depth'], 0);
  assert.equal(p.jobs.plan.steps.at(-1).run, 'node scripts/test-plan.mjs');
  assert.equal(p.jobs.plan.steps.at(-1).env.GITHUB_TOKEN, '${{ github.token }}');
  for (const key of ['reuse', 'ci', 'audit', 'browser', 'browsers', 'chromium', 'compatible']) {
    assert.equal(p.jobs.plan.outputs[key], '${{ steps.plan.outputs.' + key + ' }}');
  }
  assert.equal(p.jobs.build.needs, 'plan');
  assert.deepEqual(p.jobs.compatibility.needs, ['plan', 'build']);
  assert.equal(p.jobs.compatibility.if, "needs.plan.outputs.browser == 'true'");
  assert.equal(p.jobs.compatibility.uses, './.github/workflows/compatibility.yml');
  for (const key of ['browsers', 'chromium', 'compatible']) {
    assert.equal(p.jobs.compatibility.with[key], '${{ needs.plan.outputs.' + key + ' }}');
    assert.deepEqual(c.on.workflow_call.inputs[key], {type: 'string', required: true});
  }
  assert.deepEqual(p.jobs.validated.needs, ['plan', 'build', 'compatibility']);
  assert.equal(p.jobs.validated.if, '${{ always() }}');
  assert.deepEqual(p.jobs.validated.steps[0].env, {
    PLAN_RESULT: '${{ needs.plan.result }}', BUILD_RESULT: '${{ needs.build.result }}',
    BROWSER_REQUIRED: '${{ needs.plan.outputs.browser }}', BROWSER_RESULT: '${{ needs.compatibility.result }}',
  });
  assert.deepEqual(p.jobs.deploy.needs, ['validated']);
  assert.deepEqual(c.jobs.library.strategy, {'fail-fast': false, matrix: {browser: '${{ fromJSON(inputs.browsers) }}'}});
  assert.deepEqual(c.jobs.library.container, {
    image: `mcr.microsoft.com/playwright:v${lock.packages['node_modules/playwright-core'].version}-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea`,
    options: '--init --shm-size=1gb --user 1001',
  });
  assert.equal(c.jobs.library.env.INKREAD_BROWSER, '${{ matrix.browser }}');
  assert.equal(c.jobs.library.env.INKREAD_TEST_SUITES, "${{ matrix.browser == 'chromium' && inputs.chromium || inputs.compatible }}");
  assert.deepEqual(c.jobs.library.steps.filter(s => s.run).map(s => s.run), ['npm ci', 'npm run build', 'node scripts/run-selected.mjs']);
  for (const job of [p.jobs.plan, p.jobs.build, c.jobs.library]) {
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.equal(job.if, undefined);
    assert.equal(action(job, 'actions/checkout').with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
  }
  for (const job of [p.jobs.build, c.jobs.library]) assert.equal(job['timeout-minutes'], 35);
  for (const job of [...Object.values(p.jobs), ...Object.values(c.jobs)]) {
    assert.equal(job['continue-on-error'], undefined);
    for (const step of job.steps ?? []) assert.equal(step['continue-on-error'], undefined);
  }
  const ci = p.jobs.build.steps.find(s => s.run === 'npm run test:ci');
  assert.equal(ci.if, "needs.plan.outputs.ci == 'true'");
  assert.equal(p.jobs.build.steps.find(s => s.run === 'npm audit --audit-level=low').if, "needs.plan.outputs.audit == 'true'");
  assert.equal(p.jobs.build.steps.some(s => s.run === 'npm test'), false);
  const upload = action(p.jobs.build, 'actions/upload-pages-artifact');
  assert.deepEqual(upload.with, {path: 'dist'});
  assert.equal(upload.if, undefined);
  assert.equal(p.jobs.build.steps.at(-1), upload);
  assert.deepEqual(p.jobs.deploy.steps.map(s => s.uses), ['actions/configure-pages@v5', 'actions/deploy-pages@v4']);
  assert.equal(p.jobs.deploy.steps.at(-1).with, undefined);
  for (const plan of statuses) for (const build of statuses) for (const browser of statuses) {
    for (const required of ['true', 'false', '', 'unknown']) {
      assert.equal(validationAllowed(p, plan, build, browser, required), plan === 'success' && build === 'success' && (required === 'true' && browser === 'success' || required === 'false' && browser === 'skipped'));
    }
  }
  for (const status of statuses) for (const event of ['push', 'workflow_dispatch', 'pull_request', 'workflow_run']) {
    for (const ref of ['refs/heads/main', 'refs/heads/topic', 'refs/pull/3/merge']) for (const cancelled of [false, true]) {
      assert.equal(deployAllowed(p, status, event, ref, cancelled), !cancelled && status === 'success' && ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(event));
    }
  }
}
test('affected checks and current-run artifact gate (352 failure/skip/cancellation scenarios)', () => contract(pages, compatibility));
const mutations = {
  'missing prerequisite': p => { p.jobs.validated.needs = ['build']; },
  'skipped tests accepted': p => { p.jobs.validated.steps[0].run = "node <<'JS'\ntrue\nJS"; },
  'PR deployment': p => { p.jobs.deploy.if = "${{ !cancelled() && needs.validated.result == 'success' }}"; },
  'cancelled deployment': p => { p.jobs.deploy.if = p.jobs.deploy.if.replace('!cancelled() &&', ''); },
  'wrong source': p => { p.jobs.build.steps[0].with.ref = 'main'; },
  'ignored failure': (_, c) => { c.jobs.library['continue-on-error'] = true; },
  'unconditional full suite': p => { p.jobs.build.steps.push({run: 'npm test'}); },
  'foreign Pages artifact': p => { p.jobs.deploy.steps.at(-1).with = {artifact_name: 'old-pages'}; },
  'unbound browser plan': p => { p.jobs.compatibility.with.browsers = '["chromium"]'; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, () => {
  const p = structuredClone(pages), c = structuredClone(compatibility);
  mutate(p, c);
  assert.throws(() => contract(p, c), assert.AssertionError);
});
