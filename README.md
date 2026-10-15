# ReSell — AI-Powered Peer-to-Peer Marketplace

> A full-stack, production-ready secondhand marketplace with a multi-layer ML fraud detection pipeline, CLIP-powered semantic search, AI price recommendations, product identity verification, and real-time messaging.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack](#3-tech-stack)
4. [Repository Structure](#4-repository-structure)
5. [Frontend](#5-frontend)
6. [Backend API](#6-backend-api)
7. [ML / AI System — Deep Dive](#7-ml--ai-system--deep-dive)
   - [7.1 Image Fraud Detection Pipeline](#71-image-fraud-detection-pipeline)
   - [7.2 Perceptual Hashing (pHash)](#72-perceptual-hashing-phash)
   - [7.3 MobileNet Image Classification](#73-mobilenet-image-classification)
   - [7.4 CNN Product Fingerprinting](#74-cnn-product-fingerprinting)
   - [7.5 Computer Vision — Damage & Condition Scoring](#75-computer-vision--damage--condition-scoring)
   - [7.6 Identity Verification & Provenance](#76-identity-verification--provenance)
   - [7.7 Seller Trust Score](#77-seller-trust-score)
   - [7.8 Price Recommendation Engine](#78-price-recommendation-engine)
   - [7.9 Risk Scoring — Unified Fraud Engine](#79-risk-scoring--unified-fraud-engine)
    - [7.10 Scam-Text Pattern Analyzer](#710-scam-text-pattern-analyzer)
    - [7.11 Duplicate Detection — Complete Flow](#711-duplicate-detection--complete-flow)
    - [7.12 Multi-Object Image Handling](#712-multi-object-image-handling)
8. [ML Microservice (Python / FastAPI)](#8-ml-microservice-python--fastapi)
   - [8.1 CLIP Embeddings](#81-clip-embeddings)
   - [8.2 LightGBM Fraud Pipeline v2](#82-lightgbm-fraud-pipeline-v2)
   - [8.3 Quantile Price Estimation (kNN)](#83-quantile-price-estimation-knn)
   - [8.4 Shadow Mode & A/B Testing](#84-shadow-mode--ab-testing)
   - [8.5 ANN Index (HNSW)](#85-ann-index-hnsw)
9. [Real-Time Features](#9-real-time-features)
10. [Background Job Workers](#10-background-job-workers)
11. [Database Models](#11-database-models)
12. [Security](#12-security)
13. [Environment Variables](#13-environment-variables)
14. [Local Development Setup](#14-local-development-setup)
15. [Docker / Production Deployment](#15-docker--production-deployment)
16. [API Reference](#16-api-reference)
17. [Testing](#17-testing)
18. [Theoretical Limitations & Mitigations](#18-theoretical-limitations--mitigations)
19. [Screenshots](#19-screenshots)

---

## Demo

Load realistic demo data (users, products, chat, offers, reviews, and a duplicate-image listing) into a running local MongoDB:

```bash
cd backend && npm run seed -- --force
```

`npm run seed` aborts if demo data already exists; `--force` wipes the demo-managed collections and reseeds (demo placeholder images are generated locally into `backend/public/seed-images/`, served at `/public/seed-images/`).

| Email | Password | Role |
|---|---|---|
| admin@resell.dev | Password123! | admin |
| priya@resell.dev | Password123! | seller |
| arjun@resell.dev | Password123! | seller |
| meera@resell.dev | Password123! | buyer |

> Seeded data includes a duplicate-image listing to demonstrate the fraud detection pipeline.

---

## 1. Project Overview

**ReSell** is a peer-to-peer secondhand marketplace designed to solve the core trust problem of buying and selling used goods online. Unlike generic marketplaces, ReSell embeds fraud detection, condition verification, and price transparency directly into the listing creation flow — all powered by machine learning models that run on every image uploaded to the platform.

### Key Differentiators

| Feature | Description |
|---|---|
| **Image Fraud Detection** | Multi-layer pipeline: perceptual hashing to CNN fingerprinting to CLIP vector similarity to LightGBM classifier |
| **Product Identity** | Serial / IMEI / VIN registry with cryptographic possession verification and provenance chain |
| **AI Price Recommendation** | Depreciation model + market comparables + visual condition adjustment |
| **MobileNet Auto-Category** | Automatic product category suggestion from uploaded images |
| **Seller Trust Score** | Transparent 0-100 score with per-component breakdown |
| **Real-Time Chat & Offers** | Socket.IO-powered negotiation with offer countering |
| **Stripe Checkout** | Secure end-to-end payment with webhook verification |
| **Multi-Currency** | Live exchange rates with a daily scheduler |

---

## 2. Architecture

```
+---------------------------------------------------------------------+
|                         CLIENT (Browser)                            |
|              React 18 + Vite + TailwindCSS + Socket.IO              |
+------------------------+--------------------------------------------+
                         | HTTPS / WSS
+------------------------v--------------------------------------------+
|                   BACKEND API  (Node.js / Express)                  |
|  REST API - Socket.IO - BullMQ Job Queues - Rate Limiting - Helmet  |
|  +------------+  +-------------+  +--------------+  +-----------+  |
|  |  Auth /JWT |  |  Products   |  | Orders/Stripe|  |  Chat/IO  |  |
|  +------------+  +------+------+  +--------------+  +-----------+  |
|                         | enqueue                                   |
|  +----------------------v------------------------------------------+ |
|  |             BULLMQ WORKERS (Redis-backed)                        | |
|  |  imageProcessor.js  -  priceAnalyzer.js                         | |
|  +----------------------+------------------------------------------+ |
+-------------------------|--------------------------------------------|
                          | HTTP (internal)
+-------------------------v-------------------------------------------+
|               ML MICROSERVICE  (Python / FastAPI)                   |
|  CLIP ViT-B/32 Embeddings - LightGBM Fraud v2 - kNN Price - HNSW   |
+---------------------------------------------------------------------+
          |                        |                       |
+---------v------+      +----------v------+    +----------v----------+
|   MongoDB 6.0  |      |   Redis 7       |    |  Cloudinary CDN     |
|  (Primary DB)  |      |  (Cache/Queue)  |    |  (Image Storage)    |
+----------------+      +-----------------+    +---------------------+
```

### Data Flow — Listing Creation

```
User uploads images
        |
        v
  Backend receives -> validates -> saves to Cloudinary
        |
        v
  BullMQ: enqueue "image-processing" job
        |
        v
  imageProcessor Worker:
    +- 1. pHash (64-bit DCT perceptual hash + 6-hash set: plain/mirror/r90/r180/r270/vflip)
    +- 2. MobileNet category classification
    +- 3. Condition scoring (brightness / contrast / edge density)
    +- 4. Damage scoring (heuristic pixel analysis)
    +- 5. CNN feature extraction -> cnnFeatures stored per image
    +- 6. ML Service: CLIP embedding -> vector stored
    +- 7. Identity verification (serial/IMEI/VIN registry check)
    +- 8. Product fingerprint visual similarity check
    +- 9. Fraud risk score computed & product document updated
```

---

## 3. Tech Stack

### Frontend
| Layer | Technology |
|---|---|
| Framework | React 18 + Vite |
| Styling | TailwindCSS + custom SCSS |
| Routing | React Router v6 |
| State | React Context API (Auth, Socket, Currency, Theme) |
| Real-time | Socket.IO Client |
| HTTP | Axios |
| Notifications | react-hot-toast |
| Payments | Stripe.js / @stripe/react-stripe-js |

### Backend
| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express.js |
| Database | MongoDB 6 via Mongoose |
| Auth | JWT (access + refresh tokens, httpOnly cookies) |
| Real-time | Socket.IO |
| Job Queue | BullMQ + Redis |
| Image Processing | Sharp (native) |
| ML (Node) | TensorFlow.js + @tensorflow-models/mobilenet |
| Payments | Stripe SDK |
| Image Storage | Cloudinary |
| Security | Helmet, express-rate-limit, express-mongo-sanitize |

### ML Microservice
| Layer | Technology |
|---|---|
| Runtime | Python 3.11 |
| Framework | FastAPI + Uvicorn |
| Vision Model | CLIP ViT-B/32 (open-clip-torch) |
| Fraud Classifier | LightGBM (gradient boosted trees) |
| Price Estimation | kNN + quantile regression |
| ANN Search | HNSW index (via hnswlib) |
| Calibration | Isotonic / Sigmoid probability calibration |

---

## 4. Repository Structure

```
Resell/
+-- frontend/                  # React + Vite SPA
|   +-- src/
|   |   +-- components/        # Reusable UI components
|   |   +-- contexts/          # Auth, Socket, Currency, Theme providers
|   |   +-- hooks/             # Custom React hooks
|   |   +-- pages/             # Route-level page components (25 pages)
|   |   +-- services/          # Axios API call wrappers
|   |   +-- styles/            # Global CSS + responsive SCSS
|   |   +-- utils/             # Helper utilities
|   |   +-- App.jsx            # Router & layout
|   |   +-- main.jsx           # Entry point + providers
|   +-- tailwind.config.js
|   +-- vite.config.js
|
+-- backend/
|   +-- src/
|       +-- config/            # DB connection, env validation
|       +-- controllers/       # Route handlers (13 controllers)
|       +-- middleware/        # Auth, upload, error middleware
|       +-- models/            # 15 Mongoose schemas
|       +-- queues/            # BullMQ queue definitions
|       +-- routes/            # Express routers
|       +-- services/          # Business logic & ML integrations
|       |   +-- fraudDetection.js       # Unified risk engine
|       |   +-- imageHash.js            # DCT pHash implementation
|       |   +-- imageClassifier.js      # MobileNet via TF.js
|       |   +-- computerVision.js       # Condition / damage scoring
|       |   +-- cvAdapter.js            # CV provider (local heuristics / remote ML)
|       |   +-- productFingerprint.js   # CNN cosine similarity
|       |   +-- identityVerification.js # Serial/IMEI/VIN registry
|       |   +-- provenance.js           # Ownership chain
|       |   +-- trustScore.js           # Seller trust score
|       |   +-- priceRecommendation.js  # AI price engine
|       |   +-- priceSweep.js           # Stale price re-analysis sweep
|       |   +-- mlClient.js             # HTTP client -> ML service
|       |   +-- vectorSearch.js         # CLIP vector queries
|       |   +-- exchangeRates.js        # Live FX rates
|       |   +-- stripeService.js        # Stripe checkout & webhooks
|       +-- sockets/           # Socket.IO event handlers
|       +-- workers/           # BullMQ worker processes
|       +-- server.js          # Express app entry point
|
+-- ml-service/                # Python FastAPI microservice
|   +-- models/                # CLIP model wrapper
|   +-- pipeline/              # v2 pipeline modules
|   |   +-- fraud_v2.py        # LightGBM fraud classifier
|   |   +-- price_v2.py        # Quantile price estimator
|   |   +-- ann_index.py       # HNSW ANN index
|   |   +-- embedding_cache.py # In-memory embedding cache
|   |   +-- logging_store.py   # Prediction logging + drift
|   |   +-- vision_llm.py      # Vision LLM integration
|   |   +-- config.py          # Feature flags & thresholds
|   +-- services/              # Legacy pipeline (v1)
|   +-- training/              # Model training scripts
|   +-- eval/                  # Evaluation scripts
|   +-- main.py                # FastAPI app & endpoints
|   +-- requirements.txt
|   +-- Dockerfile
|
+-- docker-compose.yml         # Backend stack orchestration (API, workers, ML service, DB, Redis)
+-- .env.example               # Environment variable template
```

---

## 5. Frontend

### Pages

| Page | Path | Description |
|---|---|---|
| `Home` | `/` | Hero, featured listings, categories |
| `Login` | `/login` | Sign in |
| `Register` | `/register` | Create an account |
| `Marketplace` | `/marketplace` | Browse, filter, search all listings |
| `ProductDetail` | `/product/:id` | Full listing + fraud indicators + reviews |
| `SellerProfile` | `/seller/:id` | Public seller page + trust score |
| `SellProduct` | `/sell` | Multi-step listing creation with AI assist |
| `EditProduct` | `/edit/:id` | Edit existing listing |
| `Favorites` | `/favorites` | Saved listings |
| `Offers` | `/offers` | Offer management (make / counter / accept) |
| `Checkout` | `/checkout/:id` | Stripe payment flow |
| `OrderSuccess` | `/order-success` | Post-payment confirmation |
| `OrderCancelled` | `/order-cancelled` | Cancelled payment landing |
| `Orders` | `/orders` | Order history |
| `OrderDetail` | `/orders/:id` | Order tracking & management |
| `MyProducts` | `/my-products` | Seller's own listings |
| `Profile` | `/profile` | User settings |
| `Chat` | `/chat` | Real-time messaging with socket presence |
| `AdminDashboard` | `/admin/dashboard` | Platform overview & moderation |
| `AdminUsers` | `/admin/users` | User management |
| `AdminProducts` | `/admin/products` | Listing management |
| `AdminReports` | `/admin/reports` | Report queue |
| `AdminAnalytics` | `/admin/analytics` | Platform analytics |
| `AdminCategories` | `/admin/categories` | Category management |
| `NotFound` | `*` | 404 fallback |

### Context Providers

- **AuthContext** — JWT authentication, refresh token rotation, user state
- **SocketContext** — Socket.IO connection lifecycle, real-time events
- **CurrencyContext** — Live exchange rates, multi-currency formatting
- **ThemeContext** — Dark/light mode persistence

---

## 6. Backend API

The backend is a monolithic Express application running on **port 5000**.

### Registered Routes

| Prefix | Controller | Key Endpoints |
|---|---|---|
| `/api/auth` | authController | POST /register, POST /login, POST /logout, POST /refresh, GET /me, PUT /profile, PUT /password |
| `/api/products` | productController | GET /, POST /, GET /:id, PUT /:id, DELETE /:id, GET /suggest-price, GET /brands, GET /mine, GET /:id/similar, GET /:id/reviews, GET /:id/identity, POST /:id/identity/possession-challenge, PATCH /:id/sold |
| `/api/categories` | categoryController | GET /, GET /stats, GET /:slug, POST /, PUT /:id, DELETE /:id |
| `/api/sellers` | sellerController | GET /:id, GET /:id/trust, POST /:id/reviews, GET /:id/similar |
| `/api/offers` | offerController | POST /, GET /mine, GET /received, GET /:id, PUT /:id, POST /:id/accept, POST /:id/reject, POST /:id/counter |
| `/api/chat` | chatController | GET /unread-count, POST /conversations, GET /conversations, GET /conversations/:id/messages, POST /messages, POST /conversations/:id/read |
| `/api/orders` | orderController | GET /mine, GET /selling, GET /:id, PATCH /:id/ship, PATCH /:id/deliver, POST /:id/cancel |
| `/api/checkout` | checkoutController | POST /session, POST /webhook |
| `/api/favorites` | favoriteController | GET /, GET /:productId/check, POST /:productId, DELETE /:productId |
| `/api/reports` | reportController | POST /, GET /, PUT /:id |
| `/api/notifications` | notificationController | GET /, GET /unread, PATCH /:id/read, PATCH /read-all |
| `/api/exchange-rates` | exchangeController | GET /rates, POST /convert |
| `/api/admin` | adminController | GET /stats, GET /analytics, Users / products / reports / identity management |

### Rate Limits

| Endpoint | Window | Max Requests |
|---|---|---|
| All `/api/*` | 15 min | 500 |
| `/api/auth/login` | 15 min | 20 |
| `/api/auth/register` | 15 min | 20 |
| Product creation | 1 hour | 20 |
| Chat messages | 1 min | 60 |

---

## 7. ML / AI System — Deep Dive

The fraud detection, condition assessment, and price recommendation system is split across two layers:

1. **Node.js services** — lightweight, always-on analysis using TF.js MobileNet + Sharp pixel analysis
2. **Python ML microservice** — heavier CLIP + LightGBM models, called asynchronously via HTTP

### 7.1 Image Fraud Detection Pipeline

Every image uploaded triggers a sequential analysis pipeline inside the `imageProcessor` BullMQ worker. The results are aggregated into a single **risk score (0-100)** with human-readable `factors[]`.

```
Image Upload
    |
    +- Step 1: pHash (64-bit DCT) + 6-hash set (plain/mirror/r90/r180/r270/vflip)
    |          -> compare against all listings in same category (up to DUPLICATE_SCAN_CAP=500)
    |          -> Hamming distance <= HASH_SIMILARITY_THRESHOLD=12 -> +35 risk points
    |
    +- Step 2: MobileNet classification
    |          -> top ImageNet labels -> ReSell category taxonomy
    |          -> auto-fills category if confidence >= 0.15
    |
    +- Step 3: Condition assessment (Sharp pixel analysis)
    |          -> brightness / contrast / sharpness -> score 30-100
    |          -> label: like-new / good / fair / poor
    |
    +- Step 4: Damage detection (heuristic)
    |          -> edge density via Sobel-like gradient
    |          -> score 0-100 (higher = more damage)
    |
    +- Step 5: CNN feature extraction (MobileNet penultimate layer)
    |          -> 1024-dim feature vector stored per image
    |
    +- Step 6: CLIP embedding (via ML service HTTP call)
    |          -> 512-dim normalized vector stored per image
    |
    +- Step 7: Identity verification (if serial/IMEI provided)
    |          -> registry lookup -> ownership signals
    |
    +- Step 8: Visual fingerprint similarity (CNN)
    |          -> cosine similarity against up to VISUAL_SCAN_CAP=200 candidates
    |          -> >= 0.90 -> +10 / >= 0.97 -> +20 (supporting-only, section 7.4)
    |
    +- Step 9: Description duplicate / scam-text signals
    |          -> exact description match (fast path) -> +20
    |          -> near-dup same seller (ML cosine >= 0.92 else 3-gram Jaccard >= 0.85) -> +20
    |          -> near-dup other seller, same category -> +15
    |          -> scam-text lexical analyzer -> up to +25 (section 7.10)
    |
    +- Step 10: Aggregate (v1 + v2 fusion) -> product.aiAnalysis updated
```

### 7.2 Perceptual Hashing (pHash)

**File:** `backend/src/services/imageHash.js`

The system implements a **64-bit DCT-based perceptual hash** — the industry-standard algorithm for near-duplicate image detection.

#### Algorithm

```
1. Resize image -> 32x32 grayscale (via Sharp)
2. Compute 2D Discrete Cosine Transform (DCT)
   - Uses a precomputed cosine lookup table (COS_TABLE)
     to avoid ~65,000 Math.cos() calls per image
3. Extract the top-left 8x8 DCT block (64 lowest frequencies)
4. Compute median of the 64 coefficients
5. Hash bit[i] = 1 if coeff[i] >= median, else 0
6. Encode 64 bits as 16-char hex string
```

#### Duplicate Detection

```js
// Hamming distance between two 64-bit hex hashes
const hammingDistance = (hash1, hash2) => {
  const bin1 = BigInt('0x' + hash1).toString(2).padStart(64, '0');
  const bin2 = BigInt('0x' + hash2).toString(2).padStart(64, '0');
  // count differing bits
};

// Threshold: <= 12 = duplicate
// Empirical validation (scripts/validate_phash.js, 24-image corpus):
//   0 false positives across 276 different-product pairs
//   closest different-product pair at Hamming distance 16
//   (4-bit margin below the threshold of 12)
//   61/120 same-item variant pairs within the threshold
// Verdict: threshold 12 retained — validated on a 24-image corpus,
//   0/276 false positives across different-product pairs.
const HASH_SIMILARITY_THRESHOLD = 12;
```

pHash catches exact reposts and lightly-edited copies; heavily transformed variants (large crops, recompression) may exceed the gate and are covered by the CNN fingerprint layer (section 7.4).

#### Mirror Hash (Anti-Evasion)

A known fraud tactic is **horizontally flipping a stolen image** to evade pHash detection (empirically, the DCT hash of a flipped image differs by a mean Hamming distance of 27.17, with a minimum of 16 — see `scripts/phash_validation_results.md`). The mirror hash exists precisely because flipped variants can fall within or near the duplicate gate — comparing both normal and mirror hashes closes this evasion path. The system counters this by storing **two hashes per image**: the normal pHash and the pHash of the horizontally flipped version:

```js
const mirrorPerceptualHashFromBuffer = async (imageBuffer) => {
  const flopped = await sharp(imageBuffer).flop().png().toBuffer();
  return perceptualHashFromBuffer(flopped);
};
```

Fraud check: A new upload's `[normalHash, mirrorHash]` pair is compared against every existing listing's pair. A mirrored stolen image's `normalHash` matches the original's `mirrorHash`.

#### Rotation & Vertical-Flip Hashes

Flipping is not the only cheap transform a reposter uses. `backend/src/services/imageHash.js` exposes `orientationHashesFromBuffer()`, which computes the **full orientation probe set** in one call — `{ rotationHashes: [r90, r180, r270], vflipHash }` alongside the plain and mirror hashes. These are persisted on the product as `aiAnalysis.rotationHashes` and `aiAnalysis.vflipHash` (see §11), and the fraud engine probes the whole set so a 90°/180°/270°-rotated or upside-down re-upload is caught just like a mirror. Validation recorded **96/96** rotation cases matched under this rotation-aware probe (see §7.11 and `backend/scripts/phash_validation_results.md`). The plain↔mirror relationship does **not** extend to rotations: a rotated copy must be hashed at the rotation, which is exactly what this probe set stores.

### 7.3 MobileNet Image Classification

**File:** `backend/src/services/imageClassifier.js`

Uses **TensorFlow.js + @tensorflow-models/mobilenet v2 (alpha 1.0)** to classify uploaded images into ReSell's category taxonomy.

#### Inference Pipeline

```
imageBuffer (raw bytes from Cloudinary upload)
    |
    v Sharp: resize to 224x224, removeAlpha(), raw RGB pixels
    |
    v tf.tensor3d([224, 224, 3], float32) of raw 0-255 pixels
      (@tensorflow-models/mobilenet normalizes internally — pre-dividing
      by 255 collapses the effective input to near-black)
    |
    v mobilenet.classify(tensor, topK=10) -> [{className, probability}]
    |
    v Map ImageNet labels -> ReSell categories
      (130+ label-to-category mappings defined)
    |
    v Aggregate probabilities per category -> pick winner
    |
    v Confidence >= 0.15 -> auto-fill category suggestion
```

#### Label Mapping Example

```js
const IMAGENET_TO_CATEGORY = {
  'cellular telephone': 'Electronics',
  'laptop': 'Electronics',
  'sneaker': 'Fashion',
  'handbag': 'Fashion',
  'sofa': 'Home & Garden',
  'barbell': 'Sports & Outdoors',
  'book': 'Books & Media',
  // ... 130+ mappings covering all categories
};
```

#### Confidence Fusion with Keywords

The system fuses two independent signals:

| Scenario | Source used | Result |
|---|---|---|
| MobileNet conf >= 0.15 | `image-model` | Category from model |
| MobileNet + keyword agree | `image-model+keyword` | Confidence +0.10 |
| MobileNet sub-threshold, keyword agrees | `image-model+keyword` | Capped at 0.95 |
| Only keyword matches | `keyword` | Low confidence |
| No match | `none` | Returns "Other" |

### 7.4 CNN Product Fingerprinting

**File:** `backend/src/services/productFingerprint.js`

While pHash detects **identical image copies**, the CNN fingerprint detects **the same physical product appearance** across different photos (different angles, backgrounds, lighting).

#### How It Works

```
Per listing: collect all images with cnnFeatures (MobileNet embeddings)
          |
          v
Build aggregate fingerprint:
  - Unit-normalized mean of all per-image feature vectors
  - Creates a single representative vector for the listing
          |
          v
Cross-listing comparison (up to 200 candidates):
  For each image in listing A:
    For each image in listing B:
      cosine_similarity(featureA, featureB)
    Keep best match per A-image
  aggregateSimilarity = mean of all best matches
          |
          v
Thresholds (configurable via env vars):
  MEDIUM_SIMILARITY_THRESHOLD = 0.90  -> supporting signal (weight: 10)
  STRONG_SIMILARITY_THRESHOLD = 0.97  -> supporting signal (weight: 20)
```

> **Important design decision:** Visual similarity alone is **never proof of fraud**. Two sellers may legitimately own the same model (e.g., iPhone 15 Pro). The visual fingerprint is always a *supporting signal* combined with other evidence. It can never push a listing to high risk by itself.

### 7.5 Computer Vision — Damage & Condition Scoring

**File:** `backend/src/services/computerVision.js`

Uses **Sharp** for pixel-level image analysis without requiring any external ML model.

#### Condition Score (100 to 30, lower = worse)

```
Base score: 100

Brightness (0-255 mean across channels):
  < 60    -> -15 pts  ("Image is dark")
  > 220   -> -10 pts  ("Image is overexposed")
  else    ->  0 pts   ("Good lighting")

Contrast (std dev per channel):
  < 20    -> -10 pts  ("Low contrast - possible dull surface")
  > 80    ->  0 pts   ("High detail contrast")

Sharpness (heuristic = contrast x 0.8 + brightness x 0.2):
  < 30    ->  -8 pts  ("Image blur detected")

Final: clamped to [30, 100]
Labels: >= 90 -> like-new | >= 75 -> good | >= 60 -> fair | else -> poor
```

#### Damage Score (0 to 100, higher = more damage)

```
Edge density analysis only (Sobel-like gradient on 64x64 grayscale thumbnail):
  For each pixel, compute |gx| + |gy| (horizontal + vertical gradient)
  edgeRatio = pixels_with_gradient > 60 / total_pixels

  edgeRatio > 0.45  -> +55  ("Extremely high edge density - severe cracking / heavy wear")
  edgeRatio > 0.35  -> +35  ("High edge density - possible cracks or heavy wear")
  edgeRatio > 0.20  -> +20  ("Elevated edge density - possible surface scratches or wear")
  edgeRatio < 0.08  ->  +0  ("Smooth surface")

Final: clamped to [0, 100]
Levels: >= 50 -> high | >= 25 -> medium | else -> low
```

Brightness / contrast / sharpness are consumed only by the condition score — they are never double-counted as damage (the same lighting problem used to stack +50 from overlapping quality rules).

These scores feed into:
1. The **price recommendation engine** (CV score adjusts the recommended price)
2. The **fraud risk engine** (damage score >= 50 adds +5 risk points)

> **Availability semantics:** When Sharp is unavailable or the image cannot be decoded, both `assessCondition()` and `detectDamage()` return `score: null` with `available: false`. A missing visual estimate is **never fabricated** as a 0 — the UI is expected to show "insufficient evidence" instead of a misleading score.

### 7.6 Identity Verification & Provenance

**Files:** `backend/src/services/identityVerification.js` · `backend/src/services/provenance.js`

A product registry for physical identifiers (serial numbers, IMEI, VIN).

#### Ownership Lifecycle

```
NEW identifier submitted
    -> Hash identifier (SHA-256, never stored raw)
    -> Create ProductIdentity record
    -> Issue 6-digit verification code (TOTP-like)
    -> Seller verifies by entering the code (proof-of-possession)

EXISTING identifier submitted
    +- Same owner?              -> Legitimate relist (low risk)
    +- Verified sale/transfer?  -> Legitimate resale (low risk)
    +- No verified transfer?    -> OWNERSHIP_MISMATCH signal (+35 risk)
    +- Reported stolen?         -> REPORTED_STOLEN_PRODUCT signal (+100 risk)
```

#### Fraud Signals from Identity

| Signal | Weight | Meaning |
|---|---|---|
| `PRODUCT_IDENTIFIER_REUSED` | +10 | Identifier used in another listing |
| `MULTIPLE_ACTIVE_LISTINGS` | +30 | Same physical item listed multiple times |
| `OWNERSHIP_MISMATCH` | +35 | Registered to different owner, no transfer |
| `NO_VERIFIED_TRANSFER` | +15 | No verified sale found for this identifier |
| `PROVENANCE_INTEGRITY_FAILURE` | +45 | Chain integrity failure or flagged identity |
| `REPORTED_STOLEN_PRODUCT` | +100 | Identifier in stolen goods registry |
| `POSSESSION_VERIFICATION_FAILED` | +10 | Wrong verification code submitted |

> **Key semantic:** An identifier being *reused* is never automatically fraud. Same identifier + legitimate ownership transfer = normal resale. Same identifier + conflicting ownership + no transfer = suspicious.

### 7.7 Seller Trust Score

**File:** `backend/src/services/trustScore.js`

A transparent **0-100 seller trust score** with six independently calculated components:

| Component | Max Points | Calculation |
|---|---|---|
| Account Age | 15 | `(days / 365) x 15` — grows linearly over one year |
| Sales Volume | 20 | `log10(salesCount + 1) x 10` — logarithmic to prevent gaming. Capped at 10 (50%) when the last 20 sales are &gt; 60% repeat-buyer concentrated (confederate-reputation guard; ratio + capped flag exposed in the breakdown). |
| Average Rating | 25 | `(avgRating / 5) x 25` — default 3.5/5 for new sellers |
| Response Time | 15 | `15 - (avgResponseMinutes / 60) x 5` — faster = higher |
| Complaint-Free | 15 | `(1 - complaints/20) x 15` — penalizes reports |
| Listing Quality | 10 | Average images per listing + description length ratio |

**Trust Levels:**
- 0-24: new
- 25-44: developing
- 45-64: established
- 65-79: trusted
- 80-100: excellent

### 7.8 Price Recommendation Engine

**File:** `backend/src/services/priceRecommendation.js`

A transparent, multi-factor pricing algorithm with full audit trail.

#### Step 1: Base Price Calculation

```
If originalPrice (MSRP) is provided:
  base = originalPrice
       x (1 - depreciationRate) ^ yearsUsed
       x brandMultiplier
       x conditionMultiplier

Depreciation rates by category (annual):
  Electronics: 18% | Fashion: 30% | Home & Garden: 10%
  Sports: 15% | Books: 25% | Automotive: 10%

Brand multipliers:
  Apple: 1.10x | Nike: 1.05x | Samsung: 1.02x | default: 1.00x

Condition multipliers:
  new: 0.95 | like-new: 0.82 | good: 0.65 | fair: 0.45 | poor: 0.25
```

#### Step 2: CV Adjustments

```
CV condition score (0-100):
  factor = (score/100) x 0.4 + 0.6
  Maps: score 0 -> 0.6x penalty | score 100 -> 1.0x (no change)

Damage score (0-100):
  factor = max(0.7, 1 - score/250)
  Maps: score 0 -> 1.0x | score 100 -> 0.7x (max 30% penalty)
```

#### Step 3: Comparable Listings Blending

```
If >= 3 comparables available:
  1. Filter to same condition as listing
  2. Compute median of same-condition comparable prices
  3. Remove outliers via IQR (Tukey's fence)
  4. Blend: 70% own calculation + 30% market median

IQR outlier removal prevents manipulated listings from skewing recommendations.
```

#### Step 4: Output

```
recommendedPrice +/- 15% -> [minPrice, maxPrice]

Confidence score:
  0.5 base
  +0.20 if MSRP provided
  +0.10 if comparables provided
  +0.10 if CV score available
  +0.05 if damage score available
  Max: 0.95
```

### 7.9 Risk Scoring — Unified Fraud Engine

**File:** `backend/src/services/fraudDetection.js`

All signals are aggregated into a single score by the `detectRisk()` function:

| Signal | Risk Points |
|---|---|
| Duplicate image (pHash Hamming distance <= 12) | +35 |
| Price < 15% of original | +25 |
| Price > 150% of original | +10 |
| High-value listing (>5000) from account < 30 days old | +15 |
| Same description as another active listing (exact match — fast path) | +20 |
| Near-duplicate description, **same seller** (ML cosine >= 0.92, else 3-gram Jaccard >= 0.85) | +20 |
| Near-duplicate description, **different seller**, same category (same thresholds) | +15 |
| Image–title mismatch (CLIP image↔title cosine < 0.20, strong band only — ML required) | +15 |
| Category mismatch (MobileNet predicted vs chosen, confidence >= 0.5) | +10 |
| Cross-category image repost (CLIP cosine >= 0.93, cross-seller, pHash did **not** fire) | +20 |
| Listing burst: >= 5 listings in 24h from an account < 7 days old | +15 |
| Listing burst: >= 10 listings in 24h (any account) | +10 |
| Scam-text patterns (lexical heuristics, capped — see §7.10) | +25 max |
| Seller has > 3 reports against them | +15 |
| AI damage score >= 50 | +5 |
| Identity signals (OWNERSHIP_MISMATCH, etc.) | +10 to +100 |
| Visual CNN fingerprint similarity | +10 to +20 |

```
riskScore = clamp(sum of all signals, 0, 100)
Risk level: < 25 -> low | 25-49 -> medium | >= 50 -> high
```

The score and `factors[]` array are stored in `product.aiAnalysis.riskAssessment.riskScore` and `product.aiAnalysis.riskAssessment.factors` (schema in section 11) and displayed prominently in the product detail page.

**Near-duplicate descriptions.** The exact-match row above is a fast path: if an identical description already exists on one of the seller's active listings the similarity scan is skipped entirely. Otherwise `detectRisk()` compares the description against the seller's other active listings (cap `DESC_DUP_SCAN_CAP`, default 100) and, if nothing matches, against other sellers' active listings in the same category (cap `OTHER_SELLER_DESC_SCAN_CAP`, default 200). Similarity is CLIP text embeddings via `POST /text-embed` (cosine, threshold 0.92) when the ML service is reachable, otherwise a pure-JS character 3-gram Jaccard score (threshold 0.85); text is lowercased and whitespace-collapsed first. This catches the "same listing, two words changed" evasion. **Honest labeling:** the fallback is a lexical overlap measure and the embedding path is a frozen general-purpose encoder — neither is a fraud-specific model, and a full rephrase evades both.

**Content-mismatch, cross-category, and velocity signals.** Four further signals feed the same score, all supporting-only (multi-object listings are categorized by their primary detected item — see §7.12):

- **Image–title mismatch.** After CLIP image embedding, the worker compares the image embedding with the CLIP *text* embedding of the title (`POST /text-embed`). Only the **strong** band (cosine `< 0.20`) fires (`IMAGE_TEXT_MISMATCH`, **+15**); the weak band `0.20–0.30` adds nothing and is logged for shadow analysis. Short or purely generic titles ("laptop for sale") are skipped, and a missing ML service skips silently.
- **Category mismatch.** The worker compares MobileNet's predicted category with the seller's chosen category; a confident disagreement (`confidence >= 0.5`) fires (`CATEGORY_MISMATCH`, **+10**) and also widens the pHash probe to the suggested category (scan routing — §7.11).
- **Cross-category image repost.** A platform-wide, cross-seller CLIP vector scan (`CROSS_CATEGORY_SIM_THRESHOLD = 0.93`, top `CROSS_CATEGORY_SCAN_K = 50`) catches the same photo filed under a *different* category (`CROSS_CATEGORY_IMAGE_REPOST`, **+20**). It is suppressed whenever the pHash duplicate gate already fired, so it can never exceed the +35 duplicate weight.
- **Listing velocity.** A single indexed count of the seller's listings in the last 24h. `>= 5` listings from an account younger than 7 days fires `LISTING_BURST_NEW_ACCOUNT` (**+15**); `>= 10` listings from any account fires `LISTING_BURST` (**+10**). This signal is **behavioral**, **capped**, and **combinable**: the two thresholds never stack (the larger weight wins) and it is independent of listing content, so it adds on top of the content signals above.

### 7.10 Scam-Text Pattern Analyzer

**File:** `backend/src/services/textScamAnalyzer.js`

A **lexical, keyword/regex-based** analyzer (a rule engine, *not* a trained model) over `title + description`, capped at **+25** total so a suspicious description can never flag a listing on its own:

| Signal | Trigger | Points |
|---|---|---|
| `SUSPICIOUS_CONTACT_INFO` | phone number, email address, or WhatsApp/messaging-app redirect (pay off-platform) | +10 |
| `URGENCY_PRESSURE_PHRASES` | >= 2 / >= 4 clichés ("urgent sale", "need cash", "moving abroad", "last date", "advance payment", "trust me", …) | +10 / +15 |
| `EXCESSIVE_CAPS` | text length > 30 and > 50% of letters uppercased | +5 |
| `EXCESSIVE_PUNCTUATION` | more than 5 exclamation marks | +5 |
| `LOWBALL_URGENCY_COMBO` | the word "urgent" **and** price < 40% of `originalPrice` | +15 |

The last rule is an *interaction* signal: neither urgency nor a low price is suspicious alone, but an urgent sale at under 40% of MSRP is the classic "get paid fast" pattern the linear price block cannot express. Detailed factor strings are admin-only; non-admin surfaces receive the generalized `content_scam_signals` category.

**Limitations / roadmap:** every rule is trivially evaded by synonyms, spacing, or leetspeak. Once labeled scam text exists, replace/augment this with an embedding-based classifier via the ML service (`POST /text-embed`) or a supervised text model. Do not treat the current signals as a trained detector.

**Note on behavioural signals.** This analyzer looks only at *content* (title/description). The **behavioral** listing-velocity signals (`LISTING_BURST_NEW_ACCOUNT` / `LISTING_BURST`) are computed separately inside `detectRisk()` from the seller's 24h listing count, are **capped** (the two thresholds never stack — the larger weight wins), and are **combinable** with the content signals (§7.9).

### 7.11 Duplicate Detection — Complete Flow

#### Purpose

The duplicate-detection subsystem exists to prevent image reuse and near-duplicate listings before they propagate. The design goal is **multi-layer defense**: a cheap perceptual-hash gate blocks exact/reposted copies early, a visual CNN fingerprint covers same-product appearance under viewpoint/lighting changes, text near-duplicate detection blocks the "two words changed" evasion, and all signals converge in the unified risk engine (`detectRisk()` in `backend/src/services/fraudDetection.js`). Listings photographed with several items together are first reduced to their primary detected item (§7.12) so bundle arrangements don't defeat appearance matching. Final outputs are stored in `product.aiAnalysis` (see §11). Final outputs are stored in `product.aiAnalysis` (see §11). When the worker detects a confident category mismatch, it also **widens the pHash probe to the suggested category's listings** (cross-category scan routing), so a repost filed under the wrong category cannot scope the duplicate check away.

#### End-to-End Flow (ASCII)

```
Upload (Cloudinary)
    |
    v
Sharp preprocess (grayscale 32x32 for pHash; full-res for CV)
    |
    v
Generate 6-hash set per image:
  {plain pHash, mirror (flop) pHash, r90, r180, r270, vflip}
    |
    v
pHash set-probe against existing listings in same category
  - scan cap: DUPLICATE_SCAN_CAP = 500
  - Hamming distance <= HASH_SIMILARITY_THRESHOLD = 12  -> match
    |
    v  (if match)
Upload gate / worker emits DUPLICATE_IMAGE (+35 risk points)
    |
    v  (else)
Visual CNN fingerprint scan (MobileNet embeddings)
  - candidate cap: VISUAL_SCAN_CAP = 200
  - mean best-match cosine >= 0.90 -> +10 ; >= 0.97 -> +20
    |
    v
Description check (exact fast-path first, then near-duplicate)
  - exact description match (fast path) -> +20
  - near-dup same seller: ML cosine >= 0.92 else 3-gram Jaccard >= 0.85
      (cap DESC_DUP_SCAN_CAP = 100) -> +20
  - near-dup other seller, same category
      (cap OTHER_SELLER_DESC_SCAN_CAP = 200) -> +15
  - scam-text lexical analyzer -> +0 to +25 (capped, §7.10)
    |
    v
Image-text + category agreement (worker; requires ML embeddings)
  - CLIP image<->title cosine < 0.20 (strong band) -> IMAGE_TEXT_MISMATCH (+15)
      (weak band 0.20-0.30 -> +0, shadow-logged; generic/short titles skipped)
  - MobileNet predicted != chosen, confidence >= 0.5 -> CATEGORY_MISMATCH (+10)
      (also widens the pHash probe to the suggested category)
    |
    v
Platform-wide CLIP vector scan (worker; cross-seller, any category)
  - top-K CROSS_CATEGORY_SCAN_K = 50, crossCategory = true
  - cosine >= CROSS_CATEGORY_SIM_THRESHOLD = 0.93 AND pHash did NOT fire
      -> CROSS_CATEGORY_IMAGE_REPOST (+20)
    |
    v
Listing velocity (behavioral; single indexed 24h count)
  - >= 5 in 24h from an account < 7 days old -> +15
  - >= 10 in 24h from any account -> +10 (never stacked; larger weight wins)
    |
    v
Aggregate + v1/v2 fusion
  - v1 only -> fusionMode "v1"
  - v2 only -> fusionMode "v2"
  - both    -> max(v1, round(v2*100)), fusionMode "v1+v2-max"
    |
    v
Stored in aiAnalysis.riskAssessment (+ imageHashes / rotationHashes / vflipHash)
```

#### Detection Matrix

| Fraud scenario | Example | Layer | Signal/weight | Empirically validated? |
|---|---|---|---|---|
| Reposted exact image | Same image copied verbatim | pHash (6-hash set probe) | `DUPLICATE_IMAGE` (+35) | Yes — 0/276 FP across different-product pairs; threshold 12 retained (`scripts/phash_validation_results.md`). |
| Mirrored / reflipped repost | Horizontally flipped stolen image | pHash (mirror hash) | `DUPLICATE_IMAGE` (+35); plain-vs-mirror cross-match | Yes — flipped variants: mean Hamming 27.17 / min 16; mirror hash closes the class. |
| Rotated 90/180/270 repost | Stolen image rotated to evade pHash | pHash (rotation hashes r90/r180/r270) | `DUPLICATE_IMAGE` (+35) | Yes — rotation recall 96/96; stored as `aiAnalysis.rotationHashes`. |
| Vertical-flip (upside-down) repost | Image flipped on the vertical axis | pHash (vflip hash) | `DUPLICATE_IMAGE` (+35) | Yes — covered by the 6-hash set probe; stored as `aiAnalysis.vflipHash`. |
| Same product, different angle / lighting / crop | Seller reuses the same physical item with new photos | CNN visual fingerprint | `VISUAL_FINGERPRINT_MEDIUM` (+10 @ >=0.90); `VISUAL_FINGERPRINT_STRONG` (+20 @ >=0.97) | Partially — cosine similarity on MobileNet embeddings; supporting-only signal (never proof alone, §7.4). |
| Same listing text, word-for-word | Description copied verbatim | Text exact-match fast path | `DUPLICATE_DESCRIPTION` (+20) | Yes — fast path skips the similarity scan entirely. |
| Near-duplicate description, same seller | "iPhone 15 Pro, 256GB" -> "iPhone 15 Pro - 256 GB" | Text near-duplicate (ML cosine / 3-gram Jaccard) | `DUPLICATE_DESCRIPTION` (+20) (cap 100) | Yes — CLIP cosine >= 0.92, else 3-gram Jaccard >= 0.85; text lowercased + whitespace-collapsed first. |
| Near-duplicate description, other seller (same category) | Same boilerplate reused across sellers | Cross-seller text near-duplicate | `DUPLICATE_DESCRIPTION` (+15) (cap 200) | Yes — same thresholds, same-category scope only. |
| Off-topic photo (title/photo mismatch) | Titled "iPhone 15 Pro" but the photo shows an unrelated item | CLIP image↔title (worker) | `IMAGE_TEXT_MISMATCH` (+15) | Yes — strong band only (< 0.20); generic/short titles skipped; skipped when ML down (unit tests). |
| Category disagreement | Listing filed under the wrong category | MobileNet classification (worker) | `CATEGORY_MISMATCH` (+10) | Partial — fires only at MobileNet confidence >= 0.5; also widens the pHash probe to the suggested category. |
| Same photo re-posted under another category | Stolen image moved to a different category to dodge the same-category pHash gate | Platform-wide CLIP vector scan (worker) | `CROSS_CATEGORY_IMAGE_REPOST` (+20) | Partial — cross-seller top-K scan, crossCategory = true; suppressed when pHash fired; skipped when ML down (unit tests, vectorSearch mocked). |
| Burst-spamming from a fresh account | Many listings published within 24h | Listing velocity (indexed 24h count) | `LISTING_BURST_NEW_ACCOUNT` (+15, age < 7d) / `LISTING_BURST` (+10) | Yes — thresholds never stack (larger wins); behavioral and capped (unit tests). |

#### Design Guarantees

1. **Orientation-complete hashing.** Each image contributes a 6-hash set — plain pHash, mirror (flop), r90, r180, r270, and vertical flip (`imageHash.js`) — so a repost cannot evade detection by a cheap flip or rotation. The set is persisted as `imageHashes` (plain + mirror), `rotationHashes`, and `vflipHash` (see §11).

2. **Bounded scans with visible truncation.** Every layer is capped (`DUPLICATE_SCAN_CAP=500`, `VISUAL_SCAN_CAP=200`, `DESC_DUP_SCAN_CAP=100`, `OTHER_SELLER_DESC_SCAN_CAP=200`) and the fraud engine logs when the candidate pool is truncated — silent under-scanning is surfaced, not hidden (§18 item 2).

3. **No single signal proves fraud.** pHash is a high-precision cheap gate; the CNN visual fingerprint is explicitly *supporting-only* (§7.4); scam-text is capped at +25 (§7.10). All signals aggregate in `detectRisk()` and, when both engines are present, fuse via `max(v1, round(v2*100))` (§8.4) — either engine may escalate, neither can downgrade, and never on a single weak signal.

#### Empirical Validation Summary

Numbers below are from `backend/scripts/phash_validation_results.md` (validated on a 24-image corpus: 276 different-product pairs, 120 same-item variant pairs):

- **Threshold retained:** `HASH_SIMILARITY_THRESHOLD = 12` (64-bit DCT pHash) — still the single source of truth for `fraudDetection.js` and the upload/edit duplicate gate.
- **False positives:** **0 / 276** different-product pairs at distance <= 12; the *closest* different-product pair sits at Hamming distance **16** — a 4-bit margin below the gate.
- **Same-item recall:** **61 / 120** same-item variant pairs fall within the gate; the remainder are the deliberately "hard" transforms handed to the CNN/text layers.
- **Rotation recall:** **96 / 96** rotation cases (90/180/270) matched under the rotation-aware probe set.
- **Flipped images:** mean Hamming distance between an image and its horizontal flip = **27.17** (minimum **16**); the mirror hash closes this evasion path.

**Honest limits of pHash.** pHash is robust to mild re-encoding, small crops, and brightness/contrast shifts, but it is **not** invariant to large crops, perspective warps, screenshots-of-screenshots, or arbitrary geometric edits — and the non-perceptual `sha256`-slice fallback used when Sharp is unavailable is invisible to pHash entirely (§18 item 3). pHash is therefore a cheap high-precision *gate*, not a complete solution: the pipeline layers CNN visual fingerprinting, description exact/near-duplicate checks, and v1/v2 fusion on top, and caps every scan so coverage loss is explicit. See **§18 Theoretical Limitations & Mitigations** for the full inventory (notably items 1–3, 11, 12, 15).

#### How to See It Live

`backend/scripts/seed.js` seeds a demo set covering five baseline cases (plus an optional sixth behavioural case via `--with-burst`) and then **runs the real `detectRisk()`** over them and prints a "Risk Assessment Table" — no risk value is hard-coded in the seed data:

- **Case 1 — exact duplicate image.** Two listings share the same `iphone-13-midnight.jpg`; the pHash probe fires `DUPLICATE_IMAGE` (**+35**), so the duplicate listing lands at roughly **risk 35** — the canonical reference for how the flow looks.
- **Case 2 — re-photographed variant.** The same product photographed differently (5% crop + brightness/JPEG change applied at seed time): shows that CNN/CLIP visual similarity is a *supporting* signal only.
- **Case 3 — legitimate same-category sellers.** Distinct photos/brands in the same category: expected **zero** duplicate signals — proof the pipeline does not penalise honest sellers.
- **Case 4 — mirror-flipped repost.** A horizontally flipped copy of the Case 1 image, which the mirror hash catches.
- **Case 5 — scam-text template.** Off-platform contact + urgency clichés exercise the scam-text signals (§7.10) served from a distinct image.
- **Case 6 — listing burst (`--with-burst`, `[DEMO]`).** Five rapid listings from a demo account younger than 7 days exercise the behavioral `LISTING_BURST_NEW_ACCOUNT` (**+15**) signal (§7.9). Omitted from the default run so the baseline seed stays clean.

So a single `node scripts/seed.js` run demonstrates the pHash, mirror, visual, and text layers feeding one aggregated score. (Redis/BullMQ workers need not be running: the printed scores come from `detectRisk()`; the fuller CNN/CLIP signals would require the workers and ML service up.) Run `node scripts/seed.js --with-burst` to additionally demonstrate the behavioral listing-velocity layer.

### 7.12 Multi-Object Image Handling

**Files:** `backend/src/services/imageClassifier.js` (detection + crops), `backend/src/workers/imageProcessor.js` (persistence + primary), `backend/src/controllers/productController.js` (`PUT primaryObjectIndex`), `frontend/src/pages/SellProduct.jsx` (overlays + picker)

Sellers often photograph several items together (a desk lot, a "bundle" photo). Classifying the whole frame then mislabels the listing and the visual fingerprint matches the *arrangement* instead of the *item*. The multi-object path handles this per cover image:

```
Cover image buffer
    |
    v
COCO-SSD detect() (same TF.js stack as MobileNet, lazy-loaded, cold start logged)
  - boxes with score >= OBJECT_DETECTION_MIN_SCORE (0.5)
  - greedy NMS: IoU > OBJECT_DETECTION_IOU_THRESHOLD (0.6) keeps the highest score
  - capped at OBJECT_DETECTION_MAX_OBJECTS (8) crops per image
    |
    v (per box)
Sharp crop (+10% padding per side, clamped) -> MobileNet classification + local CNN embedding
    |
    v
aiAnalysis.detectedObjects: [{ bbox, label, score, cropClassification, cropConfidence, cropEmbedding }]
```

- **No detections or any detection failure → whole-image analysis fallback exactly as today.** Detection is best-effort and never blocks listing creation.
- **Primary product selection.** Objects arrive sorted by detection score, so index 0 is the default primary. When `>= 2` objects are detected (`aiAnalysis.multiObject: true`), the primary crop's `cropClassification` drives the listing-level suggested category (and therefore the §7.9 category-agreement signal); a single object leaves the status-quo whole-image category untouched.
- **Seller override.** After publishing, the Sell page polls the worker result and — when `multiObject` — renders bounding-box overlays with labels ("Bottle 93%") over the cover photo. Clicking a box and choosing *Set as primary item* sends `PUT /api/products/:id { primaryObjectIndex }`: the backend re-points the category suggestion at that crop, re-runs the risk assessment, and re-enqueues the image worker (which preserves the seller's choice across re-runs). An out-of-range index is rejected with `400 INVALID_PRIMARY_OBJECT`.
- **Fingerprint.** `buildProductFingerprint()` appends the primary crop's embedding as an extra crosswise comparison vector (same local-MobileNet space crop-vs-crop), so a bundle photo of items A+B matches a single photo of A. Whole-image CLIP features are untouched; mismatched embedding spaces are skipped, never compared.
- **Bundle note.** `>= 3` objects store an informational `aiAnalysis.bundleNote` ("Bundle photo: N distinct items detected …"). It is **never a risk signal** and is displayed to admins/owners only (stripped for other viewers in `GET /product/:id`).

**Honest scope note.** COCO-SSD covers the 80 common COCO classes (bottles, cups, phones, chairs, …). Exotic or highly stylised items it was never trained on (collectibles, niche hardware, unusual angles) yield no boxes and silently take the whole-image fallback — the listing is never penalised for the detector's blind spots. Detection runs on the cover image only; per-image crop detail is recomputed on demand, never persisted per image.

---

## 8. ML Microservice (Python / FastAPI)

**Location:** `ml-service/` · **Port:** 8000 · **API Docs:** http://localhost:8000/docs

### 8.1 CLIP Embeddings

Uses **OpenCLIP ViT-B/32** (configurable via `CLIP_MODEL_NAME` / `CLIP_PRETRAINED`):

```
POST /embed
  Input:  { imageUrl: "https://..." }
  Output: { embedding: [512 floats], dimension: 512, processing_time_ms: ... }

POST /text-embed
  Input:  { text: "iPhone 15 Pro Max 256GB" }
  Output: { embedding: [512 floats], dimension: 512 }
```

All embeddings are **L2-normalized** so cosine similarity = dot product.

CLIP captures multi-modal semantics — images and text exist in the same vector space, enabling:
- Image-to-image similarity (same listing in different lighting/backgrounds)
- Text-to-image semantic matching (detecting "iPhone" listing with irrelevant image = potential fraud)
- Semantic similarity search across the marketplace

### 8.2 LightGBM Fraud Pipeline v2

**File:** `ml-service/pipeline/fraud_v2.py`

The v2 pipeline replaces the hand-weighted v1 rule engine with a **calibrated LightGBM binary classifier** trained on real fraud outcomes.

#### Feature Engineering (14 features)

| Feature | Type | Description |
|---|---|---|
| `max_cross_seller_emb_sim` | float | Max CLIP cosine similarity to any *other* seller's listings |
| `min_cross_phash_dist` | int | Min Hamming distance to any other seller's pHash |
| `cross_phash_exact` | bool | Any cross-seller pHash distance <= threshold |
| `max_same_seller_emb_sim` | float | Max CLIP similarity to same seller's own listings |
| `same_seller_relist` | bool | Seller is relisting their own previously sold item |
| `clip_image_text_sim` | float | Cosine similarity between listing image and title embeddings |
| `price_zscore_category` | float | Z-score of price vs category median (clipped to +-10) |
| `log_account_age_hours` | float | log1p(account age in hours) |
| `listings_per_hour` | float | Listing rate (spam signal) |
| `aspect_ratio` | float | Image width / height ratio |
| `is_stock_dimensions` | bool | Exactly 800x600 or 1200x900 (common stock photo dimensions) |
| `has_suspicious_software` | bool | Title/desc contains suspicious terms |
| `vision_llm_flag_count` | int | Number of flags from Vision LLM analysis |
| `vision_llm_confidence` | float | Vision LLM confidence score |

#### Vision LLM Integration

The Vision LLM (`pipeline/vision_llm.py`) is only called when the LightGBM score falls in the **uncertainty band** (configurable range, e.g. 0.3-0.7). This design:
- Reduces inference cost by ~70% (most listings are clearly legitimate or clearly fraudulent)
- Provides extra discriminating signal only for genuinely ambiguous cases

#### Probability Calibration

Raw LightGBM `predict_proba` outputs are calibrated using **isotonic regression** (sigmoid fallback when training data is insufficient), converting raw model scores to true probabilities.

### 8.3 Quantile Price Estimation (kNN)

**File:** `ml-service/pipeline/price_v2.py`

```
POST /price-estimate
  Input: {
    listing: { condition, originalPrice, yearsUsed, category },
    embedding: [512 floats],    // optional CLIP embedding
    comparables: [...],         // historical sold listings
    kNeighbors: 5
  }
  Output: { suggestedPrice, minPrice, maxPrice, confidence }
```

When CLIP embeddings are provided, comparable selection is based on **semantic similarity in the embedding space** rather than just category matching. The model computes:
- P25 (lower bound)
- P50 (median / suggested price)
- P75 (upper bound)

Using quantile regression against the k-nearest neighbors in the embedding space.

### 8.4 Shadow Mode & A/B Testing

The ML service supports three operating modes via the `ML_PIPELINE_V2` environment variable:

| Mode | Value | Behavior |
|---|---|---|
| Legacy | `0` (default) | v1 rule-based results served to all requests |
| Shadow | `shadow` | Legacy results **served**; v2 runs in parallel and logs both outputs |
| Production v2 | `1` | v2 LightGBM results served |

Shadow mode enables safe model validation:
- Both pipelines log outputs with a shared `recordId` (the listing `_id`)
- Admins attach outcomes (fraud confirmed / false positive) via `POST /feedback`
- Drift and accuracy metrics available at `GET /pipeline-stats`

**Backend outcome feedback loop** (`backend/src/services/mlClient.js`):
- `sendOutcomeFeedback({ recordId, outcome })` posts to `POST /feedback` and never throws — ML being down cannot block the request that produced the human decision.
- **Appeal approved** → `{ decided: 'false_positive', factorCategories }`; the overruled categories are also appended to `product.aiAnalysis.riskAssessment.disputedFactors` (`backend/src/controllers/appealController.js`).
- **Product report resolved with an action** → `{ decided: 'confirmed_fraud', reportAction }` (`backend/src/controllers/reportController.js`). Dismissed reports are deliberately not fed back (reporter may simply be mistaken).
- ml-service only attaches the outcome to a prediction record whose `outcome` is still `null`; no matching record is a silent no-op.

#### v1 / v2 Score Fusion Policy

`backend/src/services/fraudDetection.js` exports `fuseFraudScores()` — the single documented combination rule used by the image worker where both engines' outputs are available. When **both** the v1 additive score and the v2 calibrated probability exist, the fused score is `max(v1RiskScore, round(v2FraudProbability * 100))` with `fusionMode: "v1+v2-max"`; v1-only yields `fusionMode: "v1"` and v2-only yields `"v2"`. `max()` is deliberately conservative: either engine can escalate a listing, neither can downgrade the other, and the raw `v1RiskScore` / `v2FraudProbability` values are stored for audit (`product.aiAnalysis.riskAssessment`). Revisit as a tuned weighted fusion once the v2 pipeline has real-outcome validation.

### 8.5 ANN Index (HNSW)

**File:** `ml-service/pipeline/ann_index.py`

A persistent **Hierarchical Navigable Small World (HNSW)** approximate nearest-neighbor index for fast embedding lookups at scale:

- Stores CLIP embeddings indexed by product ID
- Supports O(log n) k-NN queries (vs O(n) brute-force linear scan)
- Persists to disk between service restarts
- Used by the v2 fraud pipeline for fast cross-seller similarity lookups

```
GET /pipeline-stats
-> {
    pipelineVersion: "v2",
    embeddingCache: { hits, misses, size },
    annIndex: { size, efConstruction, M },
    drift: { ... }   // prediction drift metrics over time
  }
```

---

## 9. Real-Time Features

**Socket.IO** powers all real-time features. The backend creates a single `io` instance shared across the application.

### Events

| Event | Direction | Description |
|---|---|---|
| `join_conversation` | Client -> Server | Subscribe to a chat conversation room |
| `send_message` | Client -> Server | Send a chat message |
| `new_message` | Server -> Client | Broadcast new message to conversation room |
| `typing` | Client -> Server | User is typing indicator |
| `stop_typing` | Client -> Server | User stopped typing |
| `offer_update` | Server -> Client | Offer accepted / countered / rejected |
| `notification` | Server -> Client | In-app notification push |
| `product_status` | Server -> Client | Listing status change (sold, etc.) |

---

## 10. Background Job Workers

Uses **BullMQ** (Redis-backed) for reliable async job processing. Jobs survive server restarts and are retried on failure.

### `imageProcessor` Worker

Triggered when a new product is created. Full processing pipeline:

1. Download images from Cloudinary URLs
2. Compute pHash + mirrorHash for each image
3. Run MobileNet category classification
4. Assess condition score (brightness / contrast / sharpness)
5. Assess damage score (edge density analysis)
6. Extract CNN feature vectors (stored per image)
7. Call ML service for CLIP embedding (stored per image)
8. Run identity verification if serial/IMEI provided
9. Compute visual fingerprint similarity against candidates
10. Run unified fraud risk scoring
11. Update `product.aiAnalysis` in MongoDB

### `priceAnalyzer` Worker

Triggered on product creation. Calculates fair market price:

1. Fetch comparable listings in same category
2. Run local price recommendation (depreciation + condition + comparables)
3. Call ML service for quantile price estimate (if ML service available)
4. Blend both estimates
5. Update `product.priceRecommendation` in MongoDB

### Queue Behavior

```
Redis available:   Jobs queued in Redis, workers process asynchronously
Redis unavailable: "[Queue] Redis unavailable — queues disabled"
                   Jobs are skipped and logged (no inline fallback)
```

When Redis is unavailable, background AI analysis jobs are skipped and logged — listings still function normally without AI analysis.

---

## 11. Database Models

| Model | Key Fields | Description |
|---|---|---|
| `User` | email, password (bcrypt), role, trustScore, complaints | Platform users |
| `Product` | title, price, images[], aiAnalysis, category, seller, status | Listings |
| `ProductIdentity` | identifierHash, ownerHistory[], possessionStatus, reportedStolen | Physical product registry |
| `ProvenanceEvent` | type, from, to, timestamp, verifiedAt, metadata | Ownership chain events |
| `Sale` | product, buyer, seller, status, stripePaymentId, amount | Completed transactions |
| `Offer` | product, buyer, seller, amount, status, counterAmount, expiresAt | Price negotiations |
| `Conversation` | participants[], product, lastMessage | Chat threads |
| `Message` | conversation, sender, body, read, readAt | Chat messages |
| `Review` | product, seller, buyer, rating, comment, verified | Seller reviews |
| `Report` | target, targetType, reason, status, resolvedBy | User/listing reports |
| `Favorite` | user, product | Saved listings |
| `Notification` | user, type, payload, read, readAt | In-app notifications |
| `AuditLog` | action, actor, target, details, ip | Admin audit trail |
| `Category` | name, slug, icon, description, parentCategory | Category tree |

### Product `aiAnalysis` Subdocument

This is the core ML output stored on every listing:

```js
aiAnalysis: {
  // Image hashing (duplicate detection)
  imageHashes: [String],        // flat 16-char hex pHash list — includes plain + mirror (flop) entries per image
  rotationHashes: [String],     // r90/r180/r270 pHash of each image (orientation probe set)
  vflipHash: [String],          // pHash of the vertically flipped image (upside-down repost probe)
  hashesUnverified: Boolean,    // true when any stored hash came from a client echo (see §7.11)

  // Computer vision scores
  conditionScore: Number,       // 0-100 (100 = like-new)
  conditionLabel: String,       // 'like-new' | 'good' | 'fair' | 'poor'
  damageScore: Number,          // 0-100 (0 = no damage detected)
  damageLevel: String,          // 'low' | 'medium' | 'high'

  // Classification
  suggestedCategory: String,    // MobileNet-suggested category name
  categoryConfidence: Number,   // 0-1 confidence

  // Multi-object detections, cover image only (see §7.12)
  detectedObjects: [{          // one entry per COCO-SSD box (score >= 0.5, NMS IoU 0.6)
    bbox: { x, y, width, height }, // original-image pixels (detectedImageWidth/Height below)
    label: String,              // COCO class, e.g. 'bottle'
    score: Number,              // detection confidence 0-1
    cropClassification: String, // per-crop MobileNet category
    cropConfidence: Number,     // 0-1
    cropEmbedding: [Number],    // local MobileNet embedding (crop-vs-crop fingerprint space)
  }],
  detectedImageWidth: Number,   // cover-image pixels the bboxes refer to
  detectedImageHeight: Number,
  multiObject: Boolean,         // true when >= 2 objects detected
  primaryObjectIndex: Number,   // seller override (null = highest score); drives suggestion + fingerprint
  bundleNote: String,           // informational note when >= 3 objects; admin/owner-only, never a risk signal

  // Fraud risk
  riskAssessment: {
    riskScore: Number,          // 0-100 aggregated fraud risk (v1, or fused v1/v2)
    riskLevel: String,          // 'low' | 'medium' | 'high'
    factors: [String],          // human-readable explanation of each signal
    riskFactorCategories: [String], // generalized categories for non-admin surfaces
    v1RiskScore: Number,        // raw v1 additive score (null when v1 unavailable)
    v2FraudProbability: Number, // raw v2 calibrated probability 0-1 (null if none)
    fusionMode: String,         // 'v1' | 'v2' | 'v1+v2-max' (see §8.4)
    assessedAt: Date,           // when the assessment was last computed
  },

  // Timestamps
  processedAt: Date,
}
```

---

## 12. Security

| Measure | Implementation |
|---|---|
| **Authentication** | JWT access tokens (15 min expiry) + refresh tokens (7 days) in httpOnly cookies |
| **Password Storage** | bcrypt with 12 salt rounds |
| **Security Headers** | Helmet.js with strict Content Security Policy |
| **NoSQL Injection** | express-mongo-sanitize strips `$` and `.` from request data |
| **Rate Limiting** | Per-endpoint limits via express-rate-limit |
| **CORS** | Explicit allowlist via `CLIENT_URL` env var only |
| **Stripe Security** | Webhook signature verification via `STRIPE_WEBHOOK_SECRET` |
| **Identifier Privacy** | Raw serial numbers / IMEI hashed with HMAC-SHA256 keyed by `IDENTIFIER_HASH_SALT` (added to defeat rainbow-table attacks on the small, structured identifier space), never stored or returned. Pre-salt SHA-256 records are migrated lazily — the legacy hash is still accepted on lookup and upgraded in place. Changing the salt invalidates existing salted records. |
| **Image Validation** | Sharp validates image buffers before any ML processing |
| **Input Validation** | Mongoose schema-level constraints + controller-level checks |
| **Compression** | Response compression enabled (compression middleware) |

---

## 13. Environment Variables

Copy `.env.example` to `backend/.env`:

```env
# ─────────────── Server ───────────────
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:3000

# ─────────────── Database ─────────────
MONGODB_URI=mongodb://localhost:27017/resell

# ─────────────── Auth ─────────────────
JWT_SECRET=your_jwt_secret_here_minimum_32_characters
# Access token is short-lived; refresh token is long-lived and used only by /api/auth/refresh
JWT_ACCESS_EXPIRE=15m
JWT_REFRESH_EXPIRE=7d

# ─────────────── Redis ────────────────
# Optional in dev — queues are disabled gracefully when Redis is unavailable
REDIS_URL=redis://localhost:6379

# ─────────────── ML Service ───────────
# Optional in dev — falls back to heuristic analysis when unavailable
ML_SERVICE_URL=http://localhost:8000
# Blends local heuristic price with ML-service estimate (0-1, 0.7 = 70% ML)
ML_BLEND_WEIGHT=0.7

# ─────────────── Cloudinary ───────────
# Required for image upload to work
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# ─────────────── Stripe ───────────────
# Optional — checkout is disabled when not set
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_test_...

# ─────────────── ML Thresholds ────────
# pHash Hamming-distance duplicate threshold — single source of truth, read by
# fraudDetection.js AND the upload/edit duplicate gate (constants.js)
HASH_SIMILARITY_THRESHOLD=12
# Visual (CNN fingerprint) similarity tiers — medium = supporting signal,
# strong = very strong similarity (still supporting-only in the fraud engine)
VISUAL_SIMILARITY_MEDIUM_THRESHOLD=0.90
VISUAL_SIMILARITY_STRONG_THRESHOLD=0.97
MAX_IMAGE_SIZE=5242880

# ─────── Duplicate detection scan caps ───────
# Max candidate listings probed per duplicate check (see §7.11). Truncation is
# logged so silent under-scanning is visible.
DUPLICATE_SCAN_CAP=500
VISUAL_SCAN_CAP=200
DESC_DUP_SCAN_CAP=100
OTHER_SELLER_DESC_SCAN_CAP=200

# ─────── Multi-object detection (§7.12) ───────
# COCO-SSD box score floor; NMS overlap threshold (keep highest); per-image crop cap
OBJECT_DETECTION_MIN_SCORE=0.5
OBJECT_DETECTION_IOU_THRESHOLD=0.6
OBJECT_DETECTION_MAX_OBJECTS=8

# ─────────────── Identifier Hashing ────────────
# HMAC key for physical-product identifier hashes (serial/IMEI/VIN). Min 32
# chars; changing it invalidates existing salted identity records.
IDENTIFIER_HASH_SALT=change-me-to-a-long-random-string-min-32-chars
```

### ML Service (`ml-service/.env`)

```env
CLIP_MODEL_NAME=ViT-B-32
CLIP_PRETRAINED=laion2b_s34b_b79k
ML_PIPELINE_V2=0          # 0=legacy | shadow | 1=v2
PHASH_DISTANCE_THRESHOLD=8  # v2 pipeline fast-path scan threshold — different domain from backend duplicate gate
FRAUD_HIGH_THRESHOLD=0.60
FRAUD_MEDIUM_THRESHOLD=0.30
```

---

## 14. Local Development Setup

### Prerequisites

- Node.js 20+
- Python 3.11+
- MongoDB 6.0 (local install or MongoDB Atlas)
- Redis 7 (optional — queues disabled if not running)

### 1. Clone & Install Dependencies

```bash
git clone <repo-url>
cd Resell

# Install root dependencies
npm install

# Install backend dependencies
cd backend && npm install && cd ..

# Install frontend dependencies
cd frontend && npm install && cd ..

# Install ML service dependencies
cd ml-service
python -m venv .venv

# Activate virtual environment
.venv\Scripts\activate      # Windows
source .venv/bin/activate   # macOS / Linux

pip install -r requirements.txt
cd ..
```

### 2. Configure Environment

```bash
cp .env.example backend/.env
# Open backend/.env and fill in your values
```

Minimum required variables for local dev:
- `MONGODB_URI` (local MongoDB)
- `JWT_SECRET` (any 32+ char string)
- `CLOUDINARY_*` (for image upload)

### 3. Start Development Servers

```bash
# Terminal 1 — Backend API (port 5000)
cd backend
npm run dev

# Terminal 2 — Frontend (port 3000)
cd frontend
npm run dev

# Terminal 3 — ML Service (port 8000, optional)
cd ml-service
.venv\Scripts\activate
uvicorn main:app --reload --port 8000
```

### 4. Access the Application

| Service | URL | Notes |
|---|---|---|
| Frontend | http://localhost:3000 | React app |
| Backend API | http://localhost:5000 | REST API |
| ML Service | http://localhost:8000 | Python FastAPI |
| ML API Docs | http://localhost:8000/docs | Swagger UI |
| ML Health | http://localhost:8000/health | Health check |
| Backend Health | http://localhost:5000/health | Health check |

> **Graceful degradation:** The app works without Redis (queues disabled) and without the ML service (falls back to heuristic-only analysis). Only Cloudinary is required for image functionality.

---

## 15. Docker / Production Deployment

```bash
# Fill in production values
cp .env.example .env
# Edit .env

# Build and start all services
docker compose up --build -d

# Monitor startup
docker compose ps
docker compose logs -f backend

# Verify health
curl http://localhost:5000/health
curl http://localhost:8000/health
```

### Services

| Container | Image | Port | Memory | Role |
|---|---|---|---|---|
| `resell-mongodb` | mongo:6.0 | 27017 | — | Primary database |
| `resell-redis` | redis:7-alpine | 6379 | — | BullMQ + cache |
| `resell-ml-service` | ./ml-service | 8000 | 2 GB limit | CLIP + LightGBM models |
| `resell-backend` | ./backend | 5000 | — | Express API + Socket.IO |
| `resell-worker-image` | ./backend | — | — | Image processing worker |
| `resell-worker-price` | ./backend | — | — | Price analysis worker |

The ML service requires **2 GB RAM** in production (needed for CLIP ViT-B/32 model weights loaded into memory). Workers are configured with `restart: unless-stopped` for reliability.

### Deployment

- Live demo: **[PENDING — add URL]**
- Deployed demo runs with heuristic-only analysis; the full ML stack runs locally via docker compose.

---

## 16. API Reference

### Authentication

All protected routes require a valid JWT passed as:
- `Authorization: Bearer <token>` header, **or**
- `token` httpOnly cookie (set automatically on login for browser clients)

### Key Request/Response Examples

#### Create a Listing

```http
POST /api/products
Content-Type: multipart/form-data
Authorization: Bearer <token>

title: "iPhone 15 Pro Max 256GB Natural Titanium"
price: 85000
originalPrice: 134900
condition: good
yearsUsed: 0.5
description: "Purchased 6 months ago, excellent condition..."
category: <categoryObjectId>
images: [file1.jpg, file2.jpg, file3.jpg]
serialNumber: "DNPXXXXXXXX"    # optional but improves trust score
```

Response:
```json
{
  "success": true,
  "product": {
    "_id": "6abb5b96613ea3c775700131",
    "title": "iPhone 15 Pro Max 256GB Natural Titanium",
    "price": 85000,
    "status": "active",
    "aiAnalysis": {
      "riskAssessment": {
        "riskScore": 5,
        "riskLevel": "low",
        "factors": [],
        "assessedAt": "2025-01-01T00:00:00.000Z"
      },
      "conditionScore": 88,
      "conditionLabel": "like-new",
      "damageScore": 12,
      "damageLevel": "low",
      "suggestedCategory": "Electronics",
      "categoryConfidence": 0.82
    },
    "priceRecommendation": {
      "recommendedPrice": 79500,
      "minPrice": 67575,
      "maxPrice": 91425,
      "confidence": 0.75,
      "explanation": "Based on depreciation model adjusted by condition..."
    }
  }
}
```

#### Get Seller Trust Score

```http
GET /api/sellers/:id/trust
```

Response:
```json
{
  "score": 74,
  "level": "trusted",
  "breakdown": {
    "accountAge": { "score": 12, "max": 15, "days": 290 },
    "sales": { "score": 18, "max": 20, "count": 47 },
    "rating": { "score": 22, "max": 25, "average": 4.4, "count": 32 },
    "responseTime": { "score": 10, "max": 15, "avgMinutes": 30 },
    "complaints": { "score": 12, "max": 15, "complaints": 1 },
    "listingQuality": { "score": 7, "max": 10, "listings": 63 }
  }
}
```

#### ML Service — Fraud Check

```http
POST http://localhost:8000/fraud-check
Content-Type: application/json

{
  "listing": {
    "id": "6abb5b96613ea3c775700131",
    "price": 5000,
    "pHash": "a3f2c1d4e5b6f7a8",
    "embedding": [0.123, -0.456, ...],
    "accountAgeHours": 48,
    "listingsPastHour": 3,
    "category": "Electronics",
    "title": "Brand new iPhone"
  },
  "candidateListings": [
    {
      "id": "other_listing_id",
      "pHash": "a3f2c1d4e5b6f7a8",
      "embedding": [0.124, -0.455, ...]
    }
  ],
  "categoryMedianPrice": 45000
}
```

Response:
```json
{
  "fraudScore": 72,
  "fraudProbability": 0.87,
  "riskLevel": "high",
  "isFlagged": true,
  "factors": [
    "Exact pHash duplicate detected (distance: 0)",
    "Price 88% below category median (z-score: -4.2)",
    "New account (48 hours) with 3 listings in last hour"
  ],
  "pipelineVersion": "v2"
}
```

---

## 17. Testing

```bash
# Run all backend tests
cd backend
npm test

# Run with coverage report
npm run test:coverage

# Run in watch mode (re-runs on file changes)
npm run test:watch
```

### Test Stack

| Tool | Purpose |
|---|---|
| Jest | Test runner + assertions |
| mongodb-memory-server | In-memory MongoDB (no real DB required) |
| supertest | HTTP integration testing against Express app |

Test files are located in `backend/src/__tests__/`.

> The backend automatically skips `dotenv` loading and env validation when `NODE_ENV=test`, allowing tests to inject their own environment variables without conflicting with a `.env` file.

---

## 18. Theoretical Limitations & Mitigations

This section is an honest inventory of the theoretical bounds the fraud/identity/trust stack operates within, alongside the mitigations already in the codebase. Perceptual hashing, CNN fingerprints, statistical pricing, and trust heuristics are probabilistic tools: they reduce abuse but are not proofs. Every row below names a concrete limitation and the specific mitigation that bounds its blast radius.

| # | Theoretical Limitation | Practical Impact | Mitigation in Codebase |
|---|---|---|---|
| 1 | pHash is not a perceptual proof; re-encoded or photographed copies diverge from a stored hash | Real-world duplicates can score below the similarity threshold | 6-hash set probing (plain/mirror/r90/r180/r270/vflip) covers exact-same-pipeline transforms 96/96 in validation; multi-signal fusion (pHash + CNN + price) so a missed duplicate still needs other signals to pass |
| 2 | Candidate scans are deliberately bounded (500 duplicates / 200 visual) | Coverage loss on large catalogs; the earliest 200-500 listings monopolize the window | `DUPLICATE_SCAN_CAP` / `VISUAL_SCAN_CAP` env caps + `countDocuments` truncation warning so silent under-scanning becomes visible; HNSW ANN index covers the unbounded case |
| 3 | Non-perceptual `sha256`-slice fallback hashes (sharp unavailable) are invisible to pHash similarity | A few images never participate in duplicate checks | Fallback entries are typed null-distance and skipped, never false-match; pHash remains the primary path and logs when sharp is missing |
| 4 | Rule-based signals must not reveal their own thresholds | Sellers can reverse-engineer exactly what triggers a flag and game it | Factors are generalized into coarse `riskFactorCategories` for buyers/sellers; the precise factor strings (with thresholds) are admin-only |
| 5 | Statistical price scoring has no ground truth about "fair" market value | Low/above-original price heuristics are approximations | Continuous graduated penalties (ceil-stepped, no cliff), ML kNN `price-estimate` blended via `ML_BLEND_WEIGHT`, and feedback on human decisions |
| 6 | Trust metrics can be gamed by a seller listing to accomplices | Concentrated buyer bases inflate sales volume | Sales-concentration ratio caps the sales sub-score when >60% of recent buyers are repeats; only verified-purchase reviews count |
| 7 | Identifier hashing is hashing, not encryption; known identifiers are still enumerable | A determined adversary could infer that a raw serial is listed | HMAC-SHA256 keyed by a per-deployment `IDENTIFIER_HASH_SALT` (min 32 chars), lazy migration of legacy bare-hash records; verification requires actual device possession |
| 8 | ML v2 only serves in production-shadow mode until enabled; retraining depends on feedback volume | v2 improvements sit unused unless explicitly flipped | `ML_PIPELINE_V2` / `ML_PIPELINE_SHADOW` flags, drift report at `/pipeline-stats`, and `training/retrain.py` consuming appeal/report outcome feedback |
| 9 | First backend boot fetches MobileNet weights over the network | Slow (~35s) cold start; offline boot fails warm-up | Failures degrade to local heuristics; neither fraud gating nor listing creation is blocked on the model actually having loaded |
| 10 | `RemoteMLProvider` (`cvAdapter.js`) is a stub; remote CV inference is deferred | Some CV signals fall back to local heuristics | Explicit stub warning + documented fallback path; local CNN fingerprinting remains the committed visual signal |
| 11 | HNSW ANN nearest-neighbor lookups are approximate | k-NN results can omit true nearest neighbors | ANN used only for fast embedding retrieval; decision-critical comparisons still run the exact code path |
| 12 | Duplicate/image scans are category-scoped | Cross-category duplicates fall outside the candidate window | Deliberate trade-off for bounded latency; the bounded-scan truncation warning surfaces when the pool is exhausted rather than silently passing. **Mitigations in place:** a confident category mismatch widens the pHash probe to the suggested category (§7.11 scan routing), and the **platform-wide** cross-category CLIP vector scan (top-K `CROSS_CATEGORY_SCAN_K = 50`, `CROSS_CATEGORY_IMAGE_REPOST`, +20) now covers cross-category copies of the *same image*. Platform-wide **pHash** (brute-force Hamming across all categories) remains future work |
| 13 | Automated flagging can false-positive legitimate listings | Seller friction from a wrong flag | Self-serve appeal flow (owner-only, one pending per product) that clears the flag on approval; approval also records `disputedFactors` so the ML side learns |
| 14 | Model feedback is driven by human decisions, which are themselves noisy and low-volume | Risk of over-fitting to a tiny, biased feedback set | Only unambiguous decisions are fed back (appeal approved = false positive; resolved product report = confirmed fraud); ml-service attaches an outcome only to an unlabelled `outcome:null` record |
| 15 | Hash state is duplicated across storage schemas (Product vs ImageUploadRecord) | Schema drift could make mirror-hash gates and probe sets disagree | Upload-time mirror-hash duplicate gate + worker merge-preserve semantics keep the two stores consistent by construction |

---

## 19. Screenshots

Screenshot captures are pending — placeholders below show where each embed will go (files live in `docs/screenshots/`):

| Screenshot | Location |
|---|---|
| Home / feed | ![Home](docs/screenshots/01-home.png) |
| Search results | ![Search](docs/screenshots/02-search.png) |
| Product detail | ![Product detail](docs/screenshots/03-product-detail.png) |
| Seller profile & trust score | ![Seller profile](docs/screenshots/04-seller-profile.png) |
| Chat | ![Chat](docs/screenshots/05-chat.png) |
| Offers | ![Offers](docs/screenshots/06-offers.png) |
| Listing creation | ![Create listing](docs/screenshots/07-create-listing.png) |
| Admin dashboard | ![Admin](docs/screenshots/08-admin.png) |

---

## License

This project is for educational and portfolio purposes.

---

*Built with — Full-stack ML-powered marketplace combining Node.js, React, Python FastAPI, CLIP, LightGBM, TensorFlow.js, and MongoDB.*
