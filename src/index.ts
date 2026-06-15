import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Transaction } from '@mysten/sui/transactions';
import mongoose from 'mongoose';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (process.env.NODE_ENV !== 'test' && MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB via mongoose'))
    .catch((err) => console.error('MongoDB connection error:', err));
}

// Schemas
const InvoiceSchema = new mongoose.Schema({
  invoiceNumber: { type: String, required: true, unique: true },
  merchantAddress: { type: String, required: true },
  customerAddress: { type: String, required: true },
  businessName: { type: String, required: true },
  amountAED: { type: String, required: true },
  vatAED: { type: String, required: true },
  timestamp: { type: Number, default: Date.now },
  status: { type: String, default: 'Issued' },
  walrusBlobId: { type: String },
  walrusUrl: { type: String },
});

export const InvoiceModel = mongoose.models.Invoice || mongoose.model('Invoice', InvoiceSchema);

const ClaimSchema = new mongoose.Schema({
  claimObjectId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  touristAddress: { type: String, required: true },
  receiptCount: { type: Number, required: true },
  totalVat: { type: String, required: true },
  payoutAmount: { type: String, required: true },
  status: { type: String, required: true },
  nftMinted: { type: Boolean, default: false },
  date: { type: String, required: true },
});

export const ClaimModel = mongoose.models.Claim || mongoose.model('Claim', ClaimSchema);

const FlaggedSchema = new mongoose.Schema({
  claimObjectId: { type: String, required: true, unique: true },
  flaggedAt: { type: Date, default: Date.now },
});

export const FlaggedModel = mongoose.models.Flagged || mongoose.model('Flagged', FlaggedSchema);

const ReceiptSchema = new mongoose.Schema({
  receiptId: { type: String, required: true, unique: true },
  touristAddress: { type: String, required: true },
  storeName: { type: String, required: true },
  amount: { type: String, required: true },
  vat: { type: String, required: true },
  date: { type: String, required: true },
  walrusUrl: { type: String, required: true },
  selectedForClaim: { type: Boolean, default: false },
  claimed: { type: Boolean, default: false },
});

export const ReceiptModel = mongoose.models.Receipt || mongoose.model('Receipt', ReceiptSchema);


export const app = express();

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
const SUI_NETWORK = process.env.SUI_NETWORK ?? 'testnet';
const ENOKI_BASE = 'https://api.enoki.mystenlabs.com/v1';

// Default packages/IDs fallback
const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID || '0x96604c290f1467bf041b080bf945518d56f597cb6a07d0d698466c44ed0eabfb';

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

// --- MONGODB REST ENDPOINTS ---

// Invoices
app.post('/api/invoices', async (req: express.Request, res: express.Response) => {
  try {
    const { invoiceNumber } = req.body;
    const existing = await InvoiceModel.findOne({ invoiceNumber });
    if (existing) {
      Object.assign(existing, req.body);
      await existing.save();
      return res.json(existing);
    } else {
      const invoice = new InvoiceModel(req.body);
      await invoice.save();
      return res.status(201).json(invoice);
    }
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/invoices/merchant/:address', async (req: express.Request, res: express.Response) => {
  try {
    const list = await InvoiceModel.find({ merchantAddress: req.params.address }).sort({ timestamp: -1 });
    return res.json(list);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/invoices/tourist/:address', async (req: express.Request, res: express.Response) => {
  try {
    const list = await InvoiceModel.find({ customerAddress: req.params.address }).sort({ timestamp: -1 });
    return res.json(list);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Claims
app.post('/api/claims', async (req: express.Request, res: express.Response) => {
  try {
    const { claimObjectId } = req.body;
    const existing = await ClaimModel.findOne({ claimObjectId });
    if (existing) {
      Object.assign(existing, req.body);
      await existing.save();
      return res.json(existing);
    } else {
      const claim = new ClaimModel(req.body);
      await claim.save();
      return res.status(201).json(claim);
    }
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/claims/tourist/:address', async (req: express.Request, res: express.Response) => {
  try {
    const list = await ClaimModel.find({ touristAddress: req.params.address }).sort({ date: -1 });
    return res.json(list);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/claims', async (req: express.Request, res: express.Response) => {
  try {
    const list = await ClaimModel.find().sort({ date: -1 });
    return res.json(list);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Flagged Claims
app.post('/api/flagged', async (req: express.Request, res: express.Response) => {
  try {
    const { claimObjectId, flagged } = req.body;
    if (flagged) {
      const entry = new FlaggedModel({ claimObjectId });
      await entry.save();
      return res.status(201).json(entry);
    } else {
      await FlaggedModel.deleteOne({ claimObjectId });
      return res.json({ status: 'removed' });
    }
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/flagged', async (req: express.Request, res: express.Response) => {
  try {
    const list = await FlaggedModel.find();
    return res.json(list.map((item: any) => item.claimObjectId));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Receipts
app.post('/api/receipts', async (req: express.Request, res: express.Response) => {
  try {
    const { receiptId } = req.body;
    const existing = await ReceiptModel.findOne({ receiptId });
    if (existing) {
      Object.assign(existing, req.body);
      await existing.save();
      return res.json(existing);
    } else {
      const receipt = new ReceiptModel(req.body);
      await receipt.save();
      return res.status(201).json(receipt);
    }
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/receipts/tourist/:address', async (req: express.Request, res: express.Response) => {
  try {
    const list = await ReceiptModel.find({ touristAddress: req.params.address }).sort({ date: -1 });
    return res.json(list);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/receipts/claim', async (req: express.Request, res: express.Response) => {
  try {
    const { receiptIds } = req.body;
    await ReceiptModel.updateMany(
      { receiptId: { $in: receiptIds } },
      { $set: { claimed: true, selectedForClaim: false } }
    );
    return res.json({ status: 'updated' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/health', (_, res: express.Response) => res.json({ status: 'ok', network: SUI_NETWORK, packageId: SUI_PACKAGE_ID }));



if (process.env.NODE_ENV !== 'test') {
  const PORT = Number(process.env.PORT ?? 3001);
  app.listen(PORT, () => {
    console.log(`Safwah sponsor backend running on port ${PORT}`);
  });
}
