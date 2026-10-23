/*
 * Renders the two Service Portal widgets with AngularJS 1.5 + Bootstrap 3 (as
 * in Service Portal) using mocked data, drives the order dialog and saves
 * screenshots in tests/ui/out. The ServiceNow server side is mocked.
 *
 *   npm install && npm run test:ui
 */
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const { chromium } = require('playwright-core');
(async () => {
  require('./render');
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  await p.goto('file://' + path.join(OUT, 'index.html'));
  await p.waitForSelector('.cy-card');
  await p.screenshot({ path: path.join(OUT, 'shot-1-catalog.png') });
  // filter
  await p.fill('.cy-search', 'kube'); const n = await p.$$eval('.cy-card', e => e.length); assert.strictEqual(n, 1, 'search filters the cards');
  await p.fill('.cy-search', '');
  await p.click('.cy-card >> nth=0');
  await p.selectOption('#cy-project', 'p1');
  const envs = await p.$$eval('#cy-env option', o => o.map(x => x.textContent.trim())); assert.deepStrictEqual(envs, ['Select an environment', 'Staging', 'Production']);
  const disabledBefore = await p.$eval('button[type=submit]', b => b.disabled); assert.strictEqual(disabledBefore, true, 'submit disabled until an environment is selected');
  await p.selectOption('#cy-env', 'e1');
  await p.screenshot({ path: path.join(OUT, 'shot-2-dialog.png') });
  await p.click('button[type=submit]');
  await p.waitForSelector('.alert-success');
  assert.deepStrictEqual(await p.evaluate(() => window.__orders), [{ action: 'deploy', stack: '1', project: 'p1', environment: 'e1' }]);
  assert.ok(/components\/create\?canonical=stack-aws-vm$/.test(await p.evaluate(() => window.__opened.location.href)));
  await p.screenshot({ path: path.join(OUT, 'shot-3-done.png') });
  // error path
  await p.selectOption('#cy-env', 'e2'); await p.click('button[type=submit]'); await p.waitForSelector('.alert-danger');
  assert.strictEqual(await p.$eval('.alert-danger', e => e.textContent.trim()), 'The request could not be created.');
  assert.strictEqual(await p.evaluate(() => !!window.__closed), true, 'blank tab closed on error');
  // project change resets env
  await p.selectOption('#cy-project', 'p2'); assert.strictEqual(await p.$eval('#cy-env', e => e.value), 'e3', 'single environment preselected');
  await p.setViewportSize({ width: 390, height: 844 }); await p.click('.close'); await p.screenshot({ path: path.join(OUT, 'shot-4-mobile.png'), fullPage: false });
  assert.deepStrictEqual(errors, []);
  console.log('UI preview OK, screenshots in ' + path.relative(ROOT, OUT));
  await b.close();
})();
