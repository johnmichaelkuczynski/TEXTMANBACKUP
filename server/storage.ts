import { 
  users, 
  documents, 
  analyses, 
  userActivities, 
  cognitiveProfiles, 
  intelligentRewrites,
  rewriteJobs,
  userCredits,
  creditTransactions,
  type User, 
  type InsertUser, 
  type InsertDocument, 
  type Document, 
  type InsertUserActivity, 
  type InsertCognitiveProfile,
  type InsertRewriteJob,
  type RewriteJob,
  type UserCredits,
  type InsertUserCredits,
  type CreditTransaction,
  type InsertCreditTransaction
} from "@shared/schema";
import { db } from "./db";
import { eq, and } from "drizzle-orm";
import session from "express-session";
import createMemoryStore from "memorystore";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getUserByUsername(username: string): Promise<User | undefined>;
  sessionStore: any;
  
  // Document operations
  createDocument(doc: InsertDocument): Promise<Document>;
  getDocumentsByUser(userId: number): Promise<Document[]>;
  
  // Analysis operations
  createAnalysis(analysis: any): Promise<any>;
  
  // Intelligent Rewrite operations
  createIntelligentRewrite(rewrite: any): Promise<any>;
  
  // Activity tracking
  logActivity(activity: InsertUserActivity): Promise<void>;
  
  // Cognitive profile operations
  getCognitiveProfile(userId: number): Promise<any>;
  updateCognitiveProfile(userId: number, profile: Partial<InsertCognitiveProfile>): Promise<void>;
  
  // GPT Bypass Humanizer operations
  createRewriteJob(job: InsertRewriteJob): Promise<RewriteJob>;
  getRewriteJob(id: number): Promise<RewriteJob | undefined>;
  updateRewriteJob(id: number, updates: Partial<RewriteJob>): Promise<RewriteJob>;
  listRewriteJobs(): Promise<RewriteJob[]>;
  
  // Credit system operations
  getUserCredits(userId: number, provider: string): Promise<UserCredits | undefined>;
  getAllUserCredits(userId: number): Promise<UserCredits[]>;
  initializeUserCredits(userId: number, provider: string): Promise<UserCredits>;
  updateUserCredits(userId: number, provider: string, credits: number): Promise<UserCredits>;
  deductCredits(userId: number, provider: string, amount: number): Promise<boolean>;
  createCreditTransaction(transaction: InsertCreditTransaction): Promise<CreditTransaction>;
  getCreditTransaction(id: number): Promise<CreditTransaction | undefined>;
  getCreditTransactionByStripeSession(sessionId: string): Promise<CreditTransaction | undefined>;
  updateCreditTransactionStatus(id: number, status: string, paymentIntentId?: string): Promise<CreditTransaction>;
  updateCreditTransactionSessionId(id: number, sessionId: string): Promise<CreditTransaction>;

  // Reconstruction operations
  createReconstructionProject(project: any): Promise<any>;
  getReconstructionProject(id: number): Promise<any>;
  updateReconstructionProject(id: number, updates: any): Promise<any>;
  
  // Job History operations
  getAllJobs(): Promise<any[]>;
  getJobWithChunks(documentId: string): Promise<{ document: any; chunks: any[] } | null>;
  getJobChunks(documentId: string): Promise<any[]>;
}

const MemoryStore = createMemoryStore(session);

export class DatabaseStorage implements IStorage {
  sessionStore: any;

  constructor() {
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000, // prune expired entries every 24h
    });
  }
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async createDocument(doc: InsertDocument): Promise<Document> {
    const [document] = await db
      .insert(documents)
      .values(doc)
      .returning();
    return document;
  }

  async getDocumentsByUser(userId: number): Promise<Document[]> {
    return await db
      .select()
      .from(documents)
      .where(eq(documents.userId, userId));
  }

  async logActivity(activity: InsertUserActivity): Promise<void> {
    await db.insert(userActivities).values(activity);
  }

  async getCognitiveProfile(userId: number): Promise<any> {
    const [profile] = await db
      .select()
      .from(cognitiveProfiles)
      .where(eq(cognitiveProfiles.userId, userId));
    return profile;
  }

  async updateCognitiveProfile(userId: number, profile: Partial<InsertCognitiveProfile>): Promise<void> {
    await db
      .insert(cognitiveProfiles)
      .values({ ...profile, userId })
      .onConflictDoUpdate({
        target: cognitiveProfiles.userId,
        set: { ...profile, lastUpdated: new Date() }
      });
  }

  async createAnalysis(analysis: any): Promise<any> {
    const [result] = await db
      .insert(analyses)
      .values(analysis)
      .returning();
    return result;
  }

  async createIntelligentRewrite(rewrite: any): Promise<any> {
    const [result] = await db
      .insert(intelligentRewrites)
      .values(rewrite)
      .returning();
    return result;
  }
  
  // GPT Bypass Humanizer operations
  async createRewriteJob(insertJob: InsertRewriteJob): Promise<RewriteJob> {
    const [job] = await db
      .insert(rewriteJobs)
      .values([insertJob])
      .returning();
    return job;
  }

  async getRewriteJob(id: number): Promise<RewriteJob | undefined> {
    const result = await db
      .select()
      .from(rewriteJobs)
      .where(eq(rewriteJobs.id, id))
      .limit(1);
    return result[0];
  }

  async updateRewriteJob(id: number, updates: Partial<RewriteJob>): Promise<RewriteJob> {
    const [updated] = await db
      .update(rewriteJobs)
      .set(updates)
      .where(eq(rewriteJobs.id, id))
      .returning();
    return updated;
  }

  async listRewriteJobs(): Promise<RewriteJob[]> {
    return await db
      .select()
      .from(rewriteJobs)
      .orderBy(eq(rewriteJobs.createdAt, rewriteJobs.createdAt)) // Simple order by
      .limit(50);
  }
  
  // Credit system implementation
  async getUserCredits(userId: number, provider: string): Promise<UserCredits | undefined> {
    const [credits] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, userId), eq(userCredits.provider, provider)));
    return credits;
  }

  async getAllUserCredits(userId: number): Promise<UserCredits[]> {
    return await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, userId));
  }

  async initializeUserCredits(userId: number, provider: string): Promise<UserCredits> {
    const [credits] = await db
      .insert(userCredits)
      .values({ userId, provider, credits: 0 })
      .returning();
    return credits;
  }

  async updateUserCredits(userId: number, provider: string, credits: number): Promise<UserCredits> {
    const existing = await this.getUserCredits(userId, provider);
    if (!existing) {
      return this.initializeUserCredits(userId, provider);
    }
    
    const [updated] = await db
      .update(userCredits)
      .set({ credits, lastUpdated: new Date() })
      .where(eq(userCredits.id, existing.id))
      .returning();
    return updated;
  }

  async deductCredits(userId: number, provider: string, amount: number): Promise<boolean> {
    const existing = await this.getUserCredits(userId, provider);
    if (!existing || existing.credits < amount) {
      return false;
    }
    
    await db
      .update(userCredits)
      .set({ 
        credits: existing.credits - amount,
        lastUpdated: new Date()
      })
      .where(eq(userCredits.id, existing.id));
    
    return true;
  }

  async createCreditTransaction(transaction: InsertCreditTransaction): Promise<CreditTransaction> {
    const [result] = await db
      .insert(creditTransactions)
      .values(transaction)
      .returning();
    return result;
  }

  async getCreditTransaction(id: number): Promise<CreditTransaction | undefined> {
    const [transaction] = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.id, id));
    return transaction;
  }

  async getCreditTransactionByStripeSession(sessionId: string): Promise<CreditTransaction | undefined> {
    const [transaction] = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.stripeSessionId, sessionId));
    return transaction;
  }

  async updateCreditTransactionStatus(
    id: number, 
    status: string, 
    paymentIntentId?: string
  ): Promise<CreditTransaction> {
    const updateData: any = { status };
    if (paymentIntentId) {
      updateData.stripePaymentIntentId = paymentIntentId;
    }
    
    const [updated] = await db
      .update(creditTransactions)
      .set(updateData)
      .where(eq(creditTransactions.id, id))
      .returning();
    return updated;
  }

  async updateCreditTransactionSessionId(id: number, sessionId: string): Promise<CreditTransaction> {
    const [updated] = await db
      .update(creditTransactions)
      .set({ stripeSessionId: sessionId })
      .where(eq(creditTransactions.id, id))
      .returning();
    return updated;
  }

  // Reconstruction operations
  async createReconstructionProject(project: any): Promise<any> {
    const { reconstructionProjects } = await import("@shared/schema");
    const [result] = await db.insert(reconstructionProjects).values(project).returning();
    return result;
  }

  async getReconstructionProject(id: number): Promise<any> {
    const { reconstructionProjects } = await import("@shared/schema");
    const [result] = await db.select().from(reconstructionProjects).where(eq(reconstructionProjects.id, id));
    return result;
  }

  async updateReconstructionProject(id: number, updates: any): Promise<any> {
    const { reconstructionProjects } = await import("@shared/schema");
    const [result] = await db.update(reconstructionProjects).set(updates).where(eq(reconstructionProjects.id, id)).returning();
    return result;
  }

  // Job History operations
  async getAllJobs(): Promise<any[]> {
    const { coherenceDocuments, coherenceChunks, reconstructionProjects } = await import("@shared/schema");
    const { desc, sql } = await import("drizzle-orm");
    
    // Helper to extract base document ID (strips chunk index suffix like "-0", "-1", etc.)
    const getBaseDocId = (docId: string): string => {
      // Pattern: ue-TIMESTAMP-CHUNKINDEX -> extract ue-TIMESTAMP
      const match = docId.match(/^(ue-\d+)-\d+$/);
      return match ? match[1] : docId;
    };
    
    // First, get ALL chunks from coherence_chunks directly
    const allChunks = await db
      .select({
        documentId: coherenceChunks.documentId,
        coherenceMode: coherenceChunks.coherenceMode,
        chunkIndex: coherenceChunks.chunkIndex,
        chunkText: coherenceChunks.chunkText,
        createdAt: coherenceChunks.createdAt,
      })
      .from(coherenceChunks)
      .orderBy(desc(coherenceChunks.createdAt));
    
    // Define chunk type
    type ChunkRow = { documentId: string; coherenceMode: string; chunkIndex: number; chunkText: string | null; createdAt: Date; };
    
    // Group chunks by BASE documentId (stripping the chunk index suffix)
    const chunksByBaseDocId: Record<string, ChunkRow[]> = {};
    for (const chunk of allChunks) {
      const baseDocId = getBaseDocId(chunk.documentId);
      if (!chunksByBaseDocId[baseDocId]) {
        chunksByBaseDocId[baseDocId] = [];
      }
      chunksByBaseDocId[baseDocId].push(chunk);
    }
    
    // Get coherence documents for additional metadata
    const coherenceDocs = await db
      .select({
        id: coherenceDocuments.id,
        documentId: coherenceDocuments.documentId,
        coherenceMode: coherenceDocuments.coherenceMode,
        globalState: coherenceDocuments.globalState,
        createdAt: coherenceDocuments.createdAt,
        updatedAt: coherenceDocuments.updatedAt,
      })
      .from(coherenceDocuments);
    
    const docsByDocId: Record<string, typeof coherenceDocs[0]> = {};
    for (const doc of coherenceDocs) {
      // Also index by base doc ID for parent lookup
      const baseDocId = getBaseDocId(doc.documentId);
      docsByDocId[doc.documentId] = doc;
      docsByDocId[baseDocId] = doc;
    }
    
    // Build jobs from chunks grouped by base document ID - this captures ALL jobs
    const coherenceJobs: any[] = [];
    
    for (const baseDocId of Object.keys(chunksByBaseDocId)) {
      const chunks = chunksByBaseDocId[baseDocId];
      const parentDoc = docsByDocId[baseDocId];
      const lastChunkTime = Math.max(...chunks.map((c: ChunkRow) => new Date(c.createdAt).getTime()));
      const firstChunkTime = Math.min(...chunks.map((c: ChunkRow) => new Date(c.createdAt).getTime()));
      const timeSinceLastActivity = Date.now() - lastChunkTime;
      
      // Check for stitched output in parent doc
      const hasStitchedOutput = parentDoc && (parentDoc.globalState as any)?.stitchedDocument;
      
      // Determine status
      let status = 'completed';
      if (!hasStitchedOutput) {
        status = timeSinceLastActivity > 60000 ? 'interrupted' : 'in-progress';
      }
      
      coherenceJobs.push({
        id: parentDoc?.id || 0,
        documentId: baseDocId,  // Use base doc ID for the job
        coherenceMode: parentDoc?.coherenceMode || chunks[0]?.coherenceMode || 'unknown',
        globalState: parentDoc?.globalState || {},
        createdAt: parentDoc?.createdAt || new Date(firstChunkTime),
        updatedAt: parentDoc?.updatedAt || new Date(lastChunkTime),
        type: 'coherence',
        chunkCount: chunks.length,  // Now correctly counts all chunks for this job
        status,
        lastActivity: new Date(lastChunkTime),
      });
    }
    
    // Get reconstruction projects
    const reconstructions = await db
      .select()
      .from(reconstructionProjects)
      .orderBy(desc(reconstructionProjects.createdAt));
    
    const reconstructionJobs = reconstructions.map(r => ({
      ...r,
      documentId: `reconstruction-${r.id}`,
      type: 'reconstruction',
      chunkCount: 0,
      coherenceMode: 'reconstruction',
      lastActivity: r.createdAt,
    }));
    
    // Combine and sort by date
    const allJobs = [...coherenceJobs, ...reconstructionJobs]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    console.log(`[Storage] getAllJobs found ${coherenceJobs.length} coherence jobs, ${reconstructionJobs.length} reconstruction jobs`);
    
    return allJobs;
  }

  async getJobWithChunks(documentId: string): Promise<{ document: any; chunks: any[] } | null> {
    const { coherenceDocuments, coherenceChunks } = await import("@shared/schema");
    const { like } = await import("drizzle-orm");
    
    // Handle base doc ID pattern - chunks have documentId like "ue-TIMESTAMP-CHUNKINDEX"
    // If documentId is a base ID (like "ue-1767891554531"), find all chunks that match the pattern
    const isBaseDocId = /^ue-\d+$/.test(documentId);
    
    let chunks: any[];
    if (isBaseDocId) {
      // Fetch all chunks that start with this base document ID
      chunks = await db
        .select()
        .from(coherenceChunks)
        .where(like(coherenceChunks.documentId, `${documentId}-%`))
        .orderBy(coherenceChunks.chunkIndex);
    } else {
      // Try exact match first
      chunks = await db
        .select()
        .from(coherenceChunks)
        .where(eq(coherenceChunks.documentId, documentId))
        .orderBy(coherenceChunks.chunkIndex);
    }
    
    // Get parent document if it exists (try both base and exact ID)
    let document = await db
      .select()
      .from(coherenceDocuments)
      .where(eq(coherenceDocuments.documentId, documentId))
      .then(rows => rows[0]);
    
    if (!document && isBaseDocId) {
      // Try to find by like pattern
      document = await db
        .select()
        .from(coherenceDocuments)
        .where(like(coherenceDocuments.documentId, `${documentId}%`))
        .then(rows => rows[0]);
    }
    
    // If no chunks exist, this job doesn't exist
    if (chunks.length === 0 && !document) return null;
    
    // Create a synthetic document from chunks if no parent document exists
    const effectiveDocument = document || {
      id: 0,
      documentId,
      coherenceMode: chunks[0]?.coherenceMode || 'unknown',
      globalState: {},
      createdAt: chunks.length > 0 ? new Date(Math.min(...chunks.map(c => new Date(c.createdAt).getTime()))) : new Date(),
      updatedAt: chunks.length > 0 ? new Date(Math.max(...chunks.map(c => new Date(c.createdAt).getTime()))) : new Date(),
    };
    
    return { document: effectiveDocument, chunks };
  }

  async getJobChunks(documentId: string): Promise<any[]> {
    const { coherenceChunks } = await import("@shared/schema");
    const { like } = await import("drizzle-orm");
    
    // Handle base doc ID pattern - chunks have documentId like "ue-TIMESTAMP-CHUNKINDEX"
    const isBaseDocId = /^ue-\d+$/.test(documentId);
    
    if (isBaseDocId) {
      return await db
        .select()
        .from(coherenceChunks)
        .where(like(coherenceChunks.documentId, `${documentId}-%`))
        .orderBy(coherenceChunks.chunkIndex);
    }
    
    return await db
      .select()
      .from(coherenceChunks)
      .where(eq(coherenceChunks.documentId, documentId))
      .orderBy(coherenceChunks.chunkIndex);
  }
}

export const storage = new DatabaseStorage();
