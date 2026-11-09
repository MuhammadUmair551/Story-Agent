import type { MongoCollection, MongoDocument, MongoPersistence } from "../../../integrations/index.js";

const matches = (document: MongoDocument, filter: Readonly<Record<string, unknown>>): boolean => Object.entries(filter).every(([key, value]) => {
  if (key === "$or") return (value as Readonly<Record<string, unknown>>[]).some((condition) => matches(document, condition));
  const actual = document[key];
  if (typeof value === "object" && value !== null) {
    if ("$ne" in value) return actual !== value.$ne;
    if ("$exists" in value) return (actual !== undefined) === value.$exists;
    if ("$lte" in value) return typeof actual === "string" && typeof value.$lte === "string" && actual <= value.$lte;
  }
  return value === null ? actual === null || actual === undefined : JSON.stringify(actual) === JSON.stringify(value);
});

export const createMemoryPersistence = (): Readonly<{ db: MongoPersistence; indexes: string[]; failures: { deleteDraft: boolean } }> => {
  const failures = { deleteDraft: false };
  const documents = new Map<string, MongoDocument[]>();
  const indexes: string[] = [];
  const collection = <TDocument extends MongoDocument>(name: string): MongoCollection<TDocument> => ({
    insertOne: (document) => {
      const items = documents.get(name) ?? [];
      items.push(structuredClone(document));
      documents.set(name, items);
      return Promise.resolve({ insertedId: items.length });
    },
    findOne: (filter) => Promise.resolve((documents.get(name) ?? []).find((document) => matches(document, filter)) as TDocument | undefined ?? null),
    find: (filter, options) => {
      const items = (documents.get(name) ?? []).filter((document) => matches(document, filter));
      const sorted = options?.sort ? [...items].sort((left, right) => {
        for (const [key, direction] of Object.entries(options.sort ?? {})) {
          const result = String(left[key]).localeCompare(String(right[key])) * direction;
          if (result !== 0) return result;
        }
        return 0;
      }) : items;
      return Promise.resolve(sorted.slice(options?.skip ?? 0, (options?.skip ?? 0) + (options?.limit ?? sorted.length)) as TDocument[]);
    },
    countDocuments: (filter) => Promise.resolve((documents.get(name) ?? []).filter((document) => matches(document, filter)).length),
    updateOne: (filter, update) => {
      const item = (documents.get(name) ?? []).find((document) => matches(document, filter));
      if (!item) return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
      Object.assign(item, update.$set ?? {});
      return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
    },
    findOneAndUpdate: (filter, update) => {
      const item = (documents.get(name) ?? []).find((document) => matches(document, filter as Partial<TDocument>));
      if (!item) return Promise.resolve(null);
      Object.assign(item, update.$set ?? {});
      const mutable = item as Record<string, unknown>;
      for (const [key, amount] of Object.entries(update.$inc ?? {})) mutable[key] = Number(mutable[key] ?? 0) + (amount ?? 0);
      return Promise.resolve(item as TDocument);
    },
    deleteOne: (filter) => {
      if (name === "story_agent_drafts" && failures.deleteDraft) return Promise.reject(new Error("Storage unavailable"));
      const items = documents.get(name) ?? []; const index = items.findIndex((item) => matches(item, filter));
      if (index < 0) return Promise.resolve({ deletedCount: 0 });
      items.splice(index, 1); return Promise.resolve({ deletedCount: 1 });
    },
    createIndex: (spec, options) => {
      indexes.push(`${name}:${Object.keys(spec).join(",")}:${String(options?.unique)}`);
      return Promise.resolve(options?.name ?? "index");
    }
  });
  return { db: { getCollection: collection }, indexes, failures };
};
