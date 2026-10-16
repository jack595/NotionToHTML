import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {createRenderer, plainValue} from '../step2_build/build_offline.mjs';
import {captureSnapshot} from '../step1_capture/capture_snapshot.mjs';

const rootId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const fixture = {root_id: rootId, pages: {[rootId]: {title: 'Study'}, [pageId]: {title: 'Subpage'}}, databases: {}};

test('Notion formatting, nested tasks, page mentions, and math survive conversion', () => {
  const issues = [], render = createRenderer(fixture, {}, issues);
  const html = render('<callout icon="⭐" color="gray_bg">\n\t**Physics statement with a trailing space **\n</callout>\n## Sample $`e^-`$\n- [ ] First task\n\t- [x] Nested task\n<mention-page url="https://app.notion.com/p/' + pageId + '"/>\n<page url="https://app.notion.com/p/' + pageId + '">Subpage</page>', rootId);
  const $ = load(html);
  assert.equal($('.callout strong').text().trim(), 'Physics statement with a trailing space');
  assert.equal($('li li input[checked][disabled]').length, 1);
  assert.equal($('math msub, math msup').length > 0, true);
  assert.equal($('a.page-mention').text(), 'Subpage');
  assert.equal($('a.page-link').attr('href'), '#' + pageId);
  assert.deepEqual(issues, []);
});

test('Uploaded media embeds exact bytes and missing media is reported', () => {
  const issues = [], uri = 'notion-file-block://image/example';
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const render = createRenderer(fixture, {[uri]: {data_uri: image}}, issues);
  let $ = load(render('![Caption](' + uri + ')', rootId));
  assert.equal($('img').attr('src'), image);
  assert.equal($('img').attr('alt'), 'Caption');
  $ = load(render('![Missing](notion-file-block://missing)', pageId));
  assert.equal($('img').length, 0);
  assert.equal($('.unavailable').length, 1);
  assert.equal(issues[0].entity, pageId);
});

test('Document content cannot inject scripts, event handlers, or remote image loads', () => {
  const render = createRenderer(fixture, {}, []);
  const html = render('<script>window.injected=true</script>\n\n<img src="https://example.com/tracker.png" onerror="alert(1)">\n\n[Bad](javascript:alert(1))\n\n```html\n<page url="https://app.notion.com/p/' + pageId + '">literal example</page>\n```', rootId);
  const $ = load(html);
  assert.equal($('script,[onerror],img[src^="http"],a[href^="javascript:"]').length, 0);
  assert.match($('pre code').text(), /<page url=/);
});

test('Checkbox markers and multi-select arrays keep their scientific task meaning', () => {
  assert.equal(plainValue('__NO__', {type: 'checkbox'}), false);
  assert.equal(plainValue('__YES__', {type: 'checkbox'}), true);
  assert.deepEqual(plainValue('["Simulation","Data"]', {type: 'multi_select'}), ['Simulation', 'Data']);
  assert.equal(plainValue('/eos/(a\\|b)/', {type: 'text'}), '/eos/(a|b)/');
});

test('Capture deduplicates a shared data source while preserving separate view order', async () => {
  const db1 = '11111111111111111111111111111111', db2 = '22222222222222222222222222222222';
  const source = '33333333333333333333333333333333', view1 = '44444444444444444444444444444444', view2 = '55555555555555555555555555555555';
  const url = id => 'https://app.notion.com/p/' + id;
  const row = {Name: 'Subpage', url: url(pageId)};
  const schema = {Name: {type: 'title', name: 'Name'}};
  const entities = {
    [rootId]: {id: rootId, title: 'Study', text: '<properties>{}</properties><content>\n<database url="' + url(db1) + '" inline="true" data-source-url="collection://' + source + '">A</database>\n<database url="' + url(db2) + '" inline="true">B</database>\n</content>'},
    [pageId]: {id: pageId, title: 'Subpage', text: '<properties>{}</properties><blank-page>This page is blank.</blank-page>'},
  };
  for (const [dbId, viewId] of [[db1, view1], [db2, view2]]) entities[dbId] = {title: dbId, text: '<data-source-state>' + JSON.stringify({name: 'Shared', url: 'collection://' + source, schema}) + '</data-source-state><views><view url="view://' + viewId + '">' + JSON.stringify({dataSourceUrl: 'collection://' + source, displayProperties: ['Name'], type: 'table'}) + '</view></views>'};
  for (const viewId of [view1, view2]) entities['view://' + viewId] = {text: '<view>' + JSON.stringify({dataSourceUrl: 'collection://' + source, displayProperties: ['Name'], type: 'table'}) + '</view>'};
  let rowQueries = 0;
  const result = await captureSnapshot({rootId, fetchEntity: async ({id}) => ({structuredContent: entities[id]}), queryDataSource: async ({data}) => {if (data.mode === 'rows') rowQueries++; return {structuredContent: {results: data.view_url === 'view://' + view2 ? [] : [row], has_more: false}};}});
  assert.equal(rowQueries, 0);
  assert.equal(result.record_scope, 'saved_views');
  assert.equal(Object.keys(result.pages).length, 2);
  assert.equal(Object.keys(result.databases).length, 2);
  assert.deepEqual(result.views[view1].row_ids, [pageId]);
  assert.deepEqual(result.views[view2].row_ids, []);
  assert.deepEqual(result.issues, []);
});
