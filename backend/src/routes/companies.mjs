// ทีม (ในโค้ดและ API ยังใช้ชื่อ company เดิม): 1 คนอยู่ได้ 1 ทีม
//
// - คนที่ยังไม่มีทีม ใช้ My Files ได้ตามปกติ สร้างหรือเข้าร่วมทีมได้ทีละ 1 ทีม
// - ทีมมีพื้นที่จัดเก็บของตัวเอง (ค่าเริ่มต้น 20 GB) แยกจากโควตาส่วนตัว
//   เก็บเฉพาะงานที่หัวหน้า Approve และหัวหน้าเห็นคนเดียว
// - สมาชิกออกจากทีมได้เลย / หัวหน้าต้องนำสมาชิกออกให้หมดก่อน แล้วจึง "ยุบทีม"
//   ยุบทีม = ลบไฟล์ทุกไฟล์ในพื้นที่ทีม งาน และประวัติการส่งงานทั้งหมด (กู้คืนไม่ได้)
import { RestoreObjectCommand } from '@aws-sdk/client-s3';
import { BatchWriteCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, s3, TABLE, BUCKET } from '../lib/aws.mjs';
import { badRequest, conflict, forbidden, json, notFound, parseBody, requireString } from '../lib/http.mjs';
import {
  defaultTeamQuota, getItem, getUserOrThrow, keys, newId, newInviteCode, nowIso, queryAll, queryPrefix,
  requireMember, requireOwner,
} from '../lib/model.mjs';
import {
  archiveState, deleteAllVersions, deletePrefixAllVersions, headObject, presignDownload,
} from '../lib/storage.mjs';
import { cancelSubmission } from './tasks.mjs';

// ทีมของฉัน
// อ่านจาก profile.companyId ก่อน (ใหม่) ถ้าไม่มีค่อยหาจาก GSI1 (ข้อมูลเก่าก่อนเปลี่ยนเป็น 1 คน 1 ทีม)
export async function findMyMembership(uid) {
  const memberships = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${uid}`, ':sk': 'COMPANY#' },
  });
  return memberships[0] || null;
}

async function assertNoTeam(user) {
  if (user.companyId || (await findMyMembership(user.userId))) {
    throw conflict('คุณอยู่ในทีมอยู่แล้ว ต้องออกจากทีมเดิมก่อน (1 คนอยู่ได้ 1 ทีม)', { code: 'ALREADY_IN_TEAM' });
  }
}

const memberItem = (company, user, role) => ({
  ...keys.member(company.companyId, user.userId),
  type: 'MEMBER',
  companyId: company.companyId,
  companyName: company.name,
  userId: user.userId,
  name: user.name,
  email: user.email,
  role,
  joinedAt: nowIso(),
  GSI1PK: `USER#${user.userId}`,
  GSI1SK: `COMPANY#${company.companyId}`,
});

// ผูก profile กับทีม เงื่อนไข attribute_not_exists กันกดสร้าง/เข้าร่วม 2 ทีมพร้อมกัน
const bindProfile = (uid, cid) => ({
  Update: {
    TableName: TABLE,
    Key: keys.user(uid),
    UpdateExpression: 'SET companyId = :cid',
    ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(companyId)',
    ExpressionAttributeValues: { ':cid': cid },
  },
});

const unbindProfile = (uid) => ({
  Update: { TableName: TABLE, Key: keys.user(uid), UpdateExpression: 'REMOVE companyId' },
});

// สร้าง / เข้าร่วม
export async function createCompany(event, uid) {
  const name = requireString(parseBody(event).name, 'ชื่อทีม', { max: 100 });
  const user = await getUserOrThrow(uid);
  await assertNoTeam(user);
  const companyId = newId();

  for (let attempt = 0; attempt < 3; attempt++) {
    const inviteCode = newInviteCode();
    const company = {
      ...keys.company(companyId), type: 'COMPANY', companyId, name, ownerId: uid, inviteCode,
      usedBytes: 0, quotaBytes: defaultTeamQuota(), createdAt: nowIso(),
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: TABLE, Item: company, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: TABLE, Item: { ...keys.invite(inviteCode), companyId }, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: TABLE, Item: memberItem(company, user, 'OWNER') } },
            bindProfile(uid, companyId),
          ],
        }),
      );
      return json(201, { company: publicCompany(company, 'OWNER') });
    } catch (err) {
      if (err.name !== 'TransactionCanceledException') throw err;
      if (err.CancellationReasons?.[3]?.Code === 'ConditionalCheckFailed') {
        throw conflict('คุณอยู่ในทีมอยู่แล้ว (1 คนอยู่ได้ 1 ทีม)', { code: 'ALREADY_IN_TEAM' });
      }
      // รหัสเชิญชนกัน → สุ่มใหม่
    }
  }
  throw conflict('สร้างรหัสเชิญไม่สำเร็จ กรุณาลองใหม่');
}

export async function joinCompany(event, uid) {
  const code = requireString(parseBody(event).inviteCode, 'รหัสเชิญ', { max: 20 }).toUpperCase();
  const user = await getUserOrThrow(uid);
  await assertNoTeam(user);
  const invite = await getItem(keys.invite(code));
  if (!invite) throw notFound('ไม่พบรหัสเชิญนี้ หรือรหัสถูกเปลี่ยนแล้ว');
  const company = await getItem(keys.company(invite.companyId));
  if (!company) throw notFound('ไม่พบทีม');
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: memberItem(company, user, 'MEMBER'), ConditionExpression: 'attribute_not_exists(PK)' } },
          bindProfile(uid, company.companyId),
        ],
      }),
    );
  } catch (err) {
    if (err.name === 'TransactionCanceledException') {
      throw conflict('คุณอยู่ในทีมอยู่แล้ว (1 คนอยู่ได้ 1 ทีม)', { code: 'ALREADY_IN_TEAM' });
    }
    throw err;
  }
  return json(201, { company: publicCompany(company, 'MEMBER') });
}

export async function getCompany(_event, uid, cid) {
  const member = await requireMember(cid, uid);
  const company = await getItem(keys.company(cid));
  if (!company) throw notFound('ไม่พบทีม');
  const memberCount = member.role === 'OWNER' ? (await queryPrefix(`COMPANY#${cid}`, 'MEMBER#')).length : undefined;
  return json(200, { company: { ...publicCompany(company, member.role), memberCount } });
}

// สมาชิก
export async function listMembers(_event, uid, cid) {
  await requireOwner(cid, uid);
  const company = await getItem(keys.company(cid));
  const members = await queryPrefix(`COMPANY#${cid}`, 'MEMBER#');
  const withUsage = await Promise.all(
    members.map(async (m) => {
      const u = await getItem(keys.user(m.userId));
      return {
        userId: m.userId, name: m.name, email: m.email, role: m.role, joinedAt: m.joinedAt,
        usedBytes: u?.usedBytes ?? 0, quotaBytes: u?.quotaBytes ?? 0,
      };
    }),
  );
  withUsage.sort((a, b) => (a.role === 'OWNER' ? -1 : b.role === 'OWNER' ? 1 : b.usedBytes - a.usedBytes));
  return json(200, {
    members: withUsage,
    companyUsedBytes: company?.usedBytes ?? 0,
    companyQuotaBytes: company?.quotaBytes ?? defaultTeamQuota(),
  });
}

// หัวหน้านำสมาชิกออก หรือสมาชิกออกจากทีมเอง (หัวหน้าออกไม่ได้ ต้องยุบทีม)
// งานที่ยังรอตรวจของคนนั้นจะถูกยกเลิกและปลดล็อกไฟล์คืน
export async function removeMember(_event, uid, cid, targetUid) {
  const actor = await requireMember(cid, uid);
  if (targetUid !== uid && actor.role !== 'OWNER') throw forbidden('เฉพาะหัวหน้าทีมเท่านั้น');
  const target = await getItem(keys.member(cid, targetUid));
  if (!target) throw notFound('ไม่พบสมาชิก');
  if (target.role === 'OWNER') {
    throw badRequest('หัวหน้าทีมออกจากทีมไม่ได้ ให้นำสมาชิกออกให้หมดแล้วกด "ยุบทีม"', { code: 'OWNER_CANNOT_LEAVE' });
  }

  const tasks = await queryPrefix(`COMPANY#${cid}`, 'TASK#');
  for (const task of tasks) {
    const subs = await queryPrefix(`TASK#${task.taskId}`, 'SUB#');
    for (const sub of subs.filter((s) => s.userId === targetUid && s.status === 'PENDING')) {
      await cancelSubmission(sub);
    }
  }
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [{ Delete: { TableName: TABLE, Key: keys.member(cid, targetUid) } }, unbindProfile(targetUid)],
    }),
  );
  return json(200, { removed: true });
}

export async function rotateInviteCode(_event, uid, cid) {
  await requireOwner(cid, uid);
  const company = await getItem(keys.company(cid));
  for (let attempt = 0; attempt < 3; attempt++) {
    const inviteCode = newInviteCode();
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: TABLE, Item: { ...keys.invite(inviteCode), companyId: cid }, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Delete: { TableName: TABLE, Key: keys.invite(company.inviteCode) } },
            {
              Update: {
                TableName: TABLE,
                Key: keys.company(cid),
                UpdateExpression: 'SET inviteCode = :code',
                ExpressionAttributeValues: { ':code': inviteCode },
              },
            },
          ],
        }),
      );
      return json(200, { inviteCode });
    } catch (err) {
      if (err.name !== 'TransactionCanceledException') throw err;
    }
  }
  throw conflict('สร้างรหัสเชิญไม่สำเร็จ กรุณาลองใหม่');
}

// พื้นที่ทีม (เฉพาะหัวหน้า)
// รายการ + ค้นหาไฟล์ในพื้นที่ทีม (เฉพาะหัวหน้า)
//   ?q=     ค้นจากชื่อไฟล์ ชื่อคนส่ง ชื่องาน หมายเหตุ และความเห็นตอน Approve (ไม่สนตัวพิมพ์)
//   ?taskId= กรองเฉพาะงานเดียว
// ทุกรายการบอกที่มา: Approve จากงานไหน ใครส่ง ส่งเมื่อไหร่ Approve เมื่อไหร่
export async function listTeamFiles(event, uid, cid) {
  await requireOwner(cid, uid);
  const company = await getItem(keys.company(cid));
  let files = await queryPrefix(`COMPANY#${cid}`, 'TFILE#');
  files = await backfillTeamFiles(cid, company, files);

  const tasks = [...new Map(files.map((f) => [f.taskId, { taskId: f.taskId, taskTitle: f.taskTitle }])).values()]
    .sort((a, b) => a.taskTitle.localeCompare(b.taskTitle, 'th'));
  const totalCount = files.length;

  const q = (event.queryStringParameters?.q || '').trim().toLocaleLowerCase('th');
  const taskId = event.queryStringParameters?.taskId || '';
  if (taskId) files = files.filter((f) => f.taskId === taskId);
  if (q) {
    files = files.filter((f) =>
      [f.name, f.userName, f.taskTitle, f.note, f.reviewComment]
        .some((v) => typeof v === 'string' && v.toLocaleLowerCase('th').includes(q)),
    );
  }
  files.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));

  return json(200, {
    files: files.map((f) => ({
      fileId: f.fileId, name: f.name, size: f.size, contentType: f.contentType,
      // ที่มาของไฟล์
      taskId: f.taskId, taskTitle: f.taskTitle, submissionId: f.submissionId,
      userId: f.userId, userName: f.userName, submittedAt: f.submittedAt, approvedAt: f.approvedAt,
      note: f.note, reviewComment: f.reviewComment,
    })),
    totalCount,
    tasks,
    usedBytes: company?.usedBytes ?? 0,
    quotaBytes: company?.quotaBytes ?? defaultTeamQuota(),
  });
}

// ไฟล์ที่ Approve ก่อนมีรายการ TFILE (ข้อมูลรุ่นเก่า) → สร้างรายการให้จากประวัติการส่งงาน
// ทำเฉพาะเมื่อพื้นที่ที่นับไว้มากกว่าผลรวมไฟล์ที่มีรายการ (แปลว่ายังมีไฟล์ตกหล่น)
async function backfillTeamFiles(cid, company, files) {
  const listed = files.reduce((sum, f) => sum + f.size, 0);
  if (!company || (company.usedBytes ?? 0) <= listed) return files;
  const have = new Set(files.map((f) => f.fileId));
  const added = [];
  for (const task of await queryPrefix(`COMPANY#${cid}`, 'TASK#')) {
    for (const sub of await queryPrefix(`TASK#${task.taskId}`, 'SUB#')) {
      if (sub.status !== 'APPROVED') continue;
      for (const f of sub.files) {
        if (have.has(f.fileId) || !f.companyKey) continue;
        added.push({
          ...keys.teamFile(cid, f.fileId), type: 'TEAM_FILE',
          fileId: f.fileId, name: f.name, size: f.size, contentType: f.contentType, companyKey: f.companyKey,
          taskId: task.taskId, taskTitle: task.title, submissionId: sub.submissionId,
          userId: sub.userId, userName: sub.userName, submittedAt: sub.createdAt,
          approvedAt: sub.reviewedAt || sub.createdAt, note: sub.note, reviewComment: sub.comment,
          reviewedBy: sub.reviewedBy,
        });
        have.add(f.fileId);
      }
    }
  }
  for (const item of added) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' })).catch(() => {});
  }
  return [...files, ...added];
}

async function getTeamFileOrThrow(cid, fid) {
  const f = await getItem(keys.teamFile(cid, fid));
  if (!f) throw notFound('ไม่พบไฟล์ในพื้นที่ทีม');
  return f;
}

export async function teamFileDownloadUrl(_event, uid, cid, fid) {
  await requireOwner(cid, uid);
  const f = await getTeamFileOrThrow(cid, fid);
  const head = await headObject(f.companyKey);
  if (!head) throw notFound('ไม่พบไฟล์ใน S3');
  const state = archiveState(head);
  if (state.archived && !state.restored) {
    throw conflict(state.restoring ? 'กำลังกู้คืนไฟล์จาก Deep Archive (12–48 ชม.)' : 'ไฟล์ถูกเก็บถาวร (Deep Archive) กดกู้คืนก่อนดาวน์โหลด', {
      code: 'ARCHIVED', restoring: state.restoring,
    });
  }
  return json(200, { url: await presignDownload({ key: f.companyKey, fileName: f.name }), storageClass: head.StorageClass || 'STANDARD' });
}

export async function restoreTeamFile(_event, uid, cid, fid) {
  await requireOwner(cid, uid);
  const f = await getTeamFileOrThrow(cid, fid);
  const state = archiveState(await headObject(f.companyKey));
  if (!state.archived) throw badRequest('ไฟล์นี้ไม่ได้อยู่ใน Deep Archive ดาวน์โหลดได้เลย');
  if (state.restored) return json(200, { restoring: false, restored: true });
  try {
    await s3.send(
      new RestoreObjectCommand({
        Bucket: BUCKET, Key: f.companyKey, RestoreRequest: { Days: 7, GlacierJobParameters: { Tier: 'Standard' } },
      }),
    );
  } catch (err) {
    if (err.name !== 'RestoreAlreadyInProgress') throw err;
  }
  return json(202, { restoring: true });
}

// ลบไฟล์ออกจากพื้นที่ทีม → คืนพื้นที่ทีม และรายการใน "งานที่ส่งแล้ว" ของสมาชิกหายไปด้วย
export async function deleteTeamFile(_event, uid, cid, fid) {
  await requireOwner(cid, uid);
  const f = await getTeamFileOrThrow(cid, fid);
  await deleteAllVersions(f.companyKey);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: TABLE, Key: keys.teamFile(cid, fid), ConditionExpression: 'attribute_exists(PK)' } },
          {
            Update: {
              TableName: TABLE,
              Key: keys.company(cid),
              UpdateExpression: 'ADD usedBytes :d',
              ExpressionAttributeValues: { ':d': -f.size },
            },
          },
          {
            Delete: {
              TableName: TABLE,
              Key: keys.file(f.userId, fid),
              ConditionExpression: 'attribute_not_exists(PK) OR #s = :moved',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':moved': 'MOVED' },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err; // ถูกลบไปแล้ว
  }
  return json(200, { deleted: true });
}

// ยุบทีม
// ทำได้เมื่อเหลือหัวหน้าคนเดียว และต้องพิมพ์ชื่อทีมยืนยัน
export async function deleteCompany(event, uid, cid) {
  await requireOwner(cid, uid);
  const company = await getItem(keys.company(cid));
  if (!company) throw notFound('ไม่พบทีม');
  const body = parseBody(event);
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName.trim() : '';
  if (confirmName !== company.name) throw badRequest('พิมพ์ชื่อทีมไม่ตรง', { code: 'CONFIRM_MISMATCH' });

  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `COMPANY#${cid}` },
  });
  const others = items.filter((i) => i.type === 'MEMBER' && i.role !== 'OWNER');
  if (others.length) {
    throw conflict(`ต้องนำสมาชิกออกให้หมดก่อน (เหลืออีก ${others.length} คน)`, { code: 'TEAM_HAS_MEMBERS', remaining: others.length });
  }

  // 1) ลบไฟล์ทุกไฟล์ทุกเวอร์ชันของทีมใน S3
  await deletePrefixAllVersions(`companies/${cid}/`);

  // 2) ลบข้อมูลทั้งหมดใน DynamoDB: ทีม สมาชิก งาน ไฟล์ทีม การส่งงาน รหัสเชิญ
  //    และรายการ "งานที่ส่งแล้ว" (MOVED) ของคนที่เคยอยู่ทีมนี้ เพราะไฟล์ถูกลบไปแล้ว
  const toDelete = items.map((i) => ({ PK: i.PK, SK: i.SK }));
  toDelete.push(keys.invite(company.inviteCode));
  for (const task of items.filter((i) => i.type === 'TASK')) {
    const subs = await queryPrefix(`TASK#${task.taskId}`, 'SUB#');
    for (const sub of subs) {
      toDelete.push({ PK: sub.PK, SK: sub.SK });
      if (sub.status === 'APPROVED') {
        for (const f of sub.files) {
          const rec = await getItem(keys.file(sub.userId, f.fileId));
          if (rec?.status === 'MOVED') toDelete.push(keys.file(sub.userId, f.fileId));
        }
      }
    }
  }
  for (let i = 0; i < toDelete.length; i += 25) {
    let RequestItems = { [TABLE]: toDelete.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    for (let retry = 0; RequestItems && Object.keys(RequestItems).length && retry < 5; retry++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems }));
      RequestItems = res.UnprocessedItems;
    }
  }
  await ddb.send(new UpdateCommand(unbindProfile(uid).Update));
  return json(200, { deleted: true });
}

function publicCompany(c, role) {
  return {
    companyId: c.companyId,
    name: c.name,
    role,
    // รหัสเชิญและพื้นที่ทีมแสดงเฉพาะหัวหน้า
    ...(role === 'OWNER'
      ? { inviteCode: c.inviteCode, usedBytes: c.usedBytes ?? 0, quotaBytes: c.quotaBytes ?? defaultTeamQuota() }
      : {}),
    createdAt: c.createdAt,
  };
}
