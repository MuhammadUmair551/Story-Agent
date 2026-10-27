import mongoose from "mongoose";
import type { Logger } from "@workspace/logging";
import type { MongoClient, MongoDatabase, MongoDbIntegration, MongoFindOptions, MongoFindOneAndUpdateOptions, MongoIndexOptions, MongoPersistence, MongoUpdate } from "./types.js";

type MongoDbIntegrationDependencies = Readonly<{
  uri?: string;
  logger: Logger;
  client?: MongoClient;
}>;

const mongooseClient: MongoClient = Object.freeze({
  connect: async (uri: string): Promise<MongoDatabase> => {
    await mongoose.connect(uri);
    const database = mongoose.connection.db;
    if (!database) throw new Error("MongoDB connection did not expose a database.");
    return Object.freeze({
      collection: <TDocument extends Record<string, unknown>>(name: string) => {
        const collection = database.collection(name);
        return Object.freeze({
          insertOne: async (document: TDocument) => {
            const inserted = await collection.insertOne(document);
            return Object.freeze({ insertedId: inserted.insertedId });
          },
          findOne: async (filter: Partial<TDocument>): Promise<TDocument | null> => {
            const found = await collection.findOne(filter);
            return found as TDocument | null;
          },
          find: async (filter: Partial<TDocument>, options: MongoFindOptions = {}): Promise<TDocument[]> => {
            let cursor = collection.find(filter);
            if (options.sort) cursor = cursor.sort(options.sort);
            if (options.skip !== undefined) cursor = cursor.skip(options.skip);
            if (options.limit !== undefined) cursor = cursor.limit(options.limit);
            return await cursor.toArray() as unknown as TDocument[];
          },
          countDocuments: async (filter: Partial<TDocument>): Promise<number> => await collection.countDocuments(filter),
          updateOne: async (filter: Partial<TDocument>, update: MongoUpdate<TDocument>) => {
            const result = await collection.updateOne(filter, update);
            return Object.freeze({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
          },
          findOneAndUpdate: async (filter: Readonly<Record<string, unknown>>, update: MongoUpdate<TDocument>, options: MongoFindOneAndUpdateOptions = {}): Promise<TDocument | null> => {
            const result = await collection.findOneAndUpdate(filter, update, { returnDocument: "after", ...(options.sort ? { sort: options.sort } : {}) });
            return result as unknown as TDocument | null;
          },
          createIndex: async (spec: Record<string, 1 | -1>, options?: MongoIndexOptions): Promise<string> => await collection.createIndex(spec, options)
        });
      }
    });
  },
  disconnect: (): Promise<void> => mongoose.disconnect()
});

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
