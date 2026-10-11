const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const dotenv = require('dotenv');
const { Server } = require('socket.io');

// Skip dotenv in test — jest.global.setup.js sets MONGODB_URI for the
// in-memory server and dotenv would overwrite it with the real URI.
// validateEnv() also depends on env vars that dotenv would load, so
// skip it in tests as well — the global setup handles what's needed.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
  const validateEnv = require('./config/validateEnv');
  validateEnv();
}

const connectDB = require('./config/db');
const setupSocket = require('./sockets');
const { errorHandler, notFound } = require('./utils/errorHandler');
const { setIo } = require('./services/notificationService');
const { CLIENT_ORIGINS, isOriginAllowed } = require('./config/corsOrigins');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    // Shared strict allowlist — same one used by the Express CORS middleware
    // below. Socket.IO accepts an array of exact origins (no wildcards).
    origin: CLIENT_ORIGINS,
    credentials: true,
  },
  // The cors option only guards the HTTP polling handshake — engine.io's ws
  // upgrade path bypasses HTTP CORS entirely, and WebSockets are not subject
  // to the browser same-origin policy. Enforce the SAME allowlist at the
  // engine level so direct websocket handshakes from a disallowed origin are
  // rejected before the socket is created.
  allowRequest(req, callback) {
    if (isOriginAllowed(req.headers.origin)) {
      return callback(null, true);
    }
    return callback('origin not allowed', false);
  },
});
app.set('io', io);

setupSocket(io);

setIo(io);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com', 'https://images.unsplash.com', 'https://*.unsplash.com'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", ...CLIENT_ORIGINS],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      interestcohort: [],
    },
  })
);
app.use(compression());

// Stripe webhook needs raw body — mount BEFORE express.json()
// This route handles its own body parsing via express.raw()
const checkoutRoutes = require('./routes/checkoutRoutes');
app.use('/api/checkout', checkoutRoutes);

app.use(
  cors({
    origin: CLIENT_ORIGINS,
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(mongoSanitize());

app.use('/public', express.static(path.join(__dirname, '..', 'public')));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

const isTest = process.env.NODE_ENV === 'test';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMIT', message: 'Too many requests' },
});
if (!isTest) app.use('/api', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, code: 'RATE_LIMIT', message: 'Too many login attempts' },
});

app.get(['/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

if (!isTest) {
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
}

const productCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { success: false, code: 'RATE_LIMIT', message: 'Too many products created. Try again later.' },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  message: { success: false, code: 'RATE_LIMIT', message: 'Too many messages. Slow down.' },
});

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const favoriteRoutes = require('./routes/favoriteRoutes');
const chatRoutes = require('./routes/chatRoutes');
const reportRoutes = require('./routes/reportRoutes');
const sellerRoutes = require('./routes/sellerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const exchangeRoutes = require('./routes/exchangeRoutes');
const offerRoutes = require('./routes/offerRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const orderRoutes = require('./routes/orderRoutes');
const { startScheduler: startExchangeScheduler } = require('./services/exchangeRates');
const { registerSweepJob } = require('./queues');

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/sellers', sellerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/exchange-rates', exchangeRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/orders', orderRoutes);

if (!isTest) {
  startExchangeScheduler();
}

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// Only start the server when run directly (node src/server.js), not when
// required as a module (e.g. by tests).  Tests import { app, server } and
// use supertest against `app` without binding a real port.
if (require.main === module) {
  const start = async () => {
    try {
      await connectDB();
      // Retry EADDRINUSE briefly instead of crashing: during a nodemon
      // restart the previous instance may still hold port 5000 while its
      // graceful shutdown finishes, which would crash the new instance and
      // leave nodemon in "app crashed — waiting for file changes" state.
      let attempts = 0;
      const listen = () => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && attempts < 5) {
            attempts += 1;
            console.warn(`[Server] Port ${PORT} busy, retrying in 2s (attempt ${attempts}/5)...`);
            setTimeout(listen, 2000);
          } else if (err.code === 'EADDRINUSE') {
            console.error(`[Server] Port ${PORT} is already in use. Stop the existing ReSell backend or set PORT to another free port.`);
            process.exit(1);
          } else {
            console.error('[Server] Startup failed:', err);
            process.exit(1);
          }
        });
        server.listen(PORT, () => {
        console.log(`[Server] Running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
        registerSweepJob();
        // Warm MobileNet in background to avoid 18s cold start on first upload
        if (process.env.NODE_ENV !== 'test') {
          const { loadModel } = require('./services/imageClassifier');
          loadModel().then(() => console.log('[Server] MobileNet warmed')).catch(() => {});
        }
        });
      };
      listen();
    } catch (err) {
      console.error('[Server] Startup failed:', err);
      process.exit(1);
    }
  };
  start();
}

// ── Process-level error handlers ────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
  gracefulShutdown(1);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  gracefulShutdown(1);
});

function gracefulShutdown(exitCode = 0) {
  console.log('[Server] Shutting down gracefully...');
  server.close(() => {
    const mongoose = require('mongoose');
    mongoose.connection.close(false).then(() => {
      console.log('[Server] Closed DB connection');
      process.exit(exitCode);
    });
  });
  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(exitCode);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown(0));
process.on('SIGINT', () => gracefulShutdown(0));

module.exports = { app, server, io };


