// งานที่ทำกับ S3: presigned URL, ลบทุกเวอร์ชัน, ตรวจสถานะ Glacier/Deep Archive
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { s3, BUCKET } from './aws.mjs';

export const UPLOAD_URL_TTL = 5 * 60; // 5 นาที
export const DOWNLOAD_URL_TTL = 10 * 60; // 10 นาที

// presigned POST: S3 จะปฏิเสธเองถ้าไฟล์ใหญ่กว่า maxBytes หรือ Content-Type ไม่ตรง
// (presigned PUT ทำแบบนี้ไม่ได้ จึงใช้ POST เพื่อบังคับโควตา)
export function presignUpload({ key, contentType, maxBytes }) {
  return createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: key,
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: UPLOAD_URL_TTL,
  });
}

export function presignDownload({ key, versionId, fileName, ttl = DOWNLOAD_URL_TTL }) {
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      VersionId: versionId,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encoded}`,
    }),
    { expiresIn: ttl },
  );
}

export async function headObject(key, versionId) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key, VersionId: versionId }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// ไฟล์ใน Deep Archive ต้องกู้คืนก่อนดาวน์โหลด
// คืน { archived, restoring, restored }
export function archiveState(head) {
  const cls = head?.StorageClass;
  const archived = cls === 'DEEP_ARCHIVE' || cls === 'GLACIER';
  const restoreHeader = head?.Restore || '';
  return {
    archived,
    restoring: archived && restoreHeader.includes('ongoing-request="true"'),
    restored: archived && restoreHeader.includes('ongoing-request="false"'),
  };
}

// ลบทุกเวอร์ชันและ delete marker ของ key นี้ เพื่อคืนพื้นที่จริง
// (DeleteObject แบบไม่ระบุ VersionId ใน bucket ที่เปิด versioning ได้แค่ delete marker)
export async function deleteAllVersions(key) {
  let KeyMarker;
  let VersionIdMarker;
  do {
    const res = await s3.send(
      new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key, KeyMarker, VersionIdMarker }),
    );
    const targets = [...(res.Versions || []), ...(res.DeleteMarkers || [])]
      .filter((v) => v.Key === key)
      .map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    if (targets.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: targets, Quiet: true } }));
    }
    KeyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
    VersionIdMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
  } while (KeyMarker);
}

export async function listVersions(key) {
  const versions = [];
  let KeyMarker;
  let VersionIdMarker;
  do {
    const res = await s3.send(
      new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key, KeyMarker, VersionIdMarker }),
    );
    versions.push(...(res.Versions || []).filter((v) => v.Key === key));
    KeyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
    VersionIdMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
  } while (KeyMarker);
  return versions.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
}

// CopySource ต้อง encode key (ชื่อไฟล์ภาษาไทยหรือมีช่องว่าง)
export function copySource(key, versionId) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${BUCKET}/${encodedKey}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`;
}
