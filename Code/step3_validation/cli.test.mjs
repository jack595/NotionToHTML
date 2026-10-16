import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, stat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {getEventListeners} from 'node:events';
import {captureSnapshot} from '../step1_capture/capture_snapshot.mjs';
import {cacheAssets} from '../step1_capture/cache_assets.mjs';
import {CredentialStore, NotionOAuthProvider, configDirectory} from '../step4_cli/auth.mjs';
import {connectNotion} from '../step4_cli/notion_client.mjs';
import {createNetworkFetch, safeMessage, retryAfterMs} from '../step4_cli/network.mjs';
import {parseArguments, parsePageLink, outputStem, runCli} from '../step4_cli/export_cli.mjs';
import {makeFixture, ROOT, SOURCE, VIEW_A, VIEW_B, pageUrl} from './cli_fixture.mjs';
import {mockNotion} from './mock_notion.mjs';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'notion-export-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test('share links and output names accept Chinese, spaces, hyphenated IDs and Notion sites', () => {
  for (const value of [pageUrl(ROOT), 'https://app.notion.com/p/Study-' + ROOT + '?source=copy_link', 'https://team.notion.site/' + ROOT, 'https://www.notion.so/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']) assert.equal(parsePageLink(value), ROOT);
  for (const value of ['http://www.notion.so/' + ROOT, 'https://notion.so.example.org/' + ROOT, 'https://example.com/' + ROOT, 'not a link']) assert.throws(() => parsePageLink(value));
  assert.throws(() => parseArguments([pageUrl(ROOT), '--output', 'file.txt']));
  assert.throws(() => parseArguments(['--login', pageUrl(ROOT)]));
  assert.throws(() => parseArguments([pageUrl(ROOT), '--token', 'secret']));
  assert.match(outputStem('中文 Study: A/B', new Date('2026-01-01T00:00:00Z')), /^中文 Study_ A_B_2026-01-01/);
  assert.match(outputStem('CON'), /^_CON_/);
  assert.ok(Buffer.byteLength(outputStem('很长'.repeat(200))) < 210);
});

test('saved views paginate past 100 rows, preserve order, deduplicate and exclude hidden records', async () => {
  const fixture = makeFixture();
  const snapshot = await captureSnapshot({rootId: ROOT, ...fixture});
  assert.equal(snapshot.record_scope, 'saved_views');
  assert.equal(Object.keys(snapshot.pages).length, 206);
  assert.equal(snapshot.sources[SOURCE].rows.length, 205);
  assert.deepEqual(snapshot.views[VIEW_A].row_ids, fixture.views[VIEW_A]);
  assert.deepEqual(snapshot.views[VIEW_B].row_ids, fixture.views[VIEW_B]);
  assert.equal(fixture.queries.length, 5);
  assert.equal(fixture.queries.every(query => query.mode === 'view'), true);
  assert.equal(fixture.fetched.includes(fixture.hidden), false);
  assert.equal(snapshot.sources[SOURCE].rows[0].Status, 'Ready');
  assert.deepEqual(snapshot.issues, []);
});

test('broken pagination is reported and unreadable root fails instead of emitting an empty success', async () => {
  const fixture = makeFixture({count: 1});
  const snapshot = await captureSnapshot({rootId: ROOT, ...fixture, queryDataSource: async () => ({structuredContent: {results: [], has_more: true, next_cursor: 'repeated'}})});
  assert.ok(snapshot.issues.some(issue => /pagination did not advance/.test(issue.message)));
  await assert.rejects(captureSnapshot({rootId: ROOT, fetchEntity: async () => {throw new Error('Permission denied');}}), /root page could not be read/);
  const controller = new AbortController(); controller.abort(new Error('Stopped'));
  await assert.rejects(captureSnapshot({rootId: ROOT, ...fixture, signal: controller.signal}), /Stopped/);
});

test('expired attachment URLs refresh once and embed verified original bytes', async t => {
  const directory = await temporary(t), snapshotFile = join(directory, 'notion_snapshot.json');
  const reference = 'notion-file-block://example/file';
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(snapshotFile, JSON.stringify({pages: {[ROOT]: {id: ROOT, markdown: `![Image](${reference})`, references: {[reference]: 'https://files.example/old?secret=temporary'}}}}));
  const requests = [], refreshes = [];
  const result = await cacheAssets(snapshotFile, {fetchFn: async url => {requests.push(url); return url.includes('/old') ? new Response('', {status: 403}) : new Response(bytes, {headers: {'content-type': 'image/png'}});}, resolveUrls: async (items, refresh) => {refreshes.push(!!refresh); return refresh ? {[reference]: 'https://files.example/fresh?signed=token'} : {};}});
  assert.equal(result.cached, 1); assert.equal(requests.length, 2); assert.deepEqual(refreshes, [false, true]);
  const manifest = JSON.parse(await readFile(join(directory, 'assets.json'), 'utf8'));
  assert.equal(manifest.files[reference].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(JSON.stringify(manifest).includes('signed=token'), false);
});

test('credentials are private, locks prevent refresh races and logout is per user', async t => {
  const directory = await temporary(t), first = new CredentialStore(join(directory, 'first')), second = new CredentialStore(join(directory, 'second'));
  assert.equal(configDirectory({XDG_CONFIG_HOME: '/tmp/custom'}), '/tmp/custom/notion-offline-exporter');
  await first.write({tokens: {access_token: 'first-secret'}}); await second.write({tokens: {access_token: 'second-secret'}});
  assert.equal((await stat(first.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(first.filename)).mode & 0o777, 0o600);
  const release = await first.lock(); await assert.rejects(first.lock(), /Another Notion exporter/); await release();
  await writeFile(join(first.directory, 'account.lock'), JSON.stringify({pid: 2147483647}));
  await (await first.lock())();
  assert.equal(await runCli(['--logout'], {store: first, fetchFn: fetch, stderr: () => {}}), 0);
  assert.deepEqual(await first.read(), {}); assert.equal((await second.read()).tokens.access_token, 'second-secret');
});

test('attachment resolver failure is contained in the incomplete-media report', async t => {
  const directory = await temporary(t), snapshotFile = join(directory, 'notion_snapshot.json');
  const reference = 'notion-file-block://unavailable/file';
  await writeFile(snapshotFile, JSON.stringify({pages: {[ROOT]: {id: ROOT, markdown: `![Missing](${reference})`, references: {[reference]: 'https://files.example/expired?signature=private'}}}}));
  const result = await cacheAssets(snapshotFile, {fetchFn: async () => new Response('', {status: 403}), resolveUrls: async () => {throw new Error('Attachment is unavailable');}});
  assert.equal(result.cached, 0); assert.equal(result.expected, 1); assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].message, /Attachment is unavailable/);
  assert.equal(JSON.stringify(result).includes('signature=private'), false);
});

test('network retries read requests but never replays refresh-token POSTs; logs remove secrets', async () => {
  let calls = 0; const pauses = [];
  const network = createNetworkFetch({useProxy: false, fetchImpl: async () => new Response('', {status: ++calls === 1 ? 429 : 200, headers: {'retry-after': '0'}}), wait: async delay => {pauses.push(delay);}});
  assert.equal((await network('https://example.com/mcp')).status, 200); assert.equal(calls, 2); assert.deepEqual(pauses, [0]);
  calls = 0;
  assert.equal((await network('https://example.com/mcp', {method: 'POST', body: JSON.stringify({jsonrpc: '2.0', method: 'initialize', id: 1})})).status, 200);
  assert.equal(calls, 2);
  const tokenFetch = createNetworkFetch({useProxy: false, fetchImpl: async () => {calls++; return new Response('', {status: 503});}});
  const before = calls;
  assert.equal((await tokenFetch('https://example.com/token', {method: 'POST', body: 'grant_type=refresh_token'})).status, 503); assert.equal(calls, before + 1);
  assert.equal(retryAfterMs('3'), 3000);
  const message = safeMessage(new Error('mock-access-1 https://files.example/a?X-Signature=secret refresh_token=hidden'), ['mock-access-1']);
  assert.equal(/mock-access-1|Signature|hidden/.test(message), false);
});

test('CLI exports Unicode paths, reports missing content and refuses overwrite before login', async t => {
  const directory = await temporary(t), fixture = makeFixture({count: 3});
  const store = new CredentialStore(join(directory, 'login')), output = join(directory, '路径 with spaces', '报告.html');
  const stdout = [], stderr = []; let connections = 0, closed = 0;
  const options = {store, connect: async () => {connections++; return {...fixture, close: async () => {closed++;}};}, fetchFn: fetch, stdout: value => stdout.push(value), stderr: value => stderr.push(value)};
  assert.equal(await runCli([pageUrl(ROOT), '--output', output], options), 0);
  const report = JSON.parse(await readFile(output.replace('.html', '.report.json'), 'utf8'));
  assert.equal(report.complete, true); assert.equal(report.counts.records, 3); assert.equal(report.record_scope, 'saved_views');
  const html = await readFile(output, 'utf8');
  assert.ok(html.includes('共享研究 中文')); assert.equal(html.includes('PSD in DSNB Study'), false);
  assert.deepEqual(stdout, [output]); assert.equal(closed, 1);
  assert.equal(await runCli([pageUrl(ROOT), '--output', output], options), 1); assert.equal(connections, 1);
  assert.equal(await runCli(['--help'], options), 0); assert.equal(connections, 1);
  const partial = join(directory, 'partial.html');
  const incomplete = makeFixture({count: 1, extra: '<unknown>Unsupported block</unknown>\n![Missing](notion-file-block://missing/file)'});
  assert.equal(await runCli([pageUrl(ROOT), '--output', partial], {...options, connect: async () => incomplete}), 1);
  const partialReport = JSON.parse(await readFile(partial.replace('.html', '.report.json'), 'utf8'));
  assert.equal(partialReport.complete, false);
  assert.ok(partialReport.issues.length >= 2);
  assert.equal((await readdir(store.directory)).includes('account.lock'), false);
});

test('real MCP SDK completes PKCE OAuth, reuses login, rotates refresh and recovers invalid_grant', {timeout: 30000}, async t => {
  const directory = await temporary(t), store = new CredentialStore(join(directory, 'login'));
  const fixture = makeFixture({count: 3}), mock = await mockNotion(fixture); t.after(mock.close);
  const logs = [];
  const launchBrowser = async authorization => {
    const url = new URL(authorization), callback = new URL(url.searchParams.get('redirect_uri'));
    // Invalid Unicode state must return 400, not crash the callback process.
    callback.searchParams.set('state', '中'.repeat(64)); callback.searchParams.set('code', 'untrusted');
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal((await fetch(authorization)).status, 200);
  };
  const controller = new AbortController();
  const options = {store, fetchFn: fetch, launchBrowser, log: value => logs.push(value), serverUrl: mock.serverUrl, signal: controller.signal};
  let connection = await connectNotion(options);
  assert.ok((await connection.fetchEntity({id: ROOT, include_file_urls: true})).content[0].text.includes('共享研究'));
  for (let index = 0; index < 20; index++) await connection.fetchEntity({id: ROOT});
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await connection.close();
  assert.equal(mock.state.registrations, 1); assert.equal(mock.state.logins, 1);
  connection = await connectNotion(options); await connection.close();
  assert.equal(mock.state.logins, 1); assert.equal(mock.state.refreshes, 0);
  connection = await connectNotion(options); mock.state.access = 'expired-on-server';
  await connection.fetchEntity({id: ROOT}); await connection.close();
  assert.equal(mock.state.refreshes, 1); assert.equal(mock.state.logins, 1);
  let credentials = await store.read(); credentials.expires_at = Date.now() - 1000; await store.write(credentials);
  connection = await connectNotion(options); await connection.close();
  assert.equal(mock.state.refreshes, 2); assert.equal(mock.state.logins, 1);
  assert.notEqual((await store.read()).tokens.refresh_token, credentials.tokens.refresh_token);
  credentials = await store.read(); credentials.expires_at = Date.now() - 1000; await store.write(credentials); mock.state.rejectRefresh = true;
  connection = await connectNotion(options); await connection.close();
  assert.equal(mock.state.refreshes, 3); assert.equal(mock.state.logins, 2); assert.equal(mock.state.registrations, 1);
  assert.equal(new Set(mock.state.usedRefresh).size, 3);
  assert.equal(logs.some(value => /mock-access|mock-refresh/.test(value)), false);
  // Export through the entire SDK/network/auth/capture/build path.
  const output = join(directory, 'SDK end to end.html');
  assert.equal(await runCli([pageUrl(ROOT), '--output', output], {store, connect: args => connectNotion({...args, serverUrl: mock.serverUrl, launchBrowser}), fetchFn: fetch, stdout: () => {}, stderr: () => {}}), 0);
  assert.equal(JSON.parse(await readFile(output.replace('.html', '.report.json'), 'utf8')).counts.records, 3);
});

test('cancelled browser authorization cleans up the callback and account lock', {timeout: 10000}, async t => {
  const directory = await temporary(t), store = new CredentialStore(join(directory, 'login'));
  const mock = await mockNotion(makeFixture({count: 0})); t.after(mock.close);
  const logs = [];
  const launchBrowser = async authorization => {
    const url = new URL(authorization), callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('error', 'access_denied');
    assert.equal((await fetch(callback)).status, 400);
  };
  assert.equal(await runCli(['--login'], {store, connect: args => connectNotion({...args, serverUrl: mock.serverUrl, launchBrowser}), fetchFn: fetch, stderr: value => logs.push(value)}), 1);
  assert.ok(logs.some(value => /cancelled/.test(value)));
  assert.equal((await readdir(store.directory)).includes('account.lock'), false);
  const provider = new NotionOAuthProvider(store); await provider.initialize(); await provider.ensureListener(); await provider.close();
});
