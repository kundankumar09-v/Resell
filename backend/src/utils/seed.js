/* eslint-disable no-console */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Review = require('../models/Review');
const Sale = require('../models/Sale');

const crypto = require('crypto');

async function seedDuplicateFixtures(sellers, categories, users) {
  const { generateFixtures, computeHashes, writeReport } = require('./generateFixtures');
  const { uploadToCloudinary, isConfigured: isCloudinaryConfigured } = require('../config/cloudinary');
  const { perceptualHashFromBuffer } = require('../services/imageHash');
  const path = require('path');

  console.log('\n[Seed] ── Duplicate Fixture Seeding ──');

  // 1. Download + transform images
  const fixtures = await generateFixtures();

  // 2. Compute hashes
  const hashed = await computeHashes(fixtures);

  // 3. Write report
  const reportPath = path.join(__dirname, '../../duplicate-fixture-report.json');
  const report = writeReport(hashed, reportPath);

  // 4. Upload originals to Cloudinary (if configured) or use placeholder URLs
  const cloudinaryAvailable = isCloudinaryConfigured();
  if (!cloudinaryAvailable) {
    console.log('[Seed] Cloudinary not configured — using local buffer metadata as image URLs (hashes still computed from real image data)');
  }

  const fixtureSeller = sellers[0];
  const fixtureProducts = [];

  // Seed original images as products
  for (const img of hashed.originals) {
    let imageUrl = `fixture://originals/${img.id}`;
    let publicId = `fixture_original_${img.id}`;

    if (cloudinaryAvailable) {
      try {
        const uploaded = await uploadToCloudinary(img.buffer, 'resell/fixtures');
        imageUrl = uploaded.url;
        publicId = uploaded.publicId;
      } catch (err) {
        console.warn(`[Seed] Cloudinary upload failed for ${img.id}: ${err.message}`);
      }
    }

    const category = categories.find((c) => c.name === img.category);
    const product = await Product.create({
      title: `[FIXTURE] ${img.title}`,
      description: `Duplicate detection fixture: original image for ${img.id}. Hash: ${img.hash}`,
      price: 100,
      originalPrice: 200,
      category: category ? category._id : categories[0]._id,
      brand: 'Fixture',
      condition: 'like-new',
      yearsUsed: 1,
      location: { city: 'Testville', state: 'TS', country: 'USA' },
      images: [{ url: imageUrl, publicId, isPrimary: true }],
      seller: fixtureSeller._id,
      status: 'active',
      aiAnalysis: {
        classification: { predictedCategory: img.category, confidence: 1.0 },
        conditionScore: 90,
        damageScore: 5,
        imageHashes: [img.hash],
        priceRecommendation: { recommendedPrice: 100, minPrice: 85, maxPrice: 115, confidence: 1.0, explanation: 'Fixture', factors: [], source: 'heuristic' },
        riskAssessment: { riskScore: 0, riskLevel: 'low', factors: [] },
        lastAnalyzedAt: new Date(),
      },
    });
    fixtureProducts.push({ ...product.toObject(), _fixtureGroup: 'original', _fixtureHash: img.hash });
  }

  // Seed variant images (true-duplicates)
  for (const v of hashed.variants) {
    let imageUrl = `fixture://variants/${v.originalId}_${v.type}`;
    let publicId = `fixture_variant_${v.originalId}_${v.type.replace(/[^a-z0-9]/g, '_')}`;

    if (cloudinaryAvailable) {
      try {
        const uploaded = await uploadToCloudinary(v.buffer, 'resell/fixtures');
        imageUrl = uploaded.url;
        publicId = uploaded.publicId;
      } catch (err) {
        console.warn(`[Seed] Cloudinary upload failed for variant ${v.originalId}/${v.type}: ${err.message}`);
      }
    }

    const category = categories.find((c) => c.name === v.category);
    const product = await Product.create({
      title: `[FIXTURE-VARIANT] ${v.originalTitle} (${v.type})`,
      description: `Duplicate detection fixture: ${v.type} variant of ${v.originalId}. Hash: ${v.hash}`,
      price: 90,
      originalPrice: 200,
      category: category ? category._id : categories[0]._id,
      brand: 'Fixture',
      condition: 'like-new',
      yearsUsed: 1,
      location: { city: 'Testville', state: 'TS', country: 'USA' },
      images: [{ url: imageUrl, publicId, isPrimary: true }],
      seller: fixtureSeller._id,
      status: 'active',
      aiAnalysis: {
        classification: { predictedCategory: v.category, confidence: 1.0 },
        conditionScore: 90,
        damageScore: 5,
        imageHashes: [v.hash],
        priceRecommendation: { recommendedPrice: 90, minPrice: 76, maxPrice: 104, confidence: 1.0, explanation: 'Fixture variant', factors: [], source: 'heuristic' },
        riskAssessment: { riskScore: 0, riskLevel: 'low', factors: [] },
        lastAnalyzedAt: new Date(),
      },
    });
    fixtureProducts.push({ ...product.toObject(), _fixtureGroup: 'true-duplicate', _fixtureHash: v.hash, _fixtureOriginalId: v.originalId, _fixtureVariantType: v.type });
  }

  // Seed similar-but-different images
  for (const s of hashed.similarPairs) {
    let imageUrl = `fixture://similar/${s.id}`;
    let publicId = `fixture_similar_${s.id}`;

    if (cloudinaryAvailable) {
      try {
        const uploaded = await uploadToCloudinary(s.buffer, 'resell/fixtures');
        imageUrl = uploaded.url;
        publicId = uploaded.publicId;
      } catch (err) {
        console.warn(`[Seed] Cloudinary upload failed for similar ${s.id}: ${err.message}`);
      }
    }

    const category = categories.find((c) => c.name === s.category);
    const product = await Product.create({
      title: `[FIXTURE-SIMILAR] ${s.title}`,
      description: `Duplicate detection fixture: similar-but-different image ${s.id}. Hash: ${s.hash}`,
      price: 100,
      originalPrice: 200,
      category: category ? category._id : categories[0]._id,
      brand: 'Fixture',
      condition: 'like-new',
      yearsUsed: 1,
      location: { city: 'Testville', state: 'TS', country: 'USA' },
      images: [{ url: imageUrl, publicId, isPrimary: true }],
      seller: fixtureSeller._id,
      status: 'active',
      aiAnalysis: {
        classification: { predictedCategory: s.category, confidence: 1.0 },
        conditionScore: 90,
        damageScore: 5,
        imageHashes: [s.hash],
        priceRecommendation: { recommendedPrice: 100, minPrice: 85, maxPrice: 115, confidence: 1.0, explanation: 'Fixture similar pair', factors: [], source: 'heuristic' },
        riskAssessment: { riskScore: 0, riskLevel: 'low', factors: [] },
        lastAnalyzedAt: new Date(),
      },
    });
    fixtureProducts.push({ ...product.toObject(), _fixtureGroup: 'similar-but-duplicate', _fixtureHash: s.hash, _fixturePairGroup: s.pairGroup });
  }

  console.log(`[Seed] Created ${fixtureProducts.length} fixture products`);
  console.log(`[Seed] Fixture report: ${reportPath}`);

  // Print hash summary
  console.log('\n[Seed] Hash Summary:');
  console.log('  Originals:');
  for (const img of hashed.originals) {
    console.log(`    ${img.id.padEnd(14)} ${img.hash}`);
  }
  console.log('  Variants:');
  for (const v of hashed.variants) {
    console.log(`    ${v.originalId}/${v.type.padEnd(30)} ${v.hash}`);
  }
  console.log('  Similar-but-different:');
  for (const s of hashed.similarPairs) {
    console.log(`    ${s.id.padEnd(14)} ${s.hash}`);
  }
}

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[Seed] Connected to MongoDB');

    // Clean
    await Promise.all([
      User.deleteMany({}),
      Category.deleteMany({}),
      Product.deleteMany({}),
      Review.deleteMany({}),
      Sale.deleteMany({}),
    ]);
    console.log('[Seed] Cleaned collections');

    // Admin
    await User.create({
      name: 'Admin',
      email: process.env.ADMIN_EMAIL || 'admin@resell.com',
      password: process.env.ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64'),
      role: 'admin',
      isVerified: true,
    });

    // Categories
    const categoryNames = [
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
    const categories = [];
    for (const c of categoryNames) {
      const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const cat = await Category.create({ ...c, slug });
      categories.push(cat);
    }
    console.log(`[Seed] Created ${categories.length} categories`);

    // Users
    const users = [];
    const sampleUsers = [
      { name: 'Sarah Chen', email: 'sarah@resell.com', role: 'seller', bio: 'Tech enthusiast and refurbished gadget seller.' },
      { name: 'Marcus Johnson', email: 'marcus@resell.com', role: 'seller', bio: 'Vintage fashion collector.' },
      { name: 'Emily Davis', email: 'emily@resell.com', role: 'seller', bio: 'Home decor specialist.' },
      { name: 'Alex Rivera', email: 'alex@resell.com', role: 'buyer', bio: 'Always looking for deals.' },
      { name: 'Jordan Lee', email: 'jordan@resell.com', role: 'buyer' },
    ];

    for (const u of sampleUsers) {
      const user = await User.create({
        ...u,
        password: 'Password123!',
        isVerified: true,
        location: ['New York', 'San Francisco', 'Austin', 'Chicago', 'Seattle'][users.length],
        averageResponseMinutes: 15 + Math.floor(Math.random() * 60),
      });
      users.push(user);
    }
    console.log(`[Seed] Created ${users.length} users`);

    // Products
    const productTemplates = [
      {
        title: 'MacBook Pro 16" M2 Pro - Like New',
        description: 'Pristine condition MacBook Pro with M2 Pro chip, 16GB RAM, 512GB SSD. Barely used, always in a case. Original box and accessories included. Battery cycle count under 50. Perfect for developers and creative professionals.',
        price: 2199,
        originalPrice: 2499,
        brand: 'Apple',
        model: 'MacBook Pro 16"',
        condition: 'like-new',
        yearsUsed: 1,
        category: 'Computers & Laptops',
        specifications: [
          { key: 'Processor', value: 'Apple M2 Pro' },
          { key: 'RAM', value: '16GB' },
          { key: 'Storage', value: '512GB SSD' },
          { key: 'Display', value: '16-inch Liquid Retina XDR' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=1200&auto=format&fit=crop',
      },
      {
        title: 'iPhone 14 Pro - 256GB - Deep Purple',
        description: 'Excellent condition iPhone 14 Pro. Always used with a screen protector and case. Face ID works perfectly. Battery health at 94%. Includes original charger and box.',
        price: 799,
        originalPrice: 999,
        brand: 'Apple',
        model: 'iPhone 14 Pro',
        condition: 'good',
        yearsUsed: 1,
        category: 'Mobile Phones',
        specifications: [
          { key: 'Storage', value: '256GB' },
          { key: 'Color', value: 'Deep Purple' },
          { key: 'Battery Health', value: '94%' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1592286927505-1def25115558?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Sony WH-1000XM5 Wireless Headphones',
        description: 'Industry-leading noise cancellation. Lightweight, comfortable design. 30-hour battery life. Includes carrying case and all accessories.',
        price: 249,
        originalPrice: 399,
        brand: 'Sony',
        model: 'WH-1000XM5',
        condition: 'like-new',
        yearsUsed: 0,
        category: 'Electronics',
        specifications: [
          { key: 'Type', value: 'Over-ear Wireless' },
          { key: 'Battery Life', value: '30 hours' },
          { key: 'ANC', value: 'Yes' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1583394838336-acd977736f90?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Nike Air Max 90 - White/Black - Size 10',
        description: 'Classic Nike Air Max 90 in great condition. Worn only a handful of times. Original box included. Perfect for everyday wear.',
        price: 65,
        originalPrice: 130,
        brand: 'Nike',
        model: 'Air Max 90',
        condition: 'good',
        yearsUsed: 2,
        category: 'Fashion',
        specifications: [
          { key: 'Size', value: 'US 10' },
          { key: 'Color', value: 'White/Black' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Vintage Leather Jacket - Brown',
        description: 'Genuine leather jacket in classic brown. Soft, well-broken-in feel. Minor wear adds character. Size Medium.',
        price: 145,
        originalPrice: 350,
        brand: 'Vintage',
        condition: 'good',
        yearsUsed: 5,
        category: 'Fashion',
        specifications: [
          { key: 'Material', value: 'Genuine Leather' },
          { key: 'Size', value: 'Medium' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Mid-Century Modern Coffee Table',
        description: 'Beautiful walnut wood coffee table with hairpin legs. Solid construction. Some minor scuffs consistent with age but adds to the charm.',
        price: 220,
        originalPrice: 450,
        brand: 'Handmade',
        condition: 'good',
        yearsUsed: 8,
        category: 'Home & Garden',
        specifications: [
          { key: 'Material', value: 'Walnut Wood' },
          { key: 'Dimensions', value: '48"x24"x18"' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Canon EOS R6 Mirrorless Camera',
        description: 'Professional-grade mirrorless camera. Includes 24-105mm f/4 lens. Excellent image quality and autofocus. Low shutter count (~5000 actuations).',
        price: 1750,
        originalPrice: 2499,
        brand: 'Canon',
        model: 'EOS R6',
        condition: 'like-new',
        yearsUsed: 2,
        category: 'Electronics',
        specifications: [
          { key: 'Sensor', value: 'Full Frame 20MP' },
          { key: 'Video', value: '4K 60fps' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1606986628253-49e2d7b5f9f7?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Trek Mountain Bike - 29er',
        description: 'Well-maintained Trek mountain bike. Shimano Deore components, hydraulic disc brakes. Recently serviced. Perfect for trail riding.',
        price: 480,
        originalPrice: 1200,
        brand: 'Trek',
        condition: 'good',
        yearsUsed: 3,
        category: 'Sports & Outdoors',
        specifications: [
          { key: 'Frame Size', value: 'Large' },
          { key: 'Wheel Size', value: '29 inch' },
          { key: 'Gears', value: '11-speed' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1576435728678-68d0fbf94e91?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Harry Potter Complete Book Set',
        description: 'All 7 Harry Potter books in hardcover. Excellent condition, kept on a shelf. A must-have for any collection.',
        price: 85,
        originalPrice: 140,
        brand: 'Scholastic',
        condition: 'like-new',
        yearsUsed: 5,
        category: 'Books & Media',
        specifications: [
          { key: 'Format', value: 'Hardcover' },
          { key: 'Books', value: '7' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=1200&auto=format&fit=crop',
      },
      {
        title: 'LEGO Creator Expert - Bookshop',
        description: 'Modular building set, 99% complete with all original pieces and instructions. Displayed but never played with.',
        price: 110,
        originalPrice: 170,
        brand: 'LEGO',
        condition: 'like-new',
        yearsUsed: 2,
        category: 'Toys & Games',
        specifications: [
          { key: 'Pieces', value: '2,504' },
          { key: 'Theme', value: 'Modular Buildings' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Samsung Galaxy Watch 5 Pro',
        description: 'Premium smartwatch with titanium case. Excellent battery life. Includes multiple watch bands.',
        price: 240,
        originalPrice: 449,
        brand: 'Samsung',
        condition: 'good',
        yearsUsed: 1,
        category: 'Electronics',
        specifications: [
          { key: 'Case Size', value: '45mm' },
          { key: 'Material', value: 'Titanium' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=1200&auto=format&fit=crop',
      },
      {
        title: 'Herman Miller Aeron Chair - Size B',
        description: 'Iconic ergonomic office chair. Fully adjustable. Mesh in excellent condition. PostureFit lumbar support.',
        price: 575,
        originalPrice: 1395,
        brand: 'Herman Miller',
        model: 'Aeron',
        condition: 'good',
        yearsUsed: 4,
        category: 'Home & Garden',
        specifications: [
          { key: 'Size', value: 'B (Medium)' },
          { key: 'Material', value: 'Pellicle Mesh' },
        ],
        imageUrl:
          'https://images.unsplash.com/photo-1580480055273-228ff5388ef8?w=1200&auto=format&fit=crop',
      },
    ];

    const sellers = users.filter((u) => u.role === 'seller');
    let imageIdx = 0;
    for (const tpl of productTemplates) {
      const category = categories.find((c) => c.name === tpl.category);
      const seller = sellers[imageIdx % sellers.length];
      imageIdx++;

      // Compute AI fields based on rule
      const conditionScore = tpl.condition === 'like-new' ? 90 : tpl.condition === 'good' ? 75 : 55;
      const damageScore = tpl.condition === 'like-new' ? 5 : tpl.condition === 'good' ? 15 : 35;
      const depRate =
        tpl.category === 'Electronics' || tpl.category === 'Mobile Phones' || tpl.category === 'Computers & Laptops'
          ? 0.18
          : tpl.category === 'Fashion'
          ? 0.30
          : 0.10;
      const recommendedPrice =
        tpl.originalPrice *
        Math.pow(1 - depRate, tpl.yearsUsed) *
        (tpl.condition === 'like-new' ? 0.82 : tpl.condition === 'good' ? 0.65 : 0.45);

      const product = await Product.create({
        title: tpl.title,
        description: tpl.description,
        price: tpl.price,
        originalPrice: tpl.originalPrice,
        category: category._id,
        brand: tpl.brand,
        model: tpl.model,
        condition: tpl.condition,
        yearsUsed: tpl.yearsUsed,
        specifications: tpl.specifications,
        location: {
          city: seller.location || 'New York',
          state: 'NY',
          country: 'USA',
        },
        images: [
          {
            url: tpl.imageUrl,
            publicId: `seed_${imageIdx}`,
            isPrimary: true,
          },
        ],
        seller: seller._id,
        status: Math.random() > 0.85 ? 'sold' : 'active',
        views: Math.floor(Math.random() * 200),
        favoritesCount: Math.floor(Math.random() * 20),
        aiAnalysis: {
          classification: {
            predictedCategory: tpl.category,
            confidence: 0.85,
          },
          conditionScore,
          damageScore,
          damageDescription: damageScore > 20 ? 'Minor surface wear visible' : '',
          imageHashes: [`seed_hash_${imageIdx}`],
          priceRecommendation: {
            recommendedPrice: Math.round(recommendedPrice),
            minPrice: Math.round(recommendedPrice * 0.85),
            maxPrice: Math.round(recommendedPrice * 1.15),
            confidence: 0.75,
            explanation: `Depreciation model applied: ${(depRate * 100).toFixed(0)}% annual rate over ${tpl.yearsUsed} year(s) for ${tpl.category}, adjusted by condition and brand.`,
            factors: [
              `Annual depreciation rate: ${(depRate * 100).toFixed(0)}%`,
              `Condition factor for ${tpl.condition}`,
              `Brand premium for ${tpl.brand}`,
              `Visual condition score ${conditionScore}/100`,
            ],
            source: 'heuristic',
          },
          riskAssessment: {
            riskScore: Math.floor(Math.random() * 15),
            riskLevel: 'low',
            factors: [],
          },
          lastAnalyzedAt: new Date(),
        },
      });

      // Create a sale for "sold" items
      if (product.status === 'sold') {
        await Sale.create({
          product: product._id,
          seller: seller._id,
          buyer: users.find((u) => u.role === 'buyer')._id,
          salePrice: product.price,
          netAmount: product.price,
        });
      }
    }

    console.log(`[Seed] Created ${productTemplates.length} products`);

    // Reviews
    const buyers = users.filter((u) => u.role === 'buyer');
    for (const seller of sellers) {
      for (const buyer of buyers) {
        await Review.create({
          seller: seller._id,
          buyer: buyer._id,
          rating: 3 + Math.floor(Math.random() * 3),
          comment: [
            'Great seller, fast shipping and accurate description.',
            'Item was as described. Smooth transaction.',
            'Excellent communication and packaging.',
            'Smooth transaction, recommended!',
            'Good experience overall.',
          ][Math.floor(Math.random() * 5)],
        });
      }
    }
    console.log('[Seed] Created reviews');

    // ── Duplicate fixture seeding ──────────────────────────────────────
    if (process.argv.includes('--with-duplicate-fixtures')) {
      await seedDuplicateFixtures(sellers, categories, users);
    }

    console.log('\n[Seed] Done!');
    console.log('---');
    console.log('Admin: admin@resell.com (password set via ADMIN_PASSWORD env var)');
    console.log('Users: alex@resell.com / Password123!');
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Error:', err);
    process.exit(1);
  }
};

seed();
