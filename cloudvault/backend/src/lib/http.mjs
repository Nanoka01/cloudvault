// ตัวช่วยสร้าง response ของ API Gateway (Lambda proxy integration) และ error ที่มี status code

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);
export const forbidden = (msg = 'ไม่มีสิทธิ์ทำรายการนี้') => new HttpError(403, msg);
export const notFound = (msg = 'ไม่พบข้อมูล') => new HttpError(404, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);

const corsHeaders = () => ({
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
});

export function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

export function redirect(location) {
  return { statusCode: 302, headers: { Location: location, ...corsHeaders() }, body: '' };
}

export function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw badRequest('รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)');
  }
}

// ตรวจข้อความที่จำเป็น ตัดช่องว่าง และจำกัดความยาว
export function requireString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw badRequest(`กรุณากรอก ${field}`);
  const v = value.trim();
  if (v.length < min) throw badRequest(`${field} ต้องมีอย่างน้อย ${min} ตัวอักษร`);
  if (v.length > max) throw badRequest(`${field} ยาวเกิน ${max} ตัวอักษร`);
  return v;
}
