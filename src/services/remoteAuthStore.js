"use strict";

const fs = require("fs/promises");
const path = require("path");
const logger = require("../config/logger");
const { connectMongo, getCollection } = require("./mongoService");

const DEFAULT_COLLECTION = "whatsappSessions";

class MongoRemoteAuthStore {
  constructor({ collectionName = DEFAULT_COLLECTION } = {}) {
    this.collectionName = collectionName;
    this.collection = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) {
      return;
    }

    await connectMongo();
    this.collection = getCollection(this.collectionName);
    await this.collection.createIndex({ session: 1 }, { unique: true });
    this.initialized = true;
  }

  async sessionExists({ session }) {
    if (!session) {
      return false;
    }
    await this.init();
    const doc = await this.collection.findOne(
      { session },
      { projection: { _id: 1 } }
    );
    return Boolean(doc);
  }

  async save({ session }) {
    if (!session) {
      throw new Error("Session name is required");
    }

    await this.init();
    const archivePath = path.resolve(`${session}.zip`);
    let buffer;

    try {
      buffer = await fs.readFile(archivePath);
    } catch (error) {
      logger.error({ err: error, session }, "Failed to read remote session archive");
      throw error;
    }

    const now = new Date();

    await this.collection.updateOne(
      { session },
      {
        $set: {
          archive: buffer,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true }
    );
  }

  async extract({ session, path: targetPath }) {
    if (!session || !targetPath) {
      throw new Error("Session name and target path are required");
    }

    await this.init();
    const doc = await this.collection.findOne({ session }, { projection: { archive: 1 } });
    if (!doc || !doc.archive) {
      throw new Error(`No stored session archive for ${session}`);
    }

    const buffer = doc.archive.buffer ? doc.archive.buffer : doc.archive;
    await fs.writeFile(targetPath, buffer);
  }

  async delete({ session }) {
    if (!session) {
      return;
    }
    await this.init();
    await this.collection.deleteOne({ session });
  }

  async list() {
    await this.init();
    const docs = await this.collection
      .find({}, { projection: { session: 1, updatedAt: 1, _id: 0 } })
      .toArray();
    return docs;
  }
}

module.exports = new MongoRemoteAuthStore();
