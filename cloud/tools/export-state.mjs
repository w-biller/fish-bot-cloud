import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadKey, encrypt, genKey } from '../lib/crypto.mjs';

const CDP = 'http://127.0.0.1:9222';

const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  };
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, open, send };
}

function toPW(c) {
  const sameSite = c.sameSite === 'Strict' ? 'Strict' : c.sameSite === 'None' ? 'None' : 'Lax';
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: c.session ? -1 : Math.floor(c.expires || -1),
    httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite,
  };
}

async function main() {
  const targets = await getJSON(`${CDP}/json`).catch(() => { throw new Error('no cdp'); });
  const page = targets.find(t => t.type === 'page' && t.url.includes('fish.pipiwangcom.com'));
  if (!page) throw new Error('no page');

  const { open, send, ws } = cdpClient(page.webSocketDebuggerUrl);
  await open;
  await send('Network.enable').catch(() => { });
  const { cookies } = await send('Network.getAllCookies');

  const ALLOW = (process.env.FISH_COOKIE_DOMAINS || 'pipiwangcom.com,linux.do')
    .split(',').map(s => s.trim()).filter(Boolean);
  const keep = cookies.filter(c => ALLOW.some(d => c.domain === d || c.domain.endsWith('.' + d.replace(/^\./, '')) || c.domain.replace(/^\./, '').endsWith(d)));

  const lr = await send('Runtime.evaluate', {
    expression: `JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])))`,
    returnByValue: true,
  });
  const lsObj = JSON.parse(lr.result?.value || '{}');
  const origin = new URL(page.url).origin;
  const state = {
    cookies: keep.map(toPW),
    origins: [{
      origin,
      localStorage: Object.entries(lsObj).map(([name, value]) => ({ name, value })),
    }],
  };
  ws.close();

  let keyB64 = process.env.FISH_BOT_KEY;
  if (!keyB64) { keyB64 = genKey(); console.log(keyB64); }

  const enc = encrypt(JSON.stringify(state), loadKey(keyB64));

  const outDir = path.resolve('out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'state.enc'), enc);

  console.log('ok', state.cookies.length, state.origins[0].localStorage.length, enc.length);
}

main().catch(e => { console.error('failed', e.message); process.exit(1); });
