import fs from 'fs';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { getConfig } from '../../config';

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

/** One entry of a ListObjectVersions page — either a real version or a delete marker. */
interface VersionEntry {
  Key?: string;
  VersionId?: string;
}

/**
 * Every version id of exactly this key on one page of ListObjectVersions.
 *
 * Delete markers are included deliberately: a marker left behind once its data versions are
 * gone is an orphan that keeps the key listed as existing. Filtering on an exact key match
 * rather than trusting the Prefix matters just as much — B2 returns everything *starting*
 * with the prefix, and deleting by prefix would take out any other backup whose name happens
 * to extend this one.
 */
export function versionIdsOfKey(
  page: { Versions?: VersionEntry[]; DeleteMarkers?: VersionEntry[] },
  key: string
): string[] {
  return [...(page.Versions || []), ...(page.DeleteMarkers || [])]
    .filter((entry) => entry.Key === key && entry.VersionId)
    .map((entry) => entry.VersionId as string);
}

/**
 * Removes a backup from off-site storage — the data, not just the name.
 *
 * A plain DeleteObject does not delete anything on Backblaze B2. Its buckets keep every
 * version, and the default lifecycle setting is "Keep all versions of the file … until you
 * explicitly delete them", so a delete without a versionId only inserts a delete marker and
 * makes the object the newest version of nothing. The 5 GB archive underneath stays, and
 * stays billed. It is invisible from in here too: listRemoteBackups uses ListObjectsV2,
 * which reports current versions only, so the panel showed a tidy set of backups over a
 * bucket that had kept every nightly archive since the schedule was created.
 *
 * So every version of the key is enumerated and deleted by id, which is the only thing B2
 * documents as a permanent delete. A bucket lifecycle rule is worth setting as well, but as
 * a backstop — this must not depend on how somebody configured the bucket.
 */
export async function deleteRemoteBackup(serverId: string, fileName: string): Promise<void> {
  if (!isS3Configured()) return;
  const client = getClient();
  const Bucket = getConfig().s3Bucket!;
  const key = keyFor(serverId, fileName);

  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let deleted = 0;
  // A provider that reports more pages without advancing the markers would otherwise spin here.
  let pages = 0;

  try {
    do {
      const page = await client.send(
        new ListObjectVersionsCommand({ Bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker })
      );

      for (const VersionId of versionIdsOfKey(page, key)) {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key, VersionId }));
        deleted++;
      }

      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while ((keyMarker || versionIdMarker) && ++pages < 100);

    console.log(`[S3] Deleted ${deleted} version(s) of '${key}' from off-site storage.`);
  } catch (err: any) {
    /*
     * Not every S3-compatible endpoint this can be pointed at answers ListObjectVersions.
     * On one that does not, an unversioned delete is the correct and complete operation
     * anyway, so fall back to it rather than leaving the object there entirely.
     */
    console.warn(`[S3] Could not delete '${key}' by version (${err.message}); falling back to an unversioned delete.`);
    await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
  }
}

export { isS3Configured };
