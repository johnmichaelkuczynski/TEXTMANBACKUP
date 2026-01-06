import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { 
  reconstructionDocuments, 
  reconstructionChunks, 
  stitchResults,
  reconstructionRuns,
  type GlobalSkeleton,
  type ChunkDelta,
  type StitchResult
} from "@shared/schema";
import { eq, and, lt, asc } from "drizzle-orm";
import { safeDbInsert, safeDbUpdate, safeDbInsertRequired, safeDbUpdateRequired } from './dbHelper';

const anthropic = new Anthropic();
const PRIMARY_MODEL = "claude-sonnet-4-5-20250929";
const CHUNK_SIZE_WORDS = 1000;
const CHUNK_DELAY_MS = 15000;
const WORD_THRESHOLD = 1000;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

export interface ProcessingProgress {
  sessionId: number;
  stage: 'skeleton' | 'chunking' | 'stitching' | 'repair' | 'complete' | 'aborted';
  currentChunk: number;
  totalChunks: number;
  chunkOutput?: string;
  elapsedMs: number;
  estimatedRemainingMs?: number;
}

interface DBEnforcedResult {
  success: boolean;
  sessionId: number;
  reconstructedText: string;
  wordCount: number;
  stitchResult?: StitchResult;
  chunksProcessed: number;
  wasAborted?: boolean;
  error?: string;
}

export async function shouldUseDBEnforced(text: string): Promise<boolean> {
  const wordCount = countWords(text);
  const shouldUse = wordCount >= WORD_THRESHOLD;
  if (shouldUse) {
    console.log(`[DB-CC] Word count ${wordCount} >= ${WORD_THRESHOLD} threshold - using database-enforced architecture`);
  }
  return shouldUse;
}

export async function createSession(
  text: string,
  customInstructions?: string,
  audienceParameters?: string,
  rigorLevel?: string
): Promise<number> {
  const wordCount = countWords(text);
  console.log(`[DB-CC] Creating session for ${wordCount} word document`);
  
  try {
    console.log(`[DB] Inserting reconstructionDocuments, wordCount: ${wordCount}`);
    const [session] = await db.insert(reconstructionDocuments).values({
      originalText: text,
      wordCount,
      status: 'pending',
      customInstructions,
      audienceParameters,
      rigorLevel,
    }).returning({ id: reconstructionDocuments.id });
    
    console.log(`[DB] Successfully inserted reconstructionDocuments, id: ${session.id}`);
    console.log(`[DB-CC] Session created with ID: ${session.id}`);
    return session.id;
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert reconstructionDocuments:`, dbError.message, dbError.stack);
    throw new Error(`Database insert failed for createSession: ${dbError.message}`);
  }
}

export async function extractAndStoreSkeleton(sessionId: number): Promise<GlobalSkeleton> {
  console.log(`[DB-CC] Pass 1: Extracting global skeleton for session ${sessionId}`);
  const startTime = Date.now();
  
  const [session] = await db.select().from(reconstructionDocuments).where(eq(reconstructionDocuments.id, sessionId));
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  
  const skeletonPrompt = `You are analyzing a document to extract its global structure. Do NOT process the content yet. Only extract:

1. THESIS: The central claim or purpose (one sentence)
2. OUTLINE: 8-20 numbered sections/claims that structure the whole
3. KEY_TERMS: Important terms with their intended definitions
4. COMMITMENTS: What positions are asserted, rejected, or assumed
5. ENTITIES: Key people, concepts, variables, or proper nouns
6. METHODOLOGY: How arguments are structured or evidence is evaluated
7. TARGET_CONCLUSION: What the final output must establish

DOCUMENT:
${session.originalText}

Return as JSON only. No commentary outside the JSON:
{
  "thesis": "...",
  "outline": ["Section 1: ...", "Section 2: ...", ...],
  "keyTerms": [{"term": "...", "meaning": "..."}],
  "commitmentLedger": [{"type": "asserts|rejects|assumes", "claim": "..."}],
  "entities": [{"name": "...", "type": "...", "role": "..."}],
  "methodology": "...",
  "targetConclusion": "..."
}`;

  const message = await anthropic.messages.create({
    model: PRIMARY_MODEL,
    max_tokens: 4000,
    temperature: 0.2,
    messages: [{ role: "user", content: skeletonPrompt }]
  });
  
  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
  
  let skeleton: GlobalSkeleton;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in skeleton response");
    const parsed = JSON.parse(jsonMatch[0]);
    skeleton = {
      outline: parsed.outline || [],
      thesis: parsed.thesis || '',
      keyTerms: parsed.keyTerms || parsed.key_terms || [],
      commitmentLedger: parsed.commitmentLedger || parsed.commitments?.map((c: string) => ({ type: 'asserts', claim: c })) || [],
      entities: parsed.entities || [],
      audienceParameters: session.audienceParameters || undefined,
      rigorLevel: session.rigorLevel || undefined,
    };
  } catch (e) {
    console.error("[DB-CC] Skeleton parsing failed:", e);
    throw new Error("Failed to parse skeleton response");
  }
  
  try {
    console.log(`[DB] Updating reconstructionDocuments with skeleton, sessionId: ${sessionId}`);
    await db.update(reconstructionDocuments)
      .set({ 
        globalSkeleton: skeleton as any,
        status: 'skeleton_complete',
        updatedAt: new Date()
      })
      .where(eq(reconstructionDocuments.id, sessionId));
    console.log(`[DB] Successfully updated reconstructionDocuments with skeleton`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to update reconstructionDocuments with skeleton:`, dbError.message, dbError.stack);
    throw new Error(`Database update failed for skeleton: ${dbError.message}`);
  }
  
  try {
    console.log(`[DB] Inserting reconstructionRuns (skeleton), sessionId: ${sessionId}`);
    await db.insert(reconstructionRuns).values({
      documentId: sessionId,
      runType: 'skeleton',
      runOutput: skeleton as any,
      durationMs: Date.now() - startTime
    });
    console.log(`[DB] Successfully inserted reconstructionRuns (skeleton)`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert reconstructionRuns (skeleton):`, dbError.message, dbError.stack);
  }
  
  console.log(`[DB-CC] Skeleton written to database for session ${sessionId}`);
  console.log(`[DB-CC] Skeleton: ${skeleton.outline.length} outline items, ${skeleton.keyTerms.length} terms, ${skeleton.commitmentLedger.length} commitments`);
  
  return skeleton;
}

export async function chunkDocument(sessionId: number): Promise<number> {
  console.log(`[DB-CC] Chunking document for session ${sessionId}`);
  
  const [session] = await db.select().from(reconstructionDocuments).where(eq(reconstructionDocuments.id, sessionId));
  if (!session) throw new Error(`Session ${sessionId} not found`);
  
  const text = session.originalText;
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  
  const chunks: { text: string; words: number }[] = [];
  let currentChunk = '';
  let currentWords = 0;
  
  for (const para of paragraphs) {
    const paraWords = countWords(para);
    
    if (currentWords + paraWords > CHUNK_SIZE_WORDS && currentWords > 0) {
      chunks.push({ text: currentChunk.trim(), words: currentWords });
      currentChunk = para;
      currentWords = paraWords;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
      currentWords += paraWords;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push({ text: currentChunk.trim(), words: currentWords });
  }
  
  for (let i = 0; i < chunks.length; i++) {
    try {
      console.log(`[DB] Inserting reconstructionChunks, chunk ${i}, sessionId: ${sessionId}, words: ${chunks[i].words}`);
      await db.insert(reconstructionChunks).values({
        documentId: sessionId,
        chunkIndex: i,
        chunkInputText: chunks[i].text,
        chunkInputWords: chunks[i].words,
        status: 'pending'
      });
      console.log(`[DB] Successfully inserted reconstructionChunks chunk ${i}`);
      console.log(`[DB-CC] Chunk ${i + 1}/${chunks.length} written to database (${chunks[i].words} words)`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to insert reconstructionChunks chunk ${i}:`, dbError.message, dbError.stack);
      throw new Error(`Database insert failed for chunk ${i}: ${dbError.message}`);
    }
  }
  
  try {
    console.log(`[DB] Updating reconstructionDocuments with numChunks: ${chunks.length}`);
    await db.update(reconstructionDocuments)
      .set({ 
        numChunks: chunks.length,
        status: 'chunking',
        updatedAt: new Date()
      })
      .where(eq(reconstructionDocuments.id, sessionId));
    console.log(`[DB] Successfully updated reconstructionDocuments with numChunks`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to update reconstructionDocuments with numChunks:`, dbError.message, dbError.stack);
  }
  
  console.log(`[DB-CC] Created ${chunks.length} chunks for session ${sessionId}`);
  return chunks.length;
}

async function getSkeletonFromDB(sessionId: number): Promise<GlobalSkeleton> {
  const [session] = await db.select({ globalSkeleton: reconstructionDocuments.globalSkeleton })
    .from(reconstructionDocuments)
    .where(eq(reconstructionDocuments.id, sessionId));
  
  if (!session?.globalSkeleton) {
    throw new Error(`Skeleton not found for session ${sessionId}`);
  }
  
  console.log(`[DB-CC] Skeleton retrieved from database for session ${sessionId}`);
  return session.globalSkeleton as GlobalSkeleton;
}

async function getPriorDeltas(sessionId: number, currentIndex: number): Promise<ChunkDelta[]> {
  const priorChunks = await db.select({ chunkDelta: reconstructionChunks.chunkDelta })
    .from(reconstructionChunks)
    .where(and(
      eq(reconstructionChunks.documentId, sessionId),
      lt(reconstructionChunks.chunkIndex, currentIndex)
    ))
    .orderBy(asc(reconstructionChunks.chunkIndex));
  
  console.log(`[DB-CC] Retrieved ${priorChunks.length} prior deltas from database`);
  return priorChunks.map(c => c.chunkDelta as ChunkDelta).filter(Boolean);
}

async function checkAborted(sessionId: number): Promise<boolean> {
  const [session] = await db.select({ status: reconstructionDocuments.status })
    .from(reconstructionDocuments)
    .where(eq(reconstructionDocuments.id, sessionId));
  
  if (session?.status === 'aborted') {
    console.log(`[DB-CC] Session ${sessionId} was aborted`);
    return true;
  }
  return false;
}

export async function processChunk(
  sessionId: number,
  chunkIndex: number,
  totalChunks: number,
  onProgress?: (progress: ProcessingProgress) => void,
  startTime?: number
): Promise<{ output: string; delta: ChunkDelta }> {
  console.log(`[DB-CC] Processing chunk ${chunkIndex + 1}/${totalChunks} for session ${sessionId}`);
  const chunkStartTime = Date.now();
  
  if (await checkAborted(sessionId)) {
    throw new Error('ABORTED');
  }
  
  const skeleton = await getSkeletonFromDB(sessionId);
  const priorDeltas = await getPriorDeltas(sessionId, chunkIndex);
  
  const [chunk] = await db.select()
    .from(reconstructionChunks)
    .where(and(
      eq(reconstructionChunks.documentId, sessionId),
      eq(reconstructionChunks.chunkIndex, chunkIndex)
    ));
  
  if (!chunk) {
    throw new Error(`Chunk ${chunkIndex} not found for session ${sessionId}`);
  }
  
  try {
    console.log(`[DB] Updating reconstructionChunks to processing, chunkId: ${chunk.id}`);
    await db.update(reconstructionChunks)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(reconstructionChunks.id, chunk.id));
    console.log(`[DB] Successfully updated reconstructionChunks to processing`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to update reconstructionChunks to processing:`, dbError.message, dbError.stack);
  }
  
  const priorDeltasSummary = priorDeltas.length > 0
    ? priorDeltas.map((d, i) => `Chunk ${i + 1}: Added claims: ${d.newClaimsIntroduced?.slice(0, 3).join('; ') || 'none'}`).join('\n')
    : 'This is the first chunk.';
  
  const chunkPrompt = `You are processing chunk ${chunkIndex + 1} of ${totalChunks}.

GLOBAL SKELETON (you must not contradict this):
${JSON.stringify(skeleton, null, 2)}

PRIOR CHUNK SUMMARIES:
${priorDeltasSummary}

CHUNK TO PROCESS:
${chunk.chunkInputText}

INSTRUCTIONS:
- Reconstruct this chunk with charitable interpretation - make the argument as strong as possible
- Do not contradict the skeleton's commitments or definitions
- If you detect a conflict, flag it and propose a minimal repair
- Track what claims you add, remove, or modify
- Preserve the approximate length of the input

Return JSON only:
{
  "chunk_output": "your reconstructed text for this chunk",
  "delta": {
    "newClaimsIntroduced": ["claim 1", "claim 2"],
    "termsUsed": ["term1", "term2"],
    "conflictsDetected": [{"skeletonItem": "...", "chunkContent": "...", "description": "..."}],
    "ledgerAdditions": [{"type": "asserts", "claim": "..."}]
  }
}`;

  const message = await anthropic.messages.create({
    model: PRIMARY_MODEL,
    max_tokens: 8000,
    temperature: 0.5,
    messages: [{ role: "user", content: chunkPrompt }]
  });
  
  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
  
  let output = '';
  let delta: ChunkDelta = {
    newClaimsIntroduced: [],
    termsUsed: [],
    conflictsDetected: [],
    ledgerAdditions: []
  };
  
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      output = parsed.chunk_output || parsed.chunkOutput || '';
      delta = parsed.delta || delta;
    }
  } catch (e) {
    console.log("[DB-CC] Chunk response parsing failed, using raw text");
    output = responseText;
  }
  
  const outputWords = countWords(output);
  
  try {
    console.log(`[DB] Updating reconstructionChunks with output, chunkId: ${chunk.id}, words: ${outputWords}`);
    await db.update(reconstructionChunks)
      .set({
        chunkOutputText: output,
        actualWords: outputWords,
        chunkDelta: delta as any,
        status: 'completed',
        updatedAt: new Date()
      })
      .where(eq(reconstructionChunks.id, chunk.id));
    console.log(`[DB] Successfully updated reconstructionChunks with output`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to update reconstructionChunks with output:`, dbError.message, dbError.stack);
    throw new Error(`Database update failed for chunk output: ${dbError.message}`);
  }
  
  try {
    console.log(`[DB] Inserting reconstructionRuns (chunk_pass), sessionId: ${sessionId}, chunkIndex: ${chunkIndex}`);
    await db.insert(reconstructionRuns).values({
      documentId: sessionId,
      runType: 'chunk_pass',
      chunkIndex,
      runOutput: { output: output.slice(0, 500), delta } as any,
      durationMs: Date.now() - chunkStartTime
    });
    console.log(`[DB] Successfully inserted reconstructionRuns (chunk_pass)`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert reconstructionRuns (chunk_pass):`, dbError.message, dbError.stack);
  }
  
  console.log(`[DB-CC] Chunk ${chunkIndex + 1}/${totalChunks} completed: ${outputWords} words written to database`);
  
  try {
    console.log(`[DB] Updating reconstructionDocuments currentChunk: ${chunkIndex + 1}`);
    await db.update(reconstructionDocuments)
      .set({ currentChunk: chunkIndex + 1, updatedAt: new Date() })
      .where(eq(reconstructionDocuments.id, sessionId));
    console.log(`[DB] Successfully updated reconstructionDocuments currentChunk`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to update reconstructionDocuments currentChunk:`, dbError.message, dbError.stack);
  }
  
  if (onProgress) {
    const elapsed = startTime ? Date.now() - startTime : 0;
    const avgChunkTime = elapsed / (chunkIndex + 1);
    const remainingChunks = totalChunks - chunkIndex - 1;
    
    onProgress({
      sessionId,
      stage: 'chunking',
      currentChunk: chunkIndex + 1,
      totalChunks,
      chunkOutput: output,
      elapsedMs: elapsed,
      estimatedRemainingMs: remainingChunks * avgChunkTime
    });
  }
  
  return { output, delta };
}

export async function performStitch(sessionId: number): Promise<StitchResult> {
  console.log(`[DB-CC] Pass 3: Performing global stitch for session ${sessionId}`);
  const startTime = Date.now();
  
  const skeleton = await getSkeletonFromDB(sessionId);
  
  const chunks = await db.select()
    .from(reconstructionChunks)
    .where(eq(reconstructionChunks.documentId, sessionId))
    .orderBy(asc(reconstructionChunks.chunkIndex));
  
  const deltas = chunks.map(c => c.chunkDelta as ChunkDelta);
  
  const stitchPrompt = `You are performing a global coherence check.

GLOBAL SKELETON:
${JSON.stringify(skeleton, null, 2)}

CHUNK DELTAS (one per chunk):
${JSON.stringify(deltas.map((d, i) => ({ chunk: i + 1, ...d })), null, 2)}

YOUR TASK:
1. Identify cross-chunk contradictions (Chunk A says X but Chunk B says not-X)
2. Identify terminology drift (a term used differently across chunks)
3. Identify missing premises (claims made without proper setup)
4. Identify redundancies (same point made multiple times)
5. Generate a repair plan for any issues found
6. Determine coherence score: "pass" if no major issues, "needs_repair" otherwise

Return JSON only:
{
  "contradictions": [{"chunk1": 0, "chunk2": 1, "description": "..."}],
  "terminologyDrift": [{"term": "...", "chunk": 0, "originalMeaning": "...", "driftedMeaning": "..."}],
  "missingPremises": [{"location": 0, "description": "..."}],
  "redundancies": [{"chunks": [0, 2], "description": "..."}],
  "repairPlan": [{"chunkIndex": 0, "repairAction": "..."}],
  "coherenceScore": "pass"
}`;

  const message = await anthropic.messages.create({
    model: PRIMARY_MODEL,
    max_tokens: 4000,
    temperature: 0.2,
    messages: [{ role: "user", content: stitchPrompt }]
  });
  
  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
  
  let stitchResult: StitchResult = {
    contradictions: [],
    terminologyDrift: [],
    missingPremises: [],
    redundancies: [],
    repairPlan: []
  };
  let coherenceScore = 'pass';
  
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      stitchResult = {
        contradictions: parsed.contradictions || [],
        terminologyDrift: parsed.terminologyDrift || [],
        missingPremises: parsed.missingPremises || [],
        redundancies: parsed.redundancies || [],
        repairPlan: parsed.repairPlan || []
      };
      coherenceScore = parsed.coherenceScore || 'pass';
    }
  } catch (e) {
    console.log("[DB-CC] Stitch parsing failed");
  }
  
  try {
    console.log(`[DB] Inserting stitchResults, sessionId: ${sessionId}, score: ${coherenceScore}`);
    await db.insert(stitchResults).values({
      documentId: sessionId,
      conflicts: stitchResult.contradictions as any,
      termDrift: stitchResult.terminologyDrift as any,
      missingPremises: stitchResult.missingPremises as any,
      redundancies: stitchResult.redundancies as any,
      repairPlan: stitchResult.repairPlan as any,
      coherenceScore,
      finalValidation: { score: coherenceScore, timestamp: new Date().toISOString() } as any
    });
    console.log(`[DB] Successfully inserted stitchResults`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert stitchResults:`, dbError.message, dbError.stack);
  }
  
  try {
    console.log(`[DB] Inserting reconstructionRuns (stitch), sessionId: ${sessionId}`);
    await db.insert(reconstructionRuns).values({
      documentId: sessionId,
      runType: 'stitch',
      runOutput: { result: stitchResult, score: coherenceScore } as any,
      durationMs: Date.now() - startTime
    });
    console.log(`[DB] Successfully inserted reconstructionRuns (stitch)`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert reconstructionRuns (stitch):`, dbError.message, dbError.stack);
  }
  
  console.log(`[DB-CC] Stitch complete for session ${sessionId}: ${coherenceScore}`);
  console.log(`[DB-CC] Issues: ${stitchResult.contradictions.length} contradictions, ${stitchResult.terminologyDrift.length} term drifts, ${stitchResult.repairPlan.length} repairs needed`);
  
  return stitchResult;
}

export async function assembleOutput(sessionId: number): Promise<string> {
  const chunks = await db.select({ output: reconstructionChunks.chunkOutputText })
    .from(reconstructionChunks)
    .where(eq(reconstructionChunks.documentId, sessionId))
    .orderBy(asc(reconstructionChunks.chunkIndex));
  
  const finalOutput = chunks.map(c => c.output).filter(Boolean).join('\n\n');
  const wordCount = countWords(finalOutput);
  
  try {
    console.log(`[DB] Updating reconstructionDocuments with final output, sessionId: ${sessionId}, words: ${wordCount}`);
    await db.update(reconstructionDocuments)
      .set({
        finalOutput,
        finalWordCount: wordCount,
        status: 'complete',
        updatedAt: new Date()
      })
      .where(eq(reconstructionDocuments.id, sessionId));
    console.log(`[DB] Successfully updated reconstructionDocuments with final output`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to update reconstructionDocuments with final output:`, dbError.message, dbError.stack);
  }
  
  console.log(`[DB-CC] Final output assembled for session ${sessionId}: ${wordCount} words`);
  return finalOutput;
}

export async function abortSession(sessionId: number): Promise<void> {
  console.log(`[DB-CC] Aborting session ${sessionId}`);
  
  await db.update(reconstructionDocuments)
    .set({
      status: 'aborted',
      abortedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(reconstructionDocuments.id, sessionId));
}

export async function getPartialOutput(sessionId: number): Promise<string> {
  const chunks = await db.select({ output: reconstructionChunks.chunkOutputText })
    .from(reconstructionChunks)
    .where(and(
      eq(reconstructionChunks.documentId, sessionId),
      eq(reconstructionChunks.status, 'completed')
    ))
    .orderBy(asc(reconstructionChunks.chunkIndex));
  
  return chunks.map(c => c.output).filter(Boolean).join('\n\n');
}

export async function resumeFromLastChunk(sessionId: number): Promise<number> {
  const [lastChunk] = await db.select({ chunkIndex: reconstructionChunks.chunkIndex })
    .from(reconstructionChunks)
    .where(and(
      eq(reconstructionChunks.documentId, sessionId),
      eq(reconstructionChunks.status, 'completed')
    ))
    .orderBy(asc(reconstructionChunks.chunkIndex))
    .limit(1);
  
  const resumeFrom = lastChunk ? lastChunk.chunkIndex + 1 : 0;
  console.log(`[DB-CC] Resuming session ${sessionId} from chunk ${resumeFrom}`);
  return resumeFrom;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runFullReconstruction(
  text: string,
  customInstructions?: string,
  audienceParameters?: string,
  rigorLevel?: string,
  onProgress?: (progress: ProcessingProgress) => void
): Promise<DBEnforcedResult> {
  const startTime = Date.now();
  
  const wordCount = countWords(text);
  if (wordCount < WORD_THRESHOLD) {
    console.log(`[DB-CC] Document ${wordCount} words < ${WORD_THRESHOLD} threshold - use standard processing`);
    throw new Error(`Document too short for DB-enforced processing (${wordCount} < ${WORD_THRESHOLD})`);
  }
  
  console.log(`[DB-CC] ========================================`);
  console.log(`[DB-CC] Starting DB-enforced reconstruction`);
  console.log(`[DB-CC] Input: ${wordCount} words`);
  console.log(`[DB-CC] ========================================`);
  
  const sessionId = await createSession(text, customInstructions, audienceParameters, rigorLevel);
  
  try {
    if (onProgress) {
      onProgress({ sessionId, stage: 'skeleton', currentChunk: 0, totalChunks: 0, elapsedMs: Date.now() - startTime });
    }
    
    await extractAndStoreSkeleton(sessionId);
    const totalChunks = await chunkDocument(sessionId);
    
    for (let i = 0; i < totalChunks; i++) {
      if (await checkAborted(sessionId)) {
        const partialOutput = await getPartialOutput(sessionId);
        return {
          success: false,
          sessionId,
          reconstructedText: partialOutput,
          wordCount: countWords(partialOutput),
          chunksProcessed: i,
          wasAborted: true
        };
      }
      
      await processChunk(sessionId, i, totalChunks, onProgress, startTime);
      
      if (i < totalChunks - 1) {
        console.log(`[DB-CC] Waiting ${CHUNK_DELAY_MS / 1000}s before next chunk...`);
        await delay(CHUNK_DELAY_MS);
      }
    }
    
    if (onProgress) {
      onProgress({ sessionId, stage: 'stitching', currentChunk: totalChunks, totalChunks, elapsedMs: Date.now() - startTime });
    }
    
    const stitchResult = await performStitch(sessionId);
    const finalOutput = await assembleOutput(sessionId);
    
    if (onProgress) {
      onProgress({ sessionId, stage: 'complete', currentChunk: totalChunks, totalChunks, elapsedMs: Date.now() - startTime });
    }
    
    console.log(`[DB-CC] ========================================`);
    console.log(`[DB-CC] Reconstruction complete`);
    console.log(`[DB-CC] Output: ${countWords(finalOutput)} words`);
    console.log(`[DB-CC] Duration: ${(Date.now() - startTime) / 1000}s`);
    console.log(`[DB-CC] ========================================`);
    
    return {
      success: true,
      sessionId,
      reconstructedText: finalOutput,
      wordCount: countWords(finalOutput),
      stitchResult,
      chunksProcessed: totalChunks
    };
    
  } catch (error: any) {
    if (error.message === 'ABORTED') {
      const partialOutput = await getPartialOutput(sessionId);
      return {
        success: false,
        sessionId,
        reconstructedText: partialOutput,
        wordCount: countWords(partialOutput),
        chunksProcessed: 0,
        wasAborted: true
      };
    }
    
    await db.update(reconstructionDocuments)
      .set({
        status: 'failed',
        errorMessage: error.message,
        updatedAt: new Date()
      })
      .where(eq(reconstructionDocuments.id, sessionId));
    
    throw error;
  }
}
