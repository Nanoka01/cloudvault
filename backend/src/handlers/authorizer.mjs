// Lambda Authorizer (TOKEN) ตรวจ JWT จาก header Authorization: Bearer <token>
// ผ่าน → Allow ทุก path ของ API นี้ (ให้ API Gateway cache ผลได้) และส่ง uid ต่อให้ Lambda หลัก
// ไม่ผ่าน → throw 'Unauthorized' = API Gateway ตอบ 401
// หมายเหตุ: JWT บอกแค่ว่า "เป็นใคร" สิทธิ์ในทีมตรวจจาก DynamoDB ใน Lambda หลักทุกครั้ง
import { verifyToken } from '../lib/jwt.mjs';

export async function handler(event) {
  const header = event.authorizationToken || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = await verifyToken(token, 'access');
  if (!payload?.sub) throw new Error('Unauthorized');

  // methodArn = arn:aws:execute-api:region:account:apiId/stage/METHOD/path
  const [arnPrefix, stage] = event.methodArn.split('/');
  return {
    principalId: payload.sub,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: `${arnPrefix}/${stage}/*` }],
    },
    context: { uid: payload.sub },
  };
}
