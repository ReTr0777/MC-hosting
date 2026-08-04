import { Router, Request, Response } from 'express';
import { getConfig, saveConfig } from '../config';
import { tunnelManager } from '../services/frpc';

const router = Router();

// Middleware to check setup password
function requireSetupPassword(req: Request, res: Response, next: Function) {
  const password = req.headers['x-setup-password'] as string;
  const config = getConfig();
  
  if (!config.setupPassword || password === config.setupPassword) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Invalid setup password' });
  }
}

router.get('/config', requireSetupPassword, (req, res) => {
  const config = getConfig();
  // Don't send the setup password itself back to the client unless strictly needed
  res.json({
    apiKey: config.apiKey,
    frpServerAddr: config.frpServerAddr,
    frpServerPort: config.frpServerPort,
    frpToken: config.frpToken,
  });
});

router.post('/config', requireSetupPassword, (req, res) => {
  const { apiKey, frpServerAddr, frpServerPort, frpToken, newSetupPassword } = req.body;
  
  const updates: any = {};
  if (apiKey !== undefined) updates.apiKey = apiKey;
  if (frpServerAddr !== undefined) updates.frpServerAddr = frpServerAddr;
  if (frpServerPort !== undefined) updates.frpServerPort = parseInt(frpServerPort, 10);
  if (frpToken !== undefined) updates.frpToken = frpToken;
  if (newSetupPassword) updates.setupPassword = newSetupPassword;

  saveConfig(updates);
  
  // If FRP settings changed, dynamically restart the tunnel manager!
  if (frpServerAddr || frpServerPort || frpToken) {
    console.log('[Setup] FRP settings changed. Restarting tunnel manager...');
    tunnelManager.init(); // This re-generates frpc.toml and restarts the process
  }
  
  res.json({ success: true });
});

export default router;
