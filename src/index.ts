import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Transaction } from '@mysten/sui/transactions';

dotenv.config();

const app = express();

// In-memory rate limiting middleware
const rateLimitWindow = 60 * 1000; // 1 minute
const rateLimitMax = 60; // Max 60 requests per minute per IP
const ipRequestCounts = new Map<string, { count: number; resetTime: number }>();

function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const record = ipRequestCounts.get(ip);
  if (!record || now > record.resetTime) {
    ipRequestCounts.set(ip, { count: 1, resetTime: now + rateLimitWindow });
    return next();
  }

  if (record.count >= rateLimitMax) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  record.count += 1;
  next();
}

app.use(rateLimiter);

// Enable CORS for all local environments and the production app
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'https://safwah.vercel.app',
    'http://localhost:4000',
    'http://localhost:8080'
  ]
}));
app.use(express.json());

const ENOKI_PRIVATE_KEY = process.env.ENOKI_PRIVATE_KEY!;
const SUI_NETWORK = process.env.SUI_NETWORK ?? 'devnet';
const ENOKI_BASE = 'https://api.enoki.mystenlabs.com/v1';

// Default packages/IDs fallback
const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID || '0x4d1e423233ca6de0dbcdeabe35f90cdd340ae483942f3dad18e8f600e09d3f3d';

function normalizeSuiAddress(addr: string): string {
  const clean = addr.toLowerCase().replace(/^0x/, '');
  return '0x' + clean.padStart(64, '0');
}

const normalizedPackageId = normalizeSuiAddress(SUI_PACKAGE_ID);

// POST /sponsor
// Body: { transactionBlockKindBytes: string (base64), jwt: string }
// Returns: { bytes: string, digest: string }
app.post('/sponsor', async (req: express.Request, res: express.Response) => {
  const { transactionBlockKindBytes, jwt } = req.body;

  if (!transactionBlockKindBytes || !jwt) {
    return res.status(400).json({ error: 'Missing transactionBlockKindBytes or jwt' });
  }

  try {
    // 1. Decode and whitelist verification
    const bytesArray = Buffer.from(transactionBlockKindBytes, 'base64');
    const parsed = Transaction.fromKind(bytesArray);
    const commands = parsed.getData().commands;

    for (const command of commands) {
      if (command.MoveCall) {
        const moveCall = command.MoveCall;
        const callPackageId = normalizeSuiAddress(moveCall.package);

        // Only allow move calls targeting our package ID
        if (callPackageId !== normalizedPackageId) {
          console.warn(`Sponsorship rejected: Forbidden package ${moveCall.package}`);
          return res.status(403).json({ error: `Forbidden transaction package: ${moveCall.package}` });
        }

        const allowedTargets = [
          'usdc_mock::faucet',
          'safwah::submit_claim',
          'safwah_treasury::initiate_withdrawal',
          'safwah::issue_invoice_nft'
        ];
        const target = `${moveCall.module}::${moveCall.function}`;
        if (!allowedTargets.includes(target)) {
          console.warn(`Sponsorship rejected: Forbidden target ${target}`);
          return res.status(403).json({ error: `Forbidden transaction target function: ${target}` });
        }
      }
    }

    // 2. Call Enoki to sponsor
    const response = await fetch(`${ENOKI_BASE}/transaction-blocks/sponsor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENOKI_PRIVATE_KEY}`,
        'zklogin-jwt': jwt,
      },
      body: JSON.stringify({
        network: SUI_NETWORK,
        transactionBlockKindBytes,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Enoki sponsor error:', errText);
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err: any) {
    console.error('Sponsor request failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /sponsor/:digest/submit
// Body: { signature: string (base64) }
// Returns: { digest: string, effects: ... }
app.post('/sponsor/:digest/submit', async (req: express.Request, res: express.Response) => {
  const { digest } = req.params;
  const { signature } = req.body;

  if (!signature) return res.status(400).json({ error: 'Missing signature' });

  try {
    const response = await fetch(`${ENOKI_BASE}/transaction-blocks/sponsor/${digest}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENOKI_PRIVATE_KEY}`,
      },
      body: JSON.stringify({ signature }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    return res.json(await response.json());
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res: express.Response) => res.json({ status: 'ok', network: SUI_NETWORK, packageId: SUI_PACKAGE_ID }));

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`Safwah sponsor backend running on port ${PORT}`);
});
