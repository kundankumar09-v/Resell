/* eslint-disable no-console */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../src/models/User');
const Category = require('../src/models/Category');
const Product = require('../src/models/Product');
const Sale = require('../src/models/Sale');
const Review = require('../src/models/Review');
const Offer = require('../src/models/Offer');
const Conversation = require('../src/models/Conversation');
const Message = require('../src/models/Message');
const Notification = require('../src/models/Notification');
const ImageUploadRecord = require('../src/models/ImageUploadRecord');

const {
  perceptualHashFromBuffer,
  mirrorPerceptualHashFromBuffer,
} = require('../src/services/imageHash');
const { detectRisk } = require('../src/services/fraudDetection');

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'seed-images');
const BASE_URL = process.env.SEED_BASE_URL || 'http://localhost:5000';

const PASSWORD = 'Password123!';
const DAY_MS = 24 * 60 * 60 * 1000;

const CATEGORIES = [
  { name: 'Electronics', icon: 'smartphone' },
  { name: 'Mobile Phones', icon: 'phone' },
  { name: 'Computers & Laptops', icon: 'laptop' },
  { name: 'Fashion', icon: 'shirt' },
  { name: 'Home & Garden', icon: 'home' },
  { name: 'Sports & Outdoors', icon: 'activity' },
  { name: 'Books & Media', icon: 'book' },
  { name: 'Toys & Games', icon: 'gamepad' },
  { name: 'Beauty & Health', icon: 'heart' },
  { name: 'Automotive', icon: 'truck' },
];

const PRODUCTS = [
  {
    title: 'iPhone 13 128GB — Midnight Blue',
    category: 'Mobile Phones',
    seller: 'priya',
    price: 520,
    originalPrice: 799,
    brand: 'Apple',
    model: 'iPhone 13',
    condition: 'like-new',
    yearsUsed: 1,
    image: 'iphone-13-midnight.jpg',
    description:
      'Great condition iPhone 13, always used with a case and tempered-glass screen protector. Battery health 89%, includes the original Lightning cable and box. Face ID and all cameras fully working — no scratches, no dents. Selling because I upgraded to the 15.',
    specs: [
      { key: 'Storage', value: '128GB' },
      { key: 'Color', value: 'Midnight Blue' },
      { key: 'Battery Health', value: '89%' },
      { key: 'Network', value: 'Unlocked (all carriers)' },
    ],
  },
  {
    title: 'iPhone 13 Pro Max 256GB — Graphite',
    category: 'Mobile Phones',
    seller: 'arjun',
    price: 620,
    originalPrice: 899,
    brand: 'Apple',
    model: 'iPhone 13 Pro Max',
    condition: 'good',
    yearsUsed: 2,
    // Same image file as first listing — CASE 1: exact duplicate (pHash hit expected)
    image: 'iphone-13-midnight.jpg',
    description:
      'iPhone 13 Pro Max with 256GB storage in graphite. ProMotion 120Hz display, triple-lens camera system. Battery health 85%. Includes the original box. Ships fast.',
    specs: [
      { key: 'Storage', value: '256GB' },
      { key: 'Color', value: 'Graphite' },
      { key: 'Battery Health', value: '85%' },
    ],
  },
  {
    title: 'MacBook Pro 14" M1 Pro — 16GB / 1TB',
    category: 'Computers & Laptops',
    seller: 'meera',
    price: 1450,
    originalPrice: 2199,
    brand: 'Apple',
    model: 'MacBook Pro 14"',
    condition: 'like-new',
    yearsUsed: 1,
    image: 'macbook-pro-14.jpg',
    description:
      'MacBook Pro 14-inch with the M1 Pro chip, 16GB unified memory and a 1TB SSD. 96% design battery capacity. Purchased last year for freelance video work, barely travelled. Comes with the original 96W MagSafe charger. Unboxed this week for photos only.',
    specs: [
      { key: 'Processor', value: 'Apple M1 Pro' },
      { key: 'RAM', value: '16GB' },
      { key: 'Storage', value: '1TB SSD' },
      { key: 'Battery Cycles', value: '61' },
    ],
  },
  {
    title: 'Sony WH-1000XM4 Wireless Headphones',
    category: 'Electronics',
    seller: 'meera',
    price: 210,
    originalPrice: 349,
    brand: 'Sony',
    model: 'WH-1000XM4',
    condition: 'like-new',
    yearsUsed: 1,
    image: 'sony-wh1000xm4.jpg',
    description:
      'Industry-leading noise-cancelling headphones. 30-hour battery life, multipoint pairing, and superb call quality. Used indoors only, comes with the carry case, both cables and the airline adapter. Genuine reason for sale — I was given AirPods Max as a gift.',
    specs: [
      { key: 'Type', value: 'Over-ear wireless' },
      { key: 'Battery Life', value: '30 hours' },
      { key: 'ANC', value: 'Yes' },
    ],
  },
  {
    title: 'Nike Air Force 1 — White, US Size 10',
    category: 'Fashion',
    seller: 'priya',
    price: 65,
    originalPrice: 120,
    brand: 'Nike',
    model: 'Air Force 1',
    condition: 'good',
    yearsUsed: 2,
    image: 'nike-af1-white.jpg',
    description:
      'Classic white Air Force 1s, US size 10. Worn for a season, still plenty of life left. Cleaned and wiped before listing. Minor creasing on the toe box as expected. Original box included.',
    specs: [
      { key: 'Size', value: 'US 10' },
      { key: 'Color', value: 'White' },
    ],
  },
  {
    title: "Women's Leather Jacket — Camel, Size M",
    category: 'Fashion',
    seller: 'meera',
    price: 120,
    originalPrice: 260,
    brand: 'Everlane',
    condition: 'good',
    yearsUsed: 3,
    image: 'leather-jacket-camel.jpg',
    description:
      'Genuine leather jacket in a warm camel tone, size medium. Broke in beautifully — soft and comfortable. Zips all work, lining is intact. A couple of light surface scuffs give it character.',
    specs: [
      { key: 'Material', value: 'Genuine leather' },
      { key: 'Size', value: 'M' },
    ],
  },
  {
    title: 'Modern LED Desk Lamp with USB Charging',
    category: 'Home & Garden',
    seller: 'priya',
    price: 28,
    originalPrice: 60,
    brand: 'BenQ',
    model: 'e-Reading',
    condition: 'good',
    yearsUsed: 2,
    image: 'desk-lamp-led.jpg',
    description:
      'Reading lamp with 21 brightness levels and a USB-A port for charging your phone. Great for late-night work. Priced to move.',
    specs: [
      { key: 'Bulb', value: 'LED (included)' },
      { key: 'Extras', value: 'USB charging port' },
    ],
  },
  {
    title: 'Ergonomic Office Chair — High-back Mesh',
    category: 'Home & Garden',
    seller: 'meera',
    price: 180,
    originalPrice: 350,
    brand: 'HON',
    model: 'Ignition',
    condition: 'good',
    yearsUsed: 2,
    image: 'office-chair-mesh.jpg',
    description:
      'High-back mesh office chair with adjustable lumbar support, tilt tension control, and armrests. In very good mechanical shape — all adjustments work smoothly. Selling due to a move to a standing desk.',
    specs: [
      { key: 'Type', value: 'High-back mesh' },
      { key: 'Lumbar', value: 'Adjustable' },
    ],
  },
  {
    title: 'Adjustable Dumbbells — Pair (5–24 kg)',
    category: 'Sports & Outdoors',
    seller: 'priya',
    price: 240,
    originalPrice: 399,
    brand: 'Bowflex',
    model: 'SelectTech 552',
    condition: 'like-new',
    yearsUsed: 1,
    image: 'dumbbells-pair.jpg',
    description:
      'Pair of adjustable dumbbells spanning 5 to 24 kg each — replaces 15 sets of fixed dumbbells. Used for six months, stored on the rack, everything clicks and locks perfectly. Heavy, so local pickup preferred.',
    specs: [
      { key: 'Weight Range', value: '5–24 kg per dumbbell' },
      { key: 'Includes', value: 'Storage tray' },
    ],
  },
  {
    title: 'Home Office Desk — Scandinavian Oak',
    category: 'Home & Garden',
    seller: 'priya',
    price: 150,
    originalPrice: 300,
    brand: 'IKEA',
    model: 'Alex',
    condition: 'good',
    yearsUsed: 3,
    image: 'office-desk-oak.jpg',
    description:
      '120cm oak-look desk with two drawers and a cable-management tray. Sturdy, no wobble. Some faint ring marks from mugs — cosmetic only. Buyer collects from our apartment building lobby.',
    specs: [
      { key: 'Dimensions', value: '120 x 60 cm' },
      { key: 'Drawers', value: '2' },
    ],
  },
  {
    title: 'Harry Potter Series — All 7 Paperback Books',
    category: 'Books & Media',
    seller: 'arjun',
    price: 45,
    originalPrice: 90,
    brand: 'Bloomsbury',
    condition: 'good',
    yearsUsed: 5,
    image: 'harry-potter-books.jpg',
    description:
      'Complete seven-book run of the Harry Potter series in paperback. Kept on a shelf, spines unbroken, no underlining or dog-ears. Selling as a set — not splitting.',
    specs: [
      { key: 'Format', value: 'Paperback' },
      { key: 'Books', value: '7' },
    ],
  },
  {
    title: 'Apple Watch SE 44mm — GPS, Silver',
    category: 'Electronics',
    seller: 'arjun',
    price: 160,
    originalPrice: 279,
    brand: 'Apple',
    model: 'Watch SE 44mm',
    condition: 'good',
    yearsUsed: 1,
    image: 'apple-watch-se.jpg',
    description:
      'Apple Watch SE 44mm GPS in silver with the sport band. Battery still lasts a full day. Screen is clean, no cracks. Includes the magnetic charging cable. Great first smartwatch.',
    specs: [
      { key: 'Size', value: '44mm' },
      { key: 'Connectivity', value: 'GPS (no cellular)' },
    ],
  },
];

// ── DEMO DUPLICATE DETECTION LISTINGS ─────────────────────────────────────────
// These are 7 extra listings that cover fraud-detection cases 2–5.
// See Task 2 — each description includes one line explaining what it demonstrates.
// Case 1 (exact pHash duplicate) uses products[0] & products[1] above (iphone-13-midnight.jpg shared).
// Cases 2, 3, 4 (image/identity signals) and Case 5 (scam-text pattern signals)
// are added below. Case 6 (listing-velocity burst) is optional — see
// BURST_PRODUCTS and the --with-burst flag.

const DEMO_PRODUCTS = [
  // CASE 2A — re-photographed variant: 5% crop + brightness 1.1 + JPEG q70 applied by Sharp at seed time.
  // Expected: CNN/CLIP supporting signal only. NOT high risk — demonstrates "visual similarity alone never proves fraud."
  {
    title: '[DEMO] Samsung Galaxy S22 Ultra — Re-photo Variant',
    category: 'Mobile Phones',
    seller: 'arjun',
    price: 480,
    originalPrice: 799,
    brand: 'Samsung',
    model: 'Galaxy S22 Ultra',
    condition: 'good',
    yearsUsed: 1,
    image: 'iphone-13-midnight.jpg',
    imageTransform: 'rephotograph', // 5% crop + brightness 1.1 + q70
    description:
      '[DEMO CASE 2] Same product category but photographed differently — demonstrates that visual similarity (CNN/CLIP) alone never flags as high risk; only pHash exact match triggers the +35 duplicate penalty.',
    specs: [{ key: 'DEMO', value: 'Case 2 — re-photographed variant' }],
  },
  // CASE 2B — second listing for Case 2 demo (different seller of same product category)
  {
    title: '[DEMO] iPhone 13 — Different Angle Shot',
    category: 'Mobile Phones',
    seller: 'meera',
    price: 490,
    originalPrice: 799,
    brand: 'Apple',
    model: 'iPhone 13',
    condition: 'good',
    yearsUsed: 1,
    image: 'iphone-demo-case2.jpg',
    description:
      '[DEMO CASE 2] Distinct photo of same product category from different seller — CNN/CLIP may show visual similarity; expected riskLevel: low to medium (supporting signal only, no pHash hit).',
    specs: [{ key: 'DEMO', value: 'Case 2 — separate angle listing' }],
  },
  // CASE 3A — legitimate same-category sneakers (Adidas — distinct photo)
  {
    title: '[DEMO] Adidas Ultraboost 22 — Black, US 9',
    category: 'Fashion',
    seller: 'priya',
    price: 80,
    originalPrice: 180,
    brand: 'Adidas',
    model: 'Ultraboost 22',
    condition: 'good',
    yearsUsed: 1,
    image: 'sneakers-demo-case3a.jpg',
    description:
      '[DEMO CASE 3] Distinct Adidas sneakers — same category as Nike AF1 but entirely different brand/photo. Expect ZERO duplicate signals: proves legitimate same-category sellers are not penalised.',
    specs: [{ key: 'DEMO', value: 'Case 3 — legitimate same-category seller A' }],
  },
  // CASE 3B — second legitimate same-category sneaker listing
  {
    title: '[DEMO] New Balance 550 — White/Green, US 10',
    category: 'Fashion',
    seller: 'arjun',
    price: 90,
    originalPrice: 150,
    brand: 'New Balance',
    model: '550',
    condition: 'like-new',
    yearsUsed: 0,
    image: 'sneakers-demo-case3b.jpg',
    description:
      '[DEMO CASE 3] Distinct New Balance sneakers from different seller — same category, different photo, different brand. Expect zero duplicate signals.',
    specs: [{ key: 'DEMO', value: 'Case 3 — legitimate same-category seller B' }],
  },
  // CASE 4 — mirror-flipped version of Case 1 image. Expect mirror-hash detection.
  {
    title: '[DEMO] iPhone 13 — Mirrored Listing',
    category: 'Mobile Phones',
    seller: 'meera',
    price: 510,
    originalPrice: 799,
    brand: 'Apple',
    model: 'iPhone 13',
    condition: 'good',
    yearsUsed: 1,
    image: 'iphone-13-midnight.jpg',
    imageTransform: 'mirror', // Sharp flop() applied at seed time
    description:
      '[DEMO CASE 4] Mirror-flipped (horizontally) version of the CASE 1 iPhone image — demonstrates that mirrorPerceptualHash detects the flop() evasion: the stored mirrorHash of Case 1 matches the pHash of this listing.',
    specs: [{ key: 'DEMO', value: 'Case 4 — mirror-hash detection' }],
  },
  // CASE 5 — scam-text template: off-platform contact + urgency clichés. The
  // description is a keyword/regex demo, NOT a trained model (see README §7.10).
  // Expected text-scam signals (capped at +25 total):
  //   SUSPICIOUS_CONTACT_INFO (phone + email + WhatsApp) +10
  //   URGENCY_PRESSURE_PHRASES (>=4 clichés) +15
  //   EXCESSIVE_PUNCTUATION (>5 exclamation marks) +5
  //   LOWBALL_URGENCY_COMBO ("urgent" + price < 40% of original) +15
  // Served from a distinct re-photographed image so no pHash duplicate fires.
  {
    title: '[DEMO] iPhone 13 Pro — CASE 5 URGENT SALE!!!',
    category: 'Mobile Phones',
    seller: 'meera',
    price: 4000,
    originalPrice: 12000,
    brand: 'Apple',
    model: 'iPhone 13 Pro',
    condition: 'fair',
    yearsUsed: 2,
    image: 'dumbbells-pair.jpg',
    imageTransform: 'rephotograph',
    description:
      "[DEMO CASE 5] URGENT SALE need cash today!!! Moving abroad next week, this is the last date. Advance payment only — don't miss this, guaranteed lowest price, trust me!!! WhatsApp me on 9876543210 or email quickcash@example.com to pay advance. Calling is fine too: 9876543210.",
    specs: [{ key: 'DEMO', value: 'Case 5 — scam-text pattern signals' }],
  },
];

// ── OPTIONAL: LISTING-VELOCITY (BURST) DEMO — CASE 6 ─────────────────────────
// Created only with `--with-burst`. Five rapid listings from arjun's five-day-old
// account push his last-24h listing count to >= 5, so the listing-velocity
// signal (LISTING_BURST_NEW_ACCOUNT, +15) fires. The default seed deliberately
// stays below the threshold (arjun has 4 other listings, not 5) so a plain
// `node scripts/seed.js` shows no velocity signal. The burst listings live in
// "Toys & Games" (no other listings) with distinct images, so no pHash
// duplicate fires — the velocity signal is the only thing demonstrated.
const BURST_PRODUCTS = [
  {
    title: '[DEMO] CASE 6 Burst Listing 1 — Wooden Puzzle Set',
    category: 'Toys & Games',
    seller: 'arjun',
    price: 18,
    originalPrice: 40,
    brand: 'Melissa & Doug',
    condition: 'good',
    yearsUsed: 1,
    image: 'desk-lamp-led.jpg',
    description:
      'Fifty-piece wooden puzzle set for toddlers in an animal theme. Every piece is present and the box only shows light shelf wear.',
    specs: [{ key: 'DEMO', value: 'Case 6 — listing-velocity burst' }],
  },
  {
    title: '[DEMO] CASE 6 Burst Listing 2 — Magnetic Building Tiles',
    category: 'Toys & Games',
    seller: 'arjun',
    price: 26,
    originalPrice: 55,
    brand: 'Magna-Tiles',
    condition: 'like-new',
    yearsUsed: 1,
    image: 'office-chair-mesh.jpg',
    description:
      'Set of one hundred translucent magnetic building tiles. Cleaned and boxed, no missing magnets or cracked corners.',
    specs: [{ key: 'DEMO', value: 'Case 6 — listing-velocity burst' }],
  },
  {
    title: '[DEMO] CASE 6 Burst Listing 3 — Remote Control Car',
    category: 'Toys & Games',
    seller: 'arjun',
    price: 34,
    originalPrice: 70,
    brand: 'Traxxas',
    condition: 'good',
    yearsUsed: 2,
    image: 'dumbbells-pair.jpg',
    description:
      'Hobby-grade remote control buggy with a spare battery pack. Runs smoothly; the shell has minor scuffs from outdoor use.',
    specs: [{ key: 'DEMO', value: 'Case 6 — listing-velocity burst' }],
  },
  {
    title: '[DEMO] CASE 6 Burst Listing 4 — Board Game Bundle',
    category: 'Toys & Games',
    seller: 'arjun',
    price: 40,
    originalPrice: 85,
    brand: 'Asmodee',
    condition: 'good',
    yearsUsed: 2,
    image: 'harry-potter-books.jpg',
    description:
      'Bundle of three family strategy board games with all cards and tokens counted and complete. Rulebooks included.',
    specs: [{ key: 'DEMO', value: 'Case 6 — listing-velocity burst' }],
  },
  {
    title: '[DEMO] CASE 6 Burst Listing 5 — Plush Teddy Collection',
    category: 'Toys & Games',
    seller: 'arjun',
    price: 22,
    originalPrice: 50,
    brand: 'Gund',
    condition: 'like-new',
    yearsUsed: 0,
    image: 'sony-wh1000xm4.jpg',
    description:
      'Collection of four soft plush teddy bears in assorted sizes. Washed, odour-free, and stored in a smoke-free home.',
    specs: [{ key: 'DEMO', value: 'Case 6 — listing-velocity burst' }],
  },
];

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Load a real image from IMAGES_DIR, optionally apply a transform, resize to
 * max 1200px and return the JPEG buffer.
 */
const loadImage = async (filename, transform) => {
  const filePath = path.join(IMAGES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Seed image not found: ${filePath}. Run: node backend/scripts/download-seed-images.js`);
  }
  let pipeline = sharp(fs.readFileSync(filePath));

  if (transform === 'mirror') {
    // Case 4 — horizontal flip to test mirror-hash detection
    pipeline = pipeline.flop();
  } else if (transform === 'rephotograph') {
    // Case 2 — simulate re-photographed: 5% crop + brightness 1.1 + JPEG q70
    const meta = await sharp(fs.readFileSync(filePath)).metadata();
    const w = meta.width || 1200;
    const h = meta.height || 1200;
    const cropW = Math.round(w * 0.95);
    const cropH = Math.round(h * 0.95);
    const left = Math.round((w - cropW) / 2);
    const top = Math.round((h - cropH) / 2);
    pipeline = pipeline
      .extract({ left, top, width: cropW, height: cropH })
      .modulate({ brightness: 1.1 });
  }

  return pipeline
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: transform === 'rephotograph' ? 70 : 80 })
    .toBuffer();
};

const buildProductDoc = (tpl, userId, categoryId, imageInfo, hash, mirrorHash, now) => {
  return {
    title: tpl.title,
    description: tpl.description,
    price: tpl.price,
    originalPrice: tpl.originalPrice || 0,
    category: categoryId,
    brand: tpl.brand || '',
    model: tpl.model || '',
    condition: tpl.condition,
    yearsUsed: tpl.yearsUsed || 0,
    specifications: tpl.specs || [],
    location: { city: 'Bengaluru', state: 'KA', country: 'India' },
    images: [
      {
        url: imageInfo.url,
        publicId: `seed_${slugify(tpl.title)}`,
        isPrimary: true,
        perceptualHash: hash,
      },
    ],
    seller: userId,
    status: 'active',
    views: 12 + ((tpl.title.length * 7) % 130),
    favoritesCount: 1 + (tpl.title.length % 6),
    aiAnalysis: {
      classification: { predictedCategory: tpl.category, confidence: 0.88 },
      conditionScore: tpl.condition === 'like-new' ? 92 : 78,
      damageScore: tpl.condition === 'like-new' ? 4 : 18,
      damageLevel: tpl.condition === 'like-new' ? 'low' : 'medium',
      imageHashes: [hash, mirrorHash],
      priceRecommendation: {
        recommendedPrice: Math.round(tpl.price * 0.97),
        minPrice: Math.round(tpl.price * 0.82),
        maxPrice: Math.round(tpl.price * 1.12),
        confidence: 0.8,
        explanation: `Depreciation + condition adjustment for ${tpl.condition} ${tpl.title}.`,
        factors: [
          `MSRP ${tpl.originalPrice || 0}`,
          `Asking ${tpl.price}`,
          `${tpl.yearsUsed || 0} year(s) used`,
        ],
        source: 'heuristic',
      },
      riskAssessment: {
        riskScore: 0,
        riskLevel: 'low',
        factors: [],
        assessedAt: now,
      },
      lastAnalyzedAt: now,
    },
  };
};

const seed = async () => {
  if (!process.env.MONGODB_URI) {
    console.error('[Seed] MONGODB_URI not set — create backend/.env (see backend/.env.example).');
    process.exit(1);
  }

  // Ensure seed images exist
  if (!fs.existsSync(IMAGES_DIR)) {
    console.error('[Seed] Seed images directory not found. Run: node backend/scripts/download-seed-images.js');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[Seed] Connected to MongoDB');

  const existingUsers = await User.countDocuments();
  const force = process.argv.includes('--force');
  if (existingUsers > 0) {
    if (!force) {
      console.log('[Seed] Demo data already exists. Pass --force to reseed');
      await mongoose.disconnect();
      process.exit(0);
    }
    console.log('[Seed] --force: wiping demo-managed collections');
  }

  const managed = [
    User, Category, Product, Sale, Review, Offer, Conversation, Message,
    Notification, ImageUploadRecord,
  ];
  await Promise.all(managed.map((M) => M.deleteMany({})));
  console.log('[Seed] Cleaned collections');

  const now = Date.now();

  const admin = await User.create({
    name: 'Admin',
    email: 'admin@resell.dev',
    password: PASSWORD,
    role: 'admin',
    isVerified: true,
    location: 'Bengaluru',
  });

  const priya = await User.create({
    name: 'Priya Nair',
    email: 'priya@resell.dev',
    password: PASSWORD,
    role: 'seller',
    bio: 'Tech and home-goods reseller — everything I list is clean, tested and fairly priced.',
    location: 'Bengaluru',
    isVerified: true,
    averageResponseMinutes: 18,
  });

  const arjun = await User.create({
    name: 'Arjun Mehta',
    email: 'arjun@resell.dev',
    password: PASSWORD,
    role: 'seller',
    location: 'Bengaluru',
    averageResponseMinutes: 320,
  });

  const meera = await User.create({
    name: 'Meera Iyer',
    email: 'meera@resell.dev',
    password: PASSWORD,
    role: 'buyer',
    location: 'Mumbai',
    isVerified: true,
    averageResponseMinutes: 45,
  });

  await User.collection.updateOne({ _id: priya._id }, { $set: { createdAt: new Date(now - 300 * DAY_MS) } });
  await User.collection.updateOne({ _id: arjun._id }, { $set: { createdAt: new Date(now - 5 * DAY_MS) } });
  await User.collection.updateOne({ _id: meera._id }, { $set: { createdAt: new Date(now - 200 * DAY_MS) } });
  const usersByName = { admin, priya, arjun, meera };
  console.log('[Seed] Users created');

  const categoriesByName = {};
  for (const c of CATEGORIES) {
    const cat = await Category.create({ ...c, slug: slugify(c.name) });
    categoriesByName[c.name] = cat;
  }
  console.log(`[Seed] Categories created (${CATEGORIES.length})`);

  // Load real images once per unique filename+transform combo
  const imageCache = {};
  const getCacheKey = (filename, transform) => filename + (transform ? ':' + transform : '');

  const withBurst = process.argv.includes('--with-burst');
  const allTemplates = withBurst
    ? [...PRODUCTS, ...DEMO_PRODUCTS, ...BURST_PRODUCTS]
    : [...PRODUCTS, ...DEMO_PRODUCTS];
  for (const tpl of allTemplates) {
    const key = getCacheKey(tpl.image, tpl.imageTransform);
    if (!imageCache[key]) {
      console.log(`[Seed] Loading image: ${key}`);
      imageCache[key] = await loadImage(tpl.image, tpl.imageTransform);
    }
  }

  // Create main products
  const products = [];
  for (let i = 0; i < PRODUCTS.length; i++) {
    const tpl = PRODUCTS[i];
    const key = getCacheKey(tpl.image, tpl.imageTransform);
    const buffer = imageCache[key];
    const hash = await perceptualHashFromBuffer(buffer);
    const mirrorHash = await mirrorPerceptualHashFromBuffer(buffer);
    const doc = buildProductDoc(
      tpl,
      usersByName[tpl.seller]._id,
      categoriesByName[tpl.category]._id,
      { url: `${BASE_URL}/public/seed-images/${tpl.image}` },
      hash,
      mirrorHash,
      new Date(now - i * 3600 * 1000)
    );
    const product = await Product.create(doc);
    products.push(product);
  }

  const iphone = products[0];
  const dupListing = products[1]; // Same image as iphone — CASE 1
  const priyaProducts = products.filter((p) => p.seller.equals(usersByName.priya._id));
  console.log(`[Seed] Main products created (${products.length}) — 2 share iphone-13-midnight.jpg (CASE 1)`);

  // Create DEMO products (cases 2, 3, 4)
  const demoProducts = [];
  for (let i = 0; i < DEMO_PRODUCTS.length; i++) {
    const tpl = DEMO_PRODUCTS[i];
    const key = getCacheKey(tpl.image, tpl.imageTransform);
    const buffer = imageCache[key];
    const hash = await perceptualHashFromBuffer(buffer);
    const mirrorHash = await mirrorPerceptualHashFromBuffer(buffer);
    // Mirror image filename suffix for serving
    const servedFilename = tpl.imageTransform
      ? `${tpl.image.replace('.jpg', '')}-${tpl.imageTransform}.jpg`
      : tpl.image;
    // Write transformed image to disk so it can be served
    if (tpl.imageTransform) {
      const destPath = path.join(IMAGES_DIR, servedFilename);
      if (!fs.existsSync(destPath)) {
        fs.writeFileSync(destPath, buffer);
        console.log(`[Seed] Written transformed image: ${servedFilename}`);
      }
    }
    const doc = buildProductDoc(
      tpl,
      usersByName[tpl.seller]._id,
      categoriesByName[tpl.category]._id,
      { url: `${BASE_URL}/public/seed-images/${servedFilename}` },
      hash,
      mirrorHash,
      new Date(now - (PRODUCTS.length + i) * 3600 * 1000)
    );
    const product = await Product.create(doc);
    demoProducts.push(product);
  }
  console.log(`[Seed] DEMO products created (${demoProducts.length}) — cases 2, 3, 4, 5`);

  // OPTIONAL Case 6 — listing-velocity burst (only with --with-burst).
  const burstProducts = [];
  if (withBurst) {
    for (let i = 0; i < BURST_PRODUCTS.length; i++) {
      const tpl = BURST_PRODUCTS[i];
      const key = getCacheKey(tpl.image, tpl.imageTransform);
      const buffer = imageCache[key];
      const hash = await perceptualHashFromBuffer(buffer);
      const mirrorHash = await mirrorPerceptualHashFromBuffer(buffer);
      const doc = buildProductDoc(
        tpl,
        usersByName[tpl.seller]._id,
        categoriesByName[tpl.category]._id,
        { url: `${BASE_URL}/public/seed-images/${tpl.image}` },
        hash,
        mirrorHash,
        new Date(now - (i + 1) * 60 * 1000) // within the last few minutes
      );
      const product = await Product.create(doc);
      burstProducts.push(product);
    }
    console.log(
      `[Seed] BURST demo products created (${burstProducts.length}) — CASE 6 (listing velocity)`
    );
  }

  // ── Sales (for priya trust score) ─────────────────────────────────────────
  const sales = [];
  const buyers = [arjun._id, meera._id, admin._id];
  for (let i = 0; i < 40; i++) {
    const product = priyaProducts[i % priyaProducts.length];
    const completedAt = new Date(now - (i + 1) * 9 * DAY_MS);
    const price = product.price - (i % 5) * 5;
    const sale = await Sale.create({
      product: product._id,
      seller: priya._id,
      buyer: buyers[i % buyers.length],
      salePrice: price,
      platformFee: Math.round(price * 0.05 * 100) / 100,
      netAmount: Math.round(price * 0.95 * 100) / 100,
      currencyCode: 'USD',
      status: 'completed',
      paymentStatus: 'paid',
      completedAt,
    });
    sales.push(sale);
  }
  console.log('[Seed] Created 40 sales for priya (trust-score sales component)');

  await Review.create([
    {
      seller: priya._id,
      buyer: meera._id,
      product: iphone._id,
      sale: sales[0]._id,
      rating: 5,
      comment: 'Exactly as described — spotless phone, fast to respond, met up the same day. Would buy from Priya again without a second thought.',
    },
    {
      seller: priya._id,
      buyer: arjun._id,
      product: priyaProducts[1]._id,
      sale: sales[1]._id,
      rating: 4,
      comment: 'Smooth transaction and the item was in great shape. Took a couple of days to reply to messages, but everything arrived as promised.',
    },
  ]);
  console.log('[Seed] Reviews created (2 verified reviews for priya)');

  const offer1 = await Offer.create({
    product: iphone._id,
    buyer: arjun._id,
    seller: priya._id,
    amount: 650,
    message: 'Would you take 650 for the iPhone 13?',
    status: 'countered',
    expiresAt: new Date(now + 6 * DAY_MS),
    history: [
      { status: 'pending', actor: arjun._id, at: new Date(now - 2 * DAY_MS), note: 'Initial offer' },
      { status: 'countered', actor: priya._id, at: new Date(now - 1 * DAY_MS), note: 'Countered with 700' },
    ],
  });
  const offer2 = await Offer.create({
    product: iphone._id,
    buyer: arjun._id,
    seller: priya._id,
    amount: 700,
    message: 'I can do 700 if the charger and box are included.',
    status: 'pending',
    parentOffer: offer1._id,
    expiresAt: new Date(now + 6 * DAY_MS),
    history: [
      { status: 'pending', actor: priya._id, at: new Date(now - 1 * DAY_MS), note: 'Counter-offer sent' },
    ],
  });
  console.log('[Seed] Offers created (650 countered → 700 pending)');

  const convo = await Conversation.create({
    participants: [priya._id, arjun._id],
    product: iphone._id,
    lastMessageAt: new Date(now - 2 * 3600 * 1000),
    unreadCounts: new Map([
      [priya._id.toString(), 3],
      [arjun._id.toString(), 0],
    ]),
  });
  const messages = [
    { sender: 'arjun', body: "Hi Priya! Is the iPhone 13 still available? I'm looking to gift one to my sister.", at: now - 26 * 3600 * 1000 },
    { sender: 'priya', body: 'Hey Arjun! Yes, it is. Battery health is at 89%, it comes with the original cable and the box.', at: now - 25 * 3600 * 1000 },
    { sender: 'arjun', body: 'Perfect. Would you consider 650? I can pick it up in person near Indiranagar.', at: now - 20 * 3600 * 1000 },
    { sender: 'priya', body: "I'd like to stay closer to 700 — it's genuinely pristine and I have another offer at 680.", at: now - 5 * 3600 * 1000 },
    { sender: 'arjun', body: 'Alright, 700 works for me. What time suits you this weekend to meet up?', at: now - 2 * 3600 * 1000 },
  ];
  const createdMessages = [];
  for (const m of messages) {
    const created = await Message.create({
      conversation: convo._id,
      sender: usersByName[m.sender]._id,
      content: m.body,
      type: 'text',
      status: 'read',
    });
    await Message.collection.updateOne({ _id: created._id }, { $set: { createdAt: new Date(m.at) } });
    createdMessages.push(created);
  }
  convo.lastMessage = createdMessages[createdMessages.length - 1]._id;
  await convo.save();
  console.log('[Seed] Conversation created (5 messages, priya ↔ arjun)');

  // ── Run detectRisk on all demo listings ────────────────────────────────────
  console.log('\n[Seed] Running detectRisk on duplicate-demo listings...');
  const allDemoAndDup = [dupListing, ...demoProducts, ...burstProducts];
  const riskTable = [];

  for (const listing of allDemoAndDup) {
    const freshDoc = await Product.findById(listing._id).lean();
    const risk = await detectRisk({
      product: freshDoc,
      hashes: freshDoc.aiAnalysis.imageHashes,
      aiAnalysis: freshDoc.aiAnalysis,
    });
    await Product.updateOne(
      { _id: listing._id },
      {
        $set: {
          'aiAnalysis.riskAssessment': {
            riskScore: risk.riskScore,
            riskLevel: risk.riskLevel,
            factors: risk.factors,
            riskFactorCategories: risk.riskFactorCategories,
            v1RiskScore: risk.riskScore,
            fusionMode: 'v1',
            assessedAt: new Date(),
          },
        },
      }
    );
    const caseLabel = listing._id.equals(dupListing._id)
      ? 'CASE 1'
      : freshDoc.title.match(/CASE (\d)/)?.[0] || '?';
    riskTable.push({
      case: caseLabel,
      title: freshDoc.title.substring(0, 45),
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      factors: risk.factors.join('; ') || '(none)',
    });
  }

  console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║         DUPLICATE DETECTION DEMO — Risk Assessment Table                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');

  // Note about Redis requirement
  const redisAvailable = await (async () => {
    try {
      const { connection } = require('../src/queues');
      if (connection && connection.status === 'ready') return true;
    } catch {}
    return false;
  })();

  if (!redisAvailable) {
    console.log('⚠  NOTE: Redis/BullMQ workers are NOT running. The riskScore below is from');
    console.log('   detectRisk() (pHash + pricing heuristics). Full CNN/CLIP signals require');
    console.log('   the imageProcessor worker (npm run worker) with Redis.\n');
  }

  console.log('Case     | Title                                          | Score | Level  | Factors fired');
  console.log('---------|------------------------------------------------|-------|--------|------------------');
  for (const row of riskTable) {
    const c = row.case.padEnd(8);
    const t = row.title.substring(0, 46).padEnd(46);
    const s = String(row.riskScore).padEnd(5);
    const l = row.riskLevel.padEnd(6);
    console.log(`${c} | ${t} | ${s} | ${l} | ${row.factors.substring(0, 60)}`);
  }
  console.log('');

  console.log('\n[Seed] Done! Demo credentials (password for all users):');
  console.log('  ' + PASSWORD);
  console.log('──────────────────────────────────────────────');
  for (const [name, u] of Object.entries(usersByName)) {
    console.log(`  ${name.padEnd(6)} ${u.email.padEnd(22)} ${u.role}`);
  }
  console.log('──────────────────────────────────────────────');
  console.log(`[Seed] Real product images served from ${IMAGES_DIR}`);

  await mongoose.disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error('[Seed] Error:', err);
  process.exit(1);
});
