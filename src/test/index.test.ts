import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import dotenv from 'dotenv';

dotenv.config();

const CURRENT_PACKAGE_ID = process.env.SUI_PACKAGE_ID || '0x6130154ae2c83a4d31e6117a1067e636d650bac47d2da57c023571bb4bd9089e';

// Mock commands to be returned by mock Transaction.fromKind
let mockCommands: any[] = [];

// Mock @mysten/sui/transactions
vi.mock('@mysten/sui/transactions', () => {
  return {
    Transaction: {
      fromKind: vi.fn().mockImplementation(() => {
        return {
          getData: () => ({
            commands: mockCommands,
          }),
        };
      }),
    },
  };
});

describe('Sponsor Backend API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommands = [];
    // Mock global fetch for Enoki calls
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        bytes: 'mockSponsorBytesBase64',
        digest: 'mockSponsorDigest123',
      }),
    });
  });

  test('GET /health returns ok status and configuration', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      network: process.env.SUI_NETWORK || 'devnet',
      packageId: CURRENT_PACKAGE_ID,
    });
  });

  test('POST /sponsor rejects missing payload fields', async () => {
    const res = await request(app)
      .post('/sponsor')
      .send({ jwt: 'mockjwt' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing transactionBlockKindBytes or jwt');
  });

  test('POST /sponsor rejects forbidden package ID', async () => {
    mockCommands = [
      {
        MoveCall: {
          package: '0x1111111111111111111111111111111111111111111111111111111111111111', // Forbidden package
          module: 'safwah',
          function: 'submit_claim',
        },
      },
    ];

    const res = await request(app)
      .post('/sponsor')
      .send({
        transactionBlockKindBytes: 'mockBytes',
        jwt: 'mockjwt',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden transaction package');
  });

  test('POST /sponsor rejects forbidden target function', async () => {
    mockCommands = [
      {
        MoveCall: {
          package: CURRENT_PACKAGE_ID,
          module: 'safwah',
          function: 'forbidden_function', // Forbidden target
        },
      },
    ];

    const res = await request(app)
      .post('/sponsor')
      .send({
        transactionBlockKindBytes: 'mockBytes',
        jwt: 'mockjwt',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden transaction target function');
  });

  test('POST /sponsor accepts whitelisted package and function calls', async () => {
    mockCommands = [
      {
        MoveCall: {
          package: CURRENT_PACKAGE_ID,
          module: 'safwah',
          function: 'submit_claim', // Whitelisted
        },
      },
    ];

    const res = await request(app)
      .post('/sponsor')
      .send({
        transactionBlockKindBytes: 'mockBytes',
        jwt: 'mockjwt',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      bytes: 'mockSponsorBytesBase64',
      digest: 'mockSponsorDigest123',
    });
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  test('POST /sponsor/:digest/submit calls Enoki submit', async () => {
    const res = await request(app)
      .post('/sponsor/mockdigest123/submit')
      .send({ signature: 'mocksignature' });

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  test('Rate limiting triggers 429 after 60 requests', async () => {
    // Send 60 requests which should all pass (or be blocked by rate limit if exceeding)
    for (let i = 0; i < 60; i++) {
      await request(app).get('/health');
    }

    // The 61st request should get a 429
    const res = await request(app).get('/health');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Too many requests. Please try again later.');
  });
});
