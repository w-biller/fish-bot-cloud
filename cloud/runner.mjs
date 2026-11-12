import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { loadKey, encrypt, decrypt } from './lib/crypto.mjs';

const SITE = 'https://fish.pipiwangcom.com/';
const OUT_DIR = path.resolve('out');
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 240);
const WRAP_UP_BEFORE_MIN = 12;
const PAGE_LOG = process.env.PAGE_LOG === '1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error('missing env ' + name);
  return v;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const key = loadKey(must('FISH_BOT_KEY'));
  const botEnc = process.env.FISH_BOT_ENC || fs.readFileSync(path.resolve('assets', 'bot.enc'), 'utf8');
  const botSource = decrypt(botEnc.trim(), key);
  if (!botSource.includes('__fishBot')) throw new Error('payload check failed');
  log('payload ok', botSource.length);

  let stateBlob = '';
  let stateFrom = 'none';
  try {
    stateBlob = fs.readFileSync(path.resolve('out', 'state.enc'), 'utf8');
    stateFrom = 'cache';
  } catch {
    if (process.env.FISH_STATE_ENC) { stateBlob = process.env.FISH_STATE_ENC; stateFrom = 'seed'; }
  }
  let state = null;
  try {
    if (!stateBlob) throw new Error('no state');
    state = JSON.parse(decrypt(stateBlob.trim(), key));
    log('state ok (' + stateFrom + ') cookies ' + (state.cookies || []).length + ' origins ' + (state.origins || []).length);
  } catch (e) {
    log('state unusable', e.message);
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--mute-audio', '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: state || undefined,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
  });

  await context.route('**/*', route => {
    const type = route.request().resourceType();
    if (type === 'media' || type === 'font') return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  }).catch(() => {});

  if (PAGE_LOG) {
    page.on('console', msg => {
      const t = msg.text();
      log('page', t.replace(/%c/g, '').replace(/color:[^;]*;?/g, '').trim());
    });
  }
  page.on('pageerror', () => log('page error'));

  const apiStatus = async p => page.evaluate(async pathname => {
    try {
      const r = await fetch('/api/' + pathname, { credentials: 'same-origin', cache: 'no-store' });
      return r.status;
    } catch { return 0; }
  }, p).catch(() => 0);

  let cdp = await context.newCDPSession(page);
  const ensureCdp = async () => {
    try { await cdp.send('Runtime.enable'); } catch {
      try { cdp = await context.newCDPSession(page); await cdp.send('Runtime.enable'); } catch { }
    }
    return cdp;
  };

  const inject = async why => {
    try {
      const s = await ensureCdp();
      const has = await s.send('Runtime.evaluate', {
        expression: 'typeof window.__fishBot === "object" && !!window.__fishBot',
        returnByValue: true,
      });
      if (has?.result?.value) { log('inject(' + why + ') already'); return true; }
      await s.send('Runtime.evaluate', {
        expression: 'if(window.__fishBot){try{window.__fishBot.forceStop("reload")}catch(e){}delete window.__fishBot;}',
        returnByValue: true,
      });
      await sleep(800);
      const r = await s.send('Runtime.evaluate', {
        expression: botSource,
        returnByValue: false,
        awaitPromise: false,
        userGesture: true,
      });
      const err = r?.exceptionDetails;
      if (err) { log('inject(' + why + ') failed', String(err.text || '').slice(0, 120)); return false; }
      log('inject(' + why + ') ok');
      return true;
    } catch (e) {
      log('inject(' + why + ') error', String(e.message).slice(0, 120));
      return false;
    }
  };

  const ensureLogin = async why => {
    if (await apiStatus('fishing/current') === 200) return true;
    log('session lost (' + why + ')');
    await page.goto(SITE.replace(/\/$/, '') + '/auth/start', { waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      if (await apiStatus('fishing/current') === 200) { log('session restored'); return true; }
    }
    return false;
  };

  log('open');
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('goto failed', e.message));
  await sleep(6000);

  if (!(await ensureLogin('boot'))) {
    log('abort');
    await browser.close();
    process.exit(2);
  }

  await inject('boot');
  await sleep(5000);

  const deadline = Date.now() + MAX_MINUTES * 60000;
  const wrapUpMin = Math.max(1, Math.min(WRAP_UP_BEFORE_MIN, Math.floor(MAX_MINUTES / 3)));
  const wrapAt = deadline - wrapUpMin * 60000;
  let reloads = 0;
  let lastCasts = -1;
  let stallSince = 0;

  while (Date.now() < wrapAt) {
    await sleep(60000);

    const st = await page.evaluate(() => {
      const b = window.__fishBot;
      if (!b) return 'missing';
      return JSON.stringify({
        running: b.stats.running,
        stopType: b.stats.stopType || '',
        casts: b.stats.casts,
        caught: b.stats.caught,
        lost: b.stats.escaped,
        today: Number(localStorage.getItem('fwb_castsToday') || 0),
        rt: localStorage.getItem('fwb_runtimeToday'),
      });
    }).catch(() => 'fail');

    if (st === 'missing' || st === 'fail') {
      log('hb', st);
      const ok = await inject('hb');
      if (!ok && ++reloads >= 2) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(8000);
        if (await ensureLogin('reload')) await inject('reload');
        reloads = 0;
      }
      continue;
    }

    let info = {};
    try { info = JSON.parse(st); } catch { }
    log('hb run=' + info.running + ' today=' + info.today + ' sess=' + info.casts + ' ok=' + info.caught + ' lost=' + info.lost + ' t=' + info.rt);

    if (info.running === false) {
      if (info.stopType === 'final') {
        log('finished');
        break;
      }
      log('stopped, retry in 5m');
      await sleep(5 * 60000);
      if (Date.now() < wrapAt) await inject('retry');
      continue;
    }

    if (info.today === lastCasts) {
      if (!stallSince) stallSince = Date.now();
      else if (Date.now() - stallSince > 40 * 60000) {
        log('stall, reload');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(8000);
        if (!(await ensureLogin('reload'))) break;
        await inject('reload');
        stallSince = 0;
        lastCasts = -1;
      }
    } else {
      lastCasts = info.today;
      stallSince = 0;
    }
  }

  log('wrap up');
  await page.evaluate(() => { try { window.__fishBot?.stop('done'); } catch { } }).catch(() => {});
  await sleep(25000);

  const summary = await page.evaluate(() => {
    const s = window.__fishBot?.stats;
    if (!s) return null;
    return {
      casts: s.casts, caught: s.caught, lost: s.escaped, coins: s.coins,
      stocked: s.stocked, released: s.released, bred: s.bred, errors: s.errors,
      lastError: s.lastError, today: Number(localStorage.getItem('fwb_castsToday') || 0),
      rt: localStorage.getItem('fwb_runtimeToday'),
    };
  }).catch(() => null);
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ summary, at: new Date().toISOString() }, null, 2));
  log('summary', JSON.stringify(summary));

  try {
    const newState = await context.storageState();
    if (Array.isArray(newState.cookies)) {
      newState.cookies = newState.cookies.filter(c => /pipiwang|linux\.do/.test(c.domain));
    }
    const enc = encrypt(JSON.stringify(newState), key);
    fs.writeFileSync(path.join(OUT_DIR, 'state.enc'), enc);
    log('state saved', enc.length);

    const repo = process.env.FISH_REPO;
    const pat = process.env.GH_PAT;
    if (repo && pat && enc.length < 48000) {
      execFileSync('gh', ['secret', 'set', 'FISH_STATE_ENC', '--repo', repo, '--body', enc], {
        env: { ...process.env, GH_TOKEN: pat }, stdio: 'inherit',
      });
      log('state pushed');
    }
  } catch (e) {
    log('state export failed', e.message);
  }

  await browser.close();
  log('done');
}

main().catch(e => { console.error('failed', e); process.exit(1); });
