import fs from 'node:fs';
import path from 'node:path';
import { loadKey, encrypt, genKey } from '../lib/crypto.mjs';

const [, , srcArg] = process.argv;
const src = path.resolve(srcArg || path.join('..', 'auto-fishing.js'));
if (!fs.existsSync(src)) { console.error('not found', src); process.exit(1); }

let keyB64 = process.env.FISH_BOT_KEY;
if (!keyB64) { keyB64 = genKey(); console.log(keyB64); }

const enc = encrypt(fs.readFileSync(src, 'utf8'), loadKey(keyB64));

const outDir = path.resolve('assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'bot.enc'), enc);
console.log('ok', enc.length);
