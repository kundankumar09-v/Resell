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
    colors: ['#3b82f6', '#1e3a8a'],
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
    image: 'iphone-13-midnight.jpg',
    colors: ['#6366f1', '#0f172a'],
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
    colors: ['#64748b', '#0f172a'],
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
    colors: ['#0f766e', '#134e4a'],
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
    colors: ['#f8fafc', '#94a3b8'],
    description:
      'Classic white Air Force 1s, US size 10. Worn for a season, still plenty of life left. Cleaned and wiped before listing. Minor creasing on the toe box as expected. Original box included.',
    specs: [
      { key: 'Size', value: 'US 10' },
      { key: 'Color', value: 'White' },
    ],
  },
  {
    title: 'Women’s Leather Jacket — Camel, Size M',
    category: 'Fashion',
    seller: 'meera',
    price: 120,
    originalPrice: 260,
    brand: 'Everlane',
    condition: 'good',
    yearsUsed: 3,
    image: 'leather-jacket-camel.jpg',
    colors: ['#b45309', '#78350f'],
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
    colors: ['#0ea5e9', '#082f49'],
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
    colors: ['#475569', '#1e293b'],
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
    colors: ['#334155', '#b91c1c'],
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
    colors: ['#d6b470', '#92400e'],
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
    colors: ['#f59e0b', '#451a03'],
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
    colors: ['#cbd5e1', '#475569'],
    description:
      'Apple Watch SE 44mm GPS in silver with the sport band. Battery still lasts a full day. Screen is clean, no cracks. Includes the magnetic charging cable. Great first smartwatch.',
    specs: [
      { key: 'Size', value: '44mm' },
      { key: 'Connectivity', value: 'GPS (no cellular)' },
    ],
  },
];

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const escapeXml = (str) =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const makePlaceholderImage = async ({ filename, title, colors }) => {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const [c0, c1] = colors;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${c0}"/>
          <stop offset="100%" stop-color="${c1}"/>
        </linearGradient>
      </defs>
      <rect width="640" height="480" fill="url(#g)"/>
      <circle cx="560" cy="80" r="90" fill="rgba(255,255,255,0.12)"/>
      <circle cx="60" cy="420" r="70" fill="rgba(255,255,255,0.10)"/>
      <text x="320" y="215" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
            font-size="40" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>
      <text x="320" y="265" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
            font-size="20" fill="rgba(255,255,255,0.85)">ReSell demo listing image</text>
    </svg>`;
  const buffer = await sharp(Buffer.from(svg))
    .resize(640, 480)
    .jpeg({ quality: 88 })
    .toBuffer();
  fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);
  return buffer;
};

const buildProductDoc = (tpl, userId, categoryId, imageInfo, hash, mirrorHash, now) => {
  return {
    title: tpl.title,
    description: tpl.description,
    price: tpl.price,
    originalPrice: tpl.originalPrice,
    category: categoryId,
    brand: tpl.brand,
    model: tpl.model,
    condition: tpl.condition,
    yearsUsed: tpl.yearsUsed,
    specifications: tpl.specs,
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
        factors: [`MSRP ${tpl.originalPrice}`, `Asking ${tpl.price}`, `${tpl.yearsUsed} year(s) used`],
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

  const generatedImages = {};
  for (const tpl of PRODUCTS) {
    if (!generatedImages[tpl.image]) {
      const buffer = await makePlaceholderImage({
        filename: tpl.image,
        title: tpl.title.split('—')[0].trim(),
        colors: tpl.colors,
      });
      generatedImages[tpl.image] = buffer;
    }
  }

  const products = [];
  for (let i = 0; i < PRODUCTS.length; i++) {
    const tpl = PRODUCTS[i];
    const buffer = generatedImages[tpl.image];
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
  const dupListing = products[1];
  const priyaProducts = products.filter((p) => p.seller.equals(usersByName.priya._id));
  console.log(`[Seed] Products created (${products.length}) — 2 share iphone-13-midnight.jpg`);

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

  const dupDoc = await Product.findById(dupListing._id).lean();
  const risk = await detectRisk({
    product: dupDoc,
    hashes: dupDoc.aiAnalysis.imageHashes,
    aiAnalysis: dupDoc.aiAnalysis,
  });
  await Product.updateOne(
    { _id: dupListing._id },
    {
      $set: {
        'aiAnalysis.riskAssessment': {
          riskScore: risk.riskScore,
          riskLevel: risk.riskLevel,
          factors: risk.factors,
          assessedAt: new Date(),
        },
      },
    }
  );
  console.log(`[Seed] Duplicate-flag listing scored by detectRisk() → risk ${risk.riskScore} (${risk.riskLevel})`);

  console.log('\n[Seed] Done! Demo credentials (password for all users):');
  console.log('  ' + PASSWORD);
  console.log('──────────────────────────────────────────────');
  for (const [name, u] of Object.entries(usersByName)) {
    console.log(`  ${name.padEnd(6)} ${u.email.padEnd(22)} ${u.role}`);
  }
  console.log('──────────────────────────────────────────────');
  console.log(`[Seed] Seed images written to ${IMAGES_DIR}`);

  await mongoose.disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error('[Seed] Error:', err);
  process.exit(1);
});