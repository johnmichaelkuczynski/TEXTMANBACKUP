import { WebSocket, WebSocketServer } from 'ws';
import { Server } from 'http';
import { db } from '../db';
import { 
  reconstructionDocuments, 
  reconstructionChunks,
  InsertReconstructionDocument,
  InsertReconstructionChunk,
  GlobalSkeleton,
  ChunkDelta
} from '@shared/schema';
import { eq, and, asc } from 'drizzle-orm';
import { 
  extractGlobalSkeleton, 
  smartChunk, 
  reconstructChunkConstrained,
  stitchAndValidate,
  parseTargetLength,
  calculateLengthConfig
} from './crossChunkCoherence';

interface CCJob {
  id: number;
  status: string;
  totalChunks: number;
  completedChunks: number;
  targetWords: number;
  currentWords: number;
}

interface ClientMessage {
  type: 'start_job' | 'abort_job' | 'resume_job' | 'get_status';
  jobId?: number;
  text?: string;
  customInstructions?: string;
  audienceParameters?: string;
  rigorLevel?: string;
}

interface ChunkCompleteMessage {
  type: 'chunk_complete';
  jobId: number;
  chunkIndex: number;
  totalChunks: number;
  chunkText: string;
  actualWords: number;
  targetWords: number;
  minWords: number;
  maxWords: number;
  runningTotal: number;
  projectedFinal: number;
  status: 'on_target' | 'retrying' | 'passed_after_retry' | 'flagged';
}

interface ProgressMessage {
  type: 'progress';
  jobId: number;
  phase: 'initializing' | 'skeleton_extraction' | 'chunk_processing' | 'stitching' | 'complete' | 'failed' | 'aborted';
  message: string;
  completedChunks?: number;
  totalChunks?: number;
  wordsProcessed?: number;
  targetWords?: number;
  projectedFinal?: number;
  timeElapsed?: number;
  estimatedRemaining?: number;
}

interface WarningMessage {
  type: 'warning';
  jobId: number;
  message: string;
  projectedFinal: number;
  targetWords: number;
  shortfall: number;
}

const activeJobs = new Map<number, { aborted: boolean; startTime: number }>();
const clientConnections = new Map<WebSocket, number | null>();

let wss: WebSocketServer | null = null;

export function setupWebSocketServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws/cc-stream' });
  
  wss.on('connection', (ws: WebSocket) => {
    console.log('[CC-WS] Client connected');
    clientConnections.set(ws, null);
    
    ws.on('message', async (data: Buffer) => {
      try {
        const message: ClientMessage = JSON.parse(data.toString());
        await handleClientMessage(ws, message);
      } catch (error: any) {
        sendError(ws, `Failed to parse message: ${error.message}`);
      }
    });
    
    ws.on('close', () => {
      console.log('[CC-WS] Client disconnected');
      clientConnections.delete(ws);
    });
    
    ws.on('error', (error) => {
      console.error('[CC-WS] WebSocket error:', error);
    });
  });
  
  console.log('[CC-WS] WebSocket server initialized on /ws/cc-stream');
  return wss;
}

function sendToClient(ws: WebSocket, message: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws: WebSocket, error: string): void {
  sendToClient(ws, { type: 'error', message: error });
}

function broadcastToJob(jobId: number, message: any): void {
  clientConnections.forEach((subscribedJobId, ws) => {
    if (subscribedJobId === jobId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
}

async function handleClientMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
  switch (message.type) {
    case 'start_job':
      if (!message.text) {
        sendError(ws, 'Text is required to start a job');
        return;
      }
      await startStreamingJob(ws, message.text, message.customInstructions, message.audienceParameters, message.rigorLevel);
      break;
      
    case 'abort_job':
      if (!message.jobId) {
        sendError(ws, 'Job ID is required to abort');
        return;
      }
      await abortJob(ws, message.jobId);
      break;
      
    case 'resume_job':
      if (!message.jobId) {
        sendError(ws, 'Job ID is required to resume');
        return;
      }
      await resumeJob(ws, message.jobId);
      break;
      
    case 'get_status':
      if (message.jobId) {
        await getJobStatus(ws, message.jobId);
      }
      break;
  }
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

async function startStreamingJob(
  ws: WebSocket,
  text: string,
  customInstructions?: string,
  audienceParameters?: string,
  rigorLevel?: string
): Promise<void> {
  const wordCount = countWords(text);
  
  if (wordCount > 20000) {
    sendError(ws, `Input exceeds maximum of 20,000 words (got ${wordCount})`);
    return;
  }
  
  if (wordCount <= 500) {
    sendError(ws, `Document too short for CC processing (${wordCount} words). Use standard reconstruction.`);
    return;
  }
  
  const parsedLength = parseTargetLength(customInstructions);
  const lengthConfig = calculateLengthConfig(
    wordCount,
    parsedLength?.targetMin ?? null,
    parsedLength?.targetMax ?? null,
    customInstructions
  );
  
  const chunks = smartChunk(text);
  
  let job: any;
  try {
    console.log(`[DB] Inserting reconstructionDocuments, wordCount: ${wordCount}`);
    [job] = await db.insert(reconstructionDocuments).values({
      originalText: text,
      wordCount,
      status: 'pending',
      targetMinWords: lengthConfig.targetMin,
      targetMaxWords: lengthConfig.targetMax,
      targetMidWords: lengthConfig.targetMid,
      lengthRatio: lengthConfig.lengthRatio,
      lengthMode: lengthConfig.lengthMode,
      chunkTargetWords: lengthConfig.chunkTargetWords,
      numChunks: chunks.length,
      currentChunk: 0,
      audienceParameters,
      rigorLevel,
      customInstructions
    }).returning();
    console.log(`[DB] Successfully inserted reconstructionDocuments, jobId: ${job.id}`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert reconstructionDocuments:`, dbError.message);
    sendError(ws, `Database error: ${dbError.message}`);
    return;
  }
  
  for (let i = 0; i < chunks.length; i++) {
    const chunkInputWords = chunks[i].wordCount;
    const chunkTarget = Math.round(chunkInputWords * lengthConfig.lengthRatio);
    
    try {
      console.log(`[DB] Inserting reconstructionChunks, chunkIndex: ${i}`);
      await db.insert(reconstructionChunks).values({
        documentId: job.id,
        chunkIndex: i,
        chunkInputText: chunks[i].text,
        chunkInputWords: chunkInputWords,
        targetWords: chunkTarget,
        minWords: Math.floor(chunkTarget * 0.85),
        maxWords: Math.ceil(chunkTarget * 1.15),
        status: 'pending'
      });
      console.log(`[DB] Successfully inserted reconstructionChunks chunkIndex ${i}`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to insert reconstructionChunks chunkIndex ${i}:`, dbError.message);
    }
  }
  
  clientConnections.set(ws, job.id);
  activeJobs.set(job.id, { aborted: false, startTime: Date.now() });
  
  sendToClient(ws, {
    type: 'job_started',
    jobId: job.id,
    totalChunks: chunks.length,
    inputWords: wordCount,
    targetWords: lengthConfig.targetMid,
    lengthMode: lengthConfig.lengthMode,
    lengthRatio: lengthConfig.lengthRatio
  });
  
  processJobAsync(job.id);
}

async function processJobAsync(jobId: number): Promise<void> {
  try {
    const [job] = await db.select().from(reconstructionDocuments).where(eq(reconstructionDocuments.id, jobId));
    if (!job) throw new Error(`Job ${jobId} not found`);
    
    const jobState = activeJobs.get(jobId);
    if (!jobState) return;
    
    broadcastProgress(jobId, 'skeleton_extraction', 'Extracting document structure...');
    
    try {
      console.log(`[DB] Updating reconstructionDocuments status to skeleton_extraction, jobId: ${jobId}`);
      await db.update(reconstructionDocuments)
        .set({ status: 'skeleton_extraction', updatedAt: new Date() })
        .where(eq(reconstructionDocuments.id, jobId));
      console.log(`[DB] Successfully updated reconstructionDocuments status`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update reconstructionDocuments status:`, dbError.message);
    }
    
    const skeleton = await extractGlobalSkeleton(
      job.originalText,
      job.audienceParameters || undefined,
      job.rigorLevel || undefined
    );
    
    try {
      console.log(`[DB] Updating reconstructionDocuments with skeleton, jobId: ${jobId}`);
      await db.update(reconstructionDocuments)
        .set({ globalSkeleton: skeleton, status: 'chunk_processing', updatedAt: new Date() })
        .where(eq(reconstructionDocuments.id, jobId));
      console.log(`[DB] Successfully updated reconstructionDocuments with skeleton`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update reconstructionDocuments with skeleton:`, dbError.message);
    }
    
    if (activeJobs.get(jobId)?.aborted) {
      await handleAbort(jobId);
      return;
    }
    
    broadcastProgress(jobId, 'chunk_processing', 'Processing chunks...');
    
    const chunks = await db.select()
      .from(reconstructionChunks)
      .where(eq(reconstructionChunks.documentId, jobId))
      .orderBy(asc(reconstructionChunks.chunkIndex));
    
    let runningWordCount = 0;
    const lengthConfig = {
      targetMin: job.targetMinWords!,
      targetMax: job.targetMaxWords!,
      targetMid: job.targetMidWords!,
      lengthRatio: job.lengthRatio!,
      lengthMode: job.lengthMode as any,
      chunkTargetWords: job.chunkTargetWords!
    };
    
    for (const chunk of chunks) {
      if (activeJobs.get(jobId)?.aborted) {
        await handleAbort(jobId);
        return;
      }
      
      try {
        console.log(`[DB] Updating reconstructionChunks status to processing, chunkId: ${chunk.id}`);
        await db.update(reconstructionChunks)
          .set({ status: 'processing', updatedAt: new Date() })
          .where(eq(reconstructionChunks.id, chunk.id));
        console.log(`[DB] Successfully updated reconstructionChunks status to processing`);
      } catch (dbError: any) {
        console.error(`[DB] FAILED to update reconstructionChunks status to processing:`, dbError.message);
      }
      
      const { outputText, delta } = await reconstructChunkConstrained(
        chunk.chunkInputText,
        chunk.chunkIndex,
        job.numChunks!,
        skeleton as GlobalSkeleton,
        undefined,
        undefined,
        undefined,
        lengthConfig
      );
      
      const actualWords = countWords(outputText);
      runningWordCount += actualWords;
      
      const isOnTarget = actualWords >= chunk.minWords! && actualWords <= chunk.maxWords!;
      const chunkStatus = isOnTarget ? 'on_target' : 'flagged';
      
      try {
        console.log(`[DB] Updating reconstructionChunks complete, chunkId: ${chunk.id}`);
        await db.update(reconstructionChunks)
          .set({ 
            chunkOutputText: outputText,
            actualWords,
            chunkDelta: delta,
            status: 'complete',
            updatedAt: new Date()
          })
          .where(eq(reconstructionChunks.id, chunk.id));
        console.log(`[DB] Successfully updated reconstructionChunks complete`);
      } catch (dbError: any) {
        console.error(`[DB] FAILED to update reconstructionChunks complete:`, dbError.message);
      }
      
      try {
        console.log(`[DB] Updating reconstructionDocuments currentChunk, jobId: ${jobId}`);
        await db.update(reconstructionDocuments)
          .set({ currentChunk: chunk.chunkIndex + 1, updatedAt: new Date() })
          .where(eq(reconstructionDocuments.id, jobId));
        console.log(`[DB] Successfully updated reconstructionDocuments currentChunk`);
      } catch (dbError: any) {
        console.error(`[DB] FAILED to update reconstructionDocuments currentChunk:`, dbError.message);
      }
      
      const projectedFinal = Math.round(runningWordCount / (chunk.chunkIndex + 1) * job.numChunks!);
      
      const chunkComplete: ChunkCompleteMessage = {
        type: 'chunk_complete',
        jobId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: job.numChunks!,
        chunkText: outputText,
        actualWords,
        targetWords: chunk.targetWords!,
        minWords: chunk.minWords!,
        maxWords: chunk.maxWords!,
        runningTotal: runningWordCount,
        projectedFinal,
        status: chunkStatus
      };
      
      broadcastToJob(jobId, chunkComplete);
      
      if (chunk.chunkIndex >= 19 && chunk.chunkIndex % 10 === 0) {
        const shortfall = ((job.targetMidWords! - projectedFinal) / job.targetMidWords!) * 100;
        if (shortfall > 25) {
          const warning: WarningMessage = {
            type: 'warning',
            jobId,
            message: `After ${chunk.chunkIndex + 1} chunks, projected final is ${projectedFinal} words. Target is ${job.targetMidWords} words. System is under-producing by ~${Math.round(shortfall)}%`,
            projectedFinal,
            targetWords: job.targetMidWords!,
            shortfall: Math.round(shortfall)
          };
          broadcastToJob(jobId, warning);
        }
      }
      
      const elapsed = Date.now() - jobState.startTime;
      const avgTimePerChunk = elapsed / (chunk.chunkIndex + 1);
      const remaining = avgTimePerChunk * (job.numChunks! - chunk.chunkIndex - 1);
      
      broadcastProgress(jobId, 'chunk_processing', `Processing chunk ${chunk.chunkIndex + 2} of ${job.numChunks}...`, {
        completedChunks: chunk.chunkIndex + 1,
        totalChunks: job.numChunks!,
        wordsProcessed: runningWordCount,
        targetWords: job.targetMidWords!,
        projectedFinal,
        timeElapsed: elapsed,
        estimatedRemaining: remaining
      });
      
      if (chunk.chunkIndex < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    broadcastProgress(jobId, 'stitching', 'Running global consistency check...');
    
    try {
      console.log(`[DB] Updating reconstructionDocuments status to stitching, jobId: ${jobId}`);
      await db.update(reconstructionDocuments)
        .set({ status: 'stitching', updatedAt: new Date() })
        .where(eq(reconstructionDocuments.id, jobId));
      console.log(`[DB] Successfully updated reconstructionDocuments status to stitching`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update reconstructionDocuments status to stitching:`, dbError.message);
    }
    
    const completedChunks = await db.select()
      .from(reconstructionChunks)
      .where(and(
        eq(reconstructionChunks.documentId, jobId),
        eq(reconstructionChunks.status, 'complete')
      ))
      .orderBy(asc(reconstructionChunks.chunkIndex));
    
    const chunksForStitch = completedChunks.map(c => ({
      text: c.chunkOutputText!,
      delta: (c.chunkDelta || {}) as ChunkDelta
    }));
    
    const { finalOutput, stitchResult } = await stitchAndValidate(
      skeleton as GlobalSkeleton,
      chunksForStitch
    );
    
    const finalWordCount = countWords(finalOutput);
    
    try {
      console.log(`[DB] Updating reconstructionDocuments with final output, jobId: ${jobId}, words: ${finalWordCount}`);
      await db.update(reconstructionDocuments)
        .set({ 
          finalOutput,
          finalWordCount,
          validationResult: stitchResult,
          status: 'complete',
          updatedAt: new Date()
        })
        .where(eq(reconstructionDocuments.id, jobId));
      console.log(`[DB] Successfully updated reconstructionDocuments with final output`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update reconstructionDocuments with final output:`, dbError.message);
    }
    
    broadcastToJob(jobId, {
      type: 'job_complete',
      jobId,
      finalOutput,
      finalWordCount,
      targetWords: job.targetMidWords,
      stitchResult,
      timeElapsed: Date.now() - jobState.startTime
    });
    
    activeJobs.delete(jobId);
    
  } catch (error: any) {
    console.error(`[CC-WS] Job ${jobId} failed:`, error);
    
    try {
      console.log(`[DB] Updating reconstructionDocuments to failed status, jobId: ${jobId}`);
      await db.update(reconstructionDocuments)
        .set({ status: 'failed', errorMessage: error.message, updatedAt: new Date() })
        .where(eq(reconstructionDocuments.id, jobId));
      console.log(`[DB] Successfully updated reconstructionDocuments to failed status`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update reconstructionDocuments to failed status:`, dbError.message);
    }
    
    broadcastToJob(jobId, {
      type: 'job_failed',
      jobId,
      error: error.message
    });
    
    activeJobs.delete(jobId);
  }
}

function broadcastProgress(
  jobId: number, 
  phase: ProgressMessage['phase'], 
  message: string,
  stats?: Partial<ProgressMessage>
): void {
  const progress: ProgressMessage = {
    type: 'progress',
    jobId,
    phase,
    message,
    ...stats
  };
  broadcastToJob(jobId, progress);
}

async function handleAbort(jobId: number): Promise<void> {
  try {
    console.log(`[DB] Updating reconstructionDocuments to aborted status, jobId: ${jobId}`);
    await db.update(reconstructionDocuments)
      .set({ status: 'aborted', updatedAt: new Date() })
      .where(eq(reconstructionDocuments.id, jobId));
    console.log(`[DB] Successfully updated reconstructionDocuments to aborted status`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to update reconstructionDocuments to aborted status:`, dbError.message);
  }
  
  const completedChunks = await db.select()
    .from(reconstructionChunks)
    .where(and(
      eq(reconstructionChunks.documentId, jobId),
      eq(reconstructionChunks.status, 'complete')
    ))
    .orderBy(asc(reconstructionChunks.chunkIndex));
  
  const [job] = await db.select().from(reconstructionDocuments).where(eq(reconstructionDocuments.id, jobId));
  
  const partialOutput = completedChunks.map(c => c.chunkOutputText).join('\n\n');
  const wordCount = countWords(partialOutput);
  
  broadcastToJob(jobId, {
    type: 'job_aborted',
    jobId,
    completedChunks: completedChunks.length,
    totalChunks: job?.numChunks || 0,
    partialOutput,
    wordCount
  });
  
  activeJobs.delete(jobId);
}

async function abortJob(ws: WebSocket, jobId: number): Promise<void> {
  const jobState = activeJobs.get(jobId);
  if (jobState) {
    jobState.aborted = true;
    sendToClient(ws, { type: 'abort_acknowledged', jobId });
  } else {
    sendError(ws, `Job ${jobId} is not currently running`);
  }
}

async function resumeJob(ws: WebSocket, jobId: number): Promise<void> {
  const [job] = await db.select().from(reconstructionDocuments).where(eq(reconstructionDocuments.id, jobId));
  
  if (!job) {
    sendError(ws, `Job ${jobId} not found`);
    return;
  }
  
  if (job.status === 'complete') {
    sendToClient(ws, {
      type: 'job_already_complete',
      jobId,
      finalOutput: job.finalOutput,
      finalWordCount: job.finalWordCount
    });
    return;
  }
  
  if (activeJobs.has(jobId)) {
    sendError(ws, `Job ${jobId} is already running`);
    return;
  }
  
  clientConnections.set(ws, jobId);
  activeJobs.set(jobId, { aborted: false, startTime: Date.now() });
  
  sendToClient(ws, {
    type: 'job_resumed',
    jobId,
    status: job.status,
    currentChunk: job.currentChunk,
    totalChunks: job.numChunks
  });
  
  processJobAsync(jobId);
}

async function getJobStatus(ws: WebSocket, jobId: number): Promise<void> {
  const [job] = await db.select().from(reconstructionDocuments).where(eq(reconstructionDocuments.id, jobId));
  
  if (!job) {
    sendError(ws, `Job ${jobId} not found`);
    return;
  }
  
  const chunks = await db.select()
    .from(reconstructionChunks)
    .where(eq(reconstructionChunks.documentId, jobId))
    .orderBy(asc(reconstructionChunks.chunkIndex));
  
  const completedCount = chunks.filter(c => c.status === 'complete').length;
  const totalWords = chunks.reduce((sum, c) => sum + (c.actualWords || 0), 0);
  
  sendToClient(ws, {
    type: 'job_status',
    jobId,
    status: job.status,
    currentChunk: job.currentChunk,
    totalChunks: job.numChunks,
    completedChunks: completedCount,
    wordsProcessed: totalWords,
    targetWords: job.targetMidWords,
    isRunning: activeJobs.has(jobId)
  });
}

export async function cleanupOldJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const oldJobs = await db.select({ id: reconstructionDocuments.id })
    .from(reconstructionDocuments)
    .where(eq(reconstructionDocuments.status, 'complete'));
  
  let deletedCount = 0;
  for (const job of oldJobs) {
    const [jobData] = await db.select().from(reconstructionDocuments).where(eq(reconstructionDocuments.id, job.id));
    if (jobData && jobData.updatedAt && jobData.updatedAt < cutoff) {
      await db.delete(reconstructionChunks).where(eq(reconstructionChunks.documentId, job.id));
      await db.delete(reconstructionDocuments).where(eq(reconstructionDocuments.id, job.id));
      deletedCount++;
    }
  }
  
  console.log(`[CC-WS] Cleaned up ${deletedCount} old completed jobs`);
  return deletedCount;
}
