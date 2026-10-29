// ไดรฟ์ส่วนตัว (My Files): อัปโหลด ดาวน์โหลด แชร์ ถังขยะ เวอร์ชัน และ "งานที่ส่งแล้ว"
//
// สถานะไฟล์ (FILE#fid.status)
//   UPLOADING  ขอ URL แล้วแต่ยังไม่ยืนยัน (หมดอายุเองด้วย DynamoDB TTL)
//   ACTIVE     อยู่ใน My Files ใช้งานได้ปกติ
//   LOCKED     ถูกส่งงานอยู่ รอแอดมินตรวจ — ห้ามลบ/เขียนทับ/แชร์/ส่งซ้ำ
//   TRASHED    อยู่ในถังขยะ ลบถาวรอัตโนมัติหลัง 30 วัน
//   MOVED      Approve แล้ว ไฟล์ย้ายไปพื้นที่บริษัท ผู้ใช้เห็นแบบอ่านอย่างเดียว ไม่นับโควตา
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { DeleteCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, s3, TABLE, BUCKET } from '../lib/aws.mjs';
import { badRequest, conflict, json, notFound, parseBody, redirect, requireString } from '../lib/http.mjs';
import { signToken, verifyToken } from '../lib/jwt.mjs';
import {
  ALLOWED_EXTENSIONS, MAX_FILE_BYTES, extensionOf, getFileOrThrow, getItem, getUserOrThrow,
  keys, newId, nowIso, publicFile, queryPrefix, userFileKey,
} from '../lib/model.mjs';
import {
  archiveState, copySource, deleteAllVersions, headObject, listVersions, presignDownload, presignUpload,
} from '../lib/storage.mjs';

export const TRASH_RETENTION_DAYS = 30;
const MAX_SHARE_HOURS = 24 * 7;

// ---------- รายการไฟล์ ----------
// view=active (ค่าเริ่มต้น: ACTIVE + LOCKED) | trash | submitted (MOVED)
export async function listFiles(event, uid) {
  const view = event.queryStringParameters?.view || 'active';
  const q = (event.queryStringParameters?.q || '').trim().toLowerCase();
  const wanted = { active: ['ACTIVE', 'LOCKED'], trash: ['TRASHED'], submitted: ['MOVED'] }[view];
  if (!wanted) throw badRequest('view ไม่ถูกต้อง');

  const files = (await queryPrefix(`USER#${uid}`, 'FILE#'))
    .filter((f) => wanted.includes(f.status))
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return json(200, { files: files.map(publicFile) });
}

// ---------- อัปโหลด ----------
// ไม่ส่ง fileId = ไฟล์ใหม่ / ส่ง fileId = อัปโหลดเวอร์ชันใหม่ทับไฟล์เดิม (S3 Versioning เก็บของเก่าไว้)
export async function createUploadUrl(event, uid) {
  const body = parseBody(event);
  const contentType = requireString(body.contentType || 'application/octet-stream', 'ประเภทไฟล์', { max: 120 });
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) throw badRequest('ขนาดไฟล์ไม่ถูกต้อง');
  if (size > MAX_FILE_BYTES) throw badRequest('ไฟล์ใหญ่เกิน 5 GB');

  const user = await getUserOrThrow(uid);
  let file;
  let freed = 0;
  if (body.fileId) {
    file = await getFileOrThrow(uid, body.fileId);
    assertStatus(file, ['ACTIVE'], 'อัปโหลดเวอร์ชันใหม่');
    freed = file.size; // เวอร์ชันใหม่จะแทนขนาดเดิม
  }
  const name = file ? file.name : requireString(body.name, 'ชื่อไฟล์', { max: 200 });
  if (!ALLOWED_EXTENSIONS.includes(extensionOf(name))) {
    throw badRequest(`ไม่รองรับไฟล์ประเภทนี้ (รองรับ: ${ALLOWED_EXTENSIONS.join(', ')})`);
  }

  const remaining = user.quotaBytes - user.usedBytes + freed;
  if (size > remaining) {
    throw conflict('พื้นที่จัดเก็บไม่พอ', { code: 'QUOTA_EXCEEDED', remaining: Math.max(remaining, 0) });
  }

  if (!file) {
    const fileId = newId();
    file = {
      ...keys.file(uid, fileId),
      type: 'FILE',
      fileId,
      ownerId: uid,
      name,
      contentType,
      size: 0,
      s3Key: userFileKey(uid, fileId, name),
      status: 'UPLOADING',
      createdAt: nowIso(),
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // TTL: ลบรายการค้างหลัง 1 วัน
    };
    await ddb.send(new PutCommand({ TableName: TABLE, Item: file }));
  }

  const upload = await presignUpload({
    key: file.s3Key,
    contentType,
    maxBytes: Math.min(remaining, MAX_FILE_BYTES),
  });
  return json(200, { fileId: file.fileId, upload });
}

// เรียกหลังอัปโหลดเข้า S3 เสร็จ: อ่านขนาด/เวอร์ชันจริงจาก S3 แล้วบันทึกพร้อมตัดโควตาแบบ atomic
export async function confirmUpload(_event, uid, fid) {
  const file = await getItem(keys.file(uid, fid));
  if (!file) throw notFound('ไม่พบไฟล์');
  const head = await headObject(file.s3Key);
  if (!head) throw badRequest('ยังไม่พบไฟล์ใน S3 กรุณาอัปโหลดใหม่');

  const size = head.ContentLength;
  const versionId = head.VersionId;
  if (file.status !== 'UPLOADING' && versionId === file.versionId) {
    return json(200, { file: publicFile(file) }); // ยืนยันซ้ำ — ไม่มีอะไรเปลี่ยน
  }
  if (file.status !== 'UPLOADING') assertStatus(file, ['ACTIVE'], 'อัปโหลดเวอร์ชันใหม่');

  const user = await getUserOrThrow(uid);
  const delta = file.status === 'UPLOADING' ? size : size - file.size;
  const now = nowIso();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: keys.file(uid, fid),
              UpdateExpression: 'SET #s = :active, #sz = :size, versionId = :v, updatedAt = :now REMOVE expiresAt',
              ConditionExpression: file.status === 'UPLOADING' ? '#s = :uploading' : '#s = :active AND versionId = :oldV',
              ExpressionAttributeNames: { '#s': 'status', '#sz': 'size' }, // size เป็นคำสงวนของ DynamoDB
              ExpressionAttributeValues: {
                ':active': 'ACTIVE', ':size': size, ':v': versionId, ':now': now,
                ...(file.status === 'UPLOADING' ? { ':uploading': 'UPLOADING' } : { ':oldV': file.versionId }),
              },
            },
          },
          quotaUpdate(uid, delta, user.quotaBytes),
        ],
      }),
    );
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err;
    // เกินโควตา (เช่นอัปโหลดหลายไฟล์พร้อมกัน) หรือมีการเปลี่ยนแปลงพร้อมกัน → ทิ้งไฟล์ที่เพิ่งอัป
    if (file.status === 'UPLOADING') {
      await deleteAllVersions(file.s3Key);
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: keys.file(uid, fid) }));
    } else {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.s3Key, VersionId: versionId }));
    }
    throw conflict('พื้นที่จัดเก็บไม่พอ หรือไฟล์ถูกแก้ไขพร้อมกัน กรุณาลองใหม่', { code: 'QUOTA_EXCEEDED' });
  }
  return json(200, { file: publicFile({ ...file, status: 'ACTIVE', size, versionId, updatedAt: now }) });
}

// ADD usedBytes แบบมีเงื่อนไขไม่ให้เกินโควตา (DynamoDB คำนวณในเงื่อนไขไม่ได้ จึงเทียบกับ quota − delta)
export function quotaUpdate(uid, delta, quotaBytes) {
  const update = {
    TableName: TABLE,
    Key: keys.user(uid),
    UpdateExpression: 'ADD usedBytes :d',
    ExpressionAttributeValues: { ':d': delta },
  };
  if (delta > 0) {
    update.ConditionExpression = 'usedBytes <= :limit';
    update.ExpressionAttributeValues[':limit'] = quotaBytes - delta;
  }
  return { Update: update };
}

// ---------- ดาวน์โหลด / แชร์ ----------
export async function downloadUrl(_event, uid, fid) {
  const file = await getFileOrThrow(uid, fid);
  if (file.status === 'MOVED') {
    // ไฟล์ที่ย้ายไปบริษัทแล้ว: ดาวน์โหลดจากพื้นที่บริษัท ยกเว้นเข้า Deep Archive แล้ว
    const head = await headObject(file.companyKey);
    if (!head) throw notFound('ไม่พบไฟล์ในพื้นที่บริษัทแล้ว');
    const state = archiveState(head);
    if (state.archived && !state.restored) {
      throw conflict('ไฟล์ถูกเก็บถาวร (Deep Archive) แล้ว กรุณาติดต่อแอดมินของบริษัท', { code: 'ARCHIVED' });
    }
    return json(200, { url: await presignDownload({ key: file.companyKey, fileName: file.name }) });
  }
  assertStatus(file, ['ACTIVE', 'LOCKED'], 'ดาวน์โหลด');
  return json(200, { url: await presignDownload({ key: file.s3Key, versionId: file.versionId, fileName: file.name }) });
}

// ลิงก์แชร์ชี้มาที่ API ของเรา (/share/{token}) แล้วค่อย redirect ไป presigned URL ที่เพิ่งสร้าง
// เพราะ presigned URL ที่เซ็นด้วยสิทธิ์ชั่วคราวของ Lambda ใช้ได้แค่ไม่กี่ชั่วโมง แม้ตั้งไว้ 7 วัน
export async function createShareLink(event, uid, fid) {
  const body = parseBody(event);
  const hours = Math.min(Math.max(Number(body.hours) || 24, 1), MAX_SHARE_HOURS);
  const file = await getFileOrThrow(uid, fid);
  assertStatus(file, ['ACTIVE'], 'แชร์');
  const token = await signToken({ typ: 'share', uid, fid }, hours * 3600);
  return json(200, {
    url: `${apiBaseUrl(event)}/share/${token}`,
    expiresAt: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
  });
}

export async function openShareLink(_event, token) {
  const payload = await verifyToken(token, 'share');
  if (!payload) return json(410, { message: 'ลิงก์หมดอายุหรือไม่ถูกต้อง' });
  const file = await getItem(keys.file(payload.uid, payload.fid));
  if (!file || !['ACTIVE', 'LOCKED'].includes(file.status)) {
    return json(404, { message: 'ไฟล์นี้ถูกลบหรือย้ายไปแล้ว' });
  }
  return redirect(await presignDownload({ key: file.s3Key, versionId: file.versionId, fileName: file.name, ttl: 300 }));
}

function apiBaseUrl(event) {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');
  const { domainName, stage } = event.requestContext || {};
  return `https://${domainName}/${stage}`;
}

// ---------- แก้ชื่อ / ถังขยะ ----------
export async function renameFile(event, uid, fid) {
  const name = requireString(parseBody(event).name, 'ชื่อไฟล์', { max: 200 });
  const file = await getFileOrThrow(uid, fid);
  assertStatus(file, ['ACTIVE'], 'เปลี่ยนชื่อ');
  if (extensionOf(name) !== extensionOf(file.name)) throw badRequest('ห้ามเปลี่ยนนามสกุลไฟล์');
  await conditionalUpdate(uid, fid, 'SET #n = :name, updatedAt = :now', ['ACTIVE'], { ':name': name }, { '#n': 'name' });
  return json(200, { file: publicFile({ ...file, name }) });
}

// ACTIVE → ถังขยะ / MOVED → ซ่อนรายการ (ไฟล์ของบริษัทไม่ถูกลบ) / LOCKED → ไม่อนุญาต
export async function deleteFile(_event, uid, fid) {
  const file = await getFileOrThrow(uid, fid);
  if (file.status === 'MOVED') {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: keys.file(uid, fid) }));
    return json(200, { hidden: true });
  }
  assertStatus(file, ['ACTIVE'], 'ลบ');
  await conditionalUpdate(uid, fid, 'SET #s = :to, deletedAt = :now, updatedAt = :now', ['ACTIVE'], { ':to': 'TRASHED' });
  return json(200, { trashed: true });
}

export async function restoreFromTrash(_event, uid, fid) {
  const file = await getFileOrThrow(uid, fid);
  assertStatus(file, ['TRASHED'], 'กู้คืน');
  await conditionalUpdate(uid, fid, 'SET #s = :to, updatedAt = :now REMOVE deletedAt', ['TRASHED'], { ':to': 'ACTIVE' });
  return json(200, { restored: true });
}

export async function deletePermanently(_event, uid, fid) {
  const file = await getFileOrThrow(uid, fid);
  assertStatus(file, ['TRASHED'], 'ลบถาวร');
  await purgeFile(file);
  return json(200, { deleted: true });
}

// ลบไฟล์ถาวร: ลบทุกเวอร์ชันใน S3 → ลบรายการ + คืนโควตาในคำสั่งเดียว
// ใช้ทั้งปุ่ม "ลบถาวร" และงานล้างถังขยะอัตโนมัติ (handlers/purge.mjs)
export async function purgeFile(file) {
  await deleteAllVersions(file.s3Key);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: TABLE,
              Key: keys.file(file.ownerId, file.fileId),
              ConditionExpression: '#s = :trashed',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':trashed': 'TRASHED' },
            },
          },
          quotaUpdate(file.ownerId, -file.size),
        ],
      }),
    );
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err; // ถูกกู้คืน/ลบไปแล้ว
  }
}

// ---------- เวอร์ชัน (S3 Versioning) ----------
export async function listFileVersions(_event, uid, fid) {
  const file = await getFileOrThrow(uid, fid);
  assertStatus(file, ['ACTIVE', 'LOCKED'], 'ดูเวอร์ชัน');
  const versions = await listVersions(file.s3Key);
  return json(200, {
    versions: versions.map((v) => ({
      versionId: v.VersionId,
      size: v.Size,
      lastModified: v.LastModified,
      isCurrent: v.VersionId === file.versionId,
    })),
  });
}

export async function versionDownloadUrl(_event, uid, fid, vid) {
  const file = await getFileOrThrow(uid, fid);
  assertStatus(file, ['ACTIVE', 'LOCKED'], 'ดาวน์โหลดเวอร์ชันเก่า');
  const head = await headObject(file.s3Key, vid);
  if (!head) throw notFound('ไม่พบเวอร์ชันนี้');
  return json(200, { url: await presignDownload({ key: file.s3Key, versionId: vid, fileName: file.name }) });
}

// กู้คืนเวอร์ชันเก่า = คัดลอกเวอร์ชันนั้นมาเป็นเวอร์ชันล่าสุด (ประวัติเดิมยังอยู่ครบ)
export async function restoreVersion(_event, uid, fid, vid) {
  const file = await getFileOrThrow(uid, fid);
  assertStatus(file, ['ACTIVE'], 'กู้คืนเวอร์ชัน');
  if (vid === file.versionId) throw badRequest('นี่คือเวอร์ชันปัจจุบันอยู่แล้ว');
  const old = await headObject(file.s3Key, vid);
  if (!old) throw notFound('ไม่พบเวอร์ชันนี้');

  const user = await getUserOrThrow(uid);
  const delta = old.ContentLength - file.size;
  if (delta > user.quotaBytes - user.usedBytes) throw conflict('พื้นที่จัดเก็บไม่พอ', { code: 'QUOTA_EXCEEDED' });

  const copied = await s3.send(
    new CopyObjectCommand({ Bucket: BUCKET, Key: file.s3Key, CopySource: copySource(file.s3Key, vid) }),
  );
  const now = nowIso();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: keys.file(uid, fid),
              UpdateExpression: 'SET #sz = :size, versionId = :v, updatedAt = :now',
              ConditionExpression: '#s = :active AND versionId = :oldV',
              ExpressionAttributeNames: { '#s': 'status', '#sz': 'size' },
              ExpressionAttributeValues: {
                ':size': old.ContentLength, ':v': copied.VersionId, ':now': now,
                ':active': 'ACTIVE', ':oldV': file.versionId,
              },
            },
          },
          quotaUpdate(uid, delta, user.quotaBytes),
        ],
      }),
    );
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err;
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.s3Key, VersionId: copied.VersionId }));
    throw conflict('ไฟล์ถูกแก้ไขพร้อมกัน หรือพื้นที่ไม่พอ กรุณาลองใหม่');
  }
  return json(200, { file: publicFile({ ...file, size: old.ContentLength, versionId: copied.VersionId, updatedAt: now }) });
}

// ---------- งานที่ส่งแล้ว → ทำสำเนากลับมาไว้ใน My Files ----------
export async function copyToDrive(_event, uid, fid) {
  const file = await getFileOrThrow(uid, fid);
  assertStatus(file, ['MOVED'], 'ทำสำเนา');
  const head = await headObject(file.companyKey);
  if (!head) throw notFound('ไม่พบไฟล์ในพื้นที่บริษัทแล้ว');
  const state = archiveState(head);
  if (state.archived && !state.restored) {
    throw conflict('ไฟล์ถูกเก็บถาวร (Deep Archive) แล้ว ทำสำเนาไม่ได้', { code: 'ARCHIVED' });
  }

  const user = await getUserOrThrow(uid);
  const size = head.ContentLength;
  if (size > user.quotaBytes - user.usedBytes) throw conflict('พื้นที่จัดเก็บไม่พอ', { code: 'QUOTA_EXCEEDED' });

  const newFid = newId();
  const s3Key = userFileKey(uid, newFid, file.name);
  const copied = await s3.send(
    new CopyObjectCommand({ Bucket: BUCKET, Key: s3Key, CopySource: copySource(file.companyKey) }),
  );
  const now = nowIso();
  const newFile = {
    ...keys.file(uid, newFid),
    type: 'FILE',
    fileId: newFid,
    ownerId: uid,
    name: file.name,
    contentType: file.contentType,
    size,
    s3Key,
    versionId: copied.VersionId,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: newFile } },
          quotaUpdate(uid, size, user.quotaBytes),
        ],
      }),
    );
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err;
    await deleteAllVersions(s3Key);
    throw conflict('พื้นที่จัดเก็บไม่พอ', { code: 'QUOTA_EXCEEDED' });
  }
  return json(201, { file: publicFile(newFile) });
}

// ---------- helpers ----------
const ACTION_BLOCK_MESSAGES = {
  LOCKED: 'ไฟล์นี้ถูกล็อกเพราะส่งงานอยู่ รอแอดมินตรวจก่อน',
  TRASHED: 'ไฟล์นี้อยู่ในถังขยะ',
  MOVED: 'ไฟล์นี้ย้ายไปพื้นที่บริษัทแล้ว (อ่านอย่างเดียว)',
};

export function assertStatus(file, allowed, action) {
  if (allowed.includes(file.status)) return;
  throw conflict(ACTION_BLOCK_MESSAGES[file.status] || `${action}ไม่ได้ในสถานะนี้`, {
    code: `FILE_${file.status}`,
  });
}

async function conditionalUpdate(uid, fid, expression, fromStatuses, values = {}, names = {}) {
  const fromValues = Object.fromEntries(fromStatuses.map((s, i) => [`:from${i}`, s]));
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: keys.file(uid, fid),
        UpdateExpression: expression,
        ConditionExpression: `#s IN (${Object.keys(fromValues).join(', ')})`,
        ExpressionAttributeNames: { '#s': 'status', ...names },
        ExpressionAttributeValues: { ':now': nowIso(), ...fromValues, ...values },
      }),
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') throw conflict('สถานะไฟล์เปลี่ยนไปแล้ว กรุณารีเฟรช');
    throw err;
  }
}
