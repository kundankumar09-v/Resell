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
18. [Screenshots](#18-screenshots)

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
    +- 1. pHash (64-bit DCT perceptual hash + mirror hash)
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
    +- Step 1: pHash (64-bit DCT) + mirror pHash
    |          -> compare against all listings in same category (up to 500)
    |          -> Hamming distance <= 12 -> +35 risk points
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
    +- Step 8: Visual fingerprint similarity
    |          -> cosine similarity against up to 200 candidates
    |          -> similarity >= 0.90 -> supporting risk signal
    |
    +- Step 9: Aggregate risk score -> product.aiAnalysis updated
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

// Threshold: <= 12 = duplicate (validated on real photos)
// Observed: same-item variants -> max distance 12
//           different products -> min distance 30 (18-point margin)
const HASH_SIMILARITY_THRESHOLD = 12;
```

#### Mirror Hash (Anti-Evasion)

A known fraud tactic is **horizontally flipping a stolen image** to evade pHash detection (the DCT hash of a flipped image differs by an observed Hamming distance of ~53). The system counters this by storing **two hashes per image**: the normal pHash and the pHash of the horizontally flipped version:

```js
const mirrorPerceptualHashFromBuffer = async (imageBuffer) => {
  const flopped = await sharp(imageBuffer).flop().png().toBuffer();
  return perceptualHashFromBuffer(flopped);
};
```

Fraud check: A new upload's `[normalHash, mirrorHash]` pair is compared against every existing listing's pair. A mirrored stolen image's `normalHash` matches the original's `mirrorHash`.

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
| Sales Volume | 20 | `log10(salesCount + 1) x 10` — logarithmic to prevent gaming |
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
| Same description in >= 2 other active listings | +20 |
| Seller has > 3 reports against them | +15 |
| AI damage score >= 50 | +5 |
| Identity signals (OWNERSHIP_MISMATCH, etc.) | +10 to +100 |
| Visual CNN fingerprint similarity | +10 to +20 |

```
riskScore = clamp(sum of all signals, 0, 100)
Risk level: < 25 -> low | 25-49 -> medium | >= 50 -> high
```

The score and `factors[]` array are stored in `product.aiAnalysis.riskAssessment.riskScore` and `product.aiAnalysis.riskAssessment.factors` (schema in section 11) and displayed prominently in the product detail page.

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
- Both pipelines log outputs with a shared `recordId`
- Admins attach outcomes (fraud confirmed / false positive) via `POST /feedback`
- Drift and accuracy metrics available at `GET /pipeline-stats`

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
  // Image hashing
  imageHashes: [String],        // 16-char hex pHash per image
  mirrorHashes: [String],       // pHash of horizontally flipped image

  // Computer vision scores
  conditionScore: Number,       // 0-100 (100 = like-new)
  conditionLabel: String,       // 'like-new' | 'good' | 'fair' | 'poor'
  damageScore: Number,          // 0-100 (0 = no damage detected)
  damageLevel: String,          // 'low' | 'medium' | 'high'

  // Classification
  suggestedCategory: String,    // MobileNet-suggested category name
  categoryConfidence: Number,   // 0-1 confidence

  // Fraud risk
  riskAssessment: {
    riskScore: Number,          // 0-100 aggregated fraud risk
    riskLevel: String,          // 'low' | 'medium' | 'high'
    factors: [String],          // human-readable explanation of each signal
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
| **Identifier Privacy** | Raw serial numbers / IMEI hashed with SHA-256, never stored or returned |
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

## 18. Screenshots

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
