import crypto from 'node:crypto';

const PREFIX = 'v1';

export function loadKey(b64) {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('key length ' + key.length);
  return key;
}

export function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(blob, key) {
  const parts = String(blob).trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('format');
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plain.toString('utf8');
}

export function genKey() {
  return crypto.randomBytes(32).toString('base64');
}
