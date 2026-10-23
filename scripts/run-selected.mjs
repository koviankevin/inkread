import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {allSuites, compatibleSuites} from './test-plan.mjs';

export function runSelected(env = process.env, run = spawnSync) {
const browser = env.INKREAD_BROWSER;
if (!['chromium', 'firefox', 'webkit'].includes(browser)) throw new Error('Unknown browser');
const suites = JSON.parse(env.INKREAD_TEST_SUITES);
if (!Array.isArray(suites) || !suites.length || new Set(suites).size !== suites.length) throw new Error('Invalid suites');
const allowed = browser === 'chromium' ? [...allSuites, 'startup'] : compatibleSuites;
for (const suite of suites) {
  if (!allowed.includes(suite)) throw new Error(`Unsupported suite: ${suite}`);
  console.log(`Running ${browser}: ${suite}`);
  const result = run(process.execPath, [`tests/${suite}.mjs`], {stdio: 'inherit', env});
  if (result.error || result.status !== 0) throw new Error(`Suite failed: ${suite} (${result.status ?? result.error})`);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSelected();
