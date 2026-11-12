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
  const pages = targets.filter(t => t.type === 'page' && t.url.includes('pipiwangcom.com'));
  if (!pages.length) throw new Error('no page');

  let cookies = [];
  const byOrigin = new Map();
  for (const p of pages) {
    try {
      const { open, send, ws } = cdpClient(p.webSocketDebuggerUrl);
      await open;
      if (!cookies.length) {
        await send('Network.enable').catch(() => { });
        const r = await send('Network.getAllCookies');
        cookies = r.cookies || [];
      }
      const lr = await send('Runtime.evaluate', {
        expression: `JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])))`,
        returnByValue: true,
      });
      ws.close();
      const origin = new URL(p.url).origin;
      const obj = JSON.parse(lr.result?.value || '{}');
      byOrigin.set(origin, [{ origin, localStorage: Object.entries(obj).map(([name, value]) => ({ name, value })) }][0]);
      console.log('origin', origin, 'items', Object.keys(obj).length);
    } catch (e) {
      console.log('origin skip', String(e.message).slice(0, 50));
    }
  }

  const ALLOW = (process.env.FISH_COOKIE_DOMAINS || 'pipiwangcom.com,linux.do')
    .split(',').map(s => s.trim()).filter(Boolean);
  const keep = cookies.filter(c => ALLOW.some(d => c.domain === d || c.domain.endsWith('.' + d.replace(/^\./, '')) || c.domain.replace(/^\./, '').endsWith(d)));

  const state = { cookies: keep.map(toPW), origins: [...byOrigin.values()] };

  let keyB64 = process.env.FISH_BOT_KEY;
  if (!keyB64) { keyB64 = genKey(); console.log(keyB64); }

  const enc = encrypt(JSON.stringify({ ...state, ok: true }), loadKey(keyB64));

  const outDir = path.resolve('out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'state.enc'), enc);

  console.log('ok', state.cookies.length, state.origins.map(o => o.localStorage.length).join('/'), enc.length);
}

main().catch(e => { console.error('failed', e.message); process.exit(1); });
