// งานตามเวลา (EventBridge วันละครั้ง): ลบถาวรไฟล์ที่อยู่ในถังขยะเกิน 30 วัน
// ลบทุกเวอร์ชันใน S3 และคืนโควตาให้ผู้ใช้
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/aws.mjs';
import { purgeFile, TRASH_RETENTION_DAYS } from '../routes/files.mjs';

export async function handler() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let purged = 0;
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: '#t = :file AND #s = :trashed AND deletedAt < :cutoff',
        ExpressionAttributeNames: { '#t': 'type', '#s': 'status' },
        ExpressionAttributeValues: { ':file': 'FILE', ':trashed': 'TRASHED', ':cutoff': cutoff },
        ExclusiveStartKey,
      }),
    );
    for (const file of res.Items || []) {
      await purgeFile(file);
      purged++;
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  console.log(`purged ${purged} file(s) older than ${cutoff}`);
  return { purged };
}
