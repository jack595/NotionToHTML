import {EnvHttpProxyAgent} from 'undici';
import {setTimeout as sleep} from 'node:timers/promises';

export function safeMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 5)) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/https?:\/\/[^\s"'<>]+/g, value => {
    try {const url = new URL(value); return url.origin + url.pathname;} catch {return '[URL]';}
  }).replace(/(access_token|refresh_token|client_secret|code_verifier)["'\s]*[:=]["'\s]*[^\s,}"']+/gi, '$1=[redacted]');
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function createNetworkFetch({signal, timeoutMs = 60000, fetchImpl = globalThis.fetch, useProxy = true, wait = sleep} = {}) {
  const dispatcher = useProxy ? new EnvHttpProxyAgent() : undefined;
  const fetchRequest = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    let retryable = method === 'GET' || method === 'HEAD';
    try {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      retryable ||= ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(body.method);
    } catch {}
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw signal.reason;
      const signals = [signal, init.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean);
      let response;
      try {response = await fetchImpl(url, {...init, ...(dispatcher ? {dispatcher} : {}), signal: AbortSignal.any(signals)});}
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (retryable && attempt < 2) {await wait(500 * 2 ** attempt, undefined, {signal}); continue;}
        const address = new URL(url);
        throw new Error(`Network request failed for ${address.origin}${address.pathname}: ${error.cause?.code || error.name}`, {cause: error});
      }
      // Never retry OAuth token POSTs: refresh tokens rotate on every use.
      if (!retryable || ![429, 502, 503, 504].includes(response.status) || attempt >= 2) return response;
      const delay = retryAfterMs(response.headers.get('retry-after')) ?? 500 * 2 ** attempt;
      if (delay > 60000) throw new Error(`Notion requested a ${Math.ceil(delay / 1000)} second pause. Retry the export later.`);
      await response.body?.cancel();
      await wait(delay, undefined, {signal});
    }
  };
  fetchRequest.close = () => dispatcher?.close();
  return fetchRequest;
}
