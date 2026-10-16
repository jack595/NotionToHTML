import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {auth, UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';
import {setTimeout as sleep} from 'node:timers/promises';
import {NotionOAuthProvider} from './auth.mjs';
import {safeMessage} from './network.mjs';

export const NOTION_MCP_URL = 'https://mcp.notion.com/mcp';
const aliases = {
  fetch: ['notion-fetch', 'fetch', 'notion_fetch'],
  query: ['notion-query-data-sources', 'query-data-sources', 'query_data_sources'],
  files: ['notion-get-file-download-urls', 'get-file-download-urls', 'get_file_download_urls'],
};

export function decodeToolResult(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
  if (!text) throw new Error('Notion returned an empty response.');
  try {return JSON.parse(text);} catch {return {text};}
}

function toolError(result) {
  const data = decodeToolResult(result), detail = data.error || data;
  const error = new Error(detail.message || data.message || data.text || 'Notion could not complete this read request.');
  error.code = detail.code || detail.error_code || data.error_code;
  error.status = detail.status || data.status;
  error.retryAfter = detail.retry_after_seconds ?? data.retry_after_seconds;
  if (error.code === 'object_not_found' || error.status === 403 || error.status === 404) error.message = 'Notion could not read this content. Check the page link and the selected account/workspace permissions.';
  return error;
}

export class NotionReadClient {
  constructor({provider, fetchFn, serverUrl = NOTION_MCP_URL, signal, wait = sleep}) {
    Object.assign(this, {provider, fetchFn, serverUrl, signal, wait});
    this.queue = Promise.resolve(); this.tools = new Map();
  }
  async request(callback) {
    if (!this.signal) return callback(undefined);
    if (this.signal.aborted) throw this.signal.reason;
    // The SDK retains a listener on each request signal. Give it a short-lived
    // signal and remove our parent listener when the request settles.
    const controller = new AbortController();
    const abort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', abort, {once: true});
    try {return await callback(controller.signal);}
    finally {this.signal.removeEventListener('abort', abort);}
  }
  async open() {
    await this.provider.initialize();
    if (this.provider.credentials.expires_at && this.provider.credentials.expires_at <= Date.now() + 60000) {
      const status = await auth(this.provider, {serverUrl: this.serverUrl, fetchFn: this.fetchFn});
      if (status === 'REDIRECT') await auth(this.provider, {serverUrl: this.serverUrl, fetchFn: this.fetchFn, authorizationCode: await this.provider.waitForCode()});
    }
    await this.connect();
    let cursor;
    const cursors = new Set();
    do {
      const result = await this.request(signal => this.client.listTools(cursor ? {cursor} : {}, {signal, timeout: 60000}));
      for (const tool of result.tools) this.tools.set(tool.name, tool);
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Notion tool discovery did not advance.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.operations = Object.fromEntries(Object.entries(aliases).map(([key, values]) => [key, values.find(name => this.tools.has(name))]));
    if (!this.operations.fetch || !this.operations.query) throw new Error('This Notion connection does not expose the page and saved-view read tools required by the exporter.');
    await this.provider.close();
    return this;
  }
  async connect() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = new Client({name: 'notion-offline-exporter', version: '1.0.0'}, {capabilities: {}});
      const transport = new StreamableHTTPClientTransport(new URL(this.serverUrl), {authProvider: this.provider, fetch: this.fetchFn});
      try {await this.request(signal => client.connect(transport, {signal, timeout: 60000})); this.client = client; this.transport = transport; return;}
      catch (error) {
        try {
          if (!(error instanceof UnauthorizedError) || attempt) throw error;
          await transport.finishAuth(await this.provider.waitForCode());
        } finally {await client.close().catch(() => {});}
      }
    }
  }
  invoke(operation, args) {
    // Serialize tool calls as well as processes, so simultaneous 401s cannot
    // race refresh-token rotation. Media downloads remain concurrent.
    const request = this.queue.then(async () => {
      const name = this.operations[operation];
      if (!name) throw new Error(`Notion does not expose the ${operation} read operation.`);
      for (let attempt = 0; ; attempt++) {
        if (this.signal?.aborted) throw this.signal.reason;
        try {
          const result = await this.request(signal => this.client.callTool({name, arguments: args}, undefined, {signal, timeout: 90000}));
          if (result.isError || result.structuredContent?.error) throw toolError(result);
          return result;
        } catch (error) {
          if (error instanceof UnauthorizedError && !attempt) {
            await this.transport.finishAuth(await this.provider.waitForCode());
            await this.provider.close();
            continue;
          }
          const retryable = error.code === 'rate_limited' || [429, 500, 502, 503, 504].includes(error.status);
          if (!retryable || attempt >= 2) throw new Error(safeMessage(error, this.provider.secrets()), {cause: error});
          const delay = error.retryAfter != null ? Number(error.retryAfter) * 1000 : 500 * 2 ** attempt;
          if (delay > 60000) throw new Error('Notion is rate-limited. Retry the export later.');
          await this.wait(Math.max(0, delay), undefined, {signal: this.signal});
        }
      }
    });
    this.queue = request.catch(() => {});
    return request;
  }
  fetchEntity(args) {
    const properties = this.tools.get(this.operations.fetch)?.inputSchema?.properties;
    const filtered = properties ? Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(properties, key))) : args;
    return this.invoke('fetch', filtered);
  }
  queryDataSource({data}) {
    const properties = this.tools.get(this.operations.query)?.inputSchema?.properties;
    return this.invoke('query', properties?.data ? {data} : data);
  }
  async resolveFiles(references) {
    if (!this.operations.files) return {};
    const urls = {};
    for (let start = 0; start < references.length; start += 25) {
      const result = decodeToolResult(await this.invoke('files', {references: references.slice(start, start + 25)}));
      for (const file of result.files || []) if (file.reference && file.url) urls[file.reference] = file.url;
    }
    return urls;
  }
  async close() {await this.client?.close().catch(() => {}); await this.provider.close();}
}

export async function connectNotion({store, fetchFn, signal, launchBrowser, log, forceLogin = false, ...options}) {
  const provider = new NotionOAuthProvider(store, {launchBrowser, log, signal});
  const connection = new NotionReadClient({provider, fetchFn, signal, ...options});
  try {
    if (forceLogin) {await provider.initialize(); await provider.invalidateCredentials('tokens');}
    return await connection.open();
  } catch (error) {await connection.close(); throw new Error(safeMessage(error, provider.secrets()), {cause: error});}
}
