import fs from 'fs';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getConfig } from '../config';

function isS3Configured(): boolean {
  const c = getConfig();
  return !!(c.s3Bucket && c.s3AccessKeyId && c.s3SecretAccessKey);
}

function getClient(): S3Client {
  const c = getConfig();
  return new S3Client({
    region: c.s3Region || 'auto',
    endpoint: c.s3Endpoint || undefined,
    // Most S3-compatible providers (Backblaze B2, MinIO, R2) need path-style addressing.
    forcePathStyle: !!c.s3Endpoint,
    credentials: {
      accessKeyId: c.s3AccessKeyId!,
      secretAccessKey: c.s3SecretAccessKey!,
    },
  });
}

function keyFor(serverId: string, fileName: string): string {
  const c = getConfig();
  const prefix = c.s3Prefix ? `${c.s3Prefix.replace(/\/+$/, '')}/` : '';
  return `${prefix}${serverId}/${fileName}`;
}

export async function uploadBackup(serverId: string, fileName: string, localPath: string): Promise<void> {
  if (!isS3Configured()) return;
  const client = getClient();
  const body = fs.createReadStream(localPath);
  await client.send(new PutObjectCommand({
    Bucket: getConfig().s3Bucket!,
    Key: keyFor(serverId, fileName),
    Body: body,
  }));
}

export async function listRemoteBackups(serverId: string): Promise<{ name: string; sizeBytes: number; createdAt: string }[]> {
  if (!isS3Configured()) return [];
  const client = getClient();
  const prefix = keyFor(serverId, '');
  const result = await client.send(new ListObjectsV2Command({ Bucket: getConfig().s3Bucket!, Prefix: prefix }));

  return (result.Contents || [])
    .filter((obj) => obj.Key && obj.Key.endsWith('.zip'))
    .map((obj) => ({
      name: obj.Key!.slice(prefix.length),
      sizeBytes: obj.Size || 0,
      createdAt: (obj.LastModified || new Date()).toISOString(),
    }));
}

export async function downloadBackup(serverId: string, fileName: string, destPath: string): Promise<void> {
  const client = getClient();
  const result = await client.send(new GetObjectCommand({ Bucket: getConfig().s3Bucket!, Key: keyFor(serverId, fileName) }));
  const body = result.Body as NodeJS.ReadableStream;

  await new Promise<void>((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);
    body.pipe(writeStream);
    body.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
  });
}

export async function deleteRemoteBackup(serverId: string, fileName: string): Promise<void> {
  if (!isS3Configured()) return;
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: getConfig().s3Bucket!, Key: keyFor(serverId, fileName) }));
}

export { isS3Configured };
