const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongoServer;

module.exports = async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 60_000 },
  });
  const uri = mongoServer.getUri();
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
  global.__MONGO_SERVER__ = mongoServer;
  global.__MONGO_URI__ = uri;
};