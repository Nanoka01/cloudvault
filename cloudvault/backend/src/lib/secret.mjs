// อ่าน JWT secret จาก SSM Parameter Store (SecureString) แล้ว cache ไว้ใน container
// ตอนรันบนเครื่องตัวเอง ตั้ง JWT_SECRET ใน environment แทนได้
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { ssm } from './aws.mjs';

let cached;

export async function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!cached) {
    cached = ssm
      .send(new GetParameterCommand({ Name: process.env.JWT_SECRET_PARAM, WithDecryption: true }))
      .then((res) => res.Parameter.Value)
      .catch((err) => {
        cached = undefined; // ให้ลองใหม่รอบหน้า
        throw err;
      });
  }
  return cached;
}
