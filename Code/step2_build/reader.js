/* Browser-only reader. All content and media are supplied by the enclosing file. */
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('study-data').textContent);
  const nodes = {...data.databases, ...data.pages};
  const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const iconPaths = {
    page: '<path d="M5 2.5h6l3 3V14H5z"/><path d="M11 2.5v3h3M7 8h5M7 10.5h5"/>',
    table: '<rect x="2" y="3" width="12" height="11" rx="1"/><path d="M2 7h12M7 7v7"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
    chevron: '<path d="m6 4 4 4-4 4"/>',
    menu: '<path d="M3 4h10M3 8h10M3 12h10"/>',
    back: '<path d="m9 3-5 5 5 5"/>',
    close: '<path d="m4 4 8 8M12 4l-8 8"/>',
    expand: '<path d="M9 2h5v5M14 2 8 8M7 14H2V9M2 14l6-6"/>',
    filter: '<path d="M2 4h12M4 8h8M6 12h4"/>',
    sort: '<path d="M5 2v12m-3-3 3 3 3-3M11 14V2m-3 3 3-3 3 3"/>',
    properties: '<path d="M3 2v12M8 2v12M13 2v12"/><circle cx="3" cy="6" r="1.5"/><circle cx="8" cy="10" r="1.5"/><circle cx="13" cy="5" r="1.5"/>',
    status: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4v4l2.5 1.5"/>',
    tag: '<path d="m2 3 6-1 6 6-6 6-6-6z"/><circle cx="5" cy="5" r=".8"/>',
    text: '<path d="M3 3h10M8 3v10M5 13h6"/>',
    check: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5 8 2 2 4-4"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7v5M8 4v1"/>',
    link: '<path d="M9 2h5v5M14 2 7 9M6 3H2v11h11v-4"/>',
    star: '<path d="m8 1.2 2.1 4.4 4.8.7-3.5 3.4.8 4.8L8 12.2l-4.2 2.3.8-4.8L1.1 6.3l4.8-.7z" fill="#e5c75c" stroke="#c5a64c"/>',
    bulb: '<path d="M5 10c0-1-2-2-2-4a5 5 0 0 1 10 0c0 2-2 3-2 4z" fill="#f6df88" stroke="#b59a47"/><path d="M5.5 12h5M6.5 14h3"/>',
    pointer: '<path d="M2 7h8V4l4 4-4 4V9H2z" fill="#e5c75c" stroke="#c5a64c"/>',
  };
  const icon = (name, className = '') => `<svg class="icon ${className}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.page}</svg>`;
  const propertyIcon = spec => icon(({title: 'text', status: 'status', select: 'tag', multi_select: 'tag', checkbox: 'check'})[spec?.type] || 'text');
  const selectedViews = new Map(), tableStates = new Map();
  const expanded = new Set([data.root_id, ...data.pages[data.root_id].children.map(child => child.id)]);
  const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
  let currentId = data.root_id, previewId = null, zoom = 1, previousPreviewFocus = null;
  const sidebar = document.getElementById('sidebar'), main = document.getElementById('main-content'), preview = document.getElementById('preview');
  const searchDialog = document.getElementById('search-dialog'), searchInput = document.getElementById('global-search');
  const imageDialog = document.getElementById('image-dialog'), aboutDialog = document.getElementById('about-dialog');
  const textValue = value => Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'Checked' : 'Unchecked') : String(value ?? '');
  const dateText = value => new Date(value).toLocaleString('en', {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short'});
  const nodeIcon = id => data.databases[id] ? icon('table') : data.pages[id]?.icon ? `<span class="emoji-icon">${e(data.pages[id].icon)}</span>` : icon('page');
  function ancestors(id) {
    const result = [], seen = new Set();
    while (nodes[id] && !seen.has(id)) {seen.add(id); result.unshift(id); id = nodes[id].parent;}
    return result;
  }
  function children(id) {
    if (data.pages[id]) return data.pages[id].children.map(child => child.id).filter(id => nodes[id]);
    const db = data.databases[id];
    if (!db) return [];
    const ordered = db.views.flatMap(viewId => data.views[viewId]?.row_ids || []);
    const all = db.sources.flatMap(sourceId => data.sources[sourceId]?.rows.map(row => row.id) || []);
    return [...new Set([...ordered, ...all])].filter(id => nodes[id]);
  }
  function tree(id, depth = 0, seen = new Set()) {
    if (seen.has(id) || !nodes[id]) return '';
    const nextSeen = new Set([...seen, id]), items = children(id), open = expanded.has(id);
    return `<div class="tree-node"><div class="tree-row ${id === currentId ? 'active' : ''}" style="--depth:${depth}">${items.length ? `<button type="button" class="tree-toggle ${open ? 'expanded' : ''}" data-toggle-tree="${id}" aria-label="${open ? 'Collapse' : 'Expand'} ${e(nodes[id].title)}" aria-expanded="${open}">${icon('chevron')}</button>` : '<span class="tree-spacer"></span>'}<a href="#${id}" data-tree-id="${id}" title="${e(nodes[id].title)}" ${id === currentId ? 'aria-current="page"' : ''}>${nodeIcon(id)}<span>${e(nodes[id].title)}</span></a></div>${open && items.length ? `<div class="tree-children">${items.map(child => tree(child, depth + 1, nextSeen)).join('')}</div>` : ''}</div>`;
  }
  function renderSidebar() {
    sidebar.innerHTML = `<div class="sidebar-brand"><span class="study-monogram">${e(Array.from(nodes[data.root_id].title)[0]?.toUpperCase() || 'N')}</span><div><strong>${e(nodes[data.root_id].title)}</strong><span>Offline page collection</span></div><button class="mobile-close icon-button" data-toggle-sidebar aria-label="Close navigation">${icon('close')}</button></div><button class="search-button" data-open-search>${icon('search')}<span>Search</span><kbd>${/Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd></button><div class="sidebar-label">CONTENTS</div><nav class="page-tree" aria-label="Study pages">${tree(data.root_id)}</nav><footer class="sidebar-footer"><span class="offline-dot ${data.issues.length ? 'incomplete' : ''}"></span><div><strong>Offline · Read-only</strong><span>${data.counts.pages} pages · ${data.counts.databases} database entries</span></div><button class="icon-button" data-open-about aria-label="About this copy">${icon('info')}</button></footer>`;
  }
  function valueMarkup(value, spec, cell = '') {
    if (spec?.type === 'checkbox') return `<input type="checkbox" disabled ${value ? 'checked' : ''} aria-label="${value ? 'Checked' : 'Unchecked'}">`;
    if (['status', 'select', 'multi_select'].includes(spec?.type)) {
      const items = Array.isArray(value) ? value : value ? [value] : [];
      return items.map(item => {
        const color = spec.options.find(option => option.name === item)?.color || 'default';
        return `<span class="tag tag-${e(color)} ${spec.type === 'status' ? 'status-tag' : ''}">${spec.type === 'status' ? '<span class="status-dot"></span>' : ''}${e(item)}</span>`;
      }).join(' ');
    }
    return cell || e(textValue(value));
  }
  function documentMarkup(id, scope = 'main') {
    const node = nodes[id];
    if (data.databases[id]) {
      const count = new Set(children(id)).size;
      return `<div class="node-document" data-node-id="${id}"><div class="document-inner"><header class="page-header"><div class="page-symbol">${icon('table')}</div><h1>${e(node.title)}</h1><p class="database-description">${count} ${count === 1 ? 'entry' : 'entries'} · Read-only database</p></header><section class="database" data-db-id="${id}" aria-label="${e(node.title)}"></section></div></div>`;
    }
    const source = data.sources[node.source_id];
    const properties = source ? Object.entries(source.schema).filter(([, spec]) => spec.type !== 'title').map(([key, spec]) => `<div class="property-entry"><span class="property-name">${propertyIcon(spec)}${e(key)}</span><div class="property-value ${/path/i.test(key) ? 'path-value' : ''}">${valueMarkup(node.properties[key], spec, node.property_cells[key]) || '<span class="muted">Empty</span>'}</div></div>`).join('') : '';
    return `<div class="node-document" data-node-id="${id}">${node.cover ? `<div class="page-cover"><img class="study-image" src="${node.cover}" alt="Page cover"></div>` : ''}<div class="document-inner"><header class="page-header ${node.cover ? 'with-cover' : ''}">${node.icon ? `<div class="page-symbol">${e(node.icon)}</div>` : ''}<h1>${e(node.title)}</h1>${properties ? `<div class="page-properties" aria-label="Page properties">${properties}</div>` : ''}</header><article class="notion-content" data-document-id="${id}">${node.html || '<p class="empty-page">This page has no content yet.</p>'}</article></div></div>`;
  }
  function stateFor(dbId, scope) {
    const database = data.databases[dbId], selectionKey = `${scope}|${dbId}`;
    const viewId = selectedViews.get(selectionKey) || database.views[0];
    const key = `${selectionKey}|${viewId}`;
    if (!tableStates.has(key)) tableStates.set(key, {query: '', filters: [], sort: null, hidden: new Set(), filterOpen: false, sortOpen: false, propertiesOpen: false});
    return {database, view: data.views[viewId], viewId, state: tableStates.get(key), key, selectionKey};
  }
  function isEmpty(value) {return value === '' || value == null || Array.isArray(value) && value.length === 0;}
  function matchesFilter(value, condition) {
    if (condition.operator === 'empty') return isEmpty(value);
    if (condition.operator === 'not_empty') return !isEmpty(value);
    if (condition.value === '') return true;
    const values = (Array.isArray(value) ? value : [value]).map(value => String(value ?? '').toLocaleLowerCase());
    const wanted = condition.value.toLocaleLowerCase();
    if (condition.operator === 'is') return values.includes(wanted);
    if (condition.operator === 'is_not') return !values.includes(wanted);
    if (condition.operator === 'not_contains') return !values.some(value => value.includes(wanted));
    return values.some(value => value.includes(wanted));
  }
  function filteredRows(source, view, state) {
    const byId = new Map(source.rows.map(row => [row.id, row]));
    let rows = view.row_ids.map(id => byId.get(id)).filter(Boolean);
    const query = state.query.trim().toLocaleLowerCase();
    if (query) rows = rows.filter(row => Object.values(row.values).some(value => textValue(value).toLocaleLowerCase().includes(query)));
    rows = rows.filter(row => state.filters.every(filter => matchesFilter(row.values[filter.property], filter)));
    if (state.sort) rows.sort((a, b) => {
      const av = a.values[state.sort.property], bv = b.values[state.sort.property];
      if (isEmpty(av) !== isEmpty(bv)) return isEmpty(av) ? 1 : -1;
      const comparison = typeof av === 'boolean' ? Number(av) - Number(bv) : collator.compare(textValue(av), textValue(bv));
      return comparison * (state.sort.direction === 'desc' ? -1 : 1);
    });
    return rows;
  }
  function filterMarkup(filter, index, schema) {
    const spec = schema[filter.property];
    const options = ['status', 'select', 'multi_select', 'checkbox'].includes(spec.type);
    const operators = options ? [['is', 'is'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']] : [['contains', 'contains'], ['not_contains', 'does not contain'], ['is', 'is'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']];
    const values = spec.type === 'checkbox' ? [{name: 'true', label: 'Checked'}, {name: 'false', label: 'Unchecked'}] : spec.options || [];
    return `<div class="filter-condition"><span class="condition-word">${index ? 'And' : 'Where'}</span><select aria-label="Filter property ${index + 1}" data-filter-property="${index}">${Object.keys(schema).map(key => `<option value="${e(key)}" ${key === filter.property ? 'selected' : ''}>${e(key)}</option>`).join('')}</select><select aria-label="Filter operator ${index + 1}" data-filter-operator="${index}">${operators.map(([value, label]) => `<option value="${value}" ${value === filter.operator ? 'selected' : ''}>${label}</option>`).join('')}</select>${['empty', 'not_empty'].includes(filter.operator) ? '' : options ? `<select aria-label="Filter value ${index + 1}" data-filter-value="${index}"><option value="">Choose a value…</option>${values.map(value => `<option value="${e(value.name)}" ${value.name === filter.value ? 'selected' : ''}>${e(value.label || value.name)}</option>`).join('')}</select>` : `<input type="text" aria-label="Filter value ${index + 1}" data-filter-value="${index}" data-focus-key="filter-${index}" placeholder="Enter a value…" value="${e(filter.value)}">`}<button class="icon-button" data-remove-filter="${index}" aria-label="Remove filter ${index + 1}">${icon('close')}</button></div>`;
  }
  function renderDatabase(container) {
    const dbId = container.dataset.dbId, scope = container.dataset.scope || 'main';
    const {database, view, viewId, state} = stateFor(dbId, scope), source = data.sources[view?.source_id];
    if (!view || !source) {container.innerHTML = '<p class="unavailable">This database was not available when the copy was made.</p>'; return;}
    const focus = container.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focus?.dataset.focusKey, selection = focus?.selectionStart;
    const columns = [...(view.displayProperties || Object.keys(source.schema))].filter(key => source.schema[key]);
    const title = Object.keys(source.schema).find(key => source.schema[key].type === 'title');
    if (title && !columns.includes(title)) columns.unshift(title);
    const shown = columns.filter(key => !state.hidden.has(key) || key === title);
    const rows = filteredRows(source, view, state);
    const changed = state.query || state.filters.length || state.sort || state.hidden.size;
    container.innerHTML = `<div class="database-title"><a href="#${dbId}" title="Open database">${icon('table')}<strong>${e(database.title)}</strong></a><span class="database-count">${source.rows.length}</span></div><div class="database-toolbar"><div class="database-views" role="tablist" aria-label="Database views">${database.views.map(id => `<button type="button" role="tab" aria-selected="${id === viewId}" data-select-view="${id}" class="view-tab ${id === viewId ? 'selected' : ''}">${icon('table')}${e(data.views[id]?.name || 'Table')}</button>`).join('')}</div><div class="table-actions"><button type="button" data-table-action="filter" class="${state.filters.length ? 'has-value' : ''}" aria-expanded="${state.filterOpen}">${icon('filter')}<span>Filter${state.filters.length ? ` · ${state.filters.length}` : ''}</span></button><button type="button" data-table-action="sort" class="${state.sort ? 'has-value' : ''}" aria-expanded="${state.sortOpen}">${icon('sort')}<span>Sort</span></button><details class="properties-menu" ${state.propertiesOpen ? 'open' : ''}><summary>${icon('properties')}<span>Properties</span></summary><div class="properties-list"><strong>Show properties</strong>${columns.map(key => `<label><input type="checkbox" data-toggle-column="${e(key)}" aria-label="Show ${e(key)}" ${!state.hidden.has(key) || key === title ? 'checked' : ''} ${key === title ? 'disabled' : ''}>${propertyIcon(source.schema[key])}${e(key)}</label>`).join('')}</div></details><label class="table-search">${icon('search')}<input type="search" data-table-query data-focus-key="table-search" aria-label="Search ${e(database.title)}" placeholder="Search…" value="${e(state.query)}"></label><button type="button" data-table-action="reset" class="reset-table ${changed ? '' : 'invisible'}">Reset</button></div></div>${state.filterOpen ? `<div class="filter-panel">${state.filters.length ? state.filters.map((filter, index) => filterMarkup(filter, index, source.schema)).join('') : '<p class="muted">Narrow down the entries in this view.</p>'}<button type="button" class="add-filter" data-table-action="add-filter">+ Add filter</button>${state.filters.length ? '<button type="button" data-table-action="clear-filters">Clear filters</button>' : ''}</div>` : ''}${state.sortOpen ? `<div class="sort-panel"><span>Sort by</span><select aria-label="Sort property" data-sort-property><option value="">Original order</option>${columns.map(key => `<option value="${e(key)}" ${key === state.sort?.property ? 'selected' : ''}>${e(key)}</option>`).join('')}</select><select aria-label="Sort direction" data-sort-direction><option value="asc" ${state.sort?.direction !== 'desc' ? 'selected' : ''}>Ascending</option><option value="desc" ${state.sort?.direction === 'desc' ? 'selected' : ''}>Descending</option></select></div>` : ''}<div class="table-scroll"><table class="data-table"><thead><tr>${shown.map(key => `<th scope="col" class="${key === title ? 'title-column' : ''}" aria-sort="${state.sort?.property === key ? state.sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}"><button type="button" data-sort-column="${e(key)}" title="Sort by ${e(key)}">${propertyIcon(source.schema[key])}<span>${e(key)}</span>${state.sort?.property === key ? `<span class="sort-arrow">${state.sort.direction === 'asc' ? '↑' : '↓'}</span>` : ''}</button></th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr data-row-id="${row.id}">${shown.map(key => `<td class="${key === title ? 'title-cell' : ''} ${/path/i.test(key) ? 'path-cell' : ''}">${key === title ? `<a class="row-title" href="#${row.id}" data-preview="${row.id}">${nodeIcon(row.id)}<span>${e(textValue(row.values[key]))}</span><span class="open-hint">OPEN</span></a>` : valueMarkup(row.values[key], source.schema[key], row.cells[key])}</td>`).join('')}</tr>`).join('') || `<tr class="empty-table"><td colspan="${shown.length || 1}">${source.rows.length ? 'No entries match these filters.' : 'No entries yet.'}</td></tr>`}</tbody></table></div><div class="table-footer"><span class="row-count" aria-live="polite">${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}${rows.length !== view.row_ids.length ? ` of ${view.row_ids.length}` : ''}</span><span>Read-only</span></div>`;
    if (focusKey) {
      const next = [...container.querySelectorAll('[data-focus-key]')].find(input => input.dataset.focusKey === focusKey);
      if (next) {next.focus({preventScroll: true}); if (selection != null) next.setSelectionRange(selection, selection);}
    }
  }
  function hydrate(root, scope) {
    root.querySelectorAll('.callout-icon').forEach(element => {
      const emoji = element.textContent, name = {'⭐': 'star', '💡': 'bulb', '👉': 'pointer'}[emoji];
      if (name) {element.setAttribute('role', 'img'); element.setAttribute('aria-label', emoji); element.innerHTML = icon(name);}
    });
    root.querySelectorAll('[data-db-id]').forEach(container => {container.dataset.scope = scope; renderDatabase(container);});
    const article = root.querySelector('article');
    if (!article) return;
    const headings = [...article.querySelectorAll('[data-heading]')];
    const outline = headings.filter(heading => /^H[1-3]$/.test(heading.tagName)).map(heading => `<button type="button" data-scroll-heading="${heading.dataset.heading}" style="--level:${Number(heading.tagName.slice(1))}">${e(heading.textContent)}</button>`).join('');
    root.querySelectorAll('.inline-outline').forEach(nav => nav.innerHTML = outline);
    if (scope === 'main' && headings.length > 1) {
      const nav = document.createElement('nav');
      nav.className = 'page-outline'; nav.setAttribute('aria-label', 'On this page');
      nav.innerHTML = '<span>ON THIS PAGE</span>' + outline;
      root.querySelector('.node-document').append(nav);
    }
  }
  function closePreview() {
    preview.hidden = true; preview.innerHTML = ''; previewId = null; document.body.classList.remove('preview-open');
    if (previousPreviewFocus?.isConnected) previousPreviewFocus.focus({preventScroll: true});
    previousPreviewFocus = null;
  }
  function renderRoute() {
    const id = location.hash.slice(1);
    currentId = nodes[id] ? id : data.root_id;
    ancestors(currentId).forEach(id => expanded.add(id));
    closePreview();
    document.body.classList.remove('sidebar-open');
    renderSidebar();
    document.getElementById('topbar').innerHTML = `<button class="icon-button sidebar-toggle" data-toggle-sidebar aria-label="Toggle navigation">${icon('menu')}</button><nav class="breadcrumbs" aria-label="Breadcrumb">${ancestors(currentId).map((id, index) => `${index ? '<span class="crumb-separator">/</span>' : ''}<a href="#${id}" ${id === currentId ? 'aria-current="page"' : ''}>${nodeIcon(id)}<span>${e(nodes[id].title)}</span></a>`).join('')}</nav><div class="topbar-actions"><span class="readonly-label"><span class="offline-dot"></span>Offline copy</span><button class="icon-button" data-open-about aria-label="About this copy">${icon('info')}</button></div>`;
    main.innerHTML = documentMarkup(currentId);
    hydrate(main, 'main');
    document.title = `${nodes[currentId].title} · Offline`;
    window.scrollTo(0, 0);
  }
  function openPreview(id) {
    if (!data.pages[id]) return;
    previousPreviewFocus = document.activeElement;
    previewId = id; preview.hidden = false; document.body.classList.add('preview-open');
    preview.innerHTML = `<header class="preview-bar"><button class="icon-button" data-close-preview aria-label="Close preview">${icon('close')}</button><span>Page preview</span><a href="#${id}" class="full-page-link">${icon('expand')}Open full page</a></header><div class="preview-body">${documentMarkup(id, 'preview')}</div>`;
    hydrate(preview, 'preview');
    preview.querySelector('[data-close-preview]').focus({preventScroll: true});
  }
  function highlight(text, query) {
    const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    return index === -1 || !query ? e(text) : e(text.slice(0, index)) + '<mark>' + e(text.slice(index, index + query.length)) + '</mark>' + e(text.slice(index + query.length));
  }
  function renderSearch() {
    const query = searchInput.value.trim();
    const candidates = Object.values(nodes).filter(node => !query || (data.pages[node.id]?.search_text || node.title).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    candidates.sort((a, b) => Number(b.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) - Number(a.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
    document.getElementById('search-results').innerHTML = candidates.length ? candidates.map(node => {
      const text = data.pages[node.id]?.search_text.replace(/\s+/g, ' ') || node.title;
      const position = Math.max(0, text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 45);
      const snippet = text.slice(position, position + 170);
      return `<a class="search-result" href="#${node.id}">${nodeIcon(node.id)}<div><strong>${highlight(node.title, query)}</strong><span>${position ? '…' : ''}${highlight(snippet, query)}${position + 170 < text.length ? '…' : ''}</span><small>${e(ancestors(node.id).slice(0, -1).map(id => nodes[id].title).join(' / '))}</small></div>${icon('chevron')}</a>`;
    }).join('') : '<p class="search-empty">No matching pages.</p>';
  }
  function openSearch() {imageDialog.close(); aboutDialog.close(); searchDialog.showModal(); renderSearch(); searchInput.focus(); searchInput.select();}
  function openAbout() {
    const c = data.counts;
    aboutDialog.innerHTML = `<header><h2 id="about-title">About this copy</h2><button class="icon-button" data-close-dialog aria-label="Close about">${icon('close')}</button></header><p class="about-title">${e(nodes[data.root_id].title)}</p><p>This read-only copy works offline. It reflects the content available when it was captured.</p><dl class="about-stats"><div><dt>Captured</dt><dd>${e(dateText(data.captured_at))}</dd></div><div><dt>Pages</dt><dd>${c.pages}</dd></div><div><dt>Databases</dt><dd>${c.data_sources} data sources · ${c.views} saved views</dd></div><div><dt>Records</dt><dd>${c.records}</dd></div><div><dt>Record scope</dt><dd>${data.record_scope === 'saved_views' ? 'Entries shown in the captured saved views' : 'Captured data source records'}</dd></div><div><dt>Embedded media</dt><dd>${c.embedded_assets} of ${c.expected_assets}</dd></div></dl>${data.issues.length ? `<div class="copy-status incomplete"><strong>Some content is missing</strong><ul>${data.issues.map(issue => `<li>${nodes[issue.entity] ? `<a href="#${issue.entity}">${e(nodes[issue.entity].title)}</a>: ` : ''}${e(issue.message)}</li>`).join('')}</ul></div>` : '<div class="copy-status"><span class="offline-dot"></span>All captured pages, records and media are included.</div>'}<p class="muted">Files referenced only by text paths remain separate from this document.</p><a class="source-link" href="${e(data.pages[data.root_id].url)}" target="_blank" rel="noopener noreferrer">${icon('link')}Open original in Notion <span>(internet required)</span></a>`;
    aboutDialog.showModal();
  }
  function fitImage() {
    const image = document.getElementById('large-image');
    image.style.width = zoom === 1 ? '' : `${image.naturalWidth * zoom}px`;
    image.classList.toggle('zoomed', zoom !== 1);
  }
  function openImage(image) {
    const large = document.getElementById('large-image');
    large.src = image.src; large.alt = image.alt;
    document.getElementById('image-caption').textContent = image.alt || 'Study figure';
    zoom = 1; fitImage(); imageDialog.showModal();
  }
  function containerFor(target) {return target.closest('[data-db-id]');}
  document.addEventListener('click', event => {
    const target = event.target.closest('button,a,summary,img,dialog');
    if (!target) return;
    if (target.matches('[data-open-search]')) return openSearch();
    if (target.matches('[data-open-about]')) return openAbout();
    if (target.matches('[data-toggle-sidebar]')) return document.body.classList.toggle('sidebar-open');
    if (target.matches('[data-toggle-tree]')) {const id = target.dataset.toggleTree; expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderSidebar(); return;}
    if (target.matches('[data-close-dialog]')) return target.closest('dialog').close();
    if (target.matches('[data-close-preview]')) return closePreview();
    if (target.matches('[data-preview]') && !event.ctrlKey && !event.metaKey) {event.preventDefault(); openPreview(target.dataset.preview); return;}
    if (target.matches('.study-image')) return openImage(target);
    if (target.matches('[data-zoom]')) {const direction = Number(target.dataset.zoom); zoom = direction ? Math.max(.25, Math.min(4, zoom + direction * .25)) : 1; fitImage(); return;}
    if (target.matches('[data-scroll-heading]')) {
      const root = target.closest('#preview') || main;
      root.querySelector(`[data-heading="${target.dataset.scrollHeading}"]`)?.scrollIntoView({behavior: 'smooth', block: 'start'}); return;
    }
    if (target.matches('.skip-link')) {event.preventDefault(); main.focus(); return;}
    const container = containerFor(target);
    if (container && (target.dataset.tableAction || target.dataset.sortColumn || target.dataset.selectView)) {
      const {state, selectionKey} = stateFor(container.dataset.dbId, container.dataset.scope);
      if (target.dataset.selectView) selectedViews.set(selectionKey, target.dataset.selectView);
      if (target.dataset.sortColumn) {const property = target.dataset.sortColumn; state.sort = state.sort?.property === property ? state.sort.direction === 'asc' ? {property, direction: 'desc'} : null : {property, direction: 'asc'};}
      switch (target.dataset.tableAction) {
        case 'filter': state.filterOpen = !state.filterOpen; break;
        case 'sort': state.sortOpen = !state.sortOpen; break;
        case 'add-filter': {const source = data.sources[stateFor(container.dataset.dbId, container.dataset.scope).view.source_id]; const property = Object.keys(source.schema).find(key => source.schema[key].type === 'status') || Object.keys(source.schema)[0]; state.filters.push({property, operator: 'is', value: ''}); break;}
        case 'clear-filters': state.filters = []; break;
        case 'reset': state.query = ''; state.filters = []; state.sort = null; state.hidden = new Set(); state.filterOpen = false; state.sortOpen = false; state.propertiesOpen = false; break;
      }
      renderDatabase(container); return;
    }
    if (container && target.dataset.removeFilter != null) {const {state} = stateFor(container.dataset.dbId, container.dataset.scope); state.filters.splice(Number(target.dataset.removeFilter), 1); renderDatabase(container); return;}
    if (target.matches('a[href^="#"]')) {
      searchDialog.close(); aboutDialog.close();
      if (target.getAttribute('href') === location.hash || target.getAttribute('href') === '#' + currentId && !location.hash) {closePreview(); window.scrollTo(0, 0);}
    }
    if (target.tagName === 'DIALOG' && event.target === target) {
      const rect = target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) target.close();
    }
  });
  function changeTable(target, inputEvent = false) {
    const container = containerFor(target); if (!container) return;
    const {state} = stateFor(container.dataset.dbId, container.dataset.scope);
    if (target.hasAttribute('data-table-query')) state.query = target.value;
    else if (target.dataset.filterValue != null) state.filters[Number(target.dataset.filterValue)].value = target.value;
    else if (inputEvent) return;
    else if (target.dataset.filterProperty != null) {
      const filter = state.filters[Number(target.dataset.filterProperty)]; filter.property = target.value; filter.value = '';
      const source = data.sources[stateFor(container.dataset.dbId, container.dataset.scope).view.source_id];
      filter.operator = ['status', 'select', 'multi_select', 'checkbox'].includes(source.schema[target.value].type) ? 'is' : 'contains';
    } else if (target.dataset.filterOperator != null) state.filters[Number(target.dataset.filterOperator)].operator = target.value;
    else if (target.dataset.toggleColumn) {target.checked ? state.hidden.delete(target.dataset.toggleColumn) : state.hidden.add(target.dataset.toggleColumn); state.propertiesOpen = true;}
    else if (target.hasAttribute('data-sort-property')) state.sort = target.value ? {property: target.value, direction: state.sort?.direction || 'asc'} : null;
    else if (target.hasAttribute('data-sort-direction')) {if (state.sort) state.sort.direction = target.value;}
    else return;
    renderDatabase(container);
  }
  document.addEventListener('input', event => {if (event.target === searchInput) renderSearch(); else if (event.target.tagName === 'INPUT') changeTable(event.target, true);});
  document.addEventListener('change', event => changeTable(event.target));
  document.addEventListener('toggle', event => {
    if (event.target.matches?.('.properties-menu')) {const container = containerFor(event.target); if (container) stateFor(container.dataset.dbId, container.dataset.scope).state.propertiesOpen = event.target.open;}
  }, true);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' || event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {event.preventDefault(); if (!searchDialog.open) openSearch();}
    if (event.key === 'Escape') {
      // Search inputs consume Escape to clear text in some browsers.
      event.preventDefault();
      if (searchDialog.open) searchDialog.close();
      else if (imageDialog.open) imageDialog.close();
      else if (aboutDialog.open) aboutDialog.close();
      else {closePreview(); document.body.classList.remove('sidebar-open');}
    }
    if (event.target === searchInput && event.key === 'Enter') {const first = document.querySelector('.search-result'); if (first) first.click();}
  });
  window.addEventListener('hashchange', renderRoute);
  renderRoute();
})();
