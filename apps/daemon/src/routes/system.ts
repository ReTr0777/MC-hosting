import { Router, Request, Response } from 'express';
import { getSystemHealth } from '../services/system';
import { getConfig, saveConfig } from '../config';
import { ALL_GAMES, DEFAULT_ENABLED_GAMES, GAME_LABELS, parseGameList } from '@mc-manager/shared';

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

/*
 * GET/POST /api/v1/system/games — which games this node will host.
 *
 * The same setting exists on /api/v1/setup/config, but that route is guarded by the
 * setup password, which only a human at the node's own GUI has. The panel authenticates
 * with the node's API key and has no way to obtain it, so it could read enabledGames
 * from a health report and never change it. This is that route's counterpart for
 * callers holding the API key.
 *
 * The daemon stays the source of truth either way: the panel writes here and its stored
 * copy is refreshed from the next health poll, so the two cannot drift.
 */
router.get('/games', (req: Request, res: Response) => {
  res.json({
    enabledGames: getConfig().enabledGames ?? [...DEFAULT_ENABLED_GAMES],
    availableGames: ALL_GAMES.map((id) => ({ id, label: GAME_LABELS[id] })),
  });
});

router.post('/games', (req: Request, res: Response) => {
  // Rejected rather than quietly corrected, for the same reason as the setup route: a
  // caller that turned everything off has asked for a node that can host nothing, and
  // silently reinstating a default would leave the panel showing a state the node is
  // not in.
  const parsed = parseGameList(req.body?.enabledGames);
  if (!parsed) {
    return res.status(400).json({
      error: `enabledGames must contain at least one of: ${ALL_GAMES.join(', ')}`,
    });
  }

  saveConfig({ enabledGames: parsed });
  res.json({ success: true, enabledGames: parsed });
});

export default router;
