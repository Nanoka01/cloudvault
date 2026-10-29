// ทดสอบ end-to-end: เรียก API ผ่าน HTTP จริง + อัปโหลดเข้า S3 ด้วย presigned POST
// โดยใช้ AWS จำลอง (moto server) ที่ test เปิดให้เอง ไม่ต้องมีบัญชี AWS
// รัน: npm test   (ต้องติดตั้ง: pip install "moto[server]")
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CopyObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';

const MOTO_PORT = 5099;
process.env.AWS_ENDPOINT_URL = `http://localhost:${MOTO_PORT}`;
process.env.TABLE_NAME = 'cv-test';
process.env.BUCKET_NAME = 'cv-test';
process.env.USER_QUOTA_BYTES = '5000'; // โควตาเล็ก ๆ เพื่อทดสอบการเต็ม
process.env.TEAM_QUOTA_BYTES = '45'; // พื้นที่ทีมเล็ก ๆ เพื่อทดสอบพื้นที่ทีมเต็ม
process.env.PORT = '0';
process.env.PUBLIC_API_URL = 'http://placeholder'; // แทนที่ด้านล่างเมื่อรู้พอร์ตจริง

let moto;
let server;
let API;
const s3 = new S3Client({ forcePathStyle: true, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

before(async () => {
  moto = spawn('python3', ['-m', 'moto.server', '-p', String(MOTO_PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${MOTO_PORT}`); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const { setupLocal } = await import('../local/setup.mjs');
  await setupLocal();
  const { createServer } = await import('../local/server.mjs');
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  API = `http://localhost:${server.address().port}`;
  process.env.PUBLIC_API_URL = API;
});

after(() => {
  server?.close();
  moto?.kill();
});

// helpers
async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? safeJson(text) : null, headers: res.headers };
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return t; } };

async function register(name) {
  const r = await call('POST', '/auth/register', null, { name, email: `${name}@test.com`, password: 'password123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
}

async function upload(token, name, content, fileId) {
  const blob = new Blob([content], { type: 'text/plain' });
  const r = await call('POST', '/files/upload-url', token, { name, contentType: 'text/plain', size: blob.size, fileId });
  if (r.status !== 200) return r;
  const form = new FormData();
  for (const [k, v] of Object.entries(r.body.upload.fields)) form.append(k, v);
  form.append('file', blob, name);
  const up = await fetch(r.body.upload.url, { method: 'POST', body: form });
  assert.ok(up.status < 300, `S3 upload failed ${up.status}`);
  return call('POST', `/files/${r.body.fileId}/confirm`, token);
}

const usage = async (token) => (await call('GET', '/me', token)).body.user.usedBytes;
const fileStatus = async (token, fid, view = 'active') =>
  (await call('GET', `/files?view=${view}`, token)).body.files.find((f) => f.fileId === fid)?.status;
const fetchText = async (url) => (await fetch(url)).text();

// tests
let owner, member, outsider, cid, tid, fileA, fileB;

test('สมัคร / login / อีเมลซ้ำ / ไม่มี token', async () => {
  owner = await register('owner');
  member = await register('member');
  outsider = await register('outsider');
  assert.equal((await call('POST', '/auth/register', null, { name: 'x', email: 'owner@test.com', password: 'password123' })).status, 409);
  assert.equal((await call('POST', '/auth/login', null, { email: 'owner@test.com', password: 'wrong-pass' })).status, 401);
  const ok = await call('POST', '/auth/login', null, { email: 'OWNER@test.com', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('GET', '/me', 'bad.token.here')).status, 401);
});

test('อัปโหลดเข้า My Files ด้วย presigned POST และนับโควตา', async () => {
  const a = await upload(member, 'รายงาน บทที่1.txt', 'version-1 of report');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  fileA = a.body.file.fileId;
  assert.equal(a.body.file.status, 'ACTIVE');
  const b = await upload(member, 'slides.txt', 'slides content');
  fileB = b.body.file.fileId;
  assert.equal(await usage(member), 'version-1 of report'.length + 'slides content'.length);

  const bad = await call('POST', '/files/upload-url', member, { name: 'virus.exe', contentType: 'application/octet-stream', size: 10 });
  assert.equal(bad.status, 400);
  const tooBig = await call('POST', '/files/upload-url', member, { name: 'big.txt', contentType: 'text/plain', size: 999999 });
  assert.equal(tooBig.status, 409);
  assert.equal(tooBig.body.code, 'QUOTA_EXCEEDED');

  // ค้นหาด้วยชื่อ (ภาษาไทย)
  const search = await call('GET', `/files?q=${encodeURIComponent('บทที่')}`, member);
  assert.deepEqual(search.body.files.map((f) => f.fileId), [fileA]);
  // คนอื่นเข้าไฟล์เราไม่ได้
  assert.equal((await call('GET', `/files/${fileA}/download-url`, outsider)).status, 404);
});

test('เวอร์ชันไฟล์: อัปโหลดทับ แล้วกู้คืนเวอร์ชันเก่า', async () => {
  // เวอร์ชันใหม่ต้องนามสกุลเดียวกับไฟล์เดิม
  const wrongExt = await call('POST', '/files/upload-url', member, { fileId: fileA, name: 'report.pdf', contentType: 'application/pdf', size: 10 });
  assert.equal(wrongExt.status, 400);
  assert.equal(wrongExt.body.code, 'EXTENSION_MISMATCH');
  const v2 = await upload(member, 'report-edited.txt', 'version-2 of the report!!', fileA);
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  const versions = (await call('GET', `/files/${fileA}/versions`, member)).body.versions;
  assert.equal(versions.length, 2);
  const old = versions.find((v) => !v.isCurrent);
  const restored = await call('POST', `/files/${fileA}/versions/${encodeURIComponent(old.versionId)}/restore`, member);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const dl = await call('GET', `/files/${fileA}/download-url`, member);
  assert.equal(await fetchText(dl.body.url), 'version-1 of report');
  assert.equal(await usage(member), 'version-1 of report'.length + 'slides content'.length);
});

test('ถังขยะ: ลบ → กู้คืน และลิงก์แชร์', async () => {
  assert.equal((await call('DELETE', `/files/${fileB}`, member)).status, 200);
  assert.equal(await fileStatus(member, fileB, 'trash'), 'TRASHED');
  assert.equal((await call('POST', `/files/${fileB}/restore`, member)).status, 200);
  assert.equal(await fileStatus(member, fileB), 'ACTIVE');

  const share = await call('POST', `/files/${fileB}/share`, member, { hours: 1 });
  assert.equal(share.status, 200);
  const open = await fetch(share.body.url, { redirect: 'manual' });
  assert.equal(open.status, 302);
  assert.equal(await fetchText(open.headers.get('location')), 'slides content');
  assert.equal((await fetch(`${API}/share/forged.token.value`)).status, 410);

  // หน้าดาวน์โหลดลิงก์แชร์ (ไม่ต้อง login): ชื่อ ขนาด คนแชร์ วันหมดอายุ
  assert.ok(share.body.token);
  const info = await call('GET', `/share/${share.body.token}/info`);
  assert.equal(info.status, 200);
  assert.equal(info.body.name, 'slides.txt');
  assert.equal(info.body.size, 'slides content'.length);
  assert.equal(info.body.sharedBy, 'member');
  assert.ok(new Date(info.body.expiresAt) > new Date());
  assert.equal(info.body.s3Key, undefined);
  const bad = await call('GET', '/share/forged.token.value/info');
  assert.equal(bad.status, 410);
  assert.equal(bad.body.code, 'LINK_EXPIRED');
});

test('ทีม: สร้าง / เข้าร่วมด้วยรหัสเชิญ / สิทธิ์ / 1 คน 1 ทีม', async () => {
  const c = await call('POST', '/companies', owner, { name: 'ทีมทดสอบ' });
  assert.equal(c.status, 201);
  cid = c.body.company.companyId;
  assert.match(c.body.company.inviteCode, /^CV-[A-Z2-9]{6}$/);
  assert.equal((await call('POST', '/companies/join', member, { inviteCode: c.body.company.inviteCode.toLowerCase() })).status, 201);
  assert.equal((await call('POST', '/companies/join', member, { inviteCode: c.body.company.inviteCode })).status, 409);
  assert.equal((await call('POST', '/companies/join', outsider, { inviteCode: 'CV-XXXXXX' })).status, 404);

  const me = await call('GET', '/me', member);
  assert.equal(me.body.team.role, 'MEMBER');
  assert.equal((await call('GET', '/me', outsider)).body.team, null);

  // 1 คน 1 ทีม: อยู่ทีมแล้วสร้าง/เข้าร่วมทีมอื่นไม่ได้
  assert.equal((await call('POST', '/companies', member, { name: 'ทีมที่สอง' })).body.code, 'ALREADY_IN_TEAM');
  assert.equal((await call('POST', '/companies', owner, { name: 'ทีมที่สอง' })).body.code, 'ALREADY_IN_TEAM');
  const other = await call('POST', '/companies', outsider, { name: 'ทีมคนนอก' });
  assert.equal(other.status, 201);
  assert.equal((await call('POST', '/companies/join', member, { inviteCode: other.body.company.inviteCode })).body.code, 'ALREADY_IN_TEAM');
  // ทีมใหม่ได้พื้นที่ทีมของตัวเอง
  assert.equal(other.body.company.quotaBytes, 45);
  // คนนอกยุบทีมของตัวเอง (ยังไม่มีสมาชิก) เพื่อกลับไปเป็นคนไม่มีทีม
  assert.equal((await call('DELETE', `/companies/${other.body.company.companyId}`, outsider, { confirmName: 'ทีมคนนอก' })).status, 200);
  assert.equal((await call('GET', '/me', outsider)).body.team, null);

  // หัวหน้าออกจากทีมไม่ได้
  const ownerId = (await call('GET', '/me', owner)).body.user.userId;
  assert.equal((await call('DELETE', `/companies/${cid}/members/${ownerId}`, owner)).body.code, 'OWNER_CANNOT_LEAVE');
  const asMember = await call('GET', `/companies/${cid}`, member);
  assert.equal(asMember.body.company.inviteCode, undefined); // สมาชิกไม่เห็นรหัสเชิญ
  assert.equal((await call('GET', `/companies/${cid}/members`, member)).status, 403);
  assert.equal((await call('GET', `/companies/${cid}`, outsider)).status, 403);
  assert.equal((await call('POST', `/companies/${cid}/tasks`, member, { title: 'x', assignees: [] })).status, 403);
});

test('สั่งงาน และส่งงาน → ไฟล์ถูกล็อก', async () => {
  const memberId = (await call('GET', '/me', member)).body.user.userId;
  const t = await call('POST', `/companies/${cid}/tasks`, owner, {
    title: 'ส่งรายงานบทที่ 1', description: 'ส่งเป็น PDF', dueDate: '2099-12-31', assignees: [memberId],
  });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  tid = t.body.task.taskId;
  assert.equal((await call('GET', `/companies/${cid}/tasks`, member)).body.tasks.length, 1);

  const sub = await call('POST', `/companies/${cid}/tasks/${tid}/submissions`, member, { fileIds: [fileA, fileB], note: 'ส่งครับ' });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(await fileStatus(member, fileA), 'LOCKED');

  // ไฟล์ที่ล็อก: ลบ / แชร์ / อัปโหลดทับ / ส่งซ้ำ ไม่ได้
  assert.equal((await call('DELETE', `/files/${fileA}`, member)).status, 409);
  assert.equal((await call('POST', `/files/${fileA}/share`, member, {})).status, 409);
  assert.equal((await call('POST', '/files/upload-url', member, { fileId: fileA, contentType: 'text/plain', size: 5 })).status, 409);
  assert.equal((await call('POST', `/companies/${cid}/tasks/${tid}/submissions`, member, { fileIds: [fileA] })).status, 409);
  // แต่ยังดาวน์โหลดของตัวเองได้
  assert.equal((await call('GET', `/files/${fileA}/download-url`, member)).status, 200);
});

test('Reject → ปลดล็อก แล้วส่งใหม่', async () => {
  const detail = await call('GET', `/companies/${cid}/tasks/${tid}`, owner);
  const sid = detail.body.submissions[0].submissionId;
  const dl = await call('GET', `/companies/${cid}/tasks/${tid}/submissions/${sid}/files/${fileA}/download-url`, owner);
  assert.equal(await fetchText(dl.body.url), 'version-1 of report');
  assert.equal((await call('GET', `/companies/${cid}/tasks/${tid}/submissions/${sid}/files/${fileA}/download-url`, outsider)).status, 403);

  const rej = await call('PATCH', `/companies/${cid}/tasks/${tid}/submissions/${sid}`, owner, { action: 'reject', comment: 'แก้หน้า 2' });
  assert.equal(rej.status, 200);
  assert.equal(await fileStatus(member, fileA), 'ACTIVE');
  assert.equal((await call('PATCH', `/companies/${cid}/tasks/${tid}/submissions/${sid}`, owner, { action: 'approve' })).status, 409);

  const again = await call('POST', `/companies/${cid}/tasks/${tid}/submissions`, member, { fileIds: [fileA] });
  assert.equal(again.status, 201);
});

test('Approve → ย้ายไปพื้นที่ทีม คืนโควตา ลบไฟล์ฝั่งผู้ใช้ทุกเวอร์ชัน', async () => {
  const before = await usage(member);
  const detail = await call('GET', `/companies/${cid}/tasks/${tid}`, owner);
  const pending = detail.body.submissions.find((s) => s.status === 'PENDING');
  assert.equal((await call('PATCH', `/companies/${cid}/tasks/${tid}/submissions/${pending.submissionId}`, member, { action: 'approve' })).status, 403);

  const ok = await call('PATCH', `/companies/${cid}/tasks/${tid}/submissions/${pending.submissionId}`, owner, { action: 'approve', comment: 'ดีมาก' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await usage(member), before - 'version-1 of report'.length);

  // ไฟล์หายจาก My Files แต่อยู่ในแท็บ "งานที่ส่งแล้ว"
  assert.equal(await fileStatus(member, fileA), undefined);
  assert.equal(await fileStatus(member, fileA, 'submitted'), 'MOVED');

  // ฝั่งผู้ใช้ไม่เหลือเวอร์ชันใดเลย (พื้นที่คืนจริง)
  const memberId = (await call('GET', '/me', member)).body.user.userId;
  const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: 'cv-test', Prefix: `users/${memberId}/files/${fileA}` }));
  assert.equal((versions.Versions || []).length + (versions.DeleteMarkers || []).length, 0);

  // ทั้ง owner และผู้ส่งดาวน์โหลดจากพื้นที่ทีมได้
  const dlOwner = await call('GET', `/companies/${cid}/tasks/${tid}/submissions/${pending.submissionId}/files/${fileA}/download-url`, owner);
  assert.equal(await fetchText(dlOwner.body.url), 'version-1 of report');
  const dlMember = await call('GET', `/files/${fileA}/download-url`, member);
  assert.equal(await fetchText(dlMember.body.url), 'version-1 of report');

  const company = await call('GET', `/companies/${cid}/members`, owner);
  assert.equal(company.body.companyUsedBytes, 'version-1 of report'.length);

  // พื้นที่ทีม: หัวหน้าเห็นรายการไฟล์ สมาชิกไม่เห็น
  const teamFiles = await call('GET', `/companies/${cid}/files`, owner);
  assert.equal(teamFiles.status, 200);
  assert.deepEqual(teamFiles.body.files.map((f) => f.name), ['รายงาน บทที่1.txt']);
  assert.equal(teamFiles.body.files[0].userName, 'member');
  assert.equal(teamFiles.body.quotaBytes, 45);
  assert.equal((await call('GET', `/companies/${cid}/files`, member)).status, 403);
  const dlTeam = await call('GET', `/companies/${cid}/files/${fileA}/download-url`, owner);
  assert.equal(await fetchText(dlTeam.body.url), 'version-1 of report');

  // ค้นหาในพื้นที่ทีม: ชื่อไฟล์ / ชื่อคนส่ง / ชื่องาน / ความเห็นตอน Approve + บอกที่มา
  const search = async (q, extra = '') =>
    (await call('GET', `/companies/${cid}/files?q=${encodeURIComponent(q)}${extra}`, owner)).body;
  const byName = await search('บทที่1');
  assert.equal(byName.files.length, 1);
  const hit = byName.files[0];
  assert.equal(hit.taskId, tid);
  assert.equal(hit.taskTitle, 'ส่งรายงานบทที่ 1');
  assert.equal(hit.submissionId, pending.submissionId);
  assert.equal(hit.userName, 'member');
  assert.equal(hit.reviewComment, 'ดีมาก');
  assert.ok(hit.submittedAt && hit.approvedAt);
  assert.equal((await search('MEMBER')).files.length, 1); // ไม่สนตัวพิมพ์เล็กใหญ่
  assert.equal((await search('ส่งรายงาน')).files.length, 1); // ชื่องาน
  assert.equal((await search('ดีมาก')).files.length, 1); // ความเห็นตอน Approve
  const none = await search('ไม่มีไฟล์นี้แน่นอน');
  assert.equal(none.files.length, 0);
  assert.equal(none.totalCount, 1);
  assert.deepEqual(none.tasks.map((t) => t.taskId), [tid]);
  assert.equal((await search('', `&taskId=${tid}`)).files.length, 1);
  assert.equal((await search('', '&taskId=nope')).files.length, 0);

  // ข้อมูลรุ่นเก่า (Approve ก่อนมีรายการไฟล์ทีม) → ระบบสร้างรายการคืนให้อัตโนมัติ
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await doc.send(new DeleteCommand({ TableName: 'cv-test', Key: { PK: `COMPANY#${cid}`, SK: `TFILE#${fileA}` } }));
  const restored = await search('บทที่1');
  assert.equal(restored.files.length, 1);
  assert.equal(restored.files[0].submissionId, pending.submissionId);
});

test('Deep Archive: ดาวน์โหลดไม่ได้จนกว่าจะกู้คืน', async () => {
  const detail = await call('GET', `/companies/${cid}/tasks/${tid}`, owner);
  const approved = detail.body.submissions.find((s) => s.status === 'APPROVED');
  const memberId = (await call('GET', '/me', member)).body.user.userId;
  // จำลองว่า Lifecycle ย้ายไฟล์ไป Deep Archive แล้ว
  const list = await s3.send(new ListObjectVersionsCommand({ Bucket: 'cv-test', Prefix: `companies/${cid}/approved/${tid}/${memberId}/` }));
  const key = list.Versions[0].Key;
  await s3.send(new CopyObjectCommand({ Bucket: 'cv-test', Key: key, CopySource: `cv-test/${key.split('/').map(encodeURIComponent).join('/')}`, StorageClass: 'DEEP_ARCHIVE' }));
  const head = await s3.send(new HeadObjectCommand({ Bucket: 'cv-test', Key: key }));
  assert.equal(head.StorageClass, 'DEEP_ARCHIVE');

  const base = `/companies/${cid}/tasks/${tid}/submissions/${approved.submissionId}/files/${fileA}`;
  const blocked = await call('GET', `${base}/download-url`, owner);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'ARCHIVED');
  assert.equal((await call('GET', `/files/${fileA}/download-url`, member)).body.code, 'ARCHIVED');
  assert.equal((await call('POST', `${base}/restore`, member)).status, 403);
  assert.equal((await call('POST', `${base}/restore`, owner)).status, 202);
});

test('ทำสำเนากลับมา My Files ได้ครั้งเดียว / ลบงานที่ส่งแล้วไม่ได้', async () => {
  const fresh = await upload(member, 'notes.txt', 'n');
  const t = await call('POST', `/companies/${cid}/tasks`, owner, {
    title: 'งานสอง', assignees: [(await call('GET', '/me', member)).body.user.userId],
  });
  const tid2 = t.body.task.taskId;
  const s = await call('POST', `/companies/${cid}/tasks/${tid2}/submissions`, member, { fileIds: [fresh.body.file.fileId] });
  await call('PATCH', `/companies/${cid}/tasks/${tid2}/submissions/${s.body.submission.submissionId}`, owner, { action: 'approve' });

  const movedId = fresh.body.file.fileId;
  const before = await usage(member);
  const copy = await call('POST', `/files/${movedId}/copy-to-drive`, member);
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  const copyId = copy.body.file.fileId;
  assert.equal(await fileStatus(member, copyId), 'ACTIVE');
  assert.equal(await usage(member), before + 1);

  // กดซ้ำ → ไม่สร้างสำเนาใหม่ ไม่กินพื้นที่เพิ่ม
  const again = await call('POST', `/files/${movedId}/copy-to-drive`, member);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ALREADY_COPIED');
  assert.equal(await usage(member), before + 1);
  const submitted = (await call('GET', '/files?view=submitted', member)).body.files.find((f) => f.fileId === movedId);
  assert.equal(submitted.copiedFileId, copyId);

  // สำเนาอยู่ในถังขยะ → ยังทำซ้ำไม่ได้
  await call('DELETE', `/files/${copyId}`, member);
  assert.equal((await call('POST', `/files/${movedId}/copy-to-drive`, member)).body.code, 'ALREADY_COPIED');
  // ลบสำเนาถาวรแล้ว → ทำสำเนาใหม่ได้อีกครั้ง
  await call('DELETE', `/files/${copyId}/permanent`, member);
  assert.equal(await usage(member), before);
  assert.equal((await call('POST', `/files/${movedId}/copy-to-drive`, member)).status, 201);
  assert.equal(await usage(member), before + 1);

  // งานที่ส่งแล้วลบ/ซ่อนไม่ได้
  const del = await call('DELETE', `/files/${movedId}`, member);
  assert.equal(del.status, 409);
  assert.equal(await fileStatus(member, movedId, 'submitted'), 'MOVED');
});

test('พื้นที่ทีมเต็ม → Approve ไม่ได้ / หัวหน้าลบไฟล์ทีมแล้วคืนพื้นที่', async () => {
  const memberId = (await call('GET', '/me', member)).body.user.userId;
  const big = (await upload(member, 'big.txt', 'x'.repeat(30))).body.file.fileId; // ใช้แล้ว 20 + 30 > 45
  const t = await call('POST', `/companies/${cid}/tasks`, owner, { title: 'งานใหญ่', assignees: [memberId] });
  const tid3 = t.body.task.taskId;
  const s = await call('POST', `/companies/${cid}/tasks/${tid3}/submissions`, member, { fileIds: [big] });
  const sid = s.body.submission.submissionId;

  const full = await call('PATCH', `/companies/${cid}/tasks/${tid3}/submissions/${sid}`, owner, { action: 'approve' });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'TEAM_QUOTA_EXCEEDED');
  assert.equal(await fileStatus(member, big), 'LOCKED'); // ยังรอตรวจอยู่ ไม่มีอะไรเปลี่ยน

  // หัวหน้าลบไฟล์เก่าในพื้นที่ทีม → พื้นที่คืน และรายการในงานที่ส่งแล้วของสมาชิกหายไป
  assert.equal((await call('DELETE', `/companies/${cid}/files/${fileA}`, member)).status, 403);
  assert.equal((await call('DELETE', `/companies/${cid}/files/${fileA}`, owner)).status, 200);
  assert.equal(await fileStatus(member, fileA, 'submitted'), undefined);
  assert.equal((await call('GET', `/companies/${cid}/files`, owner)).body.usedBytes, 1);

  const ok = await call('PATCH', `/companies/${cid}/tasks/${tid3}/submissions/${sid}`, owner, { action: 'approve' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await call('GET', `/companies/${cid}/files`, owner)).body.usedBytes, 31);
});

test('ลบสมาชิก → งานที่รอตรวจถูกยกเลิกและปลดล็อกไฟล์', async () => {
  const memberId = (await call('GET', '/me', member)).body.user.userId;
  const t = await call('POST', `/companies/${cid}/tasks`, owner, { title: 'งานสาม', assignees: [memberId] });
  const s = await call('POST', `/companies/${cid}/tasks/${t.body.task.taskId}/submissions`, member, { fileIds: [fileB] });
  assert.equal(s.status, 201);
  assert.equal(await fileStatus(member, fileB), 'LOCKED');

  assert.equal((await call('DELETE', `/companies/${cid}/members/${memberId}`, owner)).status, 200);
  assert.equal(await fileStatus(member, fileB), 'ACTIVE');
  assert.equal((await call('GET', `/companies/${cid}/tasks`, member)).status, 403);
  assert.equal((await call('GET', '/me', member)).body.team, null); // ไม่มีทีมแล้ว → เข้าร่วมทีมใหม่ได้
});

test('ลบถาวร → คืนโควตาและลบทุกเวอร์ชัน / เปลี่ยนรหัสเชิญ', async () => {
  const before = await usage(member);
  await call('DELETE', `/files/${fileB}`, member);
  assert.equal((await call('DELETE', `/files/${fileB}/permanent`, member)).status, 200);
  assert.equal(await usage(member), before - 'slides content'.length);
  assert.equal(await fileStatus(member, fileB, 'trash'), undefined);

  const old = (await call('GET', `/companies/${cid}`, owner)).body.company.inviteCode;
  const rotated = await call('POST', `/companies/${cid}/invite-code/rotate`, owner);
  assert.notEqual(rotated.body.inviteCode, old);
  assert.equal((await call('POST', '/companies/join', outsider, { inviteCode: old })).status, 404);
  assert.equal((await call('POST', '/companies/join', outsider, { inviteCode: rotated.body.inviteCode })).status, 201);
});

test('งานล้างถังขยะอัตโนมัติ: ลบไฟล์ที่อยู่ในถังขยะเกิน 30 วัน', async () => {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const oldFile = (await upload(outsider, 'old.txt', 'old-old')).body.file.fileId;
  const newFile = (await upload(outsider, 'new.txt', 'new')).body.file.fileId;
  await call('DELETE', `/files/${oldFile}`, outsider);
  await call('DELETE', `/files/${newFile}`, outsider);
  const uid = (await call('GET', '/me', outsider)).body.user.userId;
  await doc.send(new UpdateCommand({
    TableName: 'cv-test', Key: { PK: `USER#${uid}`, SK: `FILE#${oldFile}` },
    UpdateExpression: 'SET deletedAt = :d', ExpressionAttributeValues: { ':d': new Date(Date.now() - 40 * 864e5).toISOString() },
  }));

  const { handler: purge } = await import('../src/handlers/purge.mjs');
  const result = await purge();
  assert.equal(result.purged, 1);
  assert.equal(await fileStatus(outsider, oldFile, 'trash'), undefined);
  assert.equal(await fileStatus(outsider, newFile, 'trash'), 'TRASHED');
  assert.equal(await usage(outsider), 'new'.length);
});

test('สมาชิกออกจากทีมเอง / ยุบทีม: ต้องไม่มีสมาชิก + พิมพ์ชื่อยืนยัน → ไฟล์ทีมหายทั้งหมด', async () => {
  // outsider อยู่ในทีม (เข้าร่วมในเทสต์ก่อนหน้า) → ยุบไม่ได้
  const blocked = await call('DELETE', `/companies/${cid}`, owner, { confirmName: 'ทีมทดสอบ' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'TEAM_HAS_MEMBERS');

  // สมาชิกกดออกจากทีมเองได้เลย
  const outsiderId = (await call('GET', '/me', outsider)).body.user.userId;
  assert.equal((await call('DELETE', `/companies/${cid}/members/${outsiderId}`, outsider)).status, 200);
  assert.equal((await call('GET', '/me', outsider)).body.team, null);

  assert.equal((await call('DELETE', `/companies/${cid}`, member, { confirmName: 'ทีมทดสอบ' })).status, 403);
  assert.equal((await call('DELETE', `/companies/${cid}`, owner, { confirmName: 'ชื่อผิด' })).body.code, 'CONFIRM_MISMATCH');

  const memberSubmittedBefore = (await call('GET', '/files?view=submitted', member)).body.files.length;
  assert.ok(memberSubmittedBefore > 0);
  const del = await call('DELETE', `/companies/${cid}`, owner, { confirmName: 'ทีมทดสอบ' });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  // ไฟล์ทีมใน S3 หายหมด, งานที่ส่งแล้วของอดีตสมาชิกหายด้วย, หัวหน้ากลับเป็นคนไม่มีทีม
  const left = await s3.send(new ListObjectVersionsCommand({ Bucket: 'cv-test', Prefix: `companies/${cid}/` }));
  assert.equal((left.Versions || []).length + (left.DeleteMarkers || []).length, 0);
  assert.equal((await call('GET', '/files?view=submitted', member)).body.files.length, 0);
  assert.equal((await call('GET', '/me', owner)).body.team, null);
  assert.equal((await call('GET', `/companies/${cid}`, owner)).status, 403);
  // สำเนาที่ทำไว้ใน My Files ยังอยู่ (เป็นไฟล์ส่วนตัวแล้ว)
  assert.ok((await call('GET', '/files', member)).body.files.some((f) => f.name === 'notes.txt'));
  // สร้างทีมใหม่ได้
  assert.equal((await call('POST', '/companies', owner, { name: 'ทีมใหม่' })).status, 201);
});
