import { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config';

export function authenticateDaemonKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Bearer token' });
  }

  const token = authHeader.substring(7);
  const { apiKey } = getConfig();

  if (token !== apiKey) {
    return res.status(403).json({ error: 'Forbidden: Invalid API Key' });
  }

  next();
}
