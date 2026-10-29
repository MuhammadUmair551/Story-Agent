import mongoose from "mongoose";
import { metrics } from "@opentelemetry/api";
import type { Logger } from "@workspace/logging";
import type { MongoClient, MongoDatabase, MongoDbIntegration, MongoFindOptions, MongoFindOneAndUpdateOptions, MongoIndexOptions, MongoPersistence, MongoUpdate } from "./types.js";

type MongoDbIntegrationDependencies = Readonly<{
  uri?: string;
  logger: Logger;
  client?: MongoClient;
}>;

const mongoMeter = metrics.getMeter("story-agent-api.mongodb");
const mongoOperationDuration = mongoMeter.createHistogram("mongodb.operation.duration", { unit: "ms", description: "MongoDB operation duration." });
const mongoOperationFailures = mongoMeter.createCounter("mongodb.operation.failure.count", { description: "Failed MongoDB operations." });
const measureMongoOperation = async <T>(collection: string, operation: string, run: () => Promise<T>): Promise<T> => {
  const startedAt = process.hrtime.bigint();
  try {
    return await run();
  } catch (error: unknown) {
    mongoOperationFailures.add(1, { "db.collection.name": collection, "db.operation.name": operation });
    throw error;
  } finally {
    mongoOperationDuration.record(Number(process.hrtime.bigint() - startedAt) / 1_000_000, {
      "db.collection.name": collection,
      "db.operation.name": operation
    });
  }
};

const mongooseClient: MongoClient = Object.freeze({
  connect: async (uri: string): Promise<MongoDatabase> => {
    await mongoose.connect(uri);
    const database = mongoose.connection.db;
    if (!database) throw new Error("MongoDB connection did not expose a database.");
    return Object.freeze({
      collection: <TDocument extends Record<string, unknown>>(name: string) => {
        const collection = database.collection(name);
        return Object.freeze({
          insertOne: async (document: TDocument) => await measureMongoOperation(name, "insertOne", async () => {
            const inserted = await collection.insertOne(document);
            return Object.freeze({ insertedId: inserted.insertedId });
          }),
          findOne: async (filter: Partial<TDocument>): Promise<TDocument | null> => await measureMongoOperation(name, "findOne", async () => {
            const found = await collection.findOne(filter);
            return found as TDocument | null;
          }),
          find: async (filter: Partial<TDocument>, options: MongoFindOptions = {}): Promise<TDocument[]> => await measureMongoOperation(name, "find", async () => {
            let cursor = collection.find(filter);
            if (options.sort) cursor = cursor.sort(options.sort);
            if (options.skip !== undefined) cursor = cursor.skip(options.skip);
            if (options.limit !== undefined) cursor = cursor.limit(options.limit);
            return await cursor.toArray() as unknown as TDocument[];
          }),
          countDocuments: async (filter: Partial<TDocument>): Promise<number> => await measureMongoOperation(name, "countDocuments", async () => await collection.countDocuments(filter)),
          updateOne: async (filter: Partial<TDocument>, update: MongoUpdate<TDocument>) => await measureMongoOperation(name, "updateOne", async () => {
            const result = await collection.updateOne(filter, update);
            return Object.freeze({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
          }),
          findOneAndUpdate: async (filter: Readonly<Record<string, unknown>>, update: MongoUpdate<TDocument>, options: MongoFindOneAndUpdateOptions = {}): Promise<TDocument | null> => await measureMongoOperation(name, "findOneAndUpdate", async () => {
            const result = await collection.findOneAndUpdate(filter, update, { returnDocument: "after", ...(options.sort ? { sort: options.sort } : {}) });
            return result as unknown as TDocument | null;
          }),
          createIndex: async (spec: Record<string, 1 | -1>, options?: MongoIndexOptions): Promise<string> => await measureMongoOperation(name, "createIndex", async () => await collection.createIndex(spec, options))
        });
      }
    });
  },
  disconnect: (): Promise<void> => mongoose.disconnect()
});

mongoMeter.createObservableGauge("mongodb.connection.state", {
  description: "Mongoose connection state (0 disconnected, 1 connected, 2 connecting, 3 disconnecting)."
}).addCallback((result) => { result.observe(mongoose.connection.readyState); });

const unavailablePersistence = (): MongoPersistence => Object.freeze({
  getCollection: () => { throw new Error("MongoDB persistence is not configured."); }
});

export const createMongoDbIntegration = ({
  uri,
  logger,
  client = mongooseClient
}: MongoDbIntegrationDependencies): MongoDbIntegration => {
  if (!uri) {
    const persistence = unavailablePersistence();
    return Object.freeze({
      getCollection: persistence.getCollection,
      connect: (): Promise<void> => {
        logger.info("MongoDB connection is not configured; starting without persistence.");
        return Promise.resolve();
      },
      disconnect: (): Promise<void> => Promise.resolve()
    });
  }

  let database: MongoDatabase | undefined;
  return Object.freeze({
    getCollection: (name) => {
      if (!database) throw new Error("MongoDB persistence is not connected.");
      return database.collection(name);
    },
    connect: async (): Promise<void> => {
      database = await client.connect(uri);
      logger.info("MongoDB connection established.");
    },
    disconnect: async (): Promise<void> => {
      await client.disconnect();
    }
  });
};
