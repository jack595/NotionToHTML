#!/usr/bin/env node
import {writeFile, mkdir, mkdtemp, rm, copyFile, access, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {captureSnapshot} from '../step1_capture/capture_snapshot.mjs';
import {cacheAssets} from '../step1_capture/cache_assets.mjs';
import {buildOffline} from '../step2_build/build_offline.mjs';
import {CredentialStore} from './auth.mjs';
import {connectNotion, decodeToolResult} from './notion_client.mjs';
import {createNetworkFetch, safeMessage} from './network.mjs';

export const HELP = `Notion Offline Exporter 1.0.0

Usage:
  notion-export.sh 'NOTION_PAGE_SHARE_LINK' [--output /path/report.html]
  notion-export.sh --login
  notion-export.sh --logout
  notion-export.sh --help

The first export opens your browser for Notion authorization.
Exports include child pages and every record shown in the captured saved views.
Hidden records outside those views are not collected. Existing files are never
overwritten. Only the generated HTML needs to be shared.

Exit status: 0 complete; 1 failed/incomplete; 2 invalid arguments; 130 cancelled.
`;

export function parsePageLink(value) {
  let url;
  try {url = new URL(value);} catch {throw new Error('Supply a full Notion page share link, enclosed in quotes.');}
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !['notion.so', 'www.notion.so', 'notion.com', 'www.notion.com', 'app.notion.com'].includes(host) && !host.endsWith('.notion.site')) throw new Error('Expected an HTTPS Notion page link from notion.so, notion.com, or notion.site.');
  const id = decodeURIComponent(url.pathname).match(/(?:^|[^a-f0-9])([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:[^a-f0-9]|$)/i)?.[1];
  if (!id) throw new Error('The link does not contain a Notion page ID. Use Notion’s Copy link action on the page.');
  return id.replaceAll('-', '').toLowerCase();
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--help', '-h', '--login', '--logout'].includes(argument)) {
      const action = argument === '-h' ? 'help' : argument.slice(2);
      if (options.action) throw new Error('Choose only one action.'); options.action = action;
    } else if (argument === '--output') {
      if (options.output || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--output requires one HTML file path.');
      options.output = resolve(argv[++index]);
      if (!/\.html$/i.test(options.output)) throw new Error('--output must name an .html file.');
    } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else {if (options.url) throw new Error('Supply one page link per export.'); options.url = argument;}
  }
  if (options.action && (options.url || options.output)) throw new Error('Use --login, --logout or --help separately from an export.');
  if (!options.action && !options.url) throw new Error('Supply a Notion page share link, or use --help.');
  if (options.output && !options.url) throw new Error('--output requires a page link.');
  if (options.url) options.rootId = parsePageLink(options.url);
  return options;
}

export function outputStem(title, date = new Date()) {
  let name = String(title).normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[.\s]+$/g, '').trim() || 'Notion_page';
  while (Buffer.byteLength(name) > 170) name = Array.from(name).slice(0, -1).join('');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name + '_' + date.toISOString().replaceAll(':', '-').replace('T', '_').replace('Z', '');
}

async function ensureUnused(filename) {
  for (const file of [filename, filename.replace(/\.html$/i, '.report.json')]) {
    try {await access(file);} catch (error) {if (error.code === 'ENOENT') continue; throw error;}
    throw new Error('An output file already exists. Choose another --output filename.');
  }
}

async function publishFiles(temporaryHtml, output, explicit) {
  await mkdir(dirname(output), {recursive: true});
  for (let suffix = 0; suffix < 100; suffix++) {
    const target = suffix ? output.replace(/\.html$/i, `_${suffix}.html`) : output;
    try {await ensureUnused(target);}
    catch (error) {if (!explicit) continue; throw error;}
    try {await copyFile(temporaryHtml, target, constants.COPYFILE_EXCL);}
    catch (error) {if (error.code === 'EEXIST' && !explicit) continue; throw error;}
    try {await copyFile(temporaryHtml.replace(/\.html$/, '.report.json'), target.replace(/\.html$/i, '.report.json'), constants.COPYFILE_EXCL);}
    catch (error) {await unlink(target); throw error;}
    return target;
  }
  throw new Error('Could not choose an unused output filename. Supply --output explicitly.');
}

/** Injecting a connection keeps regression tests independent of anyone's login. */
export async function runCli(argv, {stdout = text => process.stdout.write(text + '\n'), stderr = text => process.stderr.write(text + '\n'), store = new CredentialStore(), connect = connectNotion, fetchFn, signal, cwd = process.cwd()} = {}) {
  let options;
  try {options = parseArguments(argv);} catch (error) {stderr(error.message); stderr('Use --help for usage.'); return 2;}
  if (options.action === 'help') {stdout(HELP.trimEnd()); return 0;}
  if (options.output) {try {await ensureUnused(options.output);} catch (error) {stderr(error.message); return 1;}}
  let release, connection, workspace;
  const network = fetchFn || createNetworkFetch({signal});
  try {
    release = await store.lock();
    if (options.action === 'logout') {await store.clear(); stderr('The local Notion login has been removed.'); return 0;}
    connection = await connect({store, fetchFn: network, signal, log: stderr, forceLogin: options.action === 'login'});
    if (options.action === 'login') {stderr('Connected to Notion. You can now export a page link.'); return 0;}
    stderr('Reading the page and its saved database views…');
    let last = 0;
    const snapshot = await captureSnapshot({rootId: options.rootId, fetchEntity: args => connection.fetchEntity(args), queryDataSource: args => connection.queryDataSource(args), signal, onProgress: progress => {
      if (progress.pages + progress.databases - last >= 5) {stderr(`Read ${progress.pages} pages and ${progress.databases} database entries.`); last = progress.pages + progress.databases;}
    }});
    workspace = await mkdtemp(join(tmpdir(), 'notion-offline-'));
    const snapshotFile = join(workspace, 'notion_snapshot.json');
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    stderr('Downloading attached media…');
    const resolveUrls = async (items, refresh = false) => {
      const urls = await connection.resolveFiles(items.filter(item => item.reference.startsWith('notion-file-block://')).map(item => item.reference));
      const pageIds = [...new Set(items.filter(item => /^(cover|icon):/.test(item.reference) || refresh && !urls[item.reference]).flatMap(item => item.pages))];
      for (const pageId of pageIds) {
        const page = decodeToolResult(await connection.fetchEntity({id: pageId, include_file_urls: true}));
        Object.assign(urls, page.references || page.metadata?.references || {});
        if (page.cover) urls[`cover:${pageId}`] = page.cover.file?.url || page.cover.external?.url;
        if (page.icon) urls[`icon:${pageId}`] = page.icon.file?.url || page.icon.external?.url;
      }
      return urls;
    };
    const media = await cacheAssets(snapshotFile, {fetchFn: network, resolveUrls, signal});
    stderr(`Downloaded ${media.cached} of ${media.expected} media files. Building offline HTML…`);
    if (signal?.aborted) throw signal.reason;
    const temporaryHtml = join(workspace, 'export.html');
    const report = await buildOffline(snapshotFile, temporaryHtml);
    const destination = options.output || resolve(cwd, outputStem(snapshot.pages[snapshot.root_id].title) + '.html');
    const published = await publishFiles(temporaryHtml, destination, Boolean(options.output));
    stdout(published);
    stderr(`${report.complete ? 'Complete' : 'Incomplete'}: ${report.counts.pages} pages, ${report.counts.views} saved views, ${report.counts.records} records, ${report.counts.embedded_assets}/${report.counts.expected_assets} media files.`);
    if (!report.complete) stderr('Some content could not be included. See About this copy in the HTML and the adjacent report.');
    return report.complete ? 0 : 1;
  } catch (error) {stderr(signal?.aborted ? 'Export cancelled.' : safeMessage(error, connection?.provider?.secrets?.() || [])); return signal?.aborted ? 130 : 1;}
  finally {
    await connection?.close().catch(() => {});
    if (workspace) await rm(workspace, {recursive: true, force: true});
    await release?.();
    if (!fetchFn) await network.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Cancelled'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  process.exitCode = await runCli(process.argv.slice(2), {signal: controller.signal});
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
