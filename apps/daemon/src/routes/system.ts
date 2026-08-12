import { Router, Request, Response } from 'express';
import { getSystemHealth } from '../services/system';
import { getConfig, saveConfig } from '../config';

const router = Router();

router.get('/health', async (req: Request, res: Response) => {
  try {
    const health = await getSystemHealth();
    res.json(health);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve system health', details: err.message });
  }
});

// GET/POST /api/v1/system/backup-storage — configures the optional S3-compatible
// off-site backup target for this node. Secret key is never echoed back in full.
router.get('/backup-storage', (req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    s3Endpoint: config.s3Endpoint || '',
    s3Bucket: config.s3Bucket || '',
    s3Region: config.s3Region || '',
    s3AccessKeyId: config.s3AccessKeyId || '',
    s3SecretAccessKeySet: !!config.s3SecretAccessKey,
    s3Prefix: config.s3Prefix || '',
    s3RetainLocal: config.s3RetainLocal !== false,
    configured: !!(config.s3Bucket && config.s3AccessKeyId && config.s3SecretAccessKey),
  });
});

router.post('/backup-storage', (req: Request, res: Response) => {
  const { s3Endpoint, s3Bucket, s3Region, s3AccessKeyId, s3SecretAccessKey, s3Prefix, s3RetainLocal } = req.body;

  const updates: any = {};
  if (s3Endpoint !== undefined) updates.s3Endpoint = s3Endpoint;
  if (s3Bucket !== undefined) updates.s3Bucket = s3Bucket;
  if (s3Region !== undefined) updates.s3Region = s3Region;
  if (s3AccessKeyId !== undefined) updates.s3AccessKeyId = s3AccessKeyId;
  // Blank secret means "leave unchanged" — only overwrite when a new value is provided.
  if (s3SecretAccessKey) updates.s3SecretAccessKey = s3SecretAccessKey;
  if (s3Prefix !== undefined) updates.s3Prefix = s3Prefix;
  if (s3RetainLocal !== undefined) updates.s3RetainLocal = !!s3RetainLocal;

  saveConfig(updates);
  res.json({ success: true });
});

export default router;
