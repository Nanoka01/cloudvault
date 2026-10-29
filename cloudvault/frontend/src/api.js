// ตัวเรียก API ของ CloudVault — แนบ JWT ทุก request และจัดการ error เป็นข้อความภาษาไทย
const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const TOKEN_KEY = 'cloudvault.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* โหมดส่วนตัวของเบราว์เซอร์อาจบล็อก localStorage */
  }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `เกิดข้อผิดพลาด (${status})`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

export async function api(method, path, body) {
  const token = getToken();
  let res;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่' });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (res.status === 401 && token && !path.startsWith('/auth/')) {
    onUnauthorized();
    throw new ApiError(401, { message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// อัปโหลด: ขอ presigned POST → ส่งไฟล์ตรงเข้า S3 (มี progress) → ยืนยันกับ API
// ส่ง fileId เมื่อต้องการอัปโหลดเป็นเวอร์ชันใหม่ของไฟล์เดิม
export async function uploadFile(file, { fileId, onProgress } = {}) {
  const contentType = file.type || 'application/octet-stream';
  const { fileId: id, upload } = await api('POST', '/files/upload-url', {
    name: file.name,
    contentType,
    size: file.size,
    fileId,
  });

  const form = new FormData();
  Object.entries(upload.fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', file);

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', upload.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, { message: 'อัปโหลดไป S3 ไม่สำเร็จ (ไฟล์อาจใหญ่เกินพื้นที่ที่เหลือ)' }));
    xhr.onerror = () => reject(new ApiError(0, { message: 'อัปโหลดไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่' }));
    xhr.send(form);
  });

  return api('POST', `/files/${id}/confirm`);
}

// เปิดดาวน์โหลดจาก presigned URL
export function startDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
