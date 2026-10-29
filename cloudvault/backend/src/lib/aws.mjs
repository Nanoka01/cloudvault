// AWS SDK clients ที่ใช้ร่วมกันทุก handler (สร้างครั้งเดียวต่อ Lambda container)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';

// ตอนรันบนเครื่อง (local/server.mjs) ชี้ไปที่ AWS จำลองผ่าน AWS_ENDPOINT_URL
// บน Lambda จริงไม่ต้องตั้งค่าอะไร
const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({ forcePathStyle });
export const ssm = new SSMClient({});

export const TABLE = process.env.TABLE_NAME;
export const BUCKET = process.env.BUCKET_NAME;
