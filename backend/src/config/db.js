const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    const conn = await mongoose.connect(uri);
    console.log(`[DB] MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`\n[DB] Failed to connect to MongoDB: ${error.message}`);
    console.error('[DB] Troubleshooting tips:');
    console.error('  1. Ensure MongoDB service is running locally (mongod / net start MongoDB).');
    console.error('  2. If using MongoDB Atlas, check your MONGODB_URI in backend/.env and verify your IP is whitelisted in Atlas Network Access.\n');
    if (process.env.NODE_ENV !== 'test') process.exit(1);
    throw error;
  }
};

module.exports = connectDB;
