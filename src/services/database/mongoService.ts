import { MongoClient, Db, MongoClientOptions, Collection, Document } from "mongodb";
import env from "../../config/env";
import logger from "../../config/logger";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;

  const uri = env.MONGO_URI;
  const dbName = env.MONGO_DB_NAME;
  if (!uri || !dbName) throw new Error("MongoDB configuration missing");

  const opts: MongoClientOptions = {
    maxPoolSize: 10,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
  } as MongoClientOptions;

  client = new MongoClient(uri, opts);
  try {
    await client.connect();
    db = client.db(dbName);
    logger.info({ dbName }, "MongoDB connected");
    return db;
  } catch (error) {
    logger.fatal({ err: error }, "Failed to connect to MongoDB");
    throw error;
  }
}

export function getDb(): Db {
  if (!db) throw new Error("MongoDB not initialized");
  return db;
}

export function getCollection<T extends Document = Document>(name: string): Collection<T> {
  const database = getDb();
  return database.collection<T>(name);
}

export async function closeMongo(): Promise<void> {
  if (!client) return;
  try {
    await client.close();
    logger.info("MongoDB connection closed");
  } catch (error) {
    logger.error({ err: error }, "Failed to close MongoDB connection");
  } finally {
    client = null;
    db = null;
  }
}
