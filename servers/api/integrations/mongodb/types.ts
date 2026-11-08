export type MongoDocument = Readonly<Record<string, unknown>>;
export type MongoReadFilter<TDocument extends MongoDocument> = Readonly<{
  [Key in keyof TDocument]?: TDocument[Key] | Readonly<{ $exists: boolean }>;
}>;

export type MongoInsertResult = Readonly<{ insertedId: unknown }>;
export type MongoFindOptions = Readonly<{
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}>;
export type MongoUpdateResult = Readonly<{ matchedCount: number; modifiedCount: number }>;
export type MongoIndexOptions = Readonly<{ unique?: boolean; name?: string }>;
export type MongoFindOneAndUpdateOptions = Readonly<{ sort?: Record<string, 1 | -1> }>;
export type MongoUpdate<TDocument extends MongoDocument> = Readonly<{
  $set?: Partial<TDocument>;
  $inc?: Partial<Record<keyof TDocument, number>>;
}>;

export type MongoCollection<TDocument extends MongoDocument> = Readonly<{
  insertOne: (document: TDocument) => Promise<MongoInsertResult>;
  findOne: (filter: Partial<TDocument>) => Promise<TDocument | null>;
  find: (filter: MongoReadFilter<TDocument>, options?: MongoFindOptions) => Promise<TDocument[]>;
  countDocuments: (filter: MongoReadFilter<TDocument>) => Promise<number>;
  deleteOne: (filter: Partial<TDocument>) => Promise<Readonly<{ deletedCount: number }>>;
  updateOne: (filter: Partial<TDocument>, update: MongoUpdate<TDocument>) => Promise<MongoUpdateResult>;
  findOneAndUpdate: (filter: Readonly<Record<string, unknown>>, update: MongoUpdate<TDocument>, options?: MongoFindOneAndUpdateOptions) => Promise<TDocument | null>;
  createIndex: (spec: Record<string, 1 | -1>, options?: MongoIndexOptions) => Promise<string>;
}>;

export type MongoDatabase = Readonly<{
  collection: <TDocument extends MongoDocument>(name: string) => MongoCollection<TDocument>;
}>;

export type MongoClient = Readonly<{
  connect: (uri: string) => Promise<MongoDatabase>;
  disconnect: () => Promise<void>;
}>;

export type MongoPersistence = Readonly<{
  getCollection: <TDocument extends MongoDocument>(name: string) => MongoCollection<TDocument>;
}>;

export type MongoDbIntegration = MongoPersistence & Readonly<{
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}>;
