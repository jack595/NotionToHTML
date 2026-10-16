import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';

/** Exercises the real MCP SDK and OAuth transport against an isolated server. */
export async function mockNotion(fixture) {
  const state = {registrations: 0, logins: 0, refreshes: 0, rejectRefresh: false, usedRefresh: [], access: '', refresh: '', generation: 0};
  let origin;
  const send = (response, status, value, headers = {}) => {response.writeHead(status, {'content-type': 'application/json', ...headers}); response.end(value == null ? '' : JSON.stringify(value));};
  const tools = [
    {name: 'notion-fetch', description: 'Read a page', inputSchema: {type: 'object', properties: {id: {type: 'string'}, include_file_urls: {type: 'boolean'}}, required: ['id']}},
    {name: 'notion-query-data-sources', description: 'Read saved view', inputSchema: {type: 'object', properties: {data: {type: 'object'}}, required: ['data']}},
    {name: 'notion-get-file-download-urls', description: 'Resolve uploaded files', inputSchema: {type: 'object', properties: {references: {type: 'array', items: {type: 'string'}}}}},
  ];
  function tokens() {
    state.generation++;
    state.access = 'mock-access-' + state.generation;
    state.refresh = 'mock-refresh-' + state.generation;
    return {access_token: state.access, refresh_token: state.refresh, expires_in: 3600, token_type: 'Bearer'};
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      let body = '';
      for await (const chunk of request) body += chunk;
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return send(response, 200, {resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['read']});
      if (url.pathname === '/.well-known/oauth-authorization-server') return send(response, 200, {issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256']});
      if (url.pathname === '/register') {
        state.registrations++;
        state.registration = JSON.parse(body);
        return send(response, 201, {...state.registration, client_id: 'public-test-client'});
      }
      if (url.pathname === '/authorize') {
        state.logins++;
        state.challenge = url.searchParams.get('code_challenge');
        const target = new URL(url.searchParams.get('redirect_uri'));
        target.searchParams.set('state', url.searchParams.get('state'));
        target.searchParams.set('code', 'test-authorization-' + state.logins);
        return send(response, 302, null, {location: target.href});
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'refresh_token') {
          state.refreshes++;
          state.usedRefresh.push(form.get('refresh_token'));
          if (state.rejectRefresh || form.get('refresh_token') !== state.refresh) {state.rejectRefresh = false; return send(response, 400, {error: 'invalid_grant', error_description: 'Refresh token expired'});}
        } else {
          const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
          if (challenge !== state.challenge) return send(response, 400, {error: 'invalid_grant', error_description: 'Wrong PKCE verifier'});
          if (!state.registration.redirect_uris.includes(form.get('redirect_uri'))) throw new Error('Callback address changed');
        }
        return send(response, 200, tokens());
      }
      if (url.pathname !== '/mcp') return send(response, 404, {error: 'not_found'});
      if (request.headers.authorization !== 'Bearer ' + state.access || !state.access) return send(response, 401, {error: 'unauthorized'}, {'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`});
      if (request.method !== 'POST') return send(response, 405, null);
      const message = JSON.parse(body);
      if (message.id == null) return send(response, 202, null);
      let result;
      if (message.method === 'initialize') result = {protocolVersion: message.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'isolated-notion-fixture', version: '1.0.0'}};
      else if (message.method === 'tools/list') result = {tools};
      else if (message.method === 'tools/call') {
        const {name, arguments: args} = message.params;
        if (name === 'notion-fetch') result = await fixture.fetchEntity(args);
        else if (name === 'notion-query-data-sources') result = await fixture.queryDataSource(args);
        else result = {content: [{type: 'text', text: JSON.stringify({files: []})}]};
        // The production service may return JSON inside text instead of structuredContent.
        if (result.structuredContent) result = {content: [{type: 'text', text: JSON.stringify(result.structuredContent)}]};
      } else return send(response, 200, {jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Unknown method'}});
      return send(response, 200, {jsonrpc: '2.0', id: message.id, result});
    } catch (error) {send(response, 500, {error: error.message});}
  });
  server.listen({host: '127.0.0.1', port: 0});
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  return {state, origin, serverUrl: origin + '/mcp', close: () => new Promise(resolve => {server.close(resolve); server.closeAllConnections();})};
}
