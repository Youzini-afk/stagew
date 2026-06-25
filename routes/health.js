import express from 'express';
import { config } from '../config.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    name: 'stagewise-2api',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      chat: '/v1/chat/completions',
      models: '/v1/models',
      auth: '/v1/auth',
      pool: '/v1/pool',
      usage: '/v1/usage',
      dashboard: '/dashboard',
    },
    provider: 'https://stagewise.io',
  });
});

export default router;
