// สมัครสมาชิก / เข้าสู่ระบบ / ข้อมูลตัวเอง
import bcrypt from 'bcryptjs';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/aws.mjs';
import { badRequest, conflict, HttpError, json, parseBody, requireString } from '../lib/http.mjs';
import { signToken } from '../lib/jwt.mjs';
import { getItem, getUserOrThrow, keys, newId, nowIso, queryAll } from '../lib/model.mjs';

const TOKEN_TTL = 12 * 60 * 60; // 12 ชั่วโมง
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const defaultQuota = () => Number(process.env.USER_QUOTA_BYTES || 5 * 1024 ** 3);

function publicUser(u) {
  return { userId: u.userId, name: u.name, email: u.email, usedBytes: u.usedBytes, quotaBytes: u.quotaBytes };
}

export async function register(event) {
  const body = parseBody(event);
  const name = requireString(body.name, 'ชื่อ', { max: 80 });
  const email = requireString(body.email, 'อีเมล', { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('รูปแบบอีเมลไม่ถูกต้อง');
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) throw badRequest('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (password.length > 72) throw badRequest('รหัสผ่านยาวเกิน 72 ตัวอักษร'); // ข้อจำกัดของ bcrypt

  const userId = newId();
  const user = {
    ...keys.user(userId),
    type: 'USER',
    userId,
    name,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    usedBytes: 0,
    quotaBytes: defaultQuota(),
    createdAt: nowIso(),
  };

  // เขียนผู้ใช้กับ email lookup พร้อมกัน — ถ้า email ซ้ำ ทั้งคู่จะไม่ถูกเขียน
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: { ...keys.email(email), userId }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: TABLE, Item: user, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }),
    );
  } catch (err) {
    if (err.name === 'TransactionCanceledException') throw conflict('อีเมลนี้ถูกใช้งานแล้ว');
    throw err;
  }

  const token = await signToken({ sub: userId, typ: 'access' }, TOKEN_TTL);
  return json(201, { token, user: publicUser(user) });
}

export async function login(event) {
  const body = parseBody(event);
  const email = requireString(body.email, 'อีเมล', { max: 254 }).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  const lookup = await getItem(keys.email(email));
  const user = lookup && (await getItem(keys.user(lookup.userId)));
  // ข้อความเดียวกันทั้งกรณีไม่พบบัญชีและรหัสผิด เพื่อไม่บอกใบ้ว่ามีอีเมลนี้หรือไม่
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  const token = await signToken({ sub: user.userId, typ: 'access' }, TOKEN_TTL);
  return json(200, { token, user: publicUser(user) });
}

export async function me(_event, uid) {
  const user = await getUserOrThrow(uid);
  const memberships = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${uid}`, ':sk': 'COMPANY#' },
  });
  return json(200, {
    user: publicUser(user),
    companies: memberships.map((m) => ({ companyId: m.companyId, companyName: m.companyName, role: m.role })),
  });
}
