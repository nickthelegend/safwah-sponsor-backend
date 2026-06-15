# ⚡ Safwah Transaction Sponsor Backend & Database

This Node.js Express server acts as the transaction sponsor and database gateway for the Safwah applications. It sponsors gasless transactions via **Mysten Labs Enoki** and connects to MongoDB to persist invoice, claim, and verification history.

## 🛠️ Tech Stack & Key Integrations

* **Express.js & TypeScript**: Exposes REST API endpoints.
* **Mongoose**: Integrates MongoDB Atlas to store invoices, claims, and flagged claim logs.
* **Sui TypeScript SDK**: Decodes transaction kind bytes to perform whitelist verification.
* **Enoki SDK**: Sponsors on-chain gas fees, removing SUI gas friction for tourists and merchants.

## ⚙️ Environment Variables (`.env`)

Create a `.env` file in this directory with the following keys:
```env
ENOKI_PRIVATE_KEY=your_enoki_secret_api_key
SUI_NETWORK=testnet
SUI_PACKAGE_ID=0x96604c290f1467bf041b080bf945518d56f597cb6a07d0d698466c44ed0eabfb
PORT=3001
MONGODB_URI=mongodb+srv://niveshgajengi_db_user:888wtyiipGn8Hwd2@cluster0.yghfjok.mongodb.net/?appName=Cluster0
```

*Note: The `MONGODB_URI` string integrates with MongoDB Atlas to store persistence data.*

## 📋 API Endpoints

### 1. Gasless Sponsorship
* `POST /sponsor` - Inspects, verifies whitelisted calls, and signs transaction blocks using Enoki.
* `POST /sponsor/:digest/submit` - Submits the signed transaction block to the Sui blockchain network.

### 2. Invoices (MongoDB Persistence)
* `POST /api/invoices` - Persists a new invoice.
* `GET /api/invoices/merchant/:address` - Fetches invoices issued by a merchant.
* `GET /api/invoices/tourist/:address` - Fetches invoices received by a tourist.

### 3. Claims (MongoDB Persistence)
* `POST /api/claims` - Creates or updates a tourist's claim.
* `GET /api/claims/tourist/:address` - Fetches claims submitted by a tourist.
* `GET /api/claims` - Fetches the global exit queues (for customs verification).

### 4. Flags (MongoDB Persistence)
* `POST /api/flagged` - Flags or clears a claim ID.
* `GET /api/flagged` - Returns list of flagged claim IDs.

## 🚀 Commands

### Install dependencies:
```bash
npm install
```

### Run development server (watcher):
```bash
npm run dev
```

### Run unit tests:
```bash
npm run test
```
*Note: Unit tests run in isolation with an in-memory database mock so that no calls block on MongoDB.*
