/** Synthetic content only: no account, page, or attachment data from Notion. */
export const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const SOURCE = '33333333333333333333333333333333';
export const VIEW_A = '44444444444444444444444444444444';
export const VIEW_B = '55555555555555555555555555555555';
export const pageUrl = id => 'https://www.notion.so/' + id;

export function makeFixture({count = 205, extra = ''} = {}) {
  const dbIds = ['11111111111111111111111111111111', '22222222222222222222222222222222'];
  const ids = Array.from({length: count}, (_, index) => (index + 1).toString(16).padStart(32, '0'));
  const hidden = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const schema = {Name: {type: 'title', name: 'Name'}, Status: {type: 'status', name: 'Status', options: [{name: 'Ready', color: 'green'}, {name: 'Pending', color: 'yellow'}]}};
  const views = {[VIEW_A]: ids, [VIEW_B]: ids.filter((_, index) => index % 2 === 0).reverse()};
  const entities = {
    [ROOT]: {id: ROOT, title: '共享研究 中文', text: '<properties>{"title":"共享研究 中文"}</properties><content>\n# Overview\nSearchable offline notes.\n' + dbIds.map(id => `<database url="${pageUrl(id)}" inline="true">Samples</database>`).join('\n') + '\n```html\n<page url="' + pageUrl(hidden) + '">Literal example</page>\n```\n' + extra + '\n</content>'},
  };
  for (const [index, dbId] of dbIds.entries()) {
    const viewId = index ? VIEW_B : VIEW_A;
    const state = {name: index ? 'Reversed subset' : 'All visible', dataSourceUrl: 'collection://' + SOURCE, displayProperties: ['Name', 'Status'], type: 'table'};
    entities[dbId] = {title: 'Samples', text: '<data-source-state>' + JSON.stringify({name: 'Samples', url: 'collection://' + SOURCE, schema}) + '</data-source-state><views><view url="view://' + viewId + '">' + JSON.stringify(state) + '</view></views>'};
    entities['view://' + viewId] = {text: '<view>' + JSON.stringify(state) + '</view>'};
  }
  for (const [index, id] of ids.entries()) entities[id] = {title: 'Record ' + (index + 1), text: '<properties>' + JSON.stringify({Name: 'Record ' + (index + 1), Status: index % 2 ? 'Pending' : 'Ready'}) + '</properties><content>\nRecord detail ' + (index + 1) + '\n</content>'};
  const fetched = [], queries = [];
  const fetchEntity = async ({id}) => {
    fetched.push(id);
    if (!entities[id]) throw new Error('No access to this page');
    return {structuredContent: entities[id], content: []};
  };
  const queryDataSource = async ({data}) => {
    queries.push(data);
    if (data.mode !== 'view') throw new Error('Only saved-view reads are authorized');
    const viewId = data.view_url.slice('view://'.length), offset = Number(data.start_cursor || 0);
    const selected = views[viewId];
    const next = offset + data.page_size;
    return {structuredContent: {results: selected.slice(offset, next).map(id => ({url: pageUrl(id), Name: entities[id].title})), has_more: next < selected.length, next_cursor: next < selected.length ? String(next) : null}, content: []};
  };
  return {entities, ids, hidden, views, fetched, queries, fetchEntity, queryDataSource, resolveFiles: async () => ({}), close: async () => {}};
}
