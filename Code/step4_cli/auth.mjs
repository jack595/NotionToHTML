import {readFile, writeFile, mkdir, rename, unlink, chmod, open as openFile} from 'node:fs/promises';
import {join, isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import openBrowser from 'open';

export function configDirectory(env = process.env) {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'notion-offline-exporter');
}

export class CredentialStore {
  constructor(directory = configDirectory()) {this.directory = directory; this.filename = join(directory, 'credentials.json');}
  async initialize() {await mkdir(this.directory, {recursive: true, mode: 0o700}); await chmod(this.directory, 0o700);}
  async read() {
    try {return JSON.parse(await readFile(this.filename, 'utf8'));}
    catch (error) {if (error.code === 'ENOENT') return {}; throw new Error('The saved Notion login is unreadable. Run --logout and --login to reconnect.');}
  }
  async write(value) {
    await this.initialize();
    const temporary = this.filename + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {await writeFile(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'}); await rename(temporary, this.filename);}
    finally {await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
  }
  async clear() {await unlink(this.filename).catch(error => {if (error.code !== 'ENOENT') throw error;});}
  async lock() {
    await this.initialize();
    const filename = join(this.directory, 'account.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await openFile(filename, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({pid: process.pid, created_at: new Date().toISOString()})); await handle.close();
        return async () => {await unlink(filename).catch(error => {if (error.code !== 'ENOENT') throw error;});};
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try {owner = JSON.parse(await readFile(filename, 'utf8'));} catch {}
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try {process.kill(owner.pid, 0);} catch (error) {
            if (error.code === 'ESRCH') {await unlink(filename).catch(() => {}); continue;}
          }
        }
        throw new Error('Another Notion exporter is using this account. Wait for it to finish before starting another export.');
      }
    }
    throw new Error('Could not acquire the local Notion account lock.');
  }
}

/** OAuth state is per process; durable registration/tokens are per local user. */
export class NotionOAuthProvider {
  constructor(store, {launchBrowser = openBrowser, log = message => console.error(message), timeoutMs = 10 * 60 * 1000, signal} = {}) {
    this.store = store; this.launchBrowser = launchBrowser; this.log = log; this.timeoutMs = timeoutMs; this.signal = signal;
    this.credentials = {}; this.oauthState = randomBytes(32).toString('hex'); this.verifier = null;
  }
  async initialize() {
    this.credentials = await this.store.read();
    // A registration's callback address must remain stable when reconnecting.
    if (!this.credentials.redirect_uri) await this.ensureListener();
  }
  get redirectUrl() {return this.credentials.redirect_uri;}
  get clientMetadata() {return {client_name: 'Notion Offline Exporter', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'};}
  state() {this.oauthState = randomBytes(32).toString('hex'); return this.oauthState;}
  clientInformation() {return this.credentials.client_information;}
  async saveClientInformation(value) {this.credentials.client_information = value; await this.store.write(this.credentials);}
  tokens() {return this.credentials.tokens;}
  async saveTokens(value) {
    this.credentials.tokens = value;
    this.credentials.expires_at = value.expires_in ? Date.now() + value.expires_in * 1000 : null;
    await this.store.write(this.credentials);
  }
  discoveryState() {return this.credentials.discovery;}
  async saveDiscoveryState(value) {this.credentials.discovery = value; await this.store.write(this.credentials);}
  saveCodeVerifier(value) {this.verifier = value;}
  codeVerifier() {if (!this.verifier) throw new Error('The sign-in session has expired. Run --login again.'); return this.verifier;}
  async invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'client') delete this.credentials.client_information;
    if (scope === 'all' || scope === 'tokens') {delete this.credentials.tokens; delete this.credentials.expires_at;}
    if (scope === 'all' || scope === 'discovery') delete this.credentials.discovery;
    if (scope === 'all' || scope === 'verifier') this.verifier = null;
    await this.store.write(this.credentials);
  }
  async ensureListener() {
    if (this.listener) return;
    if (this.signal?.aborted) throw this.signal.reason;
    const previous = this.credentials.redirect_uri ? new URL(this.credentials.redirect_uri) : null;
    if (previous && (previous.hostname !== '127.0.0.1' || previous.protocol !== 'http:' || previous.pathname !== '/callback')) throw new Error('Invalid saved callback address. Run --logout and --login.');
    this.codePromise = new Promise((resolve, reject) => {this.resolveCode = resolve; this.rejectCode = reject;});
    this.codePromise.catch(() => {});
    this.listener = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== '/callback') {response.writeHead(404).end('Not found.'); return;}
      const state = url.searchParams.get('state') || '', expected = this.oauthState;
      if (Buffer.byteLength(state) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {response.writeHead(400).end('Invalid sign-in state. Return to the original authorization tab.'); return;}
      if (url.searchParams.has('error')) {response.writeHead(400).end('Sign-in was cancelled. Return to the terminal.'); this.rejectCode(new Error('Notion sign-in was cancelled. Run --login to try again.')); return;}
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.getAll('code').length !== 1) {response.writeHead(400).end('Missing authorization code.'); return;}
      response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Notion Offline Exporter</title><body style="font:18px system-ui;margin:60px"><h1>Authorization received</h1><p>Return to the terminal to finish connecting. You may close this tab.</p></body></html>');
      this.resolveCode(code);
    });
    try {
      this.listener.listen({host: '127.0.0.1', port: previous ? Number(previous.port) : 0});
      await once(this.listener, 'listening');
    } catch (error) {await this.close(); throw new Error(error.code === 'EADDRINUSE' ? 'The local Notion sign-in port is in use. Close the application using it and try again.' : 'Could not start the local Notion sign-in callback.');}
    this.credentials.redirect_uri = `http://127.0.0.1:${this.listener.address().port}/callback`;
    await this.store.write(this.credentials);
    this.abortListener = () => this.rejectCode(this.signal.reason);
    this.signal?.addEventListener('abort', this.abortListener, {once: true});
  }
  async redirectToAuthorization(url) {
    await this.ensureListener();
    this.log('Complete Notion authorization in your browser. If no tab opens, open this URL on this computer:');
    this.log(url.toString());
    this.timer = setTimeout(() => this.rejectCode(new Error('Notion sign-in timed out. Run --login to try again.')), this.timeoutMs);
    this.timer.unref();
    try {await this.launchBrowser(url.toString());} catch {this.log('Could not open a browser automatically. Use the authorization URL above.');}
  }
  async waitForCode() {return this.codePromise;}
  secrets() {return [this.credentials.tokens?.access_token, this.credentials.tokens?.refresh_token, this.credentials.client_information?.client_secret, this.verifier];}
  async close() {
    clearTimeout(this.timer);
    if (this.abortListener) this.signal?.removeEventListener('abort', this.abortListener);
    if (this.listener) {const server = this.listener; this.listener = null; await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});}
  }
}
