// บริษัท: สร้าง เข้าร่วมด้วยรหัสเชิญ จัดการสมาชิก และ Monitoring พื้นที่
import { DeleteCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/aws.mjs';
import { badRequest, conflict, forbidden, json, notFound, parseBody, requireString } from '../lib/http.mjs';
import {
  getItem, getUserOrThrow, keys, newId, newInviteCode, nowIso, queryPrefix, requireMember, requireOwner,
} from '../lib/model.mjs';
import { cancelSubmission } from './tasks.mjs';

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
  // GSI1: ดึง "บริษัทที่ฉันอยู่" ด้วย USER#uid
  GSI1PK: `USER#${user.userId}`,
  GSI1SK: `COMPANY#${company.companyId}`,
});

export async function createCompany(event, uid) {
  const name = requireString(parseBody(event).name, 'ชื่อบริษัท', { max: 100 });
  const user = await getUserOrThrow(uid);
  const companyId = newId();

  // สุ่มรหัสเชิญใหม่ถ้าบังเอิญซ้ำ (โอกาสน้อยมาก)
  for (let attempt = 0; attempt < 3; attempt++) {
    const inviteCode = newInviteCode();
    const company = {
      ...keys.company(companyId), type: 'COMPANY', companyId, name, ownerId: uid, inviteCode,
      usedBytes: 0, createdAt: nowIso(),
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: TABLE, Item: company, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: TABLE, Item: { ...keys.invite(inviteCode), companyId }, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: TABLE, Item: memberItem(company, user, 'OWNER') } },
          ],
        }),
      );
      return json(201, { company: publicCompany(company, 'OWNER') });
    } catch (err) {
      if (err.name !== 'TransactionCanceledException') throw err;
    }
  }
  throw conflict('สร้างรหัสเชิญไม่สำเร็จ กรุณาลองใหม่');
}

export async function joinCompany(event, uid) {
  const code = requireString(parseBody(event).inviteCode, 'รหัสเชิญ', { max: 20 }).toUpperCase();
  const invite = await getItem(keys.invite(code));
  if (!invite) throw notFound('ไม่พบรหัสเชิญนี้ หรือรหัสถูกเปลี่ยนแล้ว');
  const company = await getItem(keys.company(invite.companyId));
  if (!company) throw notFound('ไม่พบบริษัท');
  const user = await getUserOrThrow(uid);
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: memberItem(company, user, 'MEMBER'),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') throw conflict('คุณเป็นสมาชิกบริษัทนี้อยู่แล้ว');
    throw err;
  }
  return json(201, { company: publicCompany(company, 'MEMBER') });
}

export async function getCompany(_event, uid, cid) {
  const member = await requireMember(cid, uid);
  const company = await getItem(keys.company(cid));
  if (!company) throw notFound('ไม่พบบริษัท');
  return json(200, { company: publicCompany(company, member.role) });
}

// รายชื่อสมาชิก + พื้นที่ที่แต่ละคนใช้ (หน้า Monitoring) — เฉพาะ Owner
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
  withUsage.sort((a, b) => b.usedBytes - a.usedBytes);
  return json(200, { members: withUsage, companyUsedBytes: company?.usedBytes ?? 0 });
}

// Owner ลบสมาชิก หรือสมาชิกออกจากบริษัทเอง
// งานที่ยังรอตรวจของคนนั้นจะถูกยกเลิกและปลดล็อกไฟล์คืน
export async function removeMember(_event, uid, cid, targetUid) {
  const actor = await requireMember(cid, uid);
  if (targetUid !== uid && actor.role !== 'OWNER') throw forbidden('เฉพาะเจ้าของบริษัทเท่านั้น');
  const target = await getItem(keys.member(cid, targetUid));
  if (!target) throw notFound('ไม่พบสมาชิก');
  if (target.role === 'OWNER') throw badRequest('ลบเจ้าของบริษัทออกไม่ได้');

  const tasks = await queryPrefix(`COMPANY#${cid}`, 'TASK#');
  for (const task of tasks) {
    const subs = await queryPrefix(`TASK#${task.taskId}`, 'SUB#');
    for (const sub of subs.filter((s) => s.userId === targetUid && s.status === 'PENDING')) {
      await cancelSubmission(sub);
    }
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: keys.member(cid, targetUid) }));
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

function publicCompany(c, role) {
  return {
    companyId: c.companyId,
    name: c.name,
    role,
    // รหัสเชิญและพื้นที่รวมแสดงเฉพาะเจ้าของ
    ...(role === 'OWNER' ? { inviteCode: c.inviteCode, usedBytes: c.usedBytes ?? 0 } : {}),
    createdAt: c.createdAt,
  };
}

