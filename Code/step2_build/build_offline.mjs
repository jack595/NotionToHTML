/** Local-only builder: a captured Notion subtree becomes one offline HTML file. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Marked} from 'marked';
import katex from 'katex';
import sanitizeHtml from 'sanitize-html';
import {load} from 'cheerio';
import {mediaReferences} from '../step1_capture/cache_assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
export const idOf = value => String(value).match(/[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0]?.replaceAll('-', '').toLowerCase();
const attrsOf = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2].replace(/^\{\{|\}\}$/g, '')]));
const dedent = text => {
  const lines = text.replace(/^\n|\n$/g, '').split('\n');
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.match(/^\s*/)[0].length));
  return lines.map(line => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
};

export function plainValue(value, spec = {}) {
  if (value == null) return spec.type === 'multi_select' ? [] : '';
  if (spec.type === 'checkbox') return value === true || value === 1 || value === '__YES__' || value === 'true';
  if (spec.type === 'multi_select') {
    if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item.name || item.plain_text || '');
    try {const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed.map(String);} catch {}
    return value ? [String(value)] : [];
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.map(item => item.plain_text || item.text?.content || item.equation?.expression || item.name || '').join('');
    return value.name ?? value.content ?? value.url ?? JSON.stringify(value);
  }
  // Unescape Markdown escapes in text properties, including literal path pipes.
  return String(value).replace(/\\([\\*~`$\[\]<>{}|^])/g, '$1');
}

function schemaOptions(spec) {
  return spec.options || Object.values(spec.groups || {}).flat();
}

export function createRenderer(snapshot, assets, issues) {
  const names = {...snapshot.databases, ...snapshot.pages};
  const report = (entity, message) => {
    if (!issues.some(issue => issue.entity === entity && issue.message === message)) issues.push({entity, message});
  };
  let owner = snapshot.root_id;
  let mathFragments = [];
  const marked = new Marked({gfm: true, breaks: true});
  const math = (equation, displayMode) => {
    try {
      const index = mathFragments.push(katex.renderToString(equation, {displayMode, output: 'htmlAndMathml', throwOnError: true, trust: false, strict: 'ignore'})) - 1;
      return `<span data-math-slot="${index}"></span>`;
    }
    catch {report(owner, `Formula could not be rendered: ${equation}`); return `<code>${escapeHtml(equation)}</code>`;}
  };
  const pageLink = (url, title = '', block = false) => {
    const id = idOf(url), known = names[id];
    const label = title || known?.title || 'Linked page';
    return `<a class="${block ? 'page-link' : 'page-mention'}" href="${known ? '#' + id : escapeHtml(url)}">${block ? '<span aria-hidden="true">▤</span>' : ''}${escapeHtml(label)}${block ? '<span class="link-arrow" aria-hidden="true">↗</span>' : ''}</a>`;
  };
  marked.use({extensions: [
    {
      name: 'notionStrong', level: 'inline', start: src => src.indexOf('**'),
      tokenizer(src) {const match = /^\*\*([^*\n]+)\*\*/.exec(src); if (match) return {type: 'notionStrong', raw: match[0], text: match[1]};},
      renderer(token) {return `<strong>${marked.parseInline(token.text)}</strong>`;},
    },
    {
      name: 'notionMath', level: 'inline', start: src => src.indexOf('$`'),
      tokenizer(src) {const match = /^\$`([\s\S]+?)`\$/.exec(src); if (match) return {type: 'notionMath', raw: match[0], text: match[1]};},
      renderer: token => math(token.text, false),
    },
    {
      name: 'notionMention', level: 'inline', start: src => src.indexOf('<mention-'),
      tokenizer(src) {
        const match = /^<mention-(page|database|data-source)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mention-\1>)/.exec(src);
        if (match) return {type: 'notionMention', raw: match[0], attrs: attrsOf(match[2]), text: match[3] || ''};
      },
      renderer: token => pageLink(token.attrs.url || '', token.text),
    },
    {
      name: 'notionMentionBlock', level: 'block', start: src => src.search(/^<mention-/m),
      tokenizer(src) {
        const match = /^<mention-(page|database|data-source)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mention-\1>)[ \t]*(?:\n|$)/.exec(src);
        if (match) return {type: 'notionMentionBlock', raw: match[0], attrs: attrsOf(match[2]), text: match[3] || ''};
      },
      renderer: token => '<p>' + pageLink(token.attrs.url || '', token.text) + '</p>\n',
    },
    {
      name: 'notionBlock', level: 'block',
      start: src => src.search(/^(?:\$\$|<(?:callout|database|page|empty-block|table_of_contents|details|columns|synced_block|file|pdf|embed|audio|video|unknown)\b)/m),
      tokenizer(src) {
        const equation = /^\$\$\n([\s\S]*?)\n\$\$(?:\n|$)/.exec(src);
        if (equation) return {type: 'notionBlock', kind: 'math', raw: equation[0], text: equation[1], attrs: {}};
        const empty = /^<(empty-block|table_of_contents|unknown)\b([^>]*?)\/>[ \t]*(?:\n|$)/.exec(src);
        if (empty) return {type: 'notionBlock', kind: empty[1], raw: empty[0], attrs: attrsOf(empty[2])};
        const tag = /^<(callout|database|page|details|columns|synced_block|synced_block_reference|file|pdf|embed|audio|video)\b([^>]*)>/.exec(src);
        if (!tag) return;
        const end = src.indexOf(`</${tag[1]}>`, tag[0].length);
        if (end === -1) return;
        const raw = src.slice(0, end + tag[1].length + 3).replace(/\r/g, '');
        return {type: 'notionBlock', kind: tag[1], raw: raw + (src[raw.length] === '\n' ? '\n' : ''), attrs: attrsOf(tag[2]), text: src.slice(tag[0].length, end)};
      },
      renderer(token) {
        const attrs = token.attrs;
        if (token.kind === 'math') return math(token.text, true);
        if (token.kind === 'empty-block') return '<div class="empty-block"></div>\n';
        if (token.kind === 'table_of_contents') return '<nav class="inline-outline" aria-label="Table of contents"></nav>\n';
        if (token.kind === 'page') return pageLink(attrs.url || '', token.text.trim(), true) + '\n';
        if (token.kind === 'database') {
          const id = idOf(attrs.url), database = snapshot.databases[id];
          if (!database) {report(owner, 'A linked database was not captured'); return '<p class="unavailable">Database unavailable in this copy.</p>';}
          if (attrs.inline !== 'true') return pageLink(attrs.url, token.text.trim() || database.title, true) + '\n';
          return `<section class="database" data-db-id="${id}" aria-label="${escapeHtml(database.title)}"></section>\n`;
        }
        if (token.kind === 'callout') return `<aside class="callout color-${escapeHtml(attrs.color || 'gray_bg')}"><span class="callout-icon" aria-hidden="true">${escapeHtml(attrs.icon || '💡')}</span><div>${marked.parse(dedent(token.text))}</div></aside>\n`;
        if (token.kind === 'details') {
          const summary = token.text.match(/<summary>([\s\S]*?)<\/summary>/);
          return `<details class="notion-toggle"><summary>${marked.parseInline(summary?.[1] || 'Details')}</summary>${marked.parse(dedent(token.text.replace(summary?.[0] || '', '')))}</details>\n`;
        }
        if (token.kind === 'columns') return `<div class="columns">${[...token.text.matchAll(/<column[^>]*>([\s\S]*?)<\/column>/g)].map(match => `<div>${marked.parse(dedent(match[1]))}</div>`).join('')}</div>\n`;
        if (token.kind.startsWith('synced_block')) return marked.parse(dedent(token.text));
        if (token.kind === 'unknown') {report(owner, 'Unsupported Notion block'); return '<p class="unavailable">This block could not be included.</p>';}
        const asset = assets[attrs.src];
        if (!asset) {report(owner, 'An attachment could not be downloaded'); return '<p class="unavailable">Attachment unavailable in this copy.</p>';}
        const caption = escapeHtml(token.text || 'Attachment');
        if (['audio', 'video'].includes(token.kind)) return `<figure><${token.kind} controls src="${asset.data_uri}"></${token.kind}><figcaption>${caption}</figcaption></figure>`;
        return `<p><a href="${asset.data_uri}" download="${caption}">${caption} ↓</a></p>`;
      },
    },
  ]});
  const mathTags = 'math semantics annotation mrow mi mn mo mtext mspace msub msup msubsup mfrac msqrt mroot mstyle mover munder munderover mtable mtr mtd mpadded mphantom menclose'.split(' ');
  function sanitize(html) {
    return sanitizeHtml(html, {
      allowedTags: [...sanitizeHtml.defaults.allowedTags, ...mathTags, 'img', 'figure', 'figcaption', 'input', 'details', 'summary', 'section', 'audio', 'video'],
      allowedAttributes: {
        '*': ['class', 'id', 'aria-label', 'data-db-id', 'data-heading', 'data-math-slot', 'role'],
        a: ['href', 'class', 'download', 'target', 'rel'],
        img: ['src', 'alt', 'class', 'loading', 'decoding'],
        input: ['type', 'checked', 'disabled', 'aria-label'],
        ol: ['start'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'],
        math: ['xmlns', 'display'], annotation: ['encoding'],
        mo: ['stretchy', 'fence', 'separator', 'lspace', 'rspace', 'minsize', 'maxsize'],
        mi: ['mathvariant'], mn: ['mathvariant'], mstyle: ['mathvariant', 'scriptlevel', 'displaystyle'],
        mspace: ['width', 'height', 'depth'], mpadded: ['width', 'height', 'depth', 'lspace', 'voffset'],
        mfrac: ['linethickness'], mtable: ['columnalign', 'rowspacing', 'columnspacing'],
        audio: ['src', 'controls'], video: ['src', 'controls'],
      },
      allowedSchemes: ['https', 'http', 'mailto'],
      allowedSchemesByTag: {img: ['data'], a: ['https', 'http', 'mailto', 'data'], audio: ['data'], video: ['data']},
      allowProtocolRelative: false,
      transformTags: {
        input: (_tag, attrs) => ({tagName: 'input', attribs: {type: 'checkbox', disabled: '', ...(Object.hasOwn(attrs, 'checked') ? {checked: ''} : {}), 'aria-label': Object.hasOwn(attrs, 'checked') ? 'Completed' : 'Not completed'}}),
        span: (_tag, attrs) => ({tagName: 'span', attribs: {...attrs, ...(attrs.color ? {class: `color-${attrs.color}`} : {}), ...(attrs.underline === 'true' ? {class: 'underlined'} : {})}}),
      },
    });
  }
  function render(markdown, pageId, inline = false) {
    owner = pageId;
    mathFragments = [];
    // Notion uses tabs for list nesting; CommonMark requires four spaces.
    const input = markdown.replace(/^\t+/gm, tabs => '    '.repeat(tabs.length));
    let html = inline ? marked.parseInline(input) : marked.parse(input);
    const $ = load(html, {xml: false}, false);
    $('img').each((_index, element) => {
      const img = $(element), src = img.attr('src'), asset = assets[src];
      if (!asset) {report(pageId, 'An image could not be downloaded'); img.replaceWith('<span class="unavailable">Image unavailable in this copy.</span>'); return;}
      img.attr({src: asset.data_uri, alt: img.attr('alt') || 'Study figure', loading: 'lazy', decoding: 'async', class: 'study-image'});
    });
    $('a[href]').each((_index, element) => {
      const link = $(element), href = link.attr('href'), id = idOf(href);
      if (/^https?:\/\/(?:app\.)?notion\.(?:com|so)\//.test(href) && names[id]) link.attr('href', '#' + id);
      else if (/^https?:/.test(href)) link.attr({target: '_blank', rel: 'noopener noreferrer'});
    });
    $('h1,h2,h3,h4,h5,h6').each((index, element) => $(element).attr({'data-heading': String(index), id: `${pageId}-h${index}`}));
    html = sanitize($.html()).replace(/<span data-math-slot="(\d+)"><\/span>/g, (_match, index) => mathFragments[Number(index)] || '');
    return html;
  }
  return render;
}

export async function buildOffline(snapshotFile, outputFile) {
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  const issues = [...snapshot.issues];
  const assets = {};
  let manifest = {files: {}, issues: []};
  try {manifest = JSON.parse(await readFile(join(dirname(snapshotFile), 'assets.json'), 'utf8'));} catch {issues.push({entity: snapshot.root_id, message: 'No downloaded-media manifest was found'});}
  issues.push(...manifest.issues.map(issue => ({entity: issue.entity, message: issue.message})));
  for (const [reference, meta] of Object.entries(manifest.files)) {
    try {
      const bytes = await readFile(join(dirname(snapshotFile), meta.path));
      if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error('Asset checksum mismatch');
      assets[reference] = {...meta, data_uri: `data:${meta.content_type};base64,${bytes.toString('base64')}`};
    } catch {issues.push({entity: meta.pages[0], message: 'A cached attachment is missing or has changed'});}
  }
  const render = createRenderer(snapshot, assets, issues);
  const data = {root_id: snapshot.root_id, record_scope: snapshot.record_scope || 'all_rows', captured_at: snapshot.captured_at, completed_at: snapshot.completed_at, generated_at: new Date().toISOString(), pages: {}, databases: snapshot.databases, sources: {}, views: snapshot.views, issues};
  for (const source of Object.values(snapshot.sources)) {
    const schema = Object.fromEntries(Object.entries(source.schema).map(([key, spec]) => [key, {name: spec.name, type: spec.type, options: schemaOptions(spec).map(option => ({name: option.name, color: option.color || 'default'}))}]));
    data.sources[source.id] = {...source, schema, rows: source.rows.map(row => ({id: row.id, values: Object.fromEntries(Object.entries(schema).map(([key, spec]) => [key, plainValue(row[key], spec)])), cells: Object.fromEntries(Object.entries(schema).map(([key, spec]) => [key, ['text', 'rich_text'].includes(spec.type) ? render(String(row[key] || ''), row.id, true) : '']))}))};
  }
  for (const page of Object.values(snapshot.pages)) {
    const source = Object.values(data.sources).find(source => source.rows.some(row => row.id === page.id));
    const row = source?.rows.find(row => row.id === page.id);
    const html = render(page.markdown, page.id);
    const $ = load(html);
    data.pages[page.id] = {id: page.id, title: page.title, url: page.url, parent: page.parent, children: page.children, html, source_id: source?.id || null, properties: row?.values || {}, property_cells: row?.cells || {}, cover: assets[`cover:${page.id}`]?.data_uri || null, icon: page.icon?.emoji || null, last_edited_at: page.last_edited_at, search_text: `${page.title}\n${$.text()}\n${Object.values(row?.values || {}).flat().join(' ')}`};
  }
  for (const [id, database] of Object.entries(data.databases)) {
    if (!database.views.length || database.views.some(id => !data.views[id])) issues.push({entity: id, message: 'A saved view was not available'});
    for (const sourceId of database.sources) if (!data.sources[sourceId]) issues.push({entity: id, message: 'Database records were not available'});
  }
  for (const view of Object.values(data.views)) {
    const source = data.sources[view.source_id];
    for (const id of view.row_ids) if (!source?.rows.some(row => row.id === id) || !data.pages[id]) issues.push({entity: view.database_id, message: 'A view references a record missing from the snapshot'});
  }
  const references = mediaReferences(snapshot);
  for (const reference of references) if (!assets[reference.reference]) issues.push({entity: reference.pages[0], message: 'A referenced attachment is not embedded'});
  const counts = {pages: Object.keys(data.pages).length, databases: Object.keys(data.databases).length, data_sources: Object.keys(data.sources).length, views: Object.keys(data.views).length, records: Object.values(data.sources).reduce((sum, source) => sum + source.rows.length, 0), embedded_assets: Object.keys(assets).length, expected_assets: references.length};
  data.counts = counts;
  const [readerCss, script] = await Promise.all([readFile(join(here, 'reader.css'), 'utf8'), readFile(join(here, 'reader.js'), 'utf8')]);
  const katexDirectory = dirname(fileURLToPath(import.meta.resolve('katex')));
  let mathCss = await readFile(join(katexDirectory, 'katex.min.css'), 'utf8');
  for (const match of [...mathCss.matchAll(/src:([^;]+);/g)]) {
    const fontPath = match[1].match(/url\(["']?([^"')]+\.woff2)["']?\)/)?.[1];
    if (!fontPath) throw new Error('KaTeX font declaration has no WOFF2 source');
    const bytes = await readFile(join(katexDirectory, fontPath));
    mathCss = mathCss.replace(match[0], `src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2");`);
  }
  const fontLicense = await readFile(join(katexDirectory, '../LICENSE'), 'utf8');
  const css = mathCss + '\n' + readerCss;
  // Escape '<' in JSON so page text cannot terminate the inert data script.
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const title = escapeHtml(data.pages[data.root_id].title);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light"><title>${title} · Offline</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%232f5a50'/%3E%3Ctext x='32' y='45' text-anchor='middle' font-size='42' fill='white'%3EP%3C/text%3E%3C/svg%3E">
<style>${css}</style></head><body>
<!-- KaTeX and its bundled fonts: ${escapeHtml(fontLicense).replaceAll('--', '—')} -->
<a class="skip-link" href="#main-content">Skip to content</a>
<aside id="sidebar" aria-label="Study navigation"></aside>
<div class="workspace"><header id="topbar"></header><main id="main-content" tabindex="-1"></main></div>
<aside id="preview" aria-label="Page preview" hidden></aside>
<dialog id="search-dialog" aria-label="Search this copy"><div class="search-head"><input id="global-search" type="search" placeholder="Search pages, notes and properties…" aria-label="Search all pages"><button type="button" data-close-dialog aria-label="Close search">Esc</button></div><div id="search-results"></div><footer class="search-footer">Search includes all ${counts.pages} pages and their database properties.</footer></dialog>
<dialog id="image-dialog" aria-label="Figure viewer"><header><span id="image-caption">Study figure</span><div><button type="button" data-zoom="-1" aria-label="Zoom out">−</button><button type="button" data-zoom="0">Fit</button><button type="button" data-zoom="1" aria-label="Zoom in">+</button><button type="button" data-close-dialog aria-label="Close figure">×</button></div></header><div class="image-stage"><img id="large-image" alt=""></div></dialog>
<dialog id="about-dialog" aria-labelledby="about-title"></dialog>
<noscript><p>This interactive copy needs JavaScript enabled in your browser. It does not need an internet connection.</p></noscript>
<script type="application/json" id="study-data">${json}</script>
<script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  await mkdir(dirname(resolve(outputFile)), {recursive: true});
  await writeFile(outputFile, html);
  const report = {title: data.pages[data.root_id].title, record_scope: data.record_scope, captured_at: data.captured_at, generated_at: data.generated_at, counts, bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'), complete: !issues.length, issues};
  await writeFile(outputFile.replace(/\.html$/i, '') + '.report.json', JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [snapshotFile, outputFile] = process.argv.slice(2);
  if (!snapshotFile || !outputFile) throw new Error('Usage: node build_offline.mjs /absolute/path/notion_snapshot.json /absolute/path/report.html');
  const result = await buildOffline(resolve(snapshotFile), resolve(outputFile));
  console.log(JSON.stringify(result, null, 2));
  if (!result.complete) process.exitCode = 1;
}
