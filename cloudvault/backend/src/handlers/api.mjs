// Lambda หลักของ API — รับทุก request จาก API Gateway แล้วส่งต่อตาม method + path
// ทุก path ยกเว้น /auth/* และ /share/* ผ่าน Lambda Authorizer มาแล้ว (uid อยู่ใน requestContext.authorizer)
import { HttpError, json } from '../lib/http.mjs';
import * as auth from '../routes/auth.mjs';
import * as files from '../routes/files.mjs';
import * as companies from '../routes/companies.mjs';
import * as tasks from '../routes/tasks.mjs';

const ID = '([A-Za-z0-9_-]+)';
const T = '/companies/' + ID + '/tasks/' + ID;

// [method, path regex, handler, ต้อง login ไหม]
const routes = [
  ['POST', '/auth/register', auth.register, false],
  ['POST', '/auth/login', auth.login, false],
  ['GET', '/share/([A-Za-z0-9_.-]+)', files.openShareLink, false],
  ['GET', '/me', auth.me],

  ['GET', '/files', files.listFiles],
  ['POST', '/files/upload-url', files.createUploadUrl],
  ['POST', `/files/${ID}/confirm`, files.confirmUpload],
  ['GET', `/files/${ID}/download-url`, files.downloadUrl],
  ['POST', `/files/${ID}/share`, files.createShareLink],
  ['PATCH', `/files/${ID}`, files.renameFile],
  ['DELETE', `/files/${ID}`, files.deleteFile],
  ['POST', `/files/${ID}/restore`, files.restoreFromTrash],
  ['DELETE', `/files/${ID}/permanent`, files.deletePermanently],
  ['GET', `/files/${ID}/versions`, files.listFileVersions],
  ['GET', `/files/${ID}/versions/([^/]+)/download-url`, files.versionDownloadUrl],
  ['POST', `/files/${ID}/versions/([^/]+)/restore`, files.restoreVersion],
  ['POST', `/files/${ID}/copy-to-drive`, files.copyToDrive],

  ['POST', '/companies', companies.createCompany],
  ['POST', '/companies/join', companies.joinCompany],
  ['GET', `/companies/${ID}`, companies.getCompany],
  ['GET', `/companies/${ID}/members`, companies.listMembers],
  ['DELETE', `/companies/${ID}/members/${ID}`, companies.removeMember],
  ['POST', `/companies/${ID}/invite-code/rotate`, companies.rotateInviteCode],

  ['POST', `/companies/${ID}/tasks`, tasks.createTask],
  ['GET', `/companies/${ID}/tasks`, tasks.listTasks],
  ['GET', T, tasks.getTask],
  ['POST', `${T}/submissions`, tasks.submitWork],
  ['PATCH', `${T}/submissions/${ID}`, tasks.reviewSubmission],
  ['GET', `${T}/submissions/${ID}/files/${ID}/download-url`, tasks.submissionFileUrl],
  ['POST', `${T}/submissions/${ID}/files/${ID}/restore`, tasks.restoreArchived],
].map(([method, path, handler, needsAuth = true]) => ({
  method, regex: new RegExp(`^${path}/?$`), handler, needsAuth,
}));

export async function handler(event) {
  const method = event.httpMethod;
  const path = event.path || '/';
  if (method === 'OPTIONS') return json(204, {});

  try {
    let pathMatched = false;
    for (const route of routes) {
      const match = path.match(route.regex);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = match.slice(1).map(decodeURIComponent);
      if (!route.needsAuth) return await route.handler(event, ...params);
      const uid = event.requestContext?.authorizer?.uid;
      if (!uid) return json(401, { message: 'กรุณาเข้าสู่ระบบ' });
      return await route.handler(event, uid, ...params);
    }
    return json(pathMatched ? 405 : 404, { message: pathMatched ? 'Method not allowed' : 'ไม่พบ API นี้' });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { message: err.message, ...err.extra });
    console.error('Unhandled error', { method, path, err });
    return json(500, { message: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
  }
}
