// JWT แบบ HS256 เขียนเองด้วย crypto ของ Node (ไม่ต้องพึ่ง library ภายนอก)
// ใช้ทั้งออก token ตอน login และตรวจใน Lambda Authorizer
// signToken/verifyToken แบบทั่วไปยังใช้ทำลิงก์แชร์ไฟล์ (typ = 'share') ด้วย
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSecret } from './secret.mjs';

const b64url = (input) => Buffer.from(input).toString('base64url');

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export async function signToken(payload, ttlSeconds) {
  const secret = await getSecret();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${header}.${body}.${sign(`${header}.${body}`, secret)}`;
}

// คืน payload ถ้า token ถูกต้องและยังไม่หมดอายุ ไม่งั้นคืน null
export async function verifyToken(token, expectedTyp) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const secret = await getSecret();
  const expected = Buffer.from(sign(`${header}.${body}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (head.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (expectedTyp && payload.typ !== expectedTyp) return null;
    return payload;
  } catch {
    return null;
  }
}
