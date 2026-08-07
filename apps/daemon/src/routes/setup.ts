import { Router, Request, Response } from 'express';
import os from 'os';
import { getConfig, saveConfig } from '../config';
import { tunnelManager } from '../services/frpc';

const router = Router();

// Helper to gather device network interfaces and IPs
function getDeviceInfo(req: Request) {
  const interfaces = os.networkInterfaces();
  const rawAddresses: string[] = [];
  
  for (const name of Object.keys(interfaces)) {
    if (name.includes('docker') || name.includes('veth') || name.includes('br-')) continue;
    for (const iface of interfaces[name] || []) {
      if (!iface.internal && iface.family === 'IPv4') {
        rawAddresses.push(iface.address);
      }
    }
  }

  // Filter out internal Docker container subnet IPs (e.g. 172.17.x.x - 172.31.x.x)
  const isDockerOrLoopback = (ip: string) => {
    if (!ip || ip === '127.0.0.1' || ip === 'localhost') return true;
    if (ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') || ip.startsWith('172.20.')) return true;
    return false;
  };

  const nonDockerLanIps = rawAddresses.filter(ip => !isDockerOrLoopback(ip));

  const hostHeader = (req.headers.host || '').split(':')[0];
  const isIpAddress = (str: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(str);

  let primaryInternalIp = process.env.HOST_IP || process.env.NODE_HOST || '';

  if (!primaryInternalIp && isIpAddress(hostHeader) && !isDockerOrLoopback(hostHeader)) {
    primaryInternalIp = hostHeader;
  }

  if (!primaryInternalIp && nonDockerLanIps.length > 0) {
    primaryInternalIp = nonDockerLanIps[0];
  }

  return {
    hostname: os.hostname(),
    internalIp: primaryInternalIp || (isDockerOrLoopback(hostHeader) ? '' : hostHeader),
    requestHostIp: hostHeader || '',
    deviceIps: nonDockerLanIps,
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

