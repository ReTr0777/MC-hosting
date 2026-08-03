import { Router, Request, Response } from 'express';
import { getSystemHealth } from '../services/system';

const router = Router();

router.get('/health', async (req: Request, res: Response) => {
  try {
    const health = await getSystemHealth();
    res.json(health);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve system health', details: err.message });
  }
});

export default router;
