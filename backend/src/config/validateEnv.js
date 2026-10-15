const REQUIRED_VARS = [
  'MONGODB_URI',
  'JWT_SECRET',
];

const REQUIRED_IN_PRODUCTION = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CLIENT_URL',
];

const OPTIONAL_WITH_DEFAULTS = {
  PORT: '5000',
  NODE_ENV: 'development',
  JWT_ACCESS_EXPIRE: '15m',
  JWT_REFRESH_EXPIRE: '7d',
  REDIS_URL: 'redis://localhost:6379',
  ML_SERVICE_URL: 'http://localhost:8000',
  ML_BLEND_WEIGHT: '0.7',
  HASH_SIMILARITY_THRESHOLD: '12',
  VISUAL_SIMILARITY_MEDIUM_THRESHOLD: '0.90',
  VISUAL_SIMILARITY_STRONG_THRESHOLD: '0.97',
  DUPLICATE_SCAN_CAP: '500',
  VISUAL_SCAN_CAP: '200',
  OBJECT_DETECTION_MIN_SCORE: '0.5',
  OBJECT_DETECTION_IOU_THRESHOLD: '0.6',
  OBJECT_DETECTION_MAX_OBJECTS: '8',
  MAX_IMAGE_SIZE: '10485760',
};

const validateEnv = () => {
  // Support both MONGODB_URI and MONGO_URI interchangeably
  if (!process.env.MONGODB_URI && process.env.MONGO_URI) {
    process.env.MONGODB_URI = process.env.MONGO_URI;
  }

  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.error(`\n[FATAL CONFIG ERROR] Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('Please create or update your "backend/.env" file with these values.');
    console.error('Refer to "backend/.env.example" for the full list of required settings.\n');
    process.exit(1);
  }

  // Stripe is required in production, warns in development
  if (process.env.NODE_ENV === 'production') {
    const missingProd = REQUIRED_IN_PRODUCTION.filter((v) => !process.env[v]);
    if (missingProd.length > 0) {
      console.error(`[Config] Missing required production variables: ${missingProd.join(', ')}`);
      console.error('[Config] Stripe is required for checkout in production.');
      process.exit(1);
    }
  } else {
    for (const v of REQUIRED_IN_PRODUCTION) {
      if (!process.env[v]) {
        console.warn(`[Config] ${v} not set — Stripe checkout is optional and unavailable locally`);
      }
    }
    if (!process.env.CLIENT_URL) {
      console.warn('[Config] CLIENT_URL not set — CORS will reject all cross-origin requests');
    }
  }

  for (const [key, defaultValue] of Object.entries(OPTIONAL_WITH_DEFAULTS)) {
    if (!process.env[key]) {
      process.env[key] = defaultValue;
      console.log(`[Config] ${key} not set, using default: ${defaultValue}${key === 'REDIS_URL' ? ' (workers require Redis; queues remain disabled when it is unavailable)' : ''}`);
    }
  }

  console.log('[Config] Environment validated successfully');
};

module.exports = validateEnv;
