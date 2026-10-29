// ทดสอบ end-to-end: เรียก API ผ่าน HTTP จริง + อัปโหลดเข้า S3 ด้วย presigned POST
// โดยใช้ AWS จำลอง (moto server) ที่ test เปิดให้เอง — ไม่ต้องมีบัญชี AWS
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

// ---------- helpers ----------
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

// ---------- tests ----------
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
  const v2 = await upload(member, 'ignored.txt', 'version-2 of the report!!', fileA);
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
});

test('บริษัท: สร้าง / เข้าร่วมด้วยรหัสเชิญ / สิทธิ์', async () => {
  const c = await call('POST', '/companies', owner, { name: 'บริษัท ทดสอบ จำกัด' });
  assert.equal(c.status, 201);
  cid = c.body.company.companyId;
  assert.match(c.body.company.inviteCode, /^CV-[A-Z2-9]{6}$/);
  assert.equal((await call('POST', '/companies/join', member, { inviteCode: c.body.company.inviteCode.toLowerCase() })).status, 201);
  assert.equal((await call('POST', '/companies/join', member, { inviteCode: c.body.company.inviteCode })).status, 409);
  assert.equal((await call('POST', '/companies/join', member, { inviteCode: 'CV-XXXXXX' })).status, 404);

  const me = await call('GET', '/me', member);
  assert.deepEqual(me.body.companies.map((x) => x.role), ['MEMBER']);
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

test('Approve → ย้ายไปพื้นที่บริษัท คืนโควตา ลบไฟล์ฝั่งผู้ใช้ทุกเวอร์ชัน', async () => {
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

  // ทั้ง owner และผู้ส่งดาวน์โหลดจากพื้นที่บริษัทได้
  const dlOwner = await call('GET', `/companies/${cid}/tasks/${tid}/submissions/${pending.submissionId}/files/${fileA}/download-url`, owner);
  assert.equal(await fetchText(dlOwner.body.url), 'version-1 of report');
  const dlMember = await call('GET', `/files/${fileA}/download-url`, member);
  assert.equal(await fetchText(dlMember.body.url), 'version-1 of report');

  const company = await call('GET', `/companies/${cid}/members`, owner);
  assert.equal(company.body.companyUsedBytes, 'version-1 of report'.length);
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

test('ทำสำเนากลับมา My Files / ซ่อนรายการงานที่ส่งแล้ว', async () => {
  const fresh = await upload(member, 'notes.txt', 'n');
  const t = await call('POST', `/companies/${cid}/tasks`, owner, {
    title: 'งานสอง', assignees: [(await call('GET', '/me', member)).body.user.userId],
  });
  const tid2 = t.body.task.taskId;
  const s = await call('POST', `/companies/${cid}/tasks/${tid2}/submissions`, member, { fileIds: [fresh.body.file.fileId] });
  await call('PATCH', `/companies/${cid}/tasks/${tid2}/submissions/${s.body.submission.submissionId}`, owner, { action: 'approve' });

  const copy = await call('POST', `/files/${fresh.body.file.fileId}/copy-to-drive`, member);
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  assert.equal(await fileStatus(member, copy.body.file.fileId), 'ACTIVE');

  assert.equal((await call('DELETE', `/files/${fresh.body.file.fileId}`, member)).body.hidden, true);
  assert.equal(await fileStatus(member, fresh.body.file.fileId, 'submitted'), undefined);
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
