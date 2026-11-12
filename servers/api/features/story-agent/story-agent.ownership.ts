import type { MongoCollection, MongoDocument, MongoPersistence, MongoUpdate } from "../../integrations/index.js";

// Ownership is injected by the authenticated server boundary, never by request JSON.
export const createOwnedStoryPersistence = (db: MongoPersistence, ownerId: string): MongoPersistence => {
  if (!ownerId) throw new Error("An authenticated owner is required.");
  return { getCollection: <T extends MongoDocument>(name: string): MongoCollection<T> => {
    if (!["story_agent_runs", "story_agent_drafts", "story_agent_projects"].includes(name)) throw new Error("Collection is outside Story Agent ownership.");
    const collection = db.getCollection<T>(name);
    const owned = <V extends Readonly<Record<string, unknown>>>(value: V): V & { ownerId: string } => ({ ...value, ownerId });
    const update = (value: MongoUpdate<T>): MongoUpdate<T> => {
      const fields: Partial<T> = value.$set ?? {};
      return { ...value, $set: owned(fields) };
    };
    return {
      insertOne: async (document) => await collection.insertOne(owned(document)),
      findOne: async (filter) => await collection.findOne(owned(filter)),
      find: async (filter, options) => await collection.find(owned(filter), options),
      countDocuments: async (filter) => await collection.countDocuments(owned(filter)),
      deleteOne: async (filter) => await collection.deleteOne(owned(filter)),
      updateOne: async (filter, value) => await collection.updateOne(owned(filter), update(value)),
      findOneAndUpdate: async (filter, value, options) => await collection.findOneAndUpdate(owned(filter), update(value), options),
      createIndex: async (spec, options) => await collection.createIndex(spec, options)
    };
  } };
};
