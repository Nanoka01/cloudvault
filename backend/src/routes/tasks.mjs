// Task และการส่งงาน
//
// ส่งงาน   : เลือกไฟล์จาก My Files → ไฟล์ ACTIVE เปลี่ยนเป็น LOCKED + สร้าง SUB (PENDING) ในคำสั่งเดียว
// Reject   : SUB → REJECTED, ไฟล์ LOCKED → ACTIVE (ผู้ใช้แก้แล้วส่งใหม่ได้)
// Approve  : 1) CopyObject เวอร์ชันที่ส่ง → companies/{cid}/approved/...
//            2) SUB → APPROVED, ไฟล์ → MOVED, คืนโควตาผู้ใช้, เพิ่มพื้นที่ทีม (คำสั่งเดียว)
//            3) ลบทุกเวอร์ชันฝั่งผู้ใช้ให้พื้นที่คืนจริง
//            ลำดับนี้ทำให้ล้มกลางทางแล้วกดซ้ำได้อย่างปลอดภัย
// หลัง Approve S3 Lifecycle จะลดระดับไฟล์เอง: วันที่ 3 → Glacier IR, วันที่ 180 → Deep Archive
import { CopyObjectCommand, RestoreObjectCommand } from '@aws-sdk/client-s3';
import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, s3, TABLE, BUCKET } from '../lib/aws.mjs';
import { badRequest, conflict, forbidden, json, notFound, parseBody, requireString } from '../lib/http.mjs';
import {
  MAX_FILES_PER_SUBMISSION, approvedKey, defaultTeamQuota, getItem, keys, newId, nowIso, queryPrefix,
  requireMember, requireOwner,
} from '../lib/model.mjs';
import { archiveState, copySource, deleteAllVersions, headObject, presignDownload } from '../lib/storage.mjs';
import { assertStatus, quotaUpdate } from './files.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const formatGB = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, Math.round(b / 1024 ** 2))} MB`);

async function getTaskOrThrow(cid, tid) {
  const task = await getItem(keys.task(cid, tid));
  if (!task) throw notFound('ไม่พบงานนี้');
  return task;
}

async function getSubmissionOrThrow(tid, sid) {
  const sub = await getItem(keys.submission(tid, sid));
  if (!sub) throw notFound('ไม่พบงานที่ส่ง');
  return sub;
}

// Task
export async function createTask(event, uid, cid) {
  await requireOwner(cid, uid);
  const body = parseBody(event);
  const title = requireString(body.title, 'หัวข้องาน', { max: 150 });
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 4000) : '';
  const dueDate = body.dueDate || null;
  if (dueDate && !DATE_RE.test(dueDate)) throw badRequest('กำหนดส่งต้องเป็นรูปแบบ YYYY-MM-DD');
  const assignees = Array.isArray(body.assignees) ? [...new Set(body.assignees)] : [];
  if (!assignees.length) throw badRequest('กรุณาเลือกผู้รับผิดชอบอย่างน้อย 1 คน');

  const members = await queryPrefix(`COMPANY#${cid}`, 'MEMBER#');
  const memberIds = new Set(members.filter((m) => m.role === 'MEMBER').map((m) => m.userId));
  const invalid = assignees.filter((a) => !memberIds.has(a));
  if (invalid.length) throw badRequest('ผู้รับผิดชอบบางคนไม่ได้เป็นสมาชิกของทีม');

  const taskId = newId();
  const task = {
    ...keys.task(cid, taskId), type: 'TASK', taskId, companyId: cid, title, description, dueDate,
    assignees, createdBy: uid, createdAt: nowIso(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: task }));
  return json(201, { task: publicTask(task) });
}

// Owner เห็นทุกงานพร้อมจำนวนที่รอตรวจ / Member เห็นเฉพาะงานที่ได้รับมอบหมาย พร้อมสถานะล่าสุดของตัวเอง
export async function listTasks(_event, uid, cid) {
  const member = await requireMember(cid, uid);
  let tasks = await queryPrefix(`COMPANY#${cid}`, 'TASK#');
  if (member.role !== 'OWNER') tasks = tasks.filter((t) => t.assignees.includes(uid));

  const result = await Promise.all(
    tasks.map(async (t) => {
      const subs = await queryPrefix(`TASK#${t.taskId}`, 'SUB#');
      if (member.role === 'OWNER') {
        return {
          ...publicTask(t),
          pendingCount: subs.filter((s) => s.status === 'PENDING').length,
          approvedCount: new Set(subs.filter((s) => s.status === 'APPROVED').map((s) => s.userId)).size,
        };
      }
      const mine = subs.filter((s) => s.userId === uid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { ...publicTask(t), myStatus: mine[0]?.status || null };
    }),
  );
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json(200, { tasks: result, role: member.role });
}

export async function getTask(_event, uid, cid, tid) {
  const member = await requireMember(cid, uid);
  const task = await getTaskOrThrow(cid, tid);
  if (member.role !== 'OWNER' && !task.assignees.includes(uid)) throw forbidden('งานนี้ไม่ได้มอบหมายให้คุณ');
  let subs = await queryPrefix(`TASK#${tid}`, 'SUB#');
  if (member.role !== 'OWNER') subs = subs.filter((s) => s.userId === uid);
  subs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  let assigneeInfo = [];
  if (member.role === 'OWNER') {
    assigneeInfo = await Promise.all(
      task.assignees.map(async (a) => {
        const m = await getItem(keys.member(cid, a));
        return { userId: a, name: m?.name || '(ออกจากทีมแล้ว)', email: m?.email };
      }),
    );
  }
  return json(200, { task: publicTask(task), role: member.role, assignees: assigneeInfo, submissions: subs.map(publicSubmission) });
}

// ส่งงาน
export async function submitWork(event, uid, cid, tid) {
  const member = await requireMember(cid, uid);
  const task = await getTaskOrThrow(cid, tid);
  if (member.role !== 'MEMBER' || !task.assignees.includes(uid)) throw forbidden('งานนี้ไม่ได้มอบหมายให้คุณ');

  const body = parseBody(event);
  const fileIds = Array.isArray(body.fileIds) ? [...new Set(body.fileIds)] : [];
  if (!fileIds.length) throw badRequest('กรุณาเลือกไฟล์อย่างน้อย 1 ไฟล์');
  if (fileIds.length > MAX_FILES_PER_SUBMISSION) throw badRequest(`ส่งได้ไม่เกิน ${MAX_FILES_PER_SUBMISSION} ไฟล์ต่อครั้ง`);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';

  const existing = await queryPrefix(`TASK#${tid}`, 'SUB#');
  if (existing.some((s) => s.userId === uid && s.status === 'PENDING')) {
    throw conflict('คุณมีงานที่รอตรวจอยู่แล้วสำหรับงานนี้');
  }

  const files = [];
  for (const fid of fileIds) {
    const f = await getItem(keys.file(uid, fid));
    if (!f || f.status === 'UPLOADING') throw notFound('ไม่พบไฟล์บางไฟล์');
    assertStatus(f, ['ACTIVE'], 'ส่งงาน');
    files.push(f);
  }

  const company = await getItem(keys.company(cid));
  const submissionId = newId();
  const now = nowIso();
  const sub = {
    ...keys.submission(tid, submissionId),
    type: 'SUBMISSION',
    submissionId,
    taskId: tid,
    companyId: cid,
    userId: uid,
    userName: member.name,
    note,
    status: 'PENDING',
    late: Boolean(task.dueDate && now.slice(0, 10) > task.dueDate),
    files: files.map((f) => ({
      fileId: f.fileId, name: f.name, size: f.size, contentType: f.contentType,
      s3Key: f.s3Key, versionId: f.versionId, // อ้างอิงเวอร์ชันที่ส่ง ณ ตอนนี้
    })),
    createdAt: now,
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: sub } },
          ...files.map((f) => ({
            Update: {
              TableName: TABLE,
              Key: keys.file(uid, f.fileId),
              UpdateExpression:
                'SET #s = :locked, submissionId = :sid, taskId = :tid, taskTitle = :tt, companyId = :cid, companyName = :cn, updatedAt = :now',
              // ต้องยังเป็นเวอร์ชันเดียวกับที่อ่านมา และยังไม่ถูกล็อกโดยงานอื่น
              ConditionExpression: '#s = :active AND versionId = :v',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: {
                ':locked': 'LOCKED', ':active': 'ACTIVE', ':v': f.versionId, ':sid': submissionId,
                ':tid': tid, ':tt': task.title, ':cid': cid, ':cn': company?.name || '', ':now': now,
              },
            },
          })),
        ],
      }),
    );
  } catch (err) {
    if (err.name === 'TransactionCanceledException') throw conflict('มีไฟล์ถูกแก้ไขหรือถูกล็อกไปแล้ว กรุณารีเฟรชแล้วลองใหม่');
    throw err;
  }
  return json(201, { submission: publicSubmission(sub) });
}

// ตรวจงาน
export async function reviewSubmission(event, uid, cid, tid, sid) {
  await requireOwner(cid, uid);
  const task = await getTaskOrThrow(cid, tid);
  const body = parseBody(event);
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : '';
  const sub = await getSubmissionOrThrow(tid, sid);
  if (sub.companyId !== cid) throw notFound('ไม่พบงานที่ส่ง');
  if (sub.status !== 'PENDING') throw conflict('งานนี้ถูกตรวจไปแล้ว');

  if (body.action === 'approve') return json(200, { submission: await approve(sub, task, uid, comment) });
  if (body.action === 'reject') {
    return json(200, { submission: await unlock(sub, 'REJECTED', { comment, reviewedBy: uid }) });
  }
  throw badRequest('action ต้องเป็น approve หรือ reject');
}

async function approve(sub, task, reviewerId, comment) {
  const now = nowIso();
  const total = sub.files.reduce((sum, f) => sum + f.size, 0);

  // 0) เช็กพื้นที่ทีมก่อนคัดลอก (ค่าเริ่มต้น 20 GB) เช็กซ้ำแบบ atomic อีกครั้งใน transaction
  const company = await getItem(keys.company(sub.companyId));
  const teamQuota = company?.quotaBytes ?? defaultTeamQuota();
  const teamUsed = company?.usedBytes ?? 0;
  if (teamUsed + total > teamQuota) {
    throw conflict(
      `พื้นที่ทีมไม่พอ (เหลือ ${formatGB(teamQuota - teamUsed)} แต่งานนี้ใช้ ${formatGB(total)}) ลบไฟล์เก่าในพื้นที่ทีมก่อน`,
      { code: 'TEAM_QUOTA_EXCEEDED' },
    );
  }

  const files = [];
  // 1) คัดลอกเวอร์ชันที่ส่งไปพื้นที่ทีม (อายุไฟล์สำหรับ Lifecycle เริ่มนับตอนนี้)
  for (const f of sub.files) {
    const companyKey = approvedKey(sub.companyId, sub.taskId, sub.userId, f.fileId, f.name);
    await s3.send(
      new CopyObjectCommand({ Bucket: BUCKET, Key: companyKey, CopySource: copySource(f.s3Key, f.versionId) }),
    );
    files.push({ ...f, companyKey });
  }

  // 2) อัปเดตสถานะทั้งหมดพร้อมกัน
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: keys.submission(sub.taskId, sub.submissionId),
              UpdateExpression: 'SET #s = :approved, files = :files, #c = :comment, reviewedAt = :now, reviewedBy = :by',
              ConditionExpression: '#s = :pending',
              ExpressionAttributeNames: { '#s': 'status', '#c': 'comment' },
              ExpressionAttributeValues: {
                ':approved': 'APPROVED', ':pending': 'PENDING', ':files': files, ':comment': comment,
                ':now': now, ':by': reviewerId,
              },
            },
          },
          ...files.map((f) => ({
            Update: {
              TableName: TABLE,
              Key: keys.file(sub.userId, f.fileId),
              UpdateExpression: 'SET #s = :moved, companyKey = :ck, approvedAt = :now, updatedAt = :now',
              ConditionExpression: '#s = :locked AND submissionId = :sid',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: {
                ':moved': 'MOVED', ':locked': 'LOCKED', ':ck': f.companyKey, ':now': now, ':sid': sub.submissionId,
              },
            },
          })),
          quotaUpdate(sub.userId, -total), // ผู้ใช้ได้พื้นที่คืน
          {
            Update: {
              TableName: TABLE,
              Key: keys.company(sub.companyId),
              UpdateExpression: 'ADD usedBytes :t',
              ConditionExpression: 'attribute_not_exists(usedBytes) OR usedBytes <= :limit',
              ExpressionAttributeValues: { ':t': total, ':limit': teamQuota - total },
            },
          },
          // รายการไฟล์ในพื้นที่ทีม (หน้า "ไฟล์ของทีม" ของหัวหน้า)
          ...files.map((f) => ({
            Put: {
              TableName: TABLE,
              Item: {
                ...keys.teamFile(sub.companyId, f.fileId),
                type: 'TEAM_FILE',
                fileId: f.fileId, name: f.name, size: f.size, contentType: f.contentType,
                companyKey: f.companyKey, taskId: sub.taskId, taskTitle: task.title,
                submissionId: sub.submissionId, userId: sub.userId, userName: sub.userName, approvedAt: now,
                // ที่มาของไฟล์ (แสดงในผลค้นหาพื้นที่ทีม)
                submittedAt: sub.createdAt, note: sub.note, reviewComment: comment, reviewedBy: reviewerId,
              },
            },
          })),
        ],
      }),
    );
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err;
    for (const f of files) await deleteAllVersions(f.companyKey).catch(() => {}); // ทิ้งสำเนาที่คัดลอกไปแล้ว
    const companyReason = err.CancellationReasons?.[files.length + 2];
    if (companyReason?.Code === 'ConditionalCheckFailed') {
      throw conflict('พื้นที่ทีมไม่พอ ลบไฟล์เก่าในพื้นที่ทีมก่อน', { code: 'TEAM_QUOTA_EXCEEDED' });
    }
    throw conflict('สถานะงานเปลี่ยนไปแล้ว กรุณารีเฟรช');
  }

  // 3) ลบทุกเวอร์ชันฝั่งผู้ใช้ (ถ้าพลาด ไฟล์ค้างจะถูก Lifecycle ลบเองภายหลัง แต่ข้อมูลในระบบถูกต้องแล้ว)
  for (const f of files) {
    try {
      await deleteAllVersions(f.s3Key);
    } catch (err) {
      console.error('delete user copy failed', f.s3Key, err);
    }
  }
  return publicSubmission({ ...sub, status: 'APPROVED', files, comment, reviewedAt: now, reviewedBy: reviewerId });
}

// Reject หรือยกเลิก (สมาชิกออกจากทีม): ปลดล็อกไฟล์กลับเป็น ACTIVE
async function unlock(sub, newStatus, { comment = '', reviewedBy } = {}) {
  const now = nowIso();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: keys.submission(sub.taskId, sub.submissionId),
              UpdateExpression: 'SET #s = :to, #c = :comment, reviewedAt = :now' + (reviewedBy ? ', reviewedBy = :by' : ''),
              ConditionExpression: '#s = :pending',
              ExpressionAttributeNames: { '#s': 'status', '#c': 'comment' },
              ExpressionAttributeValues: {
                ':to': newStatus, ':pending': 'PENDING', ':comment': comment, ':now': now,
                ...(reviewedBy ? { ':by': reviewedBy } : {}),
              },
            },
          },
          ...sub.files.map((f) => ({
            Update: {
              TableName: TABLE,
              Key: keys.file(sub.userId, f.fileId),
              UpdateExpression: 'SET #s = :active, updatedAt = :now REMOVE submissionId, taskId, taskTitle, companyId, companyName',
              ConditionExpression: '#s = :locked AND submissionId = :sid',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':active': 'ACTIVE', ':locked': 'LOCKED', ':now': now, ':sid': sub.submissionId },
            },
          })),
        ],
      }),
    );
  } catch (err) {
    if (err.name === 'TransactionCanceledException') throw conflict('สถานะงานเปลี่ยนไปแล้ว กรุณารีเฟรช');
    throw err;
  }
  return publicSubmission({ ...sub, status: newStatus, comment, reviewedAt: now, reviewedBy });
}

export const cancelSubmission = (sub) => unlock(sub, 'CANCELLED', { comment: 'สมาชิกออกจากทีม' });

// ดาวน์โหลด / กู้คืนจาก Deep Archive
// Owner ของทีม หรือคนที่ส่งงานนั้น
export async function submissionFileUrl(_event, uid, cid, tid, sid, fid) {
  const member = await requireMember(cid, uid);
  const sub = await getSubmissionOrThrow(tid, sid);
  if (sub.companyId !== cid) throw notFound('ไม่พบงานที่ส่ง');
  if (member.role !== 'OWNER' && sub.userId !== uid) throw forbidden();
  const f = sub.files.find((x) => x.fileId === fid);
  if (!f) throw notFound('ไม่พบไฟล์ในงานที่ส่ง');

  if (sub.status === 'APPROVED') {
    const head = await headObject(f.companyKey);
    if (!head) throw notFound('ไม่พบไฟล์ในพื้นที่ทีม');
    const state = archiveState(head);
    if (state.archived && !state.restored) {
      throw conflict(state.restoring ? 'กำลังกู้คืนไฟล์จาก Deep Archive (12–48 ชม.)' : 'ไฟล์ถูกเก็บถาวร (Deep Archive) กดกู้คืนก่อนดาวน์โหลด', {
        code: 'ARCHIVED', restoring: state.restoring,
      });
    }
    return json(200, { url: await presignDownload({ key: f.companyKey, fileName: f.name }), storageClass: head.StorageClass || 'STANDARD' });
  }
  if (sub.status !== 'PENDING') throw conflict('ไฟล์ของงานนี้ถูกปลดล็อกคืนให้ผู้ส่งแล้ว');
  return json(200, { url: await presignDownload({ key: f.s3Key, versionId: f.versionId, fileName: f.name }), storageClass: 'STANDARD' });
}

export async function restoreArchived(_event, uid, cid, tid, sid, fid) {
  await requireOwner(cid, uid);
  const sub = await getSubmissionOrThrow(tid, sid);
  const f = sub.files.find((x) => x.fileId === fid);
  if (!f || sub.status !== 'APPROVED') throw notFound('ไม่พบไฟล์');
  const state = archiveState(await headObject(f.companyKey));
  if (!state.archived) throw badRequest('ไฟล์นี้ไม่ได้อยู่ใน Deep Archive ดาวน์โหลดได้เลย');
  if (state.restored) return json(200, { restoring: false, restored: true });
  try {
    await s3.send(
      new RestoreObjectCommand({
        Bucket: BUCKET,
        Key: f.companyKey,
        RestoreRequest: { Days: 7, GlacierJobParameters: { Tier: 'Standard' } }, // ~12 ชม., ใช้ได้ 7 วัน
      }),
    );
  } catch (err) {
    if (err.name !== 'RestoreAlreadyInProgress') throw err;
  }
  return json(202, { restoring: true });
}

// รูปแบบข้อมูลที่ส่งให้หน้าเว็บ
function publicTask(t) {
  return {
    taskId: t.taskId, companyId: t.companyId, title: t.title, description: t.description,
    dueDate: t.dueDate, assignees: t.assignees, createdAt: t.createdAt,
  };
}

function publicSubmission(s) {
  return {
    submissionId: s.submissionId, taskId: s.taskId, userId: s.userId, userName: s.userName,
    note: s.note, status: s.status, late: s.late, comment: s.comment,
    createdAt: s.createdAt, reviewedAt: s.reviewedAt,
    files: s.files.map((f) => ({ fileId: f.fileId, name: f.name, size: f.size, contentType: f.contentType })),
  };
}
