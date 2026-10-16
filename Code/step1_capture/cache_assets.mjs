/** Local-only: download the exact media referenced by a captured Notion subtree. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function mediaReferences(snapshot) {
  const references = new Map();
  function add(reference, url, page, kind) {
    if (!reference) return;
    const entry = references.get(reference) || {reference, url, pages: [], kind};
    if (!entry.pages.includes(page)) entry.pages.push(page);
    references.set(reference, entry);
  }
  for (const page of Object.values(snapshot.pages)) {
    const signed = page.references || {};
    for (const match of page.markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) add(match[1], signed[match[1]] || match[1], page.id, 'image');
    for (const match of page.markdown.matchAll(/<(file|pdf|embed|audio|video)\b[^>]*\bsrc="([^"]+)"/g)) add(match[2], signed[match[2]] || match[2], page.id, match[1]);
    const cover = page.cover?.file?.url || page.cover?.external?.url;
    if (cover) add(`cover:${page.id}`, cover, page.id, 'image');
    const icon = page.icon?.file?.url || page.icon?.external?.url;
    if (icon) add(`icon:${page.id}`, icon, page.id, 'image');
  }
  return [...references.values()];
}

export async function cacheAssets(snapshotFile, {fetchFn = globalThis.fetch, resolveUrls, signal} = {}) {
  const directory = dirname(resolve(snapshotFile));
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  const cacheDirectory = join(directory, 'assets');
  await mkdir(cacheDirectory, {recursive: true});
  const manifestFile = join(directory, 'assets.json');
  let previous = {};
  try {previous = JSON.parse(await readFile(manifestFile, 'utf8')).files;} catch {}
  const manifest = {captured_at: new Date().toISOString(), files: {}, issues: []};
  const references = mediaReferences(snapshot);
  for (let start = 0; start < references.length; start += 4) {
    if (signal?.aborted) throw signal.reason;
    const batch = references.slice(start, start + 4);
    let fresh = {};
    if (resolveUrls) {
      try {fresh = await resolveUrls(batch);}
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        // A resolver failure must not discard the captured page. Try its
        // existing URL; individual expired/missing files become report issues.
      }
    }
    const results = await Promise.allSettled(batch.map(async item => {
      const cached = previous[item.reference];
      if (cached) {
        try {
          const bytes = await readFile(join(directory, cached.path));
          if (createHash('sha256').update(bytes).digest('hex') === cached.sha256) return {...cached, pages: item.pages};
        } catch { /* A missing cache entry is downloaded again below. */ }
      }
      let url = fresh[item.reference] || item.url;
      if (!url.startsWith('https://')) throw new Error('No signed HTTPS download URL is available for this attachment');
      let response = await fetchFn(url, {signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)});
      if ([401, 403].includes(response.status) && resolveUrls) {
        await response.body?.cancel();
        const refreshed = await resolveUrls([item], true);
        url = refreshed[item.reference];
        if (!url?.startsWith('https://')) throw new Error('Could not refresh an expired attachment URL');
        response = await fetchFn(url, {signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)});
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}; refresh expired download URLs`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      if (item.kind === 'image' && !contentType.startsWith('image/')) throw new Error(`Expected image, received ${contentType}`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const filename = `${sha256}.bin`;
      await writeFile(join(cacheDirectory, filename), bytes);
      return {path: `assets/${filename}`, sha256, bytes: bytes.length, content_type: contentType, kind: item.kind, pages: item.pages};
    }));
    results.forEach((result, index) => {
      const item = batch[index];
      if (result.status === 'fulfilled') manifest.files[item.reference] = result.value;
      else manifest.issues.push({entity: item.pages[0], reference: item.reference, message: String(result.reason).replace(/https:\/\/\S+/g, '[download URL]')});
    });
  }
  if (signal?.aborted) throw signal.reason;
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return {expected: references.length, cached: Object.keys(manifest.files).length, bytes: Object.values(manifest.files).reduce((sum, asset) => sum + asset.bytes, 0), issues: manifest.issues};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node cache_assets.mjs /absolute/path/notion_snapshot.json');
  const result = await cacheAssets(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
  if (result.issues.length) process.exitCode = 1;
}
