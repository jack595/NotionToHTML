/** Local-only validation against the actual delivered file, with networking off. */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, readdir, access} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium, firefox} from 'playwright';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const htmlFile = resolve(process.argv[2] || join(project, 'PSD_in_DSNB_Study.html'));
const output = join(project, 'validation');
await mkdir(output, {recursive: true});
const document = await readFile(htmlFile, 'utf8');
const data = JSON.parse(document.match(/<script type="application\/json" id="study-data">([\s\S]*?)<\/script>/)[1]);
const nodes = {...data.databases, ...data.pages};
const chromiumCandidates = [process.env.CHROMIUM_PATH, chromium.executablePath()];
try {
  for (const revision of await readdir(join(project, '.browsers'))) {
    if (revision.startsWith('chromium-')) for (const binary of ['chrome-linux/chrome', 'chrome-linux64/chrome']) chromiumCandidates.push(join(project, '.browsers', revision, binary));
  }
} catch {}
try {for (const version of await readdir(join(homedir(), '.cache/selenium/chrome/linux64'))) chromiumCandidates.push(join(homedir(), '.cache/selenium/chrome/linux64', version, 'chrome'));} catch {}
let chromiumPath;
for (const candidate of chromiumCandidates.filter(Boolean)) {try {await access(candidate); chromiumPath = candidate; break;} catch {}}
if (!chromiumPath) throw new Error('Install Chromium with Playwright or provide CHROMIUM_PATH.');
const firefoxPath = process.env.FIREFOX_PATH || join(project, '.browsers/firefox-1495/firefox/firefox');
const results = [];
for (const [name, engine, executablePath] of [['chromium', chromium, chromiumPath], ['firefox', firefox, firefoxPath]]) {
  const browser = await engine.launch({executablePath, headless: true, ...(name === 'chromium' ? {args: ['--no-sandbox']} : {})});
  const context = await browser.newContext({viewport: {width: 1440, height: 1080}, offline: true});
  const page = await context.newPage(), errors = [], requests = [];
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {if (/^https?:/.test(request.url())) requests.push(request.url());});
  await context.route(/^https?:/, route => route.abort());
  const url = pathToFileURL(htmlFile).href;
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px KaTeX_Main')), true);
  console.log(JSON.stringify({browser: name, stage: 'opened', errors}));
  await page.screenshot({path: join(output, `${name}-initial.png`), fullPage: true});
  async function go(id) {
    await page.evaluate(id => {location.hash = id;}, id);
    await page.locator(`main [data-node-id="${id}"]`).waitFor();
    assert.equal(await page.locator('main h1').first().textContent(), nodes[id].title);
  }
  async function rowIds(container) {return container.locator('tbody tr[data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId));}
  const dbContainer = id => page.locator(`main section[data-db-id="${id}"]`).first();
  let checkedTables = 0, checkedImages = 0, checkedMath = 0;
  for (const [id] of Object.entries(nodes)) {
    await go(id);
    const tables = page.locator('main section[data-db-id]');
    for (let index = 0; index < await tables.count(); index++) {
      const container = tables.nth(index), dbId = await container.getAttribute('data-db-id');
      const view = data.views[data.databases[dbId].views[0]];
      assert.deepEqual(await rowIds(container), view.row_ids, `${name}: record order in ${nodes[id].title}`);
      assert.deepEqual(await container.locator('thead th button span:first-of-type').allTextContents(), view.displayProperties, `${name}: columns in ${nodes[id].title}`);
      checkedTables++;
    }
    const images = await page.locator('main img').evaluateAll(async images => {
      return Promise.all(images.map(async image => {image.loading = 'eager'; await image.decode(); return {width: image.naturalWidth, height: image.naturalHeight, embedded: image.src.startsWith('data:')};}));
    });
    assert.ok(images.every(image => image.embedded && image.width > 0 && image.height > 0));
    checkedImages += images.length;
    checkedMath += await page.locator('main math').count();
    assert.equal(await page.locator('main input[type=checkbox]:not([data-toggle-column]):not([disabled])').count(), 0);
    if (Object.keys(nodes).indexOf(id) % 10 === 0) console.log(JSON.stringify({browser: name, checked: Object.keys(nodes).indexOf(id) + 1}));
  }
  const inputDb = Object.values(data.databases).find(db => db.title === 'Necessary Input').id;
  const linkedDb = Object.values(data.databases).find(db => db.title === 'View of Necessary Input').id;
  const vertexDb = Object.values(data.databases).find(db => db.title === 'Vertex Dependence').id;
  const impactId = Object.values(data.pages).find(page => page.title === 'Impact from Detector Response').id;
  await go(data.root_id);
  let container = dbContainer(inputDb);
  await container.locator('[data-table-action=filter]').click();
  await container.locator('[data-table-action=add-filter]').click();
  await container.locator('[data-filter-value="0"]').selectOption('In progress');
  assert.equal((await rowIds(container)).length, 2);
  await container.locator('[data-table-action=add-filter]').click();
  await container.locator('[data-filter-property="1"]').selectOption('tag');
  await container.locator('[data-filter-value="1"]').selectOption('Reconstruction');
  assert.deepEqual(await rowIds(container), [impactId]);
  await container.locator('[data-table-action=clear-filters]').click();
  await container.locator('[data-table-query]').fill('Energy Dependence');
  assert.equal((await rowIds(container)).length, 1);
  assert.match(await container.locator('.row-title').textContent(), /Energy Dependence/);
  await container.locator('[data-table-action=reset]').click();
  const original = data.views[data.databases[inputDb].views[0]].row_ids;
  await container.locator('[data-sort-column="Task Name"]').click();
  const ascending = await rowIds(container);
  assert.notDeepEqual(ascending, original);
  await container.locator('[data-sort-column="Task Name"]').click();
  assert.deepEqual(await rowIds(container), [...ascending].reverse());
  await container.locator('[data-sort-column="Task Name"]').click();
  assert.deepEqual(await rowIds(container), original);
  await container.locator('.properties-menu summary').click();
  await container.locator('[data-toggle-column="tag"]').uncheck();
  assert.equal(await container.locator('thead th').count(), 2);
  await go(linkedDb);
  assert.equal(await dbContainer(linkedDb).locator('thead th').count(), 3);
  assert.deepEqual(await rowIds(dbContainer(linkedDb)), data.views[data.databases[linkedDb].views[0]].row_ids);
  await go(data.root_id);
  container = dbContainer(inputDb);
  await container.locator('[data-table-action=reset]').click();
  await container.locator('[data-preview="' + impactId + '"]').click();
  assert.equal(await page.locator('#preview').isVisible(), true);
  assert.equal(await page.locator('#preview .database').count(), 3);
  await page.locator('#preview .full-page-link').click();
  await page.locator('main [data-node-id="' + impactId + '"]').waitFor();
  await page.goBack();
  await page.locator('main [data-node-id="' + data.root_id + '"]').waitFor();
  await page.goForward();
  await page.locator('main [data-node-id="' + impactId + '"]').waitFor();
  const vertex = dbContainer(vertexDb);
  await vertex.locator('[data-table-action=filter]').click();
  await vertex.locator('[data-table-action=add-filter]').click();
  await vertex.locator('[data-filter-property="0"]').selectOption('Checkbox');
  await vertex.locator('[data-filter-value="0"]').selectOption('true');
  assert.equal((await rowIds(vertex)).length, 0);
  await vertex.locator('[data-filter-value="0"]').selectOption('false');
  assert.equal((await rowIds(vertex)).length, 3);
  await vertex.locator('[data-table-action=reset]').click();
  await page.keyboard.press('Control+k');
  await page.locator('#global-search').fill('production_combined');
  assert.ok(await page.locator('.search-result').count() >= 2, 'Search includes database path properties');
  await page.locator('#global-search').fill('no-such-page-00000');
  assert.equal(await page.locator('.search-result').count(), 0);
  await page.keyboard.press('Escape');
  const figurePage = Object.values(data.pages).find(page => page.title === 'Detail of OMILRec Performance on NC').id;
  await go(figurePage);
  await page.locator('main .study-image').first().click();
  assert.equal(await page.locator('#image-dialog').isVisible(), true);
  await page.locator('[data-zoom="1"]').click();
  assert.equal(await page.locator('#large-image').evaluate(image => image.classList.contains('zoomed')), true);
  await page.keyboard.press('Escape');
  await page.screenshot({path: join(output, `${name}-figures.png`), fullPage: true});
  await go(data.root_id);
  await page.screenshot({path: join(output, `${name}-overview.png`), fullPage: true});
  await page.locator('#topbar [data-open-about]').click();
  assert.match(await page.locator('#about-dialog').textContent(), /13 of 13/);
  assert.equal(await page.locator('#about-dialog .copy-status.incomplete').count(), 0);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile page must not overflow horizontally');
  await page.locator('#topbar [data-toggle-sidebar]').click();
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('sidebar-open')), true);
  await page.waitForFunction(() => document.getElementById('sidebar').getBoundingClientRect().left >= -1);
  await page.screenshot({path: join(output, `${name}-mobile.png`)});
  assert.deepEqual(errors, [], `${name}: browser errors`);
  assert.deepEqual(requests, [], `${name}: external resource requests`);
  results.push({browser: name, pages_and_database_routes: Object.keys(nodes).length, tables: checkedTables, images: checkedImages, formulas: checkedMath, errors, external_requests: requests.length, interaction_checks: 'passed'});
  await browser.close();
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(join(output, 'browser-validation.json'), JSON.stringify({html_file: htmlFile, tested_at: new Date().toISOString(), results}, null, 2) + '\n');
