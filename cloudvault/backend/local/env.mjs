// ค่า environment สำหรับรันบนเครื่องตัวเองกับ AWS จำลอง (moto server)
// ใช้ AWS_ENDPOINT_URL ชี้ SDK ทั้งหมดไปที่ moto แทน AWS จริง
const defaults = {
  AWS_ENDPOINT_URL: 'http://localhost:5005',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  TABLE_NAME: 'cloudvault-local',
  BUCKET_NAME: 'cloudvault-local',
  JWT_SECRET: 'local-dev-secret-change-me',
  S3_FORCE_PATH_STYLE: 'true',
  PORT: '3001',
};
for (const [k, v] of Object.entries(defaults)) process.env[k] ??= v;
process.env.PUBLIC_API_URL ??= `http://localhost:${process.env.PORT}`;
