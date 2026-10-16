/** Capture a subtree using the connected Notion tools, without writing to Notion.
 * Dependency-free so it can also run inside Codex's JavaScript tool runner.
 * The caller persists the returned object locally; signed URLs are private cache.
 */
export async function captureSnapshot({rootId, fetchEntity, queryDataSource, onProgress = () => {}, signal}) {
  const idOf = value => {
    const match = String(value).match(/[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i);
    if (!match) throw new Error(`No Notion ID in ${value}`);
    return match[0].replaceAll('-', '').toLowerCase();
  };
  const cleanUrl = value => String(value).replace(/^\{\{|\}\}$/g, '');
  const attributes = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], cleanUrl(m[2])]));
  const unwrap = result => {
    if (result.isError) throw new Error(JSON.stringify(result.content));
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find(block => block.type === 'text')?.text;
    if (!text) throw new Error('Empty Notion tool response');
    try {return JSON.parse(text);} catch {return {text};}
  };
  const snapshot = {format_version: 1, record_scope: 'saved_views', root_id: idOf(rootId), captured_at: new Date().toISOString(), pages: {}, databases: {}, sources: {}, views: {}, issues: []};
  const queue = [{id: snapshot.root_id, type: 'page', parent: null}];
  const seen = new Set();
  const issue = (entity, message) => snapshot.issues.push({entity, message});
  const withoutFences = markdown => {
    let fence = null;
    return markdown.split('\n').map(line => {
      const match = /^\s*(`{3,}|~{3,})/.exec(line);
      if (match) {
        if (!fence) fence = match[1];
        else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
        return '';
      }
      return fence ? '' : line;
    }).join('\n');
  };
  while (queue.length) {
    if (signal?.aborted) throw signal.reason;
    // Keep batches bounded, preserve discovery order, and inspect every failure.
    const batch = queue.splice(0, 4).filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    const responses = await Promise.allSettled(batch.map(item => fetchEntity({id: item.id, include_file_urls: true})));
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index], response = responses[index];
      if (response.status !== 'fulfilled') {issue(item.id, `Read failed: ${String(response.reason)}`); continue;}
      let entity;
      try {entity = unwrap(response.value);} catch (error) {issue(item.id, String(error)); continue;}
      if (entity.truncated || entity.unknown_block_count) issue(item.id, `Incomplete response: truncated=${!!entity.truncated}, unknown blocks=${entity.unknown_block_count || 0}`);
      const text = entity.text || '';
      if (item.type === 'page') {
        if (item.id === snapshot.root_id && /^(?:[^<]*\n)?<database\b/.test(text)) throw new Error('The link points to a standalone database. Supply a page containing the database.');
        const markdown = text.match(/<content>\n?([\s\S]*?)\n?<\/content>/)?.[1] || '';
        let properties = {};
        try {properties = JSON.parse(text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1] || '{}');} catch {issue(item.id, 'Page properties could not be parsed');}
        const children = [];
        for (const match of withoutFences(markdown).matchAll(/^[\t ]*<(database|page|folder)\b([^>]*)>/gm)) {
          const attrs = attributes(match[2]);
          if (!attrs.url) {issue(item.id, `Unresolved ${match[1]} block`); continue;}
          const childId = idOf(attrs.url);
          children.push({id: childId, type: match[1], inline: attrs.inline === 'true'});
          if (match[1] === 'folder') issue(childId, 'Folder capture is not supported');
          else queue.push({id: childId, type: match[1], parent: item.id});
        }
        const blank = text.includes('<blank-page>');
        if (!markdown && !blank && !text.includes('<content>')) issue(item.id, 'Page body was unavailable');
        if (/<(?:unknown|custom-block|meeting-notes|tabs)\b/.test(withoutFences(markdown))) issue(item.id, 'Unsupported Notion block in page body');
        const source = Object.values(snapshot.sources).find(source => source.rows.some(row => row.id === item.id));
        const titleKey = Object.keys(source?.schema || {}).find(key => source.schema[key].type === 'title');
        const title = entity.title || properties[titleKey] || properties.title || properties.Name || 'Untitled';
        snapshot.pages[item.id] = {id: item.id, title: String(title).trim(), url: entity.url || text.match(/<page\b[^>]*\burl="([^"]+)"/)?.[1] || `https://www.notion.so/${item.id}`, parent: item.parent, properties, markdown, children, references: entity.references || entity.metadata?.references || {}, cover: entity.cover || null, icon: entity.icon || null, last_edited_at: entity.page_last_edited_at || null, source_as_of: text.match(/ as of ([^\n]+):\n/)?.[1] || null};
      } else {
        const states = [...text.matchAll(/<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/g)].map(match => JSON.parse(match[1]));
        const rawViews = [...text.matchAll(/<view url="([^"]+)">\s*([\s\S]*?)\s*<\/view>/g)].map(match => ({id: idOf(match[1]), url: cleanUrl(match[1]), ...JSON.parse(match[2])}));
        const database = {id: item.id, title: (entity.title || text.match(/The title of this Database is: ([^\n]+)/)?.[1] || 'Untitled database').trim(), url: entity.url || `https://www.notion.so/${item.id}`, parent: item.parent, sources: [], views: []};
        for (const state of states) {
          const sourceId = idOf(state.url);
          database.sources.push(sourceId);
          if (!snapshot.sources[sourceId]) {
            snapshot.sources[sourceId] = {id: sourceId, url: state.url, title: state.name.trim(), schema: state.schema, rows: []};
          }
        }
        for (const view of rawViews) {
          database.views.push(view.id);
          if (snapshot.views[view.id]) continue;
          try {
            const detail = unwrap(await fetchEntity({id: view.url}));
            const viewState = JSON.parse(detail.text.match(/<view[^>]*>\s*([\s\S]*?)\s*<\/view>/)[1]);
            if (viewState.type !== 'table') issue(item.id, `The ${viewState.type || 'unknown'} view layout is displayed as a table in this copy`);
            const rows = [];
            let cursor;
            const cursors = new Set();
            do {
              if (signal?.aborted) throw signal.reason;
              const result = unwrap(await queryDataSource({data: {mode: 'view', view_url: view.url, page_size: 100, is_archived: false, ...(cursor ? {start_cursor: cursor} : {})}}));
              const batchRows = result.results || result.rows;
              if (!Array.isArray(batchRows)) throw new Error('Unrecognized view row response');
              rows.push(...batchRows);
              if (result.truncated) issue(item.id, 'View rows were truncated by Notion');
              if (result.has_more && (!result.next_cursor || cursors.has(result.next_cursor))) throw new Error('View pagination did not advance');
              cursor = result.has_more ? result.next_cursor : null;
              if (cursor) cursors.add(cursor);
            } while (cursor);
            const sourceId = idOf(cleanUrl(viewState.dataSourceUrl)), source = snapshot.sources[sourceId];
            if (!source) throw new Error('View references an unreadable data source');
            const rowIds = [];
            for (const row of rows) {
              const rowId = idOf(row.url || row.id), existing = source.rows.find(record => record.id === rowId);
              const record = {...(row.properties || row), url: row.url || `https://www.notion.so/${rowId}`, id: rowId};
              existing ? Object.assign(existing, record) : source.rows.push(record);
              rowIds.push(rowId);
              queue.push({id: rowId, type: 'page', parent: item.id});
            }
            snapshot.views[view.id] = {...viewState, id: view.id, url: view.url, database_id: item.id, source_id: sourceId, row_ids: [...new Set(rowIds)]};
          } catch (error) {issue(view.id, `View configuration or order unavailable: ${String(error)}`);}
        }
        if (!states.length) issue(item.id, 'Database schema unavailable');
        if (!rawViews.length) issue(item.id, 'Database has no readable saved view');
        snapshot.databases[item.id] = database;
      }
      onProgress({type: item.type, title: entity.title, pages: Object.keys(snapshot.pages).length, databases: Object.keys(snapshot.databases).length});
    }
  }
  if (signal?.aborted) throw signal.reason;
  if (!snapshot.pages[snapshot.root_id]) throw new Error('The root page could not be read. Check the link and your Notion access.');
  for (const source of Object.values(snapshot.sources)) for (const row of source.rows) {
    const page = snapshot.pages[row.id];
    if (page) Object.assign(row, page.properties, {id: row.id, url: row.url});
  }
  snapshot.completed_at = new Date().toISOString();
  return snapshot;
}
