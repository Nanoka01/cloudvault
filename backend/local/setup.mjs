// สร้างตาราง DynamoDB และ bucket S3 (เปิด versioning + CORS) ใน AWS จำลอง ให้เหมือน template.yaml
import './env.mjs';
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import {
  CreateBucketCommand, PutBucketCorsCommand, PutBucketVersioningCommand, S3Client,
} from '@aws-sdk/client-s3';

export async function setupLocal() {
  const ddb = new DynamoDBClient({});
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: process.env.TABLE_NAME,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK'].map((n) => ({ AttributeName: n, AttributeType: 'S' })),
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }

  const s3 = new S3Client({ forcePathStyle: true });
  const Bucket = process.env.BUCKET_NAME;
  try {
    await s3.send(new CreateBucketCommand({ Bucket }));
  } catch (err) {
    if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(err.name)) throw err;
  }
  await s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  await s3.send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'POST', 'HEAD'], AllowedHeaders: ['*'] }],
      },
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await setupLocal();
  console.log(`พร้อมใช้งาน: table=${process.env.TABLE_NAME} bucket=${process.env.BUCKET_NAME}`);
}
