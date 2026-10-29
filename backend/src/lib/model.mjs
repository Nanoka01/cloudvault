// โครงสร้างคีย์ของ DynamoDB (single-table) และฟังก์ชันอ่านข้อมูลที่ใช้บ่อย
import { randomBytes } from 'node:crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from './aws.mjs';
import { forbidden, notFound } from './http.mjs';

// คีย์
export const keys = {
  user: (uid) => ({ PK: `USER#${uid}`, SK: 'PROFILE' }),
  email: (email) => ({ PK: `EMAIL#${email}`, SK: 'USER' }),
  file: (uid, fid) => ({ PK: `USER#${uid}`, SK: `FILE#${fid}` }),
  company: (cid) => ({ PK: `COMPANY#${cid}`, SK: 'META' }),
  invite: (code) => ({ PK: `INVITE#${code}`, SK: 'COMPANY' }),
  member: (cid, uid) => ({ PK: `COMPANY#${cid}`, SK: `MEMBER#${uid}` }),
  task: (cid, tid) => ({ PK: `COMPANY#${cid}`, SK: `TASK#${tid}` }),
  submission: (tid, sid) => ({ PK: `TASK#${tid}`, SK: `SUB#${sid}` }),
  teamFile: (cid, fid) => ({ PK: `COMPANY#${cid}`, SK: `TFILE#${fid}` }), // ไฟล์ในพื้นที่ทีม (งานที่ Approve)
};

export const defaultTeamQuota = () => Number(process.env.TEAM_QUOTA_BYTES || 20 * 1024 ** 3);

// id ที่เรียงตามเวลาได้ (เวลา base36 + สุ่ม) เช่น "m2x9k3f0a7c1e4b2"
export function newId() {
  return Date.now().toString(36).padStart(9, '0') + randomBytes(5).toString('hex');
}

// รหัสเชิญทีม เช่น CV-7K2QX9 (ตัดตัวที่สับสนง่าย 0/O/1/I ออก)
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newInviteCode() {
  const bytes = randomBytes(6);
  let code = '';
  for (const b of bytes) code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  return `CV-${code}`;
}

export const nowIso = () => new Date().toISOString();

// กฎไฟล์
export const ALLOWED_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt',
  'zip', 'jpg', 'jpeg', 'png', 'gif', 'mp4',
];
export const MAX_FILE_BYTES = 5 * 1024 ** 3; // 5 GB ต่อไฟล์ (เพดานของ presigned POST)
export const MAX_FILES_PER_SUBMISSION = 20;

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

// ชื่อไฟล์ที่ปลอดภัยสำหรับใช้ใน S3 key (ชื่อจริงยังเก็บใน DynamoDB ตามเดิม)
export function safeKeyName(name) {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, '_');
  return cleaned.slice(-120) || 'file';
}

export const userFileKey = (uid, fid, name) => `users/${uid}/files/${fid}-${safeKeyName(name)}`;
export const approvedKey = (cid, tid, uid, fid, name) =>
  `companies/${cid}/approved/${tid}/${uid}/${fid}-${safeKeyName(name)}`;

// อ่านข้อมูล
export async function getItem(key) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
  return res.Item;
}

export async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export const queryPrefix = (pk, skPrefix) =>
  queryAll({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
  });

export async function getUserOrThrow(uid) {
  const user = await getItem(keys.user(uid));
  if (!user) throw notFound('ไม่พบผู้ใช้');
  return user;
}

export async function getFileOrThrow(uid, fid) {
  const file = await getItem(keys.file(uid, fid));
  if (!file || file.status === 'UPLOADING') throw notFound('ไม่พบไฟล์');
  return file;
}

// role ของผู้ใช้ในทีม อ่านจาก DynamoDB ทุกครั้ง (ไม่เชื่อ role ใน JWT)
export async function requireMember(cid, uid) {
  const member = await getItem(keys.member(cid, uid));
  if (!member) throw forbidden('คุณไม่ได้เป็นสมาชิกของทีมนี้');
  return member;
}

export async function requireOwner(cid, uid) {
  const member = await requireMember(cid, uid);
  if (member.role !== 'OWNER') throw forbidden('เฉพาะหัวหน้าทีมเท่านั้น');
  return member;
}

// ข้อมูลไฟล์ที่ส่งกลับให้หน้าเว็บ (ไม่ส่ง PK/SK และ S3 key ภายใน)
export function publicFile(f) {
  return {
    fileId: f.fileId,
    name: f.name,
    size: f.size,
    contentType: f.contentType,
    status: f.status,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    deletedAt: f.deletedAt,
    companyId: f.companyId,
    companyName: f.companyName,
    taskId: f.taskId,
    taskTitle: f.taskTitle,
    submissionId: f.submissionId,
    approvedAt: f.approvedAt,
    copiedFileId: f.copiedFileId, // งานที่ส่งแล้ว: มีสำเนาใน My Files แล้ว
  };
}
