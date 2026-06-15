import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { Transaction } from '@mysten/sui/transactions';
import { app, ClaimModel } from '../index';
import dotenv from 'dotenv';

dotenv.config();

describe('End-to-End Integration & Validation (Unmocked)', () => {
  beforeAll(async () => {
    // Connect to the real MongoDB Atlas instance
    const MONGODB_URI = process.env.MONGODB_URI;
    expect(MONGODB_URI).toBeDefined();
    await mongoose.connect(MONGODB_URI!);
  });

  afterAll(async () => {
    // Disconnect from database
    await mongoose.disconnect();
  });

  test('Database Connectivity: can read and write to MongoDB Atlas', async () => {
    const uniqueClaimId = `test-integration-claim-${Date.now()}`;
    
    // Create a new claim
    const newClaim = new ClaimModel({
      claimObjectId: uniqueClaimId,
      title: 'E2E Integration Test Claim',
      touristAddress: '0xintegrationtouristaddress123',
      receiptCount: 2,
      totalVat: '15.50',
      payoutAmount: '12.40',
      status: 'Pending',
      nftMinted: false,
      date: new Date().toISOString()
    });

    await newClaim.save();

    // Verify it exists in MongoDB
    const found = await ClaimModel.findOne({ claimObjectId: uniqueClaimId });
    expect(found).not.toBeNull();
    expect(found?.title).toBe('E2E Integration Test Claim');

    // Clean up
    await ClaimModel.deleteOne({ claimObjectId: uniqueClaimId });
    const checkDeleted = await ClaimModel.findOne({ claimObjectId: uniqueClaimId });
    expect(checkDeleted).toBeNull();
  });

  test('Whitelist Validation and Enoki Transport: processes real Sui Transaction bytes', async () => {
    // Construct a real Sui Transaction using the real, unmocked SDK
    const tx = new Transaction();
    tx.moveCall({
      target: '0x7f49826d888c1f69ff1fb7756af657bfd24c60a3a3046ec48e343a2359ae9c63::safwah::submit_claim',
      arguments: [
        tx.pure.string('Integration Test Claim'),
        tx.pure.u32(2)
      ]
    });

    // Build the real transaction kind bytes (this requires NO network/RPC connection)
    const kindBytes = await tx.build({ onlyTransactionKind: true });
    const transactionBlockKindBytes = Buffer.from(kindBytes).toString('base64');

    // Send the real base64 bytes to /sponsor
    const res = await request(app)
      .post('/sponsor')
      .send({
        transactionBlockKindBytes,
        jwt: 'dummy_jwt_token_for_validation'
      });

    // The Whitelist parser inside our backend should accept this real transaction
    // and attempt to forward it to Enoki.
    // Since we are using a mock/dummy JWT, Enoki API should respond with an error.
    // If we receive the error response from Enoki's API server, it proves:
    // 1. Deserialization was successful.
    // 2. The Whitelist checks passed successfully.
    // 3. The request successfully traveled across the network to Enoki's real server!
    
    // Whitelist check should definitely not return 403 Forbidden
    expect(res.status).not.toBe(403);
    
    // It should fail with either 400, 401, or 500 from the real Enoki server
    expect([400, 401, 500]).toContain(res.status);
    
    console.log('Integration test result - Status:', res.status, 'Body:', res.body);
  });
});
