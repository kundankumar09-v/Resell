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
   - [7.13 ML Algorithms & Pipeline Reference](#713-ml-algorithms--pipeline-reference)
8. [ML Microservice (Python / FastAPI)](#8-ml-microservice-python--fastapi)
   - [8.1 CLIP Embeddings](#81-clip-embeddings)
   - [8.2 LightGBM Fraud Pipeline v2](#82-lightgbm-fraud-pipeline-v2)
   - [8.3 Quantile Price Estimation (kNN)](#83-quantile-price-estimation-knn)
   - [8.4 Shadow Mode & A/B Testing](#84-shadow-mode--ab-testing)
   - [8.5 ANN Index (HNSW)](#85-ann-index-hnsw)
   - [8.6 DupDetect v2 Service (SSCD + Multi-Hash + Text Fusion)](#86-dupdetect-v2-service-sscd--multi-hash--text-fusion)
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

**ReSell** is a peer-to-peer secondhand marketplace designed to solve the core trust problem of buying and selling used goods online. Unlike generic marketplaces, ReSell embeds fraud detection, condition verification, and price transparency into listing creation using a mix of learned models, deterministic heuristics, and asynchronous analysis that degrades when ML services are unavailable.

### Key Differentiators

| Feature | Description |
|---|---|
| **Image Fraud Detection** | Multi-layer pipeline: 6-hash pHash probing, CLIP-backed whole-image vector matching, cross-category CLIP search, feature-flagged LightGBM fraud pipeline, and the DupDetect v2 microservice (Meta SSCD copy detection + 256-bit PDQ + 2-signal cross-seller gating + repost-after-delete tombstones) |
| **Product Identity** | Serial / IMEI / VIN registry with cryptographic possession verification and provenance chain |
| **AI Price Recommendation** | Depreciation model + market comparables + visual condition adjustment, blended with the ML quantile estimate (`ML_BLEND_WEIGHT`) |
| **MobileNet Auto-Category** | Automatic product category suggestion from uploaded images |
| **Multi-Object Handling** | COCO-SSD per-crop classification + primary-item category selection; crop embeddings are stored, but the production fingerprint scan still compares whole-image vectors |
| **Scam-Text Detection** | Lexical analyzer (contact info, urgency clichés, formatting abuse, urgency × lowball interaction) feeding the same risk score — capped so text alone can never flag a listing |
| **Listing Velocity Signals** | Behavioral listing-burst detection (new account vs established), capped and non-stacking |
| **Seller Trust Score** | Transparent 0-100 score with per-component breakdown and a repeat-buyer concentration cap |
| **Graceful ML Degradation** | Local fraud and price paths remain available when the Python ML service is down; CLIP-dependent signals are skipped or use documented fallbacks, and unavailable analysis does not block listing creation |
| **Real-Time Chat & Offers** | Socket.IO-powered negotiation with offer countering |
| **Stripe Checkout** | Secure end-to-end payment with webhook verification |
| **Multi-Currency** | Live exchange rates with a daily scheduler |

### Feature Status

| Feature | Status |
|---|---|
| Duplicate Detection | ✅ code-path verified; live worker verification pending a running Docker daemon |
| Price Recommendation | ✅ local-engine formula verified; ML-worker verification pending a running Docker daemon |

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
+-------------------------|--------------------------------------------+
                          | HTTP (internal)
+-------------------------v-------------------------------------------+
|               ML MICROSERVICES (Python / FastAPI)                   |
|  :8000 Core: CLIP ViT-B/32, LightGBM Fraud v2, kNN Price, HNSW      |
|  :8100 DupDetect v2: Meta SSCD (512-D), PDQ-256, MIH, Text Fusion  |
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
    Product API: optional identifier ownership check
      |
      v
    BullMQ: enqueue "image-processing" job
        |
        v
  imageProcessor Worker:
    +- 1. pHash family (plain/mirror/r90/r180/r270/vflip)
    +- 2. MobileNet category classification + COCO-SSD crop analysis
    +- 3. Sharp condition/damage heuristics
    +- 4. /extract-cnn image embedding (CLIP-backed 512-D vector in legacy cnnFeatures)
    +- 5. Primary-image CLIP embedding, local/ML price estimate
    +- 6. Description/text and image/category risk signals
    +- 7. v1 risk aggregation + available v2 fusion -> aiAnalysis saved
    +- 8. DupDetect v2 shadow hook: query /dup/query (:8100), log [DupClient][SHADOW]
          verdict, and register listing via /dup/add (SSCD + PDQ + text fusion)
```

> Ordering note: the list above is the conceptual pipeline (§7.1). The exact
> execution order — including which stages run in parallel and which run in a
> non-blocking `setImmediate` block — is traced step by step in **§7.13 Part B.1**.

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

### ML Microservices
| Layer | Technology |
|---|---|
| Runtime | Python 3.11 |
| Framework | FastAPI + Uvicorn (Port 8000: Core ML API; Port 8100: DupDetect v2 API) |
| Vision / Multimodal | CLIP ViT-B/32 (`open-clip-torch`, LAION-2B) |
| Copy Detection Model | Meta SSCD (`sscd_disc_mixup.torchscript.pt`, 512-D L2-normalized embeddings) |
| Perceptual Hashing | 64-bit DCT pHash D4 (plain/mirror/r90/r180/r270/vflip) + 256-bit PDQ (`pdqhash`) |
| Hash / Vector Indexing | Multi-Index Hashing (MIH, 16 buckets) + BK-tree + HNSW vector index (`faiss-cpu`) |
| Fraud Classifier | LightGBM (gradient boosted trees, 14 engineered features) |
| Price Estimation | kNN + quantile regression (q10/q50/q90 + conformal prediction) |
| ANN Search | HNSW index (FAISS `IndexHNSWFlat`, H=32, efSearch=64) |
| Calibration | Isotonic; attempted LogisticRegression fallback (see §8.2) |

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
|       |   +-- productFingerprint.js   # stored image-vector cosine comparison
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

The fraud detection, condition assessment, and price recommendation system is split across two architectural layers:

1. **Node.js services** — lightweight, always-on analysis using TF.js MobileNet + Sharp pixel analysis + 64-bit DCT pHash
2. **Python ML microservices** —
   - **Core ML Service (Port 8000)**: OpenCLIP ViT-B/32 multimodal embeddings + LightGBM fraud classifier v2 + kNN quantile price recommendation + HNSW ANN index
   - **DupDetect v2 Service (Port 8100)**: Meta SSCD (Self-Supervised Copy Detection) 512-D embeddings + 256-bit PDQ hash + D4 pHash variants + IMEI/Serial parsing + text fusion with 2-signal gating and deletion tombstones

### 7.1 Image Fraud Detection Pipeline

Every uploaded image is analyzed by the `imageProcessor` BullMQ worker; some local stages run in parallel
and CNN-vector extraction is a non-blocking follow-up. The worker aggregates risk signals into a **0-100
score** with human-readable `factors[]`.

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
    +- Step 5: whole-image embedding via ML /extract-cnn compatibility route
    |          -> 512-dim CLIP output stored per image under legacy cnnFeatures
    |
    +- Step 6: primary-image CLIP embedding (via ML service /embed)
    |          -> 512-dim vector stored as product.embedding
    |
    +- Step 7: Visual fingerprint similarity (stored image vectors)
    |          -> cosine similarity against up to VISUAL_SCAN_CAP=200 candidates
    |          -> >= 0.90 -> +10 / >= 0.97 -> +20 (supporting-only, section 7.4)
    |
    +- Step 8: Description duplicate / scam-text signals
    |          -> exact description match (fast path) -> +20
    |          -> near-dup same seller (ML cosine >= 0.92 else 3-gram Jaccard >= 0.85) -> +20
    |          -> near-dup other seller, same category -> +15
    |          -> scam-text lexical analyzer -> up to +25 (section 7.10)
    |
    +- Step 9: Aggregate (v1 + available v2 fusion) -> product.aiAnalysis updated
    |
    +- Step 10: DupDetect v2 shadow hook (FastAPI :8100, log-only by default)
               -> POST /dup/query: evaluate SSCD + PDQ + identifiers + text fusion
               -> log structured shadow verdict [DupClient][SHADOW]
               -> POST /dup/add: register listing vector & hashes in memory store
```

  Identifier ownership verification runs in the product API request before the background image job (only
  when an eligible identifier is submitted); it is not a sequential `imageProcessor` step. A mismatch or
  reported-stolen identifier can reject listing creation.

> This is the conceptual stage list. The exact execution order in the worker — including the COCO-SSD
> multi-object stage (§7.12), the parallel Sharp/TF.js batch, and the non-blocking `setImmediate`
> CNN-extraction block — is traced step by step in **§7.13 Part B.1**.

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

pHash catches exact reposts and some lightly-edited copies; heavily transformed variants may exceed the gate. Stored-vector similarity can add supporting evidence (§7.4), but is not a guaranteed fallback detector.

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

While pHash detects **identical image copies**, the visual fingerprint compares per-image vectors across listings. The persisted field is named `cnnFeatures`, but the current worker fills it through the ML service's `/extract-cnn` compatibility endpoint, which calls the CLIP image encoder and returns a 512-dimensional vector when OpenCLIP is loaded. If OpenCLIP is unavailable, that endpoint returns the model wrapper's deterministic fallback vector instead. The field name and the Product schema's MobileNet comment are therefore stale; they do not describe the current whole-image writer. MobileNet crop embeddings are produced separately by `imageClassifier.embedBuffer()`.

#### How It Works

```
Per listing: collect all images with cnnFeatures (currently /extract-cnn CLIP vectors)
          |
          v
Build aggregate fingerprint:
  - Unit-normalized mean of same-length per-image feature vectors
  - Creates one representative whole-image vector for the listing
          |
          v
Cross-listing comparison (up to 200 candidates):
  For each image in listing A:
    For each image in listing B:
      cosine_similarity(featureA, featureB)
    Keep best match per A-image
  aggregateSimilarity = mean of best matches
  signal similarity = strongest valid single-pair cosine
          |
          v
Thresholds (configurable via env vars):
  MEDIUM_SIMILARITY_THRESHOLD = 0.90  -> supporting signal (weight: 10)
  STRONG_SIMILARITY_THRESHOLD = 0.97  -> supporting signal (weight: 20)
```

`buildProductFingerprint()` can append a primary-object crop embedding when the caller supplies `aiAnalysis.detectedObjects`. The production `assessVisualSimilarity()` queries currently select only `images.cnnFeatures`, however, so they do not load those crop embeddings; the live cross-listing scan compares the stored whole-image vectors. Different-length vectors are skipped. The signal is supporting evidence, not proof that two listings are the same physical item.

> **Important design decision:** Visual similarity alone is **never proof of fraud**. Two sellers may legitimately own the same model (e.g., iPhone 15 Pro). The visual fingerprint is always a *supporting signal* combined with other evidence. It can never push a listing to high risk by itself. Cross-seller matches surface as buyer advisories: the listing carries a `buyerAdvisory` line ("Visually similar to another active listing — we recommend verifying details with the seller before paying") rendered on the ProductDetail Trust panel, and a very strong match (≥ 0.97) combined with ≥ 2 other risk signals escalates an otherwise-low listing to medium so it appears in the admin flagged queue — neither listing is ever auto-rejected by this path.

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

> **Where it runs:** `verifyOwnershipForListing()` is called **synchronously** by
> `productController.createProduct()` / `updateProduct()` — not by the image worker — so an
> ownership mismatch or a stolen-registry hit rejects the request immediately (**403
> `OWNERSHIP_MISMATCH`** / **403 `IDENTITY_BLOCKED`**). Identity signals from outcomes that continue
> through listing creation are passed to `detectRisk()` (§7.9); mismatch/stolen outcomes are rejected
> before a listing risk score is produced. Only categories that are identifier-eligible
> (explicit `requiresIdentifier` flag, or a slug/name keyword match) collect identifiers, and the
> type must make sense for the category (IMEI → phone-like, VIN → vehicle-like, serial → every).

#### Ownership Lifecycle

```
NEW identifier submitted
    -> Normalize identifier (IMEI = 15 digits, VIN = 17 alphanumerics,
       serial >= 4 alphanumerics)
    -> Hash with HMAC-SHA256 keyed by IDENTIFIER_HASH_SALT (never stored raw)
    -> Create ProductIdentity record
    -> Issue 6-character possession-verification code (random, 24h TTL)
    -> Seller verifies by entering the code beside proof photo (proof-of-possession)

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
  +0.10 if comparables provided (granted only on the MSRP path — when there is
        no MSRP the median-of-comparables base already accounts for that evidence,
        so granting it again would double-count the same data)
  +0.10 if CV score available
  +0.05 if damage score available
  Max: 0.95
```

#### Worked Example (local engine)

For an **Electronics** listing with MSRP **50,000**, `yearsUsed: 1`, no brand
premium, and condition **good**:

```
depreciated = 50,000 × (1 - 0.18)^1 = 41,000
brand       = 41,000 × 1.00          = 41,000
condition   = 41,000 × 0.65          = 26,650
range       = 26,650 ± 15%           = [22,652.50, 30,647.50]
```

The verified local output is `recommendedPrice: 26650`, `minPrice: 22652.50`,
`maxPrice: 30647.50`, and `confidence: 0.70`. When `/price-estimate` returns a
valid estimate, the worker persists `source: "hybrid"` and blends the prices as
`local × 0.30 + ML × 0.70` by default (`ML_BLEND_WEIGHT=0.7`).

### 7.9 Risk Scoring — Unified Fraud Engine

**File:** `backend/src/services/fraudDetection.js`

All signals are aggregated into a single score by the `detectRisk()` function:

| Signal | Risk Points |
|---|---|
| Duplicate image (pHash Hamming distance <= 12) | +35 |
| Price < 15% of original | `ceil((0.15 - price/originalPrice) * 250)`, clamped to **0-25** |
| Price > 150% of original | `ceil((price/originalPrice - 1.5) * 20)`, clamped to **0-10** |
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
| Stored whole-image vector similarity (`cnnFeatures` legacy field; CLIP-backed) | +10 to +20 |

```
riskScore = clamp(sum of all signals, 0, 100)
Risk level: < 25 -> low | 25-49 -> medium | >= 50 -> high
```

The score and `factors[]` array are stored in `product.aiAnalysis.riskAssessment.riskScore` and `product.aiAnalysis.riskAssessment.factors` (schema in section 11) and displayed prominently in the product detail page.

**Two independent gates — do not confuse them.** The **displayed** risk score/level above is the backend v1 (fused) score. The **listing status** transition is a *separate* gate inside `imageProcessor.js`: a listing is moved to `pendingReview` when the ML service's own 0-100 `fraudScore` is `>= 70` **or** its `statusRecommendation` is `'pendingReview'` (the v2 flag threshold, 0.95 calibrated). The two can therefore disagree — a listing can be `pendingReview` while its displayed `riskLevel` is still `low`, and vice versa. The backend score never writes listing status directly, and the ML score never overwrites the backend score (see §7.13 Part B.1 for the exact order).

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

The duplicate-detection subsystem exists to prevent image reuse and near-duplicate listings before they propagate. The design goal is **multi-layer defense**: a cheap perceptual-hash gate blocks exact/reposted copies early, stored whole-image vectors provide a supporting visual comparison, text near-duplicate detection blocks the "two words changed" evasion, and signals converge in the unified risk engine (`detectRisk()` in `backend/src/services/fraudDetection.js`). Multi-object detection selects a primary crop for category suggestion, but the live fingerprint query does not load crop embeddings, so its vector comparison remains whole-image based (§7.12). Final outputs are stored in `product.aiAnalysis` (see §11). When the worker detects a confident category mismatch, it also **widens the pHash probe to the suggested category's listings** (cross-category scan routing), so a repost filed under the wrong category cannot scope the duplicate check away.

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
Visual fingerprint scan (whole-image vectors stored as `cnnFeatures`; currently CLIP-backed)
  - candidate cap: VISUAL_SCAN_CAP = 200
  - strongest valid image-pair cosine >= 0.90 -> +10 ; >= 0.97 -> +20
  - mean of per-image best matches is reported separately as aggregateSimilarity
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
| Same product, different angle / lighting / crop | Seller reuses the same physical item with new photos | Stored whole-image vector fingerprint (`cnnFeatures` legacy field) | `VISUAL_PRODUCT_SIMILARITY` (+10 @ >=0.90); (+20 @ >=0.97) | Partially — current worker writer supplies CLIP-backed 512-D vectors; supporting-only, no accuracy benchmark (§7.4). |
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

3. **No single signal proves fraud.** pHash is a high-precision cheap gate; stored-vector visual similarity is explicitly *supporting-only* (§7.4); scam-text is capped at +25 (§7.10). All signals aggregate in `detectRisk()` and, when both engines are present, fuse via `max(v1, round(v2*100))` (§8.4) — either engine may escalate, neither can downgrade, and never on a single weak signal.

4. **Multi-signal gating in DupDetect v2.** In the v2 service, a cross-seller `block` requires **at least two independent corroborating signals** (e.g. hash + SSCD embedding, hash + text, SSCD + text), an active tombstone match, or an exact hardware identifier match with an embedding in the review band. Text alone never auto-blocks.

#### DupDetect v2 — 5-Signal Copy Detection Engine (Python / FastAPI :8100)

**Files:** `ml-service/pipeline/dupdetect/` (`api.py`, `pipeline.py`, `embeddings.py`, `hashing.py`, `text_signal.py`), `backend/src/services/dupClient.js`

While pHash and CNN cosine comparisons provide fast in-process protection within Node.js, `dupdetect v2` runs as a dedicated Python microservice designed specifically for deep copy detection, adversarial evasion resistance, and repost-after-delete enforcement:

```
Probe (Listing ID, Seller ID, Image, Title, Description)
    |
    +---> Signal 1: Multi-Hash (pHash D4 6-variants + 256-bit PDQ with quality gate)
    |               Indexed via Multi-Index Hashing (MIH, 16 buckets) and BK-tree
    |
    +---> Signal 2: Deep Copy Embeddings (Meta SSCD ViT/ResNet 512-D, HNSW indexed)
    |               Cosine similarity evaluated against active + tombstone index
    |
    +---> Signal 3: Hardware Identifiers (Regex extraction of IMEI & Serial)
    |               Luhn algorithm validates 15-digit IMEIs; serials require >=8 alphanumeric
    |
    +---> Signal 4: Multimodal Text Fusion (OpenCLIP ViT-B/32 text embeddings)
    |               Cosine similarity >= 0.92 indicates near-duplicate description
    |
    +---> Signal 5: Lifecycle & Repost-After-Delete Tombstones
                    In-memory tombstone index retains hashes & embeddings of deleted items
    |
    v
2-Signal Decision Gating Engine:
    - BLOCK: (1) Tombstone match with hash or SSCD >= block_thr (0.4802)
             (2) Identifier match + SSCD in review band (>= 0.2185)
             (3) Cross-seller with 2 corroborating signals:
                 hash + SSCD >= block_thr | hash + text | SSCD >= block_thr + text
    - REVIEW: Same-seller repost, text near-duplicate, or single signal in review band
    - ALLOW: No corroborating signals or below review threshold
```

##### Gating Decision Matrix

| Candidate Relationship | Triggering Signals | Decision | Action / Reason |
|---|---|---|---|
| **Tombstone Repost** | Probe matches deleted listing (pHash ≤ 14, PDQ ≤ 32, or SSCD ≥ 0.4802) | **BLOCK** | `repost_after_delete` (catches delete-and-repost cycle) |
| **Identifier Match** | Same Luhn-valid IMEI or Serial + SSCD ≥ 0.2185 | **BLOCK** | `identifier_match` (physical item already cataloged) |
| **Cross-Seller Theft** | pHash/PDQ match **AND** SSCD ≥ 0.4802 | **BLOCK** | `hash_hit` + `embedding_above_block` |
| **Cross-Seller Theft** | pHash/PDQ match **AND** Text Cosine ≥ 0.92 | **BLOCK** | `hash_hit` + `text_hit` |
| **Cross-Seller Theft** | SSCD ≥ 0.4802 **AND** Text Cosine ≥ 0.92 | **BLOCK** | `embedding_above_block` + `text_hit` |
| **Same-Seller Relist** | Same seller + (hash match, SSCD ≥ 0.4802, or text match) | **REVIEW** | `same_seller_repost` (legitimate seller relisting inventory) |
| **Text Only** | Text Cosine ≥ 0.92 without image match | **REVIEW** | `text_near_dup` (text alone **never** auto-blocks) |
| **Single Vision Signal**| Hash match + SSCD in review band [0.2185, 0.4802] | **REVIEW** | `hash_hit` + `embedding_in_review_band` |
| **Borderline Visual** | SSCD in review band [0.2185, 0.4802] alone | **REVIEW** | `embedding_in_review_band` |
| **No Corroboration** | Below review band (< 0.2185) and no hash/id hits | **ALLOW** | Clear / unique listing |

##### Backend Shadow Mode Integration

The Node.js backend communicates with `dupdetect v2` via `backend/src/services/dupClient.js`:
- **Fail-Open Contract:** If the v2 service is unreachable or errors out, `dupClient` safely resolves to `null` and logs a warning; listing creation or moderation is never blocked.
- **Shadow Mode Logging:** Enabled by default (`DUPDETECT_SHADOW=true`). The `imageProcessor` BullMQ worker evaluates the cover image and text, then logs:
  `[DupClient][SHADOW] product=<id> decision=<block|review|allow> score=<sim> match=<id> reasons=[...] legacy=<v1-decision>`
- **Tombstone Hooks:** When a seller deletes their listing (`DELETE /api/products/:id`) or an admin removes a listing (`DELETE /api/admin/products/:id`), `dupClient.deleteListing(productId)` is triggered asynchronously, moving the listing record to the v2 service's tombstone registry.

#### Empirical Validation Summary

##### 1. pHash Validation (Node.js Baseline)
Numbers below are from `backend/scripts/phash_validation_results.md` (validated on a 24-image corpus: 276 different-product pairs, 120 same-item variant pairs):

- **Threshold retained:** `HASH_SIMILARITY_THRESHOLD = 12` (64-bit DCT pHash) — still the single source of truth for `fraudDetection.js` and the upload/edit duplicate gate.
- **False positives:** **0 / 276** different-product pairs at distance <= 12; the *closest* different-product pair sits at Hamming distance **16** — a 4-bit margin below the gate.
- **Same-item recall:** **61 / 120** same-item variant pairs fall within the gate; the remainder are the deliberately "hard" transforms handed to the CNN/text layers.
- **Rotation recall:** **96 / 96** rotation cases (90/180/270) matched under the rotation-aware probe set.
- **Flipped images:** mean Hamming distance between an image and its horizontal flip = **27.17** (minimum **16**); the mirror hash closes this evasion path.

##### 2. Meta SSCD Validation (DupDetect v2)
Calibrated on an adversarial evaluation suite (`ml-service/pipeline/dupdetect/thresholds.json`) testing extreme image transformations that defeat classic pHash:

- **Calibrated Thresholds:** `block_thr = 0.4802`, `review_from = 0.2185`, `review_to = 0.5602`.
- **Adversarial Transformation Recall:**

| Image Transform Variant | Adversarial Perturbation Tested | SSCD Recall |
|---|---|---:|
| `crop35` | 35% bounding crop of the product | **100.0%** |
| `rotate15` | 15° arbitrary rotation with edge fill | **100.0%** |
| `color_shift` | Hue, saturation, and contrast shift | **100.0%** |
| `watermark` | Semi-transparent text overlay across center | **100.0%** |
| `mirror` | Horizontal flip | **100.0%** |
| `screenshot` | Device frame + UI elements around photo | **100.0%** |
| `collage` | Multi-image grid assembly | **100.0%** |
| `crop_mirror` | Combined 35% crop + horizontal flip | **100.0%** |
| `rotate_color` | Combined 15° rotation + color shift | **100.0%** |
| `watermark_crop` | Watermark overlay + aggressive crop | **100.0%** |

**Comparison with pHash limits:** While pHash provides a fast O(1) gate for identical or slightly re-compressed images, it fails on crops and perspective warps. Meta SSCD retains **100% recall** across these evasive transforms, making the 2-signal combination robust against adversarial sellers.

#### How to See It Live

`backend/scripts/seed.js` seeds a demo set covering five baseline cases (plus an optional sixth behavioural case via `--with-burst`) and then **runs the real `detectRisk()`** over them and prints a "Risk Assessment Table" — no risk value is hard-coded in the seed data:

- **Case 1 — exact duplicate image.** Two listings share the same `iphone-13-midnight.jpg`; the pHash probe fires `DUPLICATE_IMAGE` (**+35**), so the duplicate listing lands at roughly **risk 35** — the canonical reference for how the flow looks.
- **Case 2 — re-photographed variant.** The same product photographed differently (5% crop + brightness/JPEG change applied at seed time): shows that stored-vector similarity is a *supporting* signal only.
- **Case 3 — legitimate same-category sellers.** Distinct photos/brands in the same category: expected **zero** duplicate signals — proof the pipeline does not penalise honest sellers.
- **Case 4 — mirror-flipped repost.** A horizontally flipped copy of the Case 1 image, which the mirror hash catches.
- **Case 5 — scam-text template.** Off-platform contact + urgency clichés exercise the scam-text signals (§7.10) served from a distinct image.
- **Case 6 — listing burst (`--with-burst`, `[DEMO]`).** Five rapid listings from a demo account younger than 7 days exercise the behavioral `LISTING_BURST_NEW_ACCOUNT` (**+15**) signal (§7.9). Omitted from the default run so the baseline seed stays clean.

So a single `node scripts/seed.js` run demonstrates the pHash, mirror, stored-vector visual, and text layers feeding one aggregated score. (Redis/BullMQ workers need not be running: the printed scores come from `detectRisk()`; the full CLIP-backed vector signals require the workers and ML service up.) Run `node scripts/seed.js --with-burst` to additionally demonstrate the behavioral listing-velocity layer.

#### Live Verification Results (2026-10-16)

The intended live environment is MongoDB + Redis + the image/price workers +
the ML service. On this verification host, Docker Desktop was not running, so
MongoDB/Redis and BullMQ workers could not be started. The values below are
therefore deliberately reported as **not observed**, rather than inferred from
unit fixtures. The local pricing calculation above was executed directly.

| Case | Signal | Observed riskScore | Status |
|---|---|---:|---|
| Cross-seller same image | `DUPLICATE_IMAGE` (+35) | Not observed | BLOCKED — Docker daemon unavailable |
| Horizontally flipped image | mirror pHash, `DUPLICATE_IMAGE` (+35) | Not observed | BLOCKED — Docker daemon unavailable |
| 90° rotated image | rotation pHash, `DUPLICATE_IMAGE` (+35) | Not observed | BLOCKED — Docker daemon unavailable |
| Re-photographed same product | `VISUAL_PRODUCT_SIMILARITY` (+10/+20) | Not observed | BLOCKED — ML worker unavailable |
| Same-seller relist / sold re-list | identity signals | Not observed | BLOCKED — worker unavailable |
| Different products, same category | no duplicate signal | Not observed | BLOCKED — worker unavailable |
| Exact / near-duplicate text | `DUPLICATE_DESCRIPTION` (+20) | Not observed | BLOCKED — worker unavailable |

The worker persistence path was corrected during this verification: visual
similarity now persists `possible_duplicate_image` in
`riskFactorCategories` alongside its score and raw factor, so the owner-facing
`AIAnalysisPanel` renders the signal instead of silently hiding it.

### 7.12 Multi-Object Image Handling

**Files:** `backend/src/services/imageClassifier.js` (detection + crops), `backend/src/workers/imageProcessor.js` (persistence + primary), `backend/src/controllers/productController.js` (`PUT primaryObjectIndex`), `frontend/src/pages/SellProduct.jsx` (overlays + picker)

Sellers often photograph several items together (a desk lot, a "bundle" photo). Classifying the whole frame can mislabel the listing; when multiple objects are found, the primary crop drives the listing-level category. The stored whole-image vector still represents the full frame, and the production fingerprint query does not currently load crop embeddings. The multi-object path handles classification and crop storage per cover image:

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
- **Fingerprint.** `buildProductFingerprint()` can append the primary crop's MobileNet embedding as an extra crosswise comparison vector, without averaging it into the whole-image vector. However, `assessVisualSimilarity()` currently queries only `images.cnnFeatures` and does not select `aiAnalysis.detectedObjects`; the production cross-listing scan therefore does not receive the stored crop embedding. Different vector lengths are skipped, never compared.
- **Bundle note.** `>= 3` objects store an informational `aiAnalysis.bundleNote` ("Bundle photo: N distinct items detected …"). It is **never a risk signal** and is displayed to admins/owners only (stripped for other viewers in `GET /product/:id`).

**Honest scope note.** COCO-SSD covers the 80 common COCO classes (bottles, cups, phones, chairs, …). Exotic or highly stylised items it was never trained on (collectibles, niche hardware, unusual angles) yield no boxes and silently take the whole-image fallback — the listing is never penalised for the detector's blind spots. Detection runs on the cover image only; per-image crop detail is recomputed on demand, never persisted per image.

### 7.13 ML Algorithms & Pipeline Reference

This section is a **study/exam reference**: every algorithm in the system, in one place, with the exact
implementation detail (libraries, tensor shapes, thresholds, formulas) taken from the code. Parts A–C
summarise and cross-reference the deep dives — **[§7.1](#71-image-fraud-detection-pipeline)** …
**[§7.12](#712-multi-object-image-handling)** and **[§8.1](#81-clip-embeddings)** …
**[§8.5](#85-ann-index-hnsw)** hold the full treatment.

#### PART A — Algorithm Master Table

Every number below is read from the source, not estimated. "Supporting-only" means the signal can raise
risk but can never alone reach `high` or auto-flag a seller.

| # | Algorithm | Domain | Purpose | Where Implemented | Key Parameters | Validation Status |
|---|---|---|---|---|---|---|
| 1 | **DCT Perceptual Hashing (pHash, 64-bit)** | Image | Exact / near-exact duplicate detection | `backend/src/services/imageHash.js` → `perceptualHashFromBuffer()` | Sharp `resize(32,32).grayscale().raw()` → 2D DCT (separable, precomputed `COS_TABLE` — one 32×32 cosine table reused for both axes, 1024 values instead of ~65 000 `Math.cos` calls per image) → top-left **8×8** block (64 lowest frequencies) → median of 64 coeffs → bit = `coeff >= median` → `BigInt('0b'+bits).toString(16).padStart(16)`. Hamming ≤ **12** (`HASH_SIMILARITY_THRESHOLD`) | **Validated** on a 24-image corpus: 0/276 false positives on different-product pairs (closest at distance **16**); 61/120 same-item variants within 12 (`backend/scripts/phash_validation_results.md`) |
| 2 | **Hamming Distance** | Image | Similarity metric between two 64-bit pHashes | `imageHash.js` → `hammingDistance()`, `similarity()` | Hex-to-binary conversion → differing-bit count. Missing operand → **64**. Wrong-length value → **null** from `hammingDistance()`; `similarity()` maps that to 0. The SHA-256 fallback is also **16 hex chars**, so it passes the length check and is compared as if it were pHash. `similarity = max(0, 1 − d/64)` | Unit-tested (`backend/src/__tests__/fraud.test.js`); corpus result applies to DCT pHashes, not fallback values |
| 3 | **Multi-Hash Set Probing** (plain / mirror / r90 / r180 / r270 / vflip) | Image | Anti-evasion against flips & rotations | `imageHash.js` → hash functions, `orientationHashesFromBuffer()`; `fraudDetection.js` → `collectHashSet()` | Plain and mirror hashes are computed separately; r90/r180/r270/vflip are computed in parallel. Full cross-product probe of upload set vs stored set. Persisted as `aiAnalysis.imageHashes` (plain+mirror), `rotationHashes`, `vflipHash` | **Validated**: set-based coverage **96/96** on exact transforms; plain-only mean Hamming 27.2–29.6 (1–4/24 caught) |
| 4 | **MobileNet v2 (TF.js, ImageNet-pretrained)** | Image | Category classification; per-object crop embedding | `backend/src/services/imageClassifier.js` → `loadModel()`, `classifyImage()`, `embedBuffer()` | `mobilenet.load({version:2, alpha:1.0})`; Sharp → 224×224 RGB, raw 0-255 float tensor; `classify(tensor, 10)`; ~130 ImageNet-label mappings; confidence capped **0.95**. `infer(tensor, true)` produces crop embeddings. The schema comment calls whole-image `cnnFeatures` 1280-D MobileNet, but the worker actually stores the ML service's **512-D `/extract-cnn` output** there | Unit/smoke-tested. **No accuracy benchmark** — ImageNet pretrained, never fine-tuned |
| 5 | **Cosine Similarity on CNN-named image embeddings** | Image | Same-product appearance fingerprinting | `backend/src/services/productFingerprint.js` → `cosineSimilarity()`, `compareProductFingerprints()` | Despite the legacy field name, whole-image vectors currently come from `/extract-cnn` and are 512-D CLIP embeddings when OpenCLIP is loaded. Crosswise image-pair cosine; strongest valid single pair drives the threshold while `aggregateSimilarity` separately reports the mean of per-image best matches. ≥ **0.90** → +10; ≥ **0.97** → +20; candidate cap **200** | **Supporting-only by design**; no accuracy benchmark |
| 6 | **Aggregate Fingerprinting** | Image | One representative vector per listing | `productFingerprint.js` → `buildProductFingerprint()` | Unit-normalised mean of same-length `images[].cnnFeatures` (512-D from current `/extract-cnn` writer). The helper can append a primary crop embedding without averaging it into the whole-image mean, but the production candidate query does not select `detectedObjects`, so crop vectors are not used in that scan | Supporting-only; unit-tested |
| 7 | **COCO-SSD Object Detection (TF.js)** | Image | Multi-object localisation, per-object crops, primary product selection | `backend/src/services/imageClassifier.js` → `loadDetector()`, `detectObjects()`, `analyzeDetectedObjects()` | `cocoSsd.load({base:'mobilenet_v2'})`; long edge capped at **800**; score **≥0.5**; greedy NMS drops boxes with IoU **>0.6**; at most **8** crops; **0.10** padding per side; each crop gets MobileNet classification and `infer(tensor,true)` embedding (dimension returned by the model) | Best-effort; no COCO mAP benchmark; **80 COCO classes only** |
| 8 | **CLIP ViT-B/32 (OpenCLIP)** | Image + Text | Joint image/text embeddings for semantic comparisons | `ml-service/models/clip_model.py` (+ `pipeline/embedding_cache.py`) | `ViT-B-32` / `laion2b_s34b_b79k` via `open_clip`, CUDA if available; when loaded, image/text outputs are L2-normalised **512-D** vectors. Uses include image↔title mismatch **<0.20** (+15) and cross-category repost **≥0.93**, top-K **50** (+20). Cache cap **4096**, keys are 32-hex-character SHA-256 prefixes. OpenCLIP failure still returns deterministic 512-D image-statistics and token-hash fallbacks, which are not a learned joint space | v2 duplicate threshold **0.8174** was selected at 2% FPR on the adversarial set; other thresholds and real-traffic accuracy are **not validated on real traffic** |
| 9 | **CLIP Text Embeddings** | Text | Near-duplicate description detection (preferred path) | `backend/src/services/mlClient.js` → `getTextEmbedding()`, `fraudDetection.js` → `findBestTextMatch()` | `POST /text-embed` per candidate (5s timeout) → cosine ≥ **0.92** (`TEXT_SIMILARITY_ML_THRESHOLD`); same-seller **+20**, other-seller same-category **+15**; caps `DESC_DUP_SCAN_CAP`=**100** / `OTHER_SELLER_DESC_SCAN_CAP`=**200**; ML health cached `DESC_DUP_ML_HEALTH_TTL_MS`=30s | Unit-tested; frozen general-purpose encoder, **not a fraud model** |
| 10 | **Character 3-gram Jaccard Similarity** | Text | ML-down fallback for text similarity | `backend/src/services/textSimilarity.js` → `charNgramJaccard()` | `n=3` overlapping grams over `normalizeText()` (lowercase + whitespace collapsed); both empty → 1, one empty → 0; threshold **≥ 0.85** (`TEXT_SIMILARITY_NGRAM_THRESHOLD`); strings shorter than n yield the whole string as one gram | Unit-tested; lexical overlap only |
| 11 | **LightGBM (gradient-boosted trees)** | Fraud | v2 fraud classifier on 14 engineered features | `ml-service/pipeline/fraud_v2.py` → `CalibratedFraudClassifier` | 14 features in fixed `FEATURE_ORDER`; training uses `objective=binary`, `learning_rate=0.05`, `num_leaves=31`, `min_child_samples=20`, `feature_fraction=0.9`, `bagging_fraction=0.8`/`bagging_freq=1`, **300 rounds**, `scale_pos_weight=max(1.0, n_neg/max(1,n_pos))`. Artifact thresholds flag **0.95** / review **0.475** override env defaults **0.60/0.30**. Default `ML_PIPELINE_V2=0` serves legacy; `shadow` serves legacy and logs v2 | **Synthetic eval only**: AUC-ROC **0.888**, recall **0.56** @ flag 0.95 (`ml-service/eval/RESULTS.md` — "DATA IS SYNTHETIC") |
| 12 | **Isotonic Regression (attempted sigmoid fallback)** | Fraud | Calibrate the raw LightGBM score | `ml-service/training/train_fraud_v2.py` + `fraud_v2.CalibratedFraudClassifier.predict_proba()` | Isotonic fit uses `out_of_bounds="clip"`, `y_min=0`, `y_max=1`. Training fallback fits `LogisticRegression` on raw scores, but inference calls `.predict([raw])`; sklearn rejects that 1-D input, the exception is caught, and inference falls back to the raw clipped score rather than a sigmoid probability | Calibration artifact uses a 400-sample synthetic split; **not validated on real outcomes** |
| 13 | **Vision LLM (uncertainty-band gating)** | Fraud | Cost-efficient ambiguous-case image analysis | `ml-service/pipeline/vision_llm.py` → `analyze_listing_image()`, `in_uncertainty_band()` | NVIDIA NIM; calibrated probability in **[0.25, 0.65]** and within **0.15** of the nearest `config.FRAUD_HIGH_THRESHOLD` / `FRAUD_MEDIUM_THRESHOLD` (defaults **0.60/0.30**); one image resized to ≤**512**px, JPEG q85; `max_tokens=128`, `temperature=0.0`; at most **6** flags; two features re-feed one model score | **Never exercised** — no API key/no images in the synthetic eval, so both features are always 0 |
| 14 | **kNN + Quantile Regression (on CLIP embedding space)** | Price | Price estimate + P25/P50/P75-style interval | `ml-service/pipeline/price_v2.py` → `evaluate_price_v2()`, `QuantilePriceModelV2` | 3 LightGBM quantile boosters `price_v2_p10/p50/p90.txt` on **log price** (`PRICE_QUANTILES = 0.1/0.5/0.9` — *not* 0.25/0.75; P25/P75 are exposed as the **midpoints** `(q10+q50)/2`, `(q90+q50)/2`); `k = KNN_NEIGHBORS`=**12** service default, **5** when the request supplies `kNeighbors` (the Node client sends 5); conformal widening **±0.1303** (`PRICE_CONFORMAL_ALPHA=0.20`, i.e. 80% coverage); features `log_original_price`, `years_used`, `condition_weight`, `is_sold_present`, `knn_median_log_price`, `knn_spread_log_price`, `knn_count`, `category_median_log_price`; `confidence = 0.6·countFactor + 0.4·spreadFactor`; `< 0.35` or `knn_count < 3` → wide range, `suggestedPrice = null` | **Synthetic eval**: MAE **$39.19** / MAPE **16.87%** vs v1 $123.76 / 68.48% (200 synthetic sold listings) |
| 15 | **HNSW (via FAISS `IndexHNSWFlat`)** | Retrieval | Approximate nearest-neighbour retrieval over 512-D embeddings | `ml-service/pipeline/ann_index.py` → `CategoryANNIndex`, called by `price_v2.py` | `faiss.IndexHNSWFlat(512, 32)`, `efSearch=64`; category stores plus global store; L2-normalized vectors; overfetch `max(k*8, k+20)` then exclude seller/IDs; pickle persistence at `models_saved/ann_index.pkl`. With FAISS absent or no index results, price v2 falls back to recency-ordered comparables. `fraud_v2.py` does not call this index | No recall benchmark; FAISS implementation, not hnswlib; runtime loads a saved index |
| 16 | **Exponential Depreciation Model** | Price | Base price from MSRP | `backend/src/services/priceRecommendation.js` → `calculateRecommendedPrice()` | `MSRP × (1 − rate)^years × brandMult × conditionMult`; annual `ANNUAL_DEPRECIATION`: Electronics 0.18, Mobile Phones 0.22, Computers 0.16, Fashion 0.30, Home & Garden 0.10, Sports 0.15, Books 0.25, Toys 0.20, Beauty 0.12, Automotive 0.10, Other 0.15; `BRAND_PREMIUM` apple 1.10, nike 1.05, adidas 1.04, sony/canon 1.03, samsung 1.02, else 1.0; `CONDITION_FACTOR` new 0.95 / like-new 0.82 / good 0.65 / fair 0.45 / poor 0.25, unknown → 0.6 | Hand-tuned constants; **no market-data validation** |
| 17 | **IQR Outlier Removal (Tukey's fence)** | Price | Comparable-price cleaning (local engine) | `backend/src/services/priceRecommendation.js` → `trimIQR()` | Needs ≥ **4** values; `q1 = s[floor(0.25n)]`, `q3 = s[floor(0.75n)]`; keep `q1 − 1.5·IQR ≤ v ≤ q3 + 1.5·IQR`; ML path instead uses **MAD**: `median ± PRICE_OUTLIER_MAD(3.0) × 1.4826 × mad` (`price_v2.clean_outliers`) | Not benchmarked; two different cleaners in two layers (documented) |
| 18 | **Z-Score (price vs category median)** | Fraud + Price | Price anomaly detection | `ml-service/pipeline/fraud_v2.py` → `_metadata_features()` | `z = (price − cat_median) / cat_std`; `cat_median` from `categoryMedianPrice` or `np.median(comparables)`; `cat_std = np.std(comparables)` or **0.35 × median** fallback; `np.clip(z, −10, 10)`; reason bands **z < −2.5** (too low) and **z > 3.0** (too high) | Synthetic only |
| 19 | **Sobel-like Edge Density Analysis** | CV | Damage heuristic | `backend/src/services/computerVision.js` → `detectDamage()` | **Heuristic, not a learned model.** 64×64 grayscale thumbnail; interior 62×62 pixels; `abs(gx) + abs(gy) > 60`; `edgeRatio = edges / 3844`; `> 0.45` → **+55**, `> 0.35` → **+35**, `> 0.20` → **+20**, `< 0.08` → smooth (no penalty); max reachable **55**; levels ≥ 50 high / ≥ 25 medium | Hand-tuned; **no damage benchmark** |
| 20 | **Pixel Statistics (brightness / contrast / sharpness)** | CV | Condition scoring | `computerVision.js` → `analyzeImageQuality()`, `assessCondition()` | `sharp.stats()` per-channel: brightness = mean of channel means; contrast = mean of `min(stdev,100)`; `sharpness = 0.8×contrast + 0.2×brightness`. Penalties: dark (<60) −15, overexposed (>220) −10, low contrast (<20) −10, blur (sharpness <30) −8; clamp **[30,100]**; labels ≥90 like-new / ≥75 good / ≥60 fair / else poor; unavailable → `score: null, available:false` | Hand-tuned; measures the **photo**, not the item |
| 21 | **Lexical Pattern Matching (regex)** | Text | Scam-text signals | `backend/src/services/textScamAnalyzer.js` → `analyzeTextScam()` | **Heuristic, not a learned model.** Contact info (email / WhatsApp / `+?91[.\s-]?[6-9]\d{9}` / generic `\b\d{10}\b`) **+10**; urgency clichés ≥4 **+15**, ≥2 **+10**; `EXCESSIVE_CAPS` (len>30, >50% uppercase) **+5**; `EXCESSIVE_PUNCTUATION` (>5 `!`) **+5**; `LOWBALL_URGENCY_COMBO` (`\burgent\b` **and** price < **0.40 × originalPrice**) **+15**; total capped at **+25** (`MAX_CONTRIBUTION`) | No labelled scam corpus; explicitly documented as trivially evadable |
| 22 | **Weighted Additive Signal Aggregation** | Fraud | v1 risk engine | `backend/src/services/fraudDetection.js` → `detectRisk()` | Fixed hand-authored weights (+5 … +100) summed then `clamp(score, 0, 100)`; bands **≥ 50 high** / **≥ 25 medium** / else low (see the full weight table in §7.9) | Unit-tested; weights hand-authored, not learned |
| 23 | **Max-Fusion Ensemble Policy** | Fraud | Combine v1 additive score with v2 probability | `fraudDetection.js` → `fuseFraudScores()` | both → `max(v1, round(v2 × 100))`, `fusionMode:'v1+v2-max'`; v1 only → `'v1'`; v2 only → `'v2'`. Conservative: either engine escalates, neither downgrades | Unit-tested (§8.4) |
| 24 | **Logarithmic Scaling `log10(n+1)`** | Trust | Anti-gaming sales component of the trust score | `backend/src/services/trustScore.js` → `calculateTrustScore()` | `salesScore = clamp(log10(salesCount+1) × 10, 0, 20)`; concentration over up to **20** recent sales: `ratio = 1 − uniqueBuyers/N`, where `N` is the actual number returned; `>0.6` caps sales points at **10** | Design choice; not benchmarked |
| 25 | **Confidence Fusion (MobileNet + keyword agreement)** | Image | Auto-categorisation of a listing | `backend/src/services/computerVision.js` → `classifyProduct()` | Keyword score **+2 per matched keyword** over lowercased filename+title (8 category lists); model threshold **0.15**; model+keyword agreement adds **0.10** when model is over threshold (cap **0.95**); sub-threshold agreement uses `min(0.95, max(modelConfidence, 0.4 + keywordScore×0.1))`; keyword-only uses `min(0.95, 0.4 + keywordScore×0.1)` | Unit-tested; no benchmark |
| 26 | **HMAC-SHA256 (salted) identifier registry** | Identity | Privacy-preserving identifier registry | `backend/src/services/provenance.js` → `hashIdentifier()`, `computeEventHash()` | Normalise (IMEI = 15 digits, VIN = 17 alnum, serial ≥ 4 alnum) → `crypto.createHmac('sha256', IDENTIFIER_HASH_SALT).update(normalized).digest('hex')`; unset salt → constant fallback **with a warning**; legacy bare-SHA-256 lookup migrates records in place; provenance chain `SHA256(prevHash \| eventType \| ownerId \| listingId \| transactionId \| timestampISO)`; possession code = 6 chars from a 32-char alphabet, **24h TTL**, `timingSafeEqual` comparison, lock after **5** failed attempts | Unit-tested (migration, possession, chain verification) |
| 27 | **Meta SSCD Copy Detection (512-D ViT/ResNet)** | Image | Deep near-duplicate and transformed copy detection | `ml-service/pipeline/dupdetect/embeddings.py` → `SSCDEmbedder` | Meta official TorchScript checkpoint (`sscd_disc_mixup.torchscript.pt`), 512-D L2-normalized descriptor. Bicubic resize(288) → CenterCrop(288) → ImageNet normalization. Thresholds: `block_thr = 0.4802`, `review_from = 0.2185`. HNSW approximate nearest-neighbour search | **Validated**: 100% recall across 10 adversarial transform variants (`thresholds.json`) |
| 28 | **256-bit PDQ Perceptual Hashing & MIH** | Image | Fast binary perceptual hash with quality weighting | `ml-service/pipeline/dupdetect/hashing.py` → `compute_pdq`, `MIHIndex` | 256-bit hex from `pdqhash.compute()`; quality score 0–100 (`MIN_PDQ_QUALITY = 20`); Hamming distance ≤ 32 (`PDQ_MATCH_MAX_DIST`). Multi-Index Hashing (MIH) with 16 nibbles × 16 buckets guarantees sub-millisecond retrieval for radius ≤ 15 | Empirical verification on PDQ benchmarks |
| 29 | **Multi-Signal Two-Gate Decision Rule** | Multi-modal | 2-signal cross-seller gating & tombstone enforcement | `ml-service/pipeline/dupdetect/pipeline.py` → `DuplicatePipeline.query()` | Cross-seller BLOCK requires **2 independent signals** (hash + SSCD, hash + text, SSCD + text) OR tombstone repost (hash / SSCD ≥ 0.4802) OR hardware identifier match + SSCD ≥ 0.2185. Single signals or same-seller yield REVIEW; text alone **never** blocks | Unit & pipeline tested |
| 30 | **Hardware Identifier Extraction (Luhn-checked IMEI & Serial)** | Identity | Physical product identifier reuse detection in text | `ml-service/pipeline/dupdetect/pipeline.py` → `extract_identifiers()` | Regex `\b\d{15}\b` validated via Luhn checksum algorithm (`_luhn_ok`); Serial regex `\b[A-Z0-9-]{8,20}\b` with alphanumeric constraints. Matches trigger `identifier_match` block when visual evidence supports | Validated against GSMA IMEI spec & mock suites |

#### PART B — Pipeline Diagrams

**B.1 IMAGE PIPELINE** (execution order in `backend/src/workers/imageProcessor.js`; conceptual order in §7.1)

```
Upload to Cloudinary -> product API identity check (if identifier supplied)
  |                     (ownership mismatch / reported stolen can reject)
  v
BullMQ "image-processing" job (concurrency 2)
   |
   v
Buffer fetch (job payload or HTTP fetch of the Cloudinary URL)
   |
   +--> per image -------------------------------------------------------+
  |    Sharp: resize 32x32 grayscale -> pHash family (imageHash.js)      |
   |      plain pHash (16 hex) + mirror (flop) + r90/r180/r270 + vflip   |
   |    Sharp: color histogram (+sharp.stats() for condition/damage)     |
  |    Whole-image MobileNet classification + condition/damage CV       |
  |    COCO-SSD detect() -> NMS -> <=8 crops -> per-crop MobileNet      |
  |      (classify + intermediate-layer embedding)                      |
   +---------------------------------------------------------------------+
   |
   v
Aggregate: avg condition/damage (nulls skipped) ; primaryObjectIndex ;
            cover-image detectedObjects ; bundleNote when >= 3 objects
   |
   v
Category agreement (MobileNet vs chosen, conf >= 0.5)
   |- agree          -> proceed
   +- mismatch       -> CATEGORY_MISMATCH (+10) + widen pHash probe pool
   |
   v
Comparables (same category, active+sold, newest 30)
   |
   v
LOCAL PRICE: depreciation -> CV/damage adjustments -> IQR/comparable blend
   |
   v
CLIP: POST /embed (cover image) -> 512-d embedding stored on product.embedding
        POST /text-embed (title) -> image<->title cosine (null when ML down)
   |
   v
ML PRICE: POST /price-estimate with embedding
  -> legacy by default; v2 kNN quantiles only when enabled
  -> blendWithMl (ML_BLEND_WEIGHT default 0.7 = 70% ML / 30% local)
   |
   v
ML fraud check: POST /fraud-check with listing + <=100 candidates
  -> legacy by default (ML_PIPELINE_V2=0); shadow logs v2 but returns legacy
  -> v2 response returned only when ML_PIPELINE_V2=1
   |
   v
Persist main document: embedding, hashes (merge-preserving), aiAnalysis.*,
        suggestedPrice/priceRange, status (pendingReview when ML >= 70 or
        statusRecommendation === 'pendingReview')
   |
Platform-wide CLIP scan (vectorSearch): top-K 50, crossCategory = true
        cross-seller cosine >= 0.93 and pHash did NOT fire -> +20
   |
   v
detectRisk() -> fuseFraudScores() -> aiAnalysis.riskAssessment
        { riskScore, riskLevel, factors, riskFactorCategories,
          v1RiskScore, v2FraudProbability, fusionMode, assessedAt }
   |
   v
Main-flow riskAssessment write completes (releases background visual check)
  |
  +--> (setImmediate, non-blocking; runs concurrently with main flow)
      POST /extract-cnn per image -> images[].cnnFeatures (512-D CLIP-backed)
      -> wait for main-flow write -> assessVisualSimilarity()
      -> strongest pair cosine >= 0.90 / 0.97, candidate cap 200
      -> atomic supporting-risk update
  |
  +--> DupDetect v2 shadow hook (imageProcessor.js, post-save):
       POST /dup/query (:8100) -> query SSCD + PDQ + identifiers + text
       -> logShadowVerdict([DupClient][SHADOW])
       -> POST /dup/add (:8100) -> register listing in memory store
  |
  v
Enqueue priceAnalysisQueue "reprice" (delay 30s)
```

**B.2 TEXT PIPELINE** (near-duplicate description + scam-text detection)

```
listing.title + listing.description
   |
   v
EXACT-MATCH FAST PATH (raw description, same seller)
   Product.countDocuments({ status:'active', same seller,
                            description: identical })
   |- hit (>= 1) -> +20 DUPLICATE_DESCRIPTION, similarity scan SKIPPED
   v (miss)
NEAR-DUPLICATE PATH (description only)
   |
  v
normalizeText(): lowercase, collapse whitespace (textSimilarity.js)
  |
   +-- method selection ----------------------------------------------+
   |   isMlTextEmbeddingAvailable() (health probe cached 30s TTL)      |
   |     yes -> POST /text-embed for target + every candidate          |
   |              cosine(targetEmbedding, candEmbedding)               |
   |              threshold 0.92   method 'ml-text-embedding'          |
   |     no  -> charNgramJaccard(target, cand, n=3)                    |
   |              threshold 0.85   method 'char-3gram-jaccard'         |
   +-------------------------------------------------------------------+
   |
   v
Candidate scope, in order:
   1. seller's own active listings      (cap DESC_DUP_SCAN_CAP = 100)
         -> sameSeller hit  -> +20
   2. other sellers, same category      (cap OTHER_SELLER_DESC_SCAN_CAP = 200)
         -> crossSeller hit -> +15
   |
   v
SCAM-TEXT (raw title + description, textScamAnalyzer.js, capped +25)
   contact-info regex | urgency cliches | excess caps | excess punctuation
   | lowball+urgency interaction
   |
   v
Both blocks feed detectRisk() -> factors[] (+ content_scam_signals category)
```

**B.3 PRICE PIPELINE**

```
listing features (category, brand, model, MSRP, yearsUsed, condition,
                  specifications, CV condition score, damage score)
   |
   v
LOCAL BASELINE (priceRecommendation.js)
   base = MSRP x (1 - annualRate)^years x brandMult x conditionMult
          (no MSRP -> IQR-trimmed median of comparables x conditionMult)
   x cvFactor     = score/100 x 0.4 + 0.6          (maps 0..100 -> 0.6..1.0)
   x damageFactor = max(0.7, 1 - damage/250)
   x 1.06 premium spec boost (pro|max|ultra|plus|premium|256|512|1tb|16gb|32gb)
  if >=3 total comparables, blend 70/30 with the median of available
  same-condition comparables (the filtered subset need not itself have 3)
   confidence: 0.5 + 0.20 (MSRP) + 0.10 (comps, MSRP path only)
                    + 0.10 (CV) + 0.05 (damage)   -> clamped to 0.95
   |
   v
ML ESTIMATE (/price-estimate; v2 path only when enabled)
  clean + prefer sold comps (>= 3 sold -> pool) -> kNN k=5 from the Node
  request (service config default 12 if omitted) over the
   512-d CLIP space (HNSW, category pre-filter) ->
   log-price features -> LightGBM quantiles q10/q50/q90 ->
   conformal +/- 0.1303 (80% coverage) -> exp() back to price
   confidence = 0.6 x countFactor + 0.4 x spreadFactor
   (confidence < 0.35 or knn_count < 3 -> wide range, suggestedPrice null)
   |
   v
BLEND (mlClient.blendWithMl, weight = ML_BLEND_WEIGHT, default 0.7)
   recommended = local x (1-w) + ml x w      min/max blended the same way
   both sides always contribute; one side missing -> the other is used as-is
   source: 'hybrid' | 'ml-service' | 'heuristic'
   |
   v
OUTPUT: recommendedPrice, minPrice/maxPrice (+/-15%), p25/p75,
        confidence, factors[], explanation
```

#### PART C — How Each Algorithm Is Achieved

**1. DCT Perceptual Hashing (pHash)** — *Purpose:* turn an image into a 64-bit fingerprint that survives
rescaling, recompression and mild edits, so byte-different but visually identical reposts collapse onto
the same hash. *How:* Sharp decodes the buffer straight to a 32×32 raw grayscale plane; a separable 2D
DCT runs over it (one horizontal pass into `temp`, one vertical pass into `output`) using a
precomputed cosine table — one 32×32 table reused for both axes, saving ~65 000 `Math.cos`
calls per image; the top-left 8×8 block holds the
64 lowest-frequency coefficients; the median of those 64 values becomes the threshold and each bit is
`coeff >= median`; the 64 bits are packed via `BigInt` and rendered as 16 hex characters. Matches are
decided by Hamming distance ≤ 12 in `detectRisk()` (§7.2, §7.11). *Limitation:* pHash is only robust to
mild transforms — a 5% crop shifts the whole low-frequency structure (mean distance 16.83 in the
validation corpus), so recall on modified same-item copies is 61/120, not 100%.

**2. Hamming Distance** — *Purpose:* compare two 64-bit pHash values. *How:* both hex strings are
converted to 64-bit binary via `BigInt`, then differing bit positions are counted; `similarity()` returns
`max(0, 1 − d/64)`. A missing operand returns 64; a wrong-length value returns `null` from
`hammingDistance()` (and 0 from `similarity()`). The Sharp-unavailable SHA-256 fallback is exactly 16
hex characters, so it passes the length check and is compared as if it were pHash (§7.2, §7.11, §18
item 3). *Limitation:* there is no fallback-type marker, so such values can yield arbitrary Hamming
distances.

**3. Multi-Hash Set Probing** — *Purpose:* close cheap flip/rotation evasion paths. *How:* the worker
computes plain and horizontal-mirror hashes separately; `orientationHashesFromBuffer()` computes the
`rotate(90/180/270)` and `sharp.flip()` hashes in parallel. `collectHashSet()` re-unions whatever is stored on the document
(`imageHashes` + `mirrorHashes` + `rotationHashes` + `vflipHash`) so the probe always compares complete
sets regardless of which fields a row was written with, and every probe hash is compared against every
candidate hash (the cross product). The worker merge-preserves existing hashes so a re-run never erases
mirror/rotation coverage (§7.2, §7.11). *Limitation:* it only catches **exact** transforms produced by
the same Sharp pipeline — the 96/96 coverage figure assumes no intermediate re-encode; a re-shot photo
at a different angle needs the CNN layer instead.

**4. MobileNet v2 (TF.js)** — *Purpose:* classify images into marketplace categories and produce
per-object crop embeddings. *How:* `mobilenet.load({version:2, alpha:1.0})` is loaded by the image-classifier service; images are
Sharp-resized to 224×224, `removeAlpha()`-ed, converted to a `tf.tensor3d([224,224,3])` float tensor of
**raw** 0-255 pixels (the model normalises internally — pre-dividing by 255 collapses the effective input
to near-black and yields near-uniform predictions), classified `topK=10`, and ImageNet labels map to the
category taxonomy via ~130 hand-authored substring mappings. `infer(tensor,true)` supplies embeddings
for detected crops; its returned dimension is not checked at this call site. Separately, the worker stores
the ML service's 512-D `/extract-cnn` output in the legacy `cnnFeatures` field, not MobileNet output
(§7.3, §7.12). *Limitation:* ImageNet labels cover only learned classes and the crop embeddings do not
identify a particular physical item.

**5. Cosine Similarity on CNN-named image embeddings** — *Purpose:* compare visual vectors across listings.
*How:* whole-image `cnnFeatures` are currently 512-D CLIP vectors supplied by `/extract-cnn`; for each
image of listing A the strongest cosine against **any** image of listing B is kept, `aggregateSimilarity` is
the mean of those best matches, and the strongest single-pair value drives the signal. Cosine is computed
directly (dot / product of norms) and clamped to [0,1] because negative cosine carries no positive
similarity meaning; invalid or length-mismatched vectors return `null` and are skipped. The scan is
bounded by `VISUAL_SCAN_CAP`=200 and fires `VISUAL_PRODUCT_SIMILARITY` at ≥0.90 (+10) or ≥0.97 (+20)
(§7.4, §7.9). *Limitation:* two sellers legitimately owning the same model also score high — hence
supporting-only, never proof.

**6. Aggregate Fingerprinting** — *Purpose:* represent a multi-image listing with a normalized mean.
*How:* `buildProductFingerprint()` averages same-length per-image `cnnFeatures` (currently 512-D CLIP
vectors) and L2-normalizes the mean. Its helper can append the primary crop embedding as a separate
comparison vector, but `assessVisualSimilarity()` does not select `detectedObjects`, so production scans
currently use whole-image vectors only (§7.4, §7.12). *Limitation:* averaging can wash out a distinctive
photo, and the stored field name does not identify the model that produced the vector.

**7. COCO-SSD Object Detection (TF.js)** — *Purpose:* classify a bundle photo by its primary detected
item and produce per-object crops/embeddings; the live whole-image fingerprint scan still compares the
full frame. *How:* `cocoSsd.load({base:
'mobilenet_v2'})` shares the TF.js stack; the image is downscaled so its long edge is ≤800px for
detection, `detect()` returns boxes which are filtered at score ≥0.5, de-duplicated by greedy
non-maximum suppression (highest score first; a box is dropped when its IoU with a kept box exceeds 0.6)
and capped at 8; coordinates are scaled back to original pixels so Sharp can `extract()` each crop with
10% padding per side, clamped to the image bounds. Each crop is then classified and embedded by
MobileNet, stored as `aiAnalysis.detectedObjects` with the highest-scoring box as the default primary
index (§7.12). *Limitation:* only the 80 COCO classes are known, so exotic items silently fall back to
whole-image analysis (never penalised).

**8. CLIP ViT-B/32 (OpenCLIP)** — *Purpose:* provide a shared image/text vector space when the pretrained
model loads, enabling semantic comparisons. *How:*
`open_clip.create_model_and_transforms('ViT-B-32', pretrained='laion2b_s34b_b79k')` runs on CUDA if
available; loaded-model image/text outputs are L2-normalised 512-D vectors. An LRU cache (cap 4096) uses
32-hex-character prefixes of SHA-256 URL/text hashes; image cache misses can be batch-encoded. If
OpenCLIP fails, the wrapper still returns 512-D deterministic fallbacks (image color/spatial moments and
hashed text tokens), which are not a learned shared semantic space. Uses include image↔title cosine
**< 0.20** → `IMAGE_TEXT_MISMATCH` (+15), with generic/short titles skipped and 0.20–0.30 shadow-logged;
and the backend platform-wide scan at cosine **≥ 0.93**, top-K 50, for `CROSS_CATEGORY_IMAGE_REPOST`
(+20), suppressed when pHash already fired (§7.9, §7.11, §8.1). *Limitation:* the loaded encoder is
general-purpose, and the deterministic fallback is not jointly trained or semantically aligned.

**9. CLIP Text Embeddings** — *Purpose:* catch "same description, two words changed" when the exact-match
fast path missed. *How:* `mlClient.getTextEmbedding()` posts each normalized candidate to `/text-embed`
(5s timeout); ML health is cached for 30s. Cosine ≥ **0.92** is a match; the 3-gram path is selected if
the service or embedding calls are unavailable. Scope: own active listings first (cap 100, +20), then
other sellers in the same category (cap 200, +15) (§7.9, §7.11). *Limitation:* health does not verify
that OpenCLIP loaded, so deterministic token-hash fallback vectors may be used in place of semantic
embeddings; full paraphrases evade either method, and neither detects scam intent.

**10. Character 3-gram Jaccard Similarity** — *Purpose:* a zero-dependency similarity measure that keeps
working when the ML service is down. *How:* `charNgramJaccard()` builds the *set* of overlapping
3-character grams of both normalised strings and returns `|A ∩ B| / |A ∪ B|`; the shortcut rules are
both-empty → 1 and one-empty → 0. The threshold is **0.85**, above the CLIP threshold because character
overlap is noisier than semantic similarity. It is the fallback path only, and every factor string reports
which method produced the match (§7.9, §7.11). *Limitation:* purely lexical — synonyms and rewording
score low, and the same generic boilerplate phrased differently is invisible to it.

**11. LightGBM (gradient-boosted trees)** — *Purpose:* replace the hand-weighted v1 rule engine with a
model that learns signal interactions. *How:* a `lgb.Booster` loaded from `models_saved/fraud_v2.txt`
consumes the 14 engineered features in a fixed `FEATURE_ORDER` (duplicate embeddings/pHash split by
seller, image-text similarity, price z-score, account age and velocity, image geometry, stock-dimension
and editing-software flags, vision-LLM flags) and outputs a probability. The three independent feature
stages (duplicates, metadata, image-text similarity) run in a `ThreadPoolExecutor` with
`Future.result(timeout=STAGE_TIMEOUT_S)` handling (default 3s) and rule-based fallbacks. A timed-out
future is cancelled where possible, but the executor context waits for running work at shutdown, so
this is not a strict end-to-end hard timeout.
Runtime thresholds come from `models_saved/fraud_v2_thresholds.json` (0.95 flag / 0.475 review) and
override env defaults. v2 is **disabled by default** (`ML_PIPELINE_V2=0`); `shadow` must be selected
explicitly and serves legacy results (§8.2, §8.4). *Limitation:* available artifacts and evaluation use
synthetic data; the generator encodes the same signals the pipeline detects, so recall 0.56 / AUC 0.888
are not production evidence.

**12. Isotonic Regression (attempted sigmoid fallback)** — *Purpose:* calibrate the raw boosted score.
*How:* training fits `IsotonicRegression(out_of_bounds='clip', y_min=0, y_max=1)` on a holdout split. If
that fails it fits sklearn `LogisticRegression` on raw scores. Inference calls
`calibrator.predict([raw])`; LogisticRegression rejects this 1-D input, the exception is caught, and the
raw clipped score is returned instead of a sigmoid probability (§8.2). *Limitation:* isotonic calibration
is based on synthetic data and is unvalidated on real outcomes; the sigmoid fallback is ineffective as
currently wired.

**13. Vision LLM (uncertainty-band gating)** — *Purpose:* get a semantic read ("this looks like a stock
photo / a screenshot / edited") only for selected listings. *How:* after the LightGBM probability is
computed, `in_uncertainty_band()` requires `VISION_LLM_BAND` **[0.25, 0.65]** *and* distance ≤
`VISION_LLM_MARGIN`=0.15 to the nearest `config.FRAUD_HIGH_THRESHOLD` / `FRAUD_MEDIUM_THRESHOLD`
(defaults 0.60 / 0.30, not the persisted response thresholds); the
request carries **one** image resized to ≤512px (JPEG q85) and a prompt that forces a JSON reply of
`{flags, confidence}` with `max_tokens=128, temperature=0.0`; ≤6 flags come back and are fed into the
classifier as two extra features for a single re-score. Missing API key, download failure, timeout or
JSON parse failure all return `None`, leaving the two features at 0 and never breaking the request
(§8.2). *Limitation:* it never ran in evaluation (no key, no images) — wired but unvalidated, and it adds
per-call latency and cost precisely for the ambiguous middle band.

**14. kNN + Quantile Regression (on CLIP embedding space)** — *Purpose:* produce a price estimate *and*
an honest uncertainty interval. *How:* comparable listings are cleaned (MAD outlier cut) and sold prices
preferred; neighbours come from the HNSW index over the 512-d CLIP space with a category pre-filter
(`k=5` on the Node request path, `KNN_NEIGHBORS=12` as the service default), falling back to the first k
recency-ordered comparables when no embedding or no index exists. Features (`log_original_price`,
`years_used`, `condition_weight`, `is_sold_present`, `knn_median_log_price`, `knn_spread_log_price`,
`knn_count`, `category_median_log_price`) feed three LightGBM quantile boosters trained on **log** price
so multiplicative errors become additive; when the conformal artifact is loaded, its width (0.1303,
α=0.20 for an 80% coverage target) widens the interval, then `exp()` maps back to price. With that
width loaded, exposed P25/P75 are midpoints `(q10+q50)/2` and `(q90+q50)/2`, not 0.25/0.75 quantiles;
without a width, the API exposes q10/q90 in those fields. Confidence is
`0.6 × countFactor + 0.4 × spreadFactor`, and below 0.35 (or fewer than 3 neighbours) the endpoint
returns a wide range with `suggestedPrice: null` instead of a misleading number (§8.3). *Limitation:*
trained on synthetic listings whose comparables come from the same pool being scored, so MAE $39 /
MAPE 16.9% is optimistic.

**15. HNSW (via FAISS `IndexHNSWFlat`)** — *Purpose:* approximate nearest-neighbour retrieval over
embeddings. *How:* `CategoryANNIndex` uses `faiss.IndexHNSWFlat(512, 32)` with `efSearch=64`, category
stores plus a global store, normalized vectors and overfetch `max(k*8, k+20)`. It persists to
`models_saved/ann_index.pkl`; startup loads a saved index, but this service has no call site that builds
or refreshes it. `price_v2.py` calls `ann_index.search()`; `fraud_v2.py` does not. Missing FAISS or an
empty search result leads price v2 to its recency-comparable fallback (§8.5). *Limitation:* approximate
retrieval can miss neighbors, and this in-process index is not shared across replicas.

**16. Exponential Depreciation Model** — *Purpose:* a transparent first estimate of resale value from
MSRP. *How:* `originalPrice × (1 − annualRate)^yearsUsed × brandMultiplier × conditionMultiplier`, with
per-category annual rates (0.10–0.30), nine brand premiums (1.0–1.10) and five condition factors
(0.25–0.95, 0.60 for an unknown condition). Each factor is appended to `factors[]` so the arithmetic is
auditable; when no MSRP exists the same function instead takes the IQR-trimmed median of comparables
times the condition multiplier (§7.8). *Limitation:* the constants are hand-authored, not fitted to sales
data — a discontinued or collectible item follows the curve only by luck.

**17. IQR Outlier Removal (Tukey's fence)** — *Purpose:* stop manipulated comparables from skewing the
recommended price. *How:* `trimIQR()` needs at least 4 values, takes `q1 = s[floor(0.25n)]` and
`q3 = s[floor(0.75n)]` from the ascending array, and keeps only values inside
`[q1 − 1.5·IQR, q3 + 1.5·IQR]`; removed values are counted and reported as "(N outliers removed)" in the
factor string. The Python price pipeline does the equivalent job with a MAD rule
(`median ± 3.0 × 1.4826 × mad`) because log-priced comparables are handled there instead (§7.8, §8.3).
*Limitation:* with fewer than four comparables no trimming happens at all, and Tukey's fence on a tiny
sample can throw away legitimate prices.

**18. Z-Score (price vs category median)** — *Purpose:* flag prices that are anomalous *for their
category*, rather than against a fixed ratio to MSRP. *How:* `_metadata_features()` computes
`z = (price − category_median) / category_std`, taking the median from `categoryMedianPrice` or
`np.median(comparables)`, the spread from `np.std(comparables)` or a **0.35 × median** assumption when
there are not enough comparables, and clipping the result to ±10 so one absurd listing cannot dominate a
feature. The reason bands are `z < −2.5` (too low) and `z > 3.0` (too high) (§8.2). *Limitation:* the
assumed 0.35 CV is a guess, and a category with genuinely bimodal pricing (used vs new mixed) yields a
large σ that hides real anomalies.

**19. Sobel-like Edge Density Analysis** — *Purpose:* a *heuristic* stand-in for damage detection with no
model dependency. *How:* the image is reduced to a 64×64 grayscale thumbnail; for every interior pixel a
forward-difference gradient `|gx| + |gy|` is computed and counted as an "edge" when it exceeds 60;
`edgeRatio = edges / (62 × 62)` then maps to bands (>0.45 → +55, >0.35 → +35, >0.20 → +20, <0.08 →
smooth). The maximum reachable score is 55, which makes the ≥50 "high" band reachable only by genuine
heavy-wear evidence — and nothing else can push it there. Brightness/contrast/sharpness are deliberately
**not** counted here, since they describe the photo and are already consumed by the condition score
(§7.5). *Limitation:* textured patterns (fabric, mesh, busy backgrounds) raise edge density without any
damage, and smooth surfaces with hairline cracks may fall under every band — it measures gradient
statistics, not damage.

**20. Pixel Statistics (brightness / contrast / sharpness)** — *Purpose:* a deterministic photo-quality
estimate used as a condition proxy. *How:* `sharp.stats()` returns per-channel mean and standard
deviation; brightness is the mean of channel means, contrast the mean of `min(stdev, 100)`, and
sharpness is `0.8 × contrast + 0.2 × brightness`. Penalties are dark (<60) −15, overexposed (>220) −10,
low contrast (<20) −10, blur (sharpness <30) −8; clamp [30,100], then label like-new/good/fair/poor.
This condition score feeds the price `cvFactor`; damage scoring separately uses edge density and adds
+5 to risk at damage ≥50. Unavailable Sharp/decode returns `score:null, available:false` (§7.5, §7.8).
*Limitation:* these are photograph properties, so lighting and focus can diverge from item condition.

**21. Lexical Pattern Matching (regex)** — *Purpose:* catch the low-effort, copy-pasted marketplace scam
template. *How:* the concatenated title+description is tested against a small regex set (email,
WhatsApp/`wa me`, an Indian mobile with optional `+91`/`0` prefix and a 6–9 first digit, plus a generic
10-digit run) for **+10**; the count of matched urgency clichés ("urgent sale", "need cash", "moving
abroad", "advance payment", "trust me"…) gives **+10** at ≥2 and **+15** at ≥4; formatting abuse (text
length >30 with >50% of letters uppercase, or >5 exclamation marks) gives **+5** each; and the
**interaction** rule — the word "urgent" *and* price < 40% of original price — gives **+15**. The whole
block is capped at `MAX_CONTRIBUTION`=25 so a suspicious description can never flag a listing on its own,
and the detailed strings are generalised to `content_scam_signals` for non-admin surfaces (§7.10).
*Limitation:* it is a rule engine, not a learned model — synonyms, spacing and leetspeak defeat every
rule, and it has no notion of intent.

**22. Weighted Additive Signal Aggregation** — *Purpose:* combine every signal into one explainable 0-100
score. *How:* `detectRisk()` walks a fixed list of blocks, each adding a hand-authored weight — duplicate
image +35, graduated price anomaly 0–25 / 0–10, new-account high value +15, exact duplicate description
+20, near-duplicate description +20/+15, image–title mismatch +15, category mismatch +10, cross-category
repost +20, listing bursts +15/+10, reports +15, damage ≥50 +5, identity signals +10…+100, visual
similarity +10/+20, scam text 0–25 — then `clamp(score, 0, 100)` and bands at ≥50 high / ≥25 medium.
Each contribution pushes a human-readable factor string, which is mapped to a coarse
`riskFactorCategories` bucket for non-admin surfaces so internal thresholds stay hidden (§7.9, §18
item 4). *Limitation:* weights are hand-authored, so the scale is not calibrated — a score of 60 is not
"60% likely fraud", which is exactly why the calibrated v2 probability exists at all.

**23. Max-Fusion Ensemble Policy** — *Purpose:* combine the v1 additive score with the v2 calibrated
probability without either engine being able to hide the other. *How:* `fuseFraudScores()` takes
`max(round(v1), round(v2 × 100))` when both are finite and records `fusionMode: 'v1+v2-max'`; v1-only
yields `'v1'` and v2-only `'v2'`. The raw `v1RiskScore` and `v2FraudProbability` are persisted alongside
the fused value for audit, and the risk level is re-derived from the fused score with the same ≥50/≥25
bands. Both engines' outputs are also logged for shadow analysis and human outcome feedback (§8.4).
*Limitation:* `max()` is conservative — it cannot downgrade a false positive from either engine, so a
noisy v2 can permanently ratchet scores upward.

**24. Logarithmic Scaling `log10(n+1)`** — *Purpose:* let sales volume raise trust without letting it run
away to the cap. *How:* `salesScore = clamp(log10(salesCount + 1) × 10, 0, 20)`. The 20 most recent sales
(or fewer when fewer exist) are examined for repeat-buyer concentration: `ratio = 1 − uniqueBuyers/N`,
where `N` is the returned sample size. When ratio exceeds 0.6, sales points are capped at 10; ratio and
the `capped` flag are exposed in the breakdown (§7.7). *Limitation:* the concentration cap only inspects
up to 20 recent sales, so coordinated buyers outside that window are not detected.

**25. Confidence Fusion (MobileNet + keyword agreement)** — *Purpose:* combine the image-model category
with filename/title keyword evidence. *How:* the keyword score over lowercased filename+title
contributes **+2 per matched keyword** across eight category lists; then: (1) a model prediction at or
above `CONFIDENCE_THRESHOLD`=0.15 wins, with **+0.10** if keyword evidence agrees; (2) a sub-threshold
model prediction with agreeing keyword uses `max(modelConfidence, 0.4 + keywordScore × 0.1)`; (3)
keyword-only falls back to `0.4 + keywordScore × 0.1`. All returned confidences are capped at 0.95.
The resulting
confidence also drives the `CATEGORY_MISMATCH` signal (fires only at ≥0.5) and therefore the pHash probe
widening (§7.3, §7.9, §7.12). *Limitation:* the keyword lists are hand-authored and brand-name heavy — an
unbranded item with a vague title falls back to "Other" and skips the mismatch check entirely.

**26. HMAC-SHA256 (salted) identifier registry** — *Purpose:* let the platform detect serial/IMEI/VIN
reuse without ever storing a raw identifier. *How:* `hashIdentifier()` normalises the value first (IMEI =
exactly 15 digits, VIN = exactly 17 alphanumerics, serial ≥ 4 alphanumerics) and then applies
`crypto.createHmac('sha256', IDENTIFIER_HASH_SALT).update(normalized).digest('hex')`; the salt is what
defeats rainbow tables over the small, structured identifier space. Records written before salting are
recovered by a legacy bare-SHA-256 lookup and upgraded in place. The registry additionally records
possession verification (a 6-character code from a 32-character alphabet, 24h TTL, `timingSafeEqual`
comparison, lockout after 5 failed attempts) and chains every ownership event with
`SHA256(previousHash | eventType | ownerId | listingId | transactionId | timestampISO)` from a `GENESIS`
root, so tampering with the chain is detectable (§7.6, §12). *Limitation:* the unset-salt fallback is a
*constant* (it warns loudly but works), so a deployment that forgets `IDENTIFIER_HASH_SALT` gets
rainbow-able hashes; and a hash lookup proves reuse, never possession — which is why the code challenge
exists.

**27. Meta SSCD (Self-Supervised Copy Detection)** — *Purpose:* robust, learned image copy detection invariant to crops, rotations, color shifts, screenshots, watermarks, and collages that defeat pHash. *How:* Meta's official TorchScript model (`sscd_disc_mixup.torchscript.pt`) maps an input image to an L2-normalized 512-D descriptor. The input is resized bicubic to 288×288, center-cropped to 288×288, and normalized with ImageNet parameters. Vector comparisons use dot product (cosine similarity) indexed with FAISS HNSW. Measured calibration establishes `block_thr = 0.4802` and `review_from = 0.2185` (§7.11, §8.6). *Limitation:* deep models require GPU/CPU inference latency (~50–150ms per image) and weight download (~100MB), which is why it runs asynchronously in the Python microservice rather than on every inline web upload.

**28. 256-bit PDQ Perceptual Hashing & Multi-Index Hashing (MIH)** — *Purpose:* fast binary visual hashing with quality assessment and sub-millisecond candidate lookup. *How:* `pdqhash.compute()` produces 256 bits of frequency domain hashes plus an image quality score (0–100). Matches require Hamming distance ≤ 32 and quality ≥ 20. Candidate retrieval is accelerated using Multi-Index Hashing (MIH) with 16 nibbles (16 buckets), which guarantees exact sub-millisecond retrieval within Hamming radius ≤ 15 (§7.11, §8.6). *Limitation:* like pHash, PDQ is susceptible to aggressive cropping (>35%) or non-affine distortions, where SSCD takes over.

**29. Multi-Signal Two-Gate Decision Rule** — *Purpose:* eliminate single-signal false positive blocks while aggressively catching stolen listings and repost-after-delete evasions. *How:* the v2 pipeline evaluates five independent signals (multi-hash, SSCD embedding, hardware identifiers, text fusion, and tombstone records). A cross-seller `block` requires **two independent corroborating signals** (e.g. hash_hit + embedding_above_block, hash_hit + text_hit, or embedding_above_block + text_hit), OR a tombstone repost (hash or SSCD ≥ 0.4802), OR an identifier match with SSCD in the review band (≥ 0.2185). Text alone **never** blocks (maximum verdict `review`). Same-seller near-matches trigger `review` (`same_seller_repost`) to avoid blocking sellers updating their listings (§7.11, §8.6). *Limitation:* an adversary possessing the physical item who uses a stolen photo and distinct text can still trigger a block without manual appeal.

**30. Hardware Identifier Extraction with Luhn Check** — *Purpose:* extract and validate physical equipment serials and IMEIs embedded in listing titles and descriptions. *How:* `extract_identifiers()` applies regex `\b\d{15}\b` for IMEIs and validates them against the Luhn mod-10 checksum algorithm (`_luhn_ok`); serial numbers require 8–20 uppercase alphanumerics matching `(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])`. Matched identifiers are prefixed (`imei:...`, `ser:...`) and checked across listings. Matches trigger `identifier_match` block when visual evidence supports (§7.6, §7.11, §8.6). *Limitation:* sellers who fail to mention the serial in the text cannot be matched by this layer.

---

## 8. ML Microservices (Python / FastAPI)

The platform runs two specialized Python FastAPI services:
1. **Core ML Service (Port 8000)**: CLIP ViT-B/32 multimodal embeddings, LightGBM fraud detection v2, kNN quantile price recommendation, and FAISS HNSW ANN search (`main.py` · Docs: http://localhost:8000/docs).
2. **DupDetect v2 Service (Port 8100)**: Meta SSCD copy detection, 256-bit PDQ + pHash multi-hashing, hardware identifier extraction, text fusion, and tombstone lifecycle management (`pipeline/dupdetect/api.py` · Docs: http://localhost:8100/docs).

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

If OpenCLIP initialization fails, `clip_model.py` still serves deterministic 512-D fallbacks: image
color/spatial moments projected with a seeded random matrix, and text tokens hashed into a signed vector.
Both are normalized, but they are **not a learned joint image/text space**, so semantic image-text and
cross-modal scores are not meaningful in that fallback mode. `/health` can still report the service
healthy while `clip_loaded` is false.

When OpenCLIP is loaded, it captures multi-modal semantics — images and text exist in the same vector space, enabling:
- Image-to-image similarity (same listing in different lighting/backgrounds)
- Text-to-image semantic matching (detecting "iPhone" listing with irrelevant image = potential fraud)
- Semantic similarity search across the marketplace

### 8.2 LightGBM Fraud Pipeline v2

**File:** `ml-service/pipeline/fraud_v2.py`

The v2 pipeline is a **calibrated LightGBM binary classifier** intended to complement the hand-weighted
v1 engine. The checked-in artifacts and evaluation use synthetic data, not real fraud outcomes (see
`eval/RESULTS.md`); `training/train_fraud_v2.py` refuses to write synthetic-trained artifacts into the
production model directory. v2 is disabled by default (`ML_PIPELINE_V2=0`).

#### Feature Engineering (14 features)

| Feature | Type | Description |
|---|---|---|
| `max_cross_seller_emb_sim` | float | Max CLIP cosine similarity to any *other* seller's listings |
| `min_cross_phash_dist` | int | Min Hamming distance to any other seller's pHash |
| `cross_phash_exact` | bool | Any cross-seller pHash distance <= threshold |
| `max_same_seller_emb_sim` | float | Max CLIP similarity to same seller's own listings |
| `same_seller_relist` | bool | Same-seller pHash near-match (Hamming ≤ 2 x `PHASH_EXACT_MAX_DIST`) — classified as a relist, not fraud |
| `clip_image_text_sim` | float | CLIP image/title cosine rescaled to 0-1 as `(sim + 1) / 2` |
| `price_zscore_category` | float | Z-score of price vs category median (clipped to +-10) |
| `log_account_age_hours` | float | log1p(account age in hours) |
| `listings_per_hour` | float | log1p(listing rate) — burst-spam signal |
| `aspect_ratio` | float | Image width / height ratio |
| `is_stock_dimensions` | bool | Exactly 1920x1080, 1200x800 or 1000x1000 (common stock photo dimensions; image EXIF/metadata width/height, defaulting to 800x600) |
| `has_suspicious_software` | bool | Image `metadata.software` mentions photoshop / gimp / canva |
| `vision_llm_flag_count` | int | Number of flags from Vision LLM analysis |
| `vision_llm_confidence` | float | Vision LLM confidence score |

> Feature-availability caveat: when LightGBM cannot be loaded the pipeline falls
> back to a transparent rule-based score over the same features
> (`_rule_fallback_score`), so the endpoint still answers.

#### Vision LLM Integration

The Vision LLM (`pipeline/vision_llm.py`) is called only when the calibrated probability is inside
`VISION_LLM_BAND` **[0.25, 0.65]** and within `VISION_LLM_MARGIN`=**0.15** of the nearest
`config.FRAUD_HIGH_THRESHOLD` / `FRAUD_MEDIUM_THRESHOLD` (defaults **0.60/0.30**). These gating
thresholds are separate from the persisted response thresholds (**0.95/0.475**). The call sends one
image resized to ≤512px with `max_tokens=128`, `temperature=0.0` and a JSON `{flags, confidence}` prompt;
up to six flags re-feed one model score. This design:
- Reduces inference cost (~70% of listings are clearly legitimate or clearly fraudulent)
- Provides extra discriminating signal only for genuinely ambiguous cases
- Never blocks the request: no API key / download failure / timeout → flags stay 0

#### Probability Calibration

Raw LightGBM scores are calibrated with **isotonic regression** when the saved calibrator is isotonic.
The training fallback fits `LogisticRegression`, but inference calls `.predict([raw])`; sklearn rejects
the 1-D input and the exception handler returns the raw clipped score instead of a calibrated sigmoid
probability. Calibration is not validated on real outcomes.

### 8.3 Quantile Price Estimation (kNN)

**File:** `ml-service/pipeline/price_v2.py`

```
POST /price-estimate
  Input: {
    listing: { condition, originalPrice, yearsUsed, category },
    embedding: [512 floats],    // optional CLIP embedding
    comparables: [...],         // historical + currently listed items
    kNeighbors: 5               // optional; service default KNN_NEIGHBORS = 12
  }
  Output: { suggestedPrice, priceRange: {min, max, p25, p75}, confidence,
            source, explanation, factors }
```

When CLIP embeddings are provided, comparable selection is based on **semantic similarity in the embedding space** rather than just category matching. The model computes:
- P25 (when conformal width is loaded, midpoint of widened q10 and q50; otherwise q10)
- P50 (median / suggested price)
- P75 (when conformal width is loaded, midpoint of widened q90 and q50; otherwise q90)

Using **three LightGBM quantile regressors** (0.1 / 0.5 / 0.9, i.e. `PRICE_QUANTILES`) trained on **log price** so multiplicative errors become additive, scored against the k-nearest neighbours in the embedding space (HNSW with category pre-filter), and the interval is then widened by a **conformal width of 0.1303** (`PRICE_CONFORMAL_ALPHA = 0.20`, i.e. an 80% coverage target) before `exp()` maps back to price. Confidence is `0.6 x countFactor + 0.4 x spreadFactor`; below **0.35**, or with fewer than 3 neighbours, the endpoint returns only a wide range (`suggestedPrice: null`, `source: "ml-quantile-v2-wide"`) instead of a misleading point estimate.

Comparables are cleaned with MAD-based outlier removal and sold prices are preferred (`_comp_price` prefers `soldPrice`/`lastSoldPrice`; `is_sold_present` is 1 once ≥3 sold comps exist). When the quantile models cannot be loaded, a heuristic baseline (`orig x condition x (1 − 0.15 x years)`, or the median of cleaned comparables) is served instead.

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

- Stores CLIP embeddings indexed by product ID, **one graph per category** plus one global graph (category pre-filter before the ANN search)
- Uses FAISS `IndexHNSWFlat(512, 32)` with `efSearch=64` and L2-normalized vectors; overfetch is `max(k*8, k+20)` before seller/ID exclusion
- Persists category/global vectors and items to `models_saved/ann_index.pkl`; startup loads an existing file, but no current service call site builds or refreshes it
- Called by price v2 for comparable retrieval; `fraud_v2.py` compares the supplied candidate list directly and does not use this index
- If FAISS is missing or search returns no neighbors, price v2 falls back to recency-ordered comparables (not a numpy path inside this index)

```
GET /pipeline-stats
-> {
    pipelineVersion: "v2",
    embeddingCache: { hits, misses, size, image_cache_size, text_cache_size, max_size },
    annIndex: { faiss_available, categories, global_items, ef_search },
    drift: { ... }   // prediction drift metrics over time
  }
```

### 8.6 DupDetect v2 Service (SSCD + Multi-Hash + Text Fusion)

**Location:** `ml-service/pipeline/dupdetect/` · **Port:** 8100 · **API Docs:** http://localhost:8100/docs · **Service Module:** `dupdetect.api:app`

`dupdetect v2` is a dedicated duplicate detection microservice that runs on port 8100 alongside the core ML service. It implements a **5-signal multimodal copy detection pipeline** combining perceptual hashing, deep copy embeddings, hardware identifier parsing, and CLIP text similarity with a **2-signal gating policy** and **tombstone support** to prevent repost-after-delete evasion.

#### Endpoints

| Method | Path | Request Body | Response / Effect |
|---|---|---|---|
| `GET` | `/health` | — | Returns `{"ok": true, "model": "sscd", "signals": ["hash", "embedding", "identifier", "text"]}` |
| `POST` | `/dup/add` | `{ listing_id, seller_id, image_b64, title, description }` | Computes hashes, SSCD embedding, and identifiers; registers the record in the in-memory HNSW and MIH indices. Returns `result: {...}` |
| `POST` | `/dup/query` | `{ listing_id, seller_id, image_b64, title, description }` | Evaluates the 5 signals against active and tombstoned listings. Returns `{ decision: "block" \| "review" \| "allow", score, match, reasons: [...] }` |
| `POST` | `/dup/delete` | `{ listing_id }` | Marks the listing as a tombstone in the vector and hash stores. Subsequent reposts continue to match against it. |

#### The 5 Detection Signals

1. **Multi-Hash Set Probing (pHash D4 + 256-bit PDQ):**
   - **pHash Variants:** Computes 6 dihedral group $D_4$ transforms (plain, mirror, r90, r180, r270, vflip) using `imagehash`.
   - **PDQ Hash:** Computes a 256-bit PDQ perceptual hash (`pdqhash`) with quality score ($Q \ge 20$, Hamming distance $\le 32$).
   - **Fast Indexing:** Uses `MIHIndex` (Multi-Index Hashing, 16 buckets) and BK-tree for sub-millisecond candidate lookup.
2. **Deep Copy Detection (Meta SSCD 512-D):**
   - Uses Meta's official TorchScript model (`sscd_disc_mixup.torchscript.pt`), generating an L2-normalized 512-D descriptor trained with mixup entropy regularization specifically for near-duplicate and transformed copy detection.
   - Preprocessing: bicubic resize to 288×288, center-crop to 288×288, and standard ImageNet normalization.
   - Indexed via in-process HNSW index (`ANNIndex`).
   - Calibrated thresholds: `block_thr = 0.4802`, `review_from = 0.2185`.
3. **Hardware Identifiers (IMEI & Serial Extraction):**
   - Regex-extracts 15-digit IMEIs (`\b\d{15}\b`) and validates them using the Luhn mod-10 checksum algorithm.
   - Regex-extracts serial numbers (`\b[A-Z0-9-]{8,20}\b`).
   - Matching a cataloged physical identifier with visual similarity $\ge 0.2185$ produces an immediate **BLOCK** (`identifier_match`).
4. **Multimodal Text Fusion (OpenCLIP ViT-B/32):**
   - Uses OpenCLIP ViT-B/32 text embeddings to compute cosine similarity between listing descriptions.
   - Cosine similarity $\ge 0.92$ triggers `text_hit`.
   - **Text alone never auto-blocks**; it requires corroboration from a vision signal or raises a `review` verdict.
5. **Lifecycle & Repost-After-Delete Tombstones:**
   - When a listing is deleted by a seller or an admin, `POST /dup/delete` marks its record as a tombstone.
   - Hashes and embeddings remain in memory flagged with `tombstone: true`.
   - An adversary who deletes their listing and immediately reposts it with new text will match the tombstone and receive a **BLOCK** (`repost_after_delete`).

#### 2-Signal Gating Policy

To avoid false-positive blocks, cross-seller rejections strictly require **two independent corroborating signals**:

```python
# 2-signal cross-seller block condition (pipeline.py)
if not same_seller and (
    (hash_hit and sim >= self.block_thr) or
    (hash_hit and text_hit) or
    (sim >= self.block_thr and text_hit)
):
    return {"decision": "block", "score": round(max(sim, text_sim), 3), "match": lid, "reasons": reasons}
```

- **BLOCK**:
  - `repost_after_delete`: Tombstone hit with hash match or SSCD $\ge 0.4802$.
  - `identifier_match`: Exact physical IMEI/Serial match with SSCD in the review band ($\ge 0.2185$).
  - `hash_hit` + `embedding_above_block` (SSCD $\ge 0.4802$).
  - `hash_hit` + `text_hit` (Text cosine $\ge 0.92$).
  - `embedding_above_block` (SSCD $\ge 0.4802$) + `text_hit` (Text cosine $\ge 0.92$).
- **REVIEW**:
  - `same_seller_repost`: Same seller matches on hash, embedding, or text (relisting inventory).
  - `text_near_dup`: Near-duplicate text alone without visual corroboration.
  - `hash_hit` + SSCD in review band $[0.2185, 0.4802]$.
  - SSCD alone in review band $[0.2185, 0.4802]$.
- **ALLOW**:
  - No matching candidate or scores below the review band.

#### Backend Shadow Mode Integration

- **Client:** `backend/src/services/dupClient.js`
- **Fail-open design:** Network timeouts or service errors resolve to `null` without throwing, ensuring listing creation never stalls.
- **Worker hook:** `backend/src/workers/imageProcessor.js` queries `dupClient.queryDuplicate()` after persisting the listing, logs verdicts as `[DupClient][SHADOW]`, and registers the listing via `dupClient.addListing()`.
- **Deletion hooks:** `productController.js` (seller deletion) and `adminController.js` (admin deletion) call `dupClient.deleteListing()` to create tombstones.

#### Running the Service

```bash
cd ml-service/pipeline
uvicorn dupdetect.api:app --host 127.0.0.1 --port 8100
```

> **Note:** Keep a single uvicorn worker process because the HNSW index, MIH buckets, and tombstone records live in process memory.

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
2. Compute the full pHash set per image (plain + mirror + r90/r180/r270 + vflip)
3. Run MobileNet category classification (+ COCO-SSD multi-object crops, §7.12)
4. Assess condition score (brightness / contrast / sharpness)
5. Assess damage score (edge density analysis)
6. Call `/extract-cnn` per image (currently CLIP-backed 512-D vectors stored under legacy `cnnFeatures`, background)
7. Call ML service for CLIP embedding (stored on `product.embedding`)
8. Blend the local price heuristic with the ML quantile estimate
9. Compute visual fingerprint similarity against candidates (supporting-only)
10. Run description exact/near-duplicate, scam-text, image-text, category-agreement,
    cross-category and listing-velocity signals, then unified fraud risk scoring + v1/v2 fusion
11. Update `product.aiAnalysis` in MongoDB
12. Query DupDetect v2 service (shadow hook on port 8100), log structured shadow verdict, and register listing in the v2 memory store

> The list above is the conceptual summary (§7.1). The exact execution order — including the
> parallel CV batch and the non-blocking `setImmediate` CNN/visual block — is traced step by
> step in **§7.13 Part B.1**.

### `priceAnalyzer` Worker

Triggered on product creation (and by a periodic stale-price sweep):

1. Fetch comparable listings in same category (`status: 'sold'`, newest 20)
2. Run local price recommendation (depreciation + condition + comparables)
3. Call ML service for quantile price estimate (if ML service available)
4. Blend both estimates with the same `ML_BLEND_WEIGHT` rule as the upload worker, so a later
   local-only recompute never clobbers the ML-informed price
5. Update `product.aiAnalysis.priceRecommendation` in MongoDB (adds a `refinedAt` timestamp)

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
  conditionScore: Number,       // 0-100 (100 = like-new); 0/absent = NO visual evidence
  conditionConfidence: Number,  // 0-1 — the condition estimate's own confidence (0.3 when unavailable)
  damageScore: Number,          // 0-100 (0 = no damage detected; higher = more damage)
  damageLevel: String,          // 'low' | 'medium' | 'high'
  damageConfidence: Number,     // 0-1 — 0.6 with evidence, 0.3 without
  visualAnalysisAvailable: Boolean, // false = insufficient evidence (UI must say so, never show 0)
  imageTextSimilarity: Number,  // CLIP image<->title cosine; null = not evaluated (ML down / no embeddings)

  // Classification (as written by imageProcessor.js / Product schema)
  classification: {
    predictedCategory: String, // MobileNet-suggested category name
    confidence: Number,        // 0-1
  },

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
  lastAnalyzedAt: Date,        // when the image pipeline last wrote this subdocument
  processedAt: Date,           // legacy field retained for older documents
}
```

---

## 12. Security

| Measure | Implementation |
|---|---|
| **Authentication** | JWT access tokens (15 min expiry) + refresh tokens (7 days) in httpOnly cookies. Refresh tokens are persisted in MongoDB (hashed, with expiry/revocation + single-use rotation) so sessions and logout/rotation survive backend restarts; `JWT_SECRET` is required and kept stable across boots. |
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

# ─────────────── DupDetect v2 Service ─────────
# Python FastAPI copy detection service (port 8100)
DUPDETECT_SERVICE_URL=http://localhost:8100
# Shadow mode (default true): logs verdicts as [DupClient][SHADOW] without altering listing status
DUPDETECT_SHADOW=true
DUPDETECT_TIMEOUT_MS=15000

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
# Visual stored-vector similarity tiers — medium = supporting signal,
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
PHASH_DISTANCE_THRESHOLD=8  # legacy v1 fraud detector only (services/fraud_detector.py) — different domain from the backend duplicate gate
PHASH_EXACT_MAX_DIST=4     # v2 pipeline fast-path pHash distance (cross-seller duplicate rule, fraud_v2.py)
FRAUD_HIGH_THRESHOLD=0.60  # v2 env defaults — models_saved/fraud_v2_thresholds.json (0.95/0.475) overrides them
FRAUD_MEDIUM_THRESHOLD=0.30
VISION_LLM_BAND_LOW=0.25   # uncertainty band for the vision LLM (high = 0.65, margin = 0.15)
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

# Terminal 3 — Core ML Service (port 8000, optional)
cd ml-service
.venv\Scripts\activate
uvicorn main:app --reload --port 8000

# Terminal 4 — DupDetect v2 Service (port 8100, optional)
cd ml-service/pipeline
uvicorn dupdetect.api:app --host 127.0.0.1 --port 8100
```

### 4. Access the Application

| Service | URL | Notes |
|---|---|---|
| Frontend | http://localhost:3000 | React app |
| Backend API | http://localhost:5000 | REST API |
| Core ML Service | http://localhost:8000 | Python FastAPI (CLIP / LightGBM / Price v2) |
| Core ML Docs | http://localhost:8000/docs | Swagger UI |
| Core ML Health | http://localhost:8000/health | Health check |
| DupDetect v2 | http://localhost:8100 | Python FastAPI (SSCD / PDQ / Identifiers) |
| DupDetect Docs | http://localhost:8100/docs | Swagger UI |
| DupDetect Health | http://localhost:8100/health | Health check |
| Backend Health | http://localhost:5000/health | Health check |

> **Graceful degradation:** The app works without Redis (queues disabled) and without the ML services (falls back to heuristic-only analysis). Only Cloudinary is required for image functionality.

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

This section is an honest inventory of the theoretical bounds the fraud/identity/trust stack operates within, alongside the mitigations already in the codebase. Perceptual hashing, stored-vector similarity, statistical pricing, and trust heuristics are probabilistic tools: they reduce abuse but are not proofs. Every row below names a concrete limitation and the specific mitigation that bounds its blast radius.

| # | Theoretical Limitation | Practical Impact | Mitigation in Codebase |
|---|---|---|---|
| 1 | pHash is not a perceptual proof; re-encoded or photographed copies diverge from a stored hash | Real-world duplicates can score below the similarity threshold | 6-hash set probing (plain/mirror/r90/r180/r270/vflip) covers exact-same-pipeline transforms 96/96 in validation; stored-vector similarity and price add supporting signals |
| 2 | Candidate scans are deliberately bounded (500 duplicates / 200 visual) | Coverage loss on large catalogs; the earliest 200-500 listings monopolize the window | `DUPLICATE_SCAN_CAP` / `VISUAL_SCAN_CAP` env caps + `countDocuments` truncation warning so silent under-scanning becomes visible; HNSW is used only by price v2, not these backend fraud scans |
| 3 | SHA-256 fallback (Sharp unavailable) is not perceptual but has the same 16-hex length as pHash | It is compared as if it were a DCT hash and can produce arbitrary Hamming distances | Current code has no hash-type marker; fallback typing/skipping is not implemented, so this remains a limitation |
| 4 | Rule-based signals must not reveal their own thresholds | Sellers can reverse-engineer exactly what triggers a flag and game it | Factors are generalized into coarse `riskFactorCategories` for buyers/sellers; the precise factor strings (with thresholds) are admin-only |
| 5 | Statistical price scoring has no ground truth about "fair" market value | Low/above-original price heuristics are approximations | Continuous graduated penalties (ceil-stepped, no cliff), ML kNN `price-estimate` blended via `ML_BLEND_WEIGHT`, and feedback on human decisions |
| 6 | Trust metrics can be gamed by a seller listing to accomplices | Concentrated buyer bases inflate sales volume | Sales-concentration ratio caps the sales sub-score when >60% of recent buyers are repeats; only verified-purchase reviews count |
| 7 | Identifier hashing is hashing, not encryption; known identifiers are still enumerable | A determined adversary could infer that a raw serial is listed | HMAC-SHA256 keyed by a per-deployment `IDENTIFIER_HASH_SALT` (min 32 chars), lazy migration of legacy bare-hash records; verification requires actual device possession |
| 8 | ML v2 is disabled by default; retraining depends on feedback volume | v2 improvements sit unused unless explicitly enabled | `ML_PIPELINE_V2` / `ML_PIPELINE_SHADOW` flags, drift report at `/pipeline-stats`, and `training/retrain.py` consuming appeal/report outcome feedback |
| 9 | First backend boot fetches MobileNet weights over the network | Slow (~35s) cold start; offline boot fails warm-up | Failures degrade to local heuristics; neither fraud gating nor listing creation is blocked on the model actually having loaded |
| 10 | `RemoteMLProvider` (`cvAdapter.js`) is a stub; remote CV inference is deferred | Some CV signals fall back to local heuristics | Explicit stub warning + documented fallback path; whole-image stored vectors currently come from the ML service's CLIP wrapper |
| 11 | HNSW ANN nearest-neighbor lookups are approximate | Price v2 can build its kNN features from neighbors that omit true nearest matches | HNSW is used by price v2 retrieval; no recall benchmark exists, and an empty/unavailable index falls back to recency-ordered comparables |
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
