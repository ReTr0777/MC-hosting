import { Router, Request, Response } from 'express';
import os from 'os';
import { getConfig, saveConfig } from '../config';
import { tunnelManager } from '../services/frpc';

const router = Router();

// Helper to gather device network interfaces and IPs
function getDeviceInfo(req: Request) {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (!iface.internal && iface.family === 'IPv4') {
        addresses.push(iface.address);
      }
    }
  }

  const hostHeader = (req.headers.host || '').split(':')[0];
  const lanIpRegex = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
  const lanIps = addresses.filter(ip => lanIpRegex.test(ip));
  
  let primaryInternalIp = hostHeader;
  if (!lanIpRegex.test(primaryInternalIp)) {
    if (lanIps.length > 0) {
      primaryInternalIp = lanIps[0];
    } else if (addresses.length > 0) {
      primaryInternalIp = addresses[0];
    }
  }

  return {
    hostname: os.hostname(),
    internalIp: primaryInternalIp,
    requestHostIp: hostHeader || 'localhost',
    deviceIps: addresses.length > 0 ? addresses : ['127.0.0.1'],
  };
}

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

// Unauthenticated public route for device IP/info display on setup page
router.get('/info', (req: Request, res: Response) => {
  const config = getConfig();
  const info = getDeviceInfo(req);
  res.json({
    ...info,
    port: config.port,
  });
});

router.get('/config', requireSetupPassword, (req: Request, res: Response) => {
  const config = getConfig();
  const info = getDeviceInfo(req);
  res.json({
    apiKey: config.apiKey,
    frpServerAddr: config.frpServerAddr,
    frpServerPort: config.frpServerPort,
    frpToken: config.frpToken,
    deviceIps: info.deviceIps,
    requestHostIp: info.requestHostIp,
    hostname: info.hostname,
    port: config.port,
  });
});

router.post('/config', requireSetupPassword, (req: Request, res: Response) => {
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

