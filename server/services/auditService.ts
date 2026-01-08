import { db } from '../db';
import { 
  auditEvents, 
  llmCalls, 
  chunkProcessingLogs, 
  lengthEnforcementLogs, 
  jobHistory,
  InsertAuditEvent,
  InsertLlmCall,
  InsertChunkProcessingLog,
  InsertLengthEnforcementLog,
  InsertJobHistory
} from '@shared/schema';

export async function logAuditEvent(event: InsertAuditEvent): Promise<number> {
  try {
    const [result] = await db.insert(auditEvents).values(event).returning({ id: auditEvents.id });
    return result.id;
  } catch (error) {
    console.error('[AUDIT] Failed to log audit event:', error);
    return -1;
  }
}

export async function logLLMCall(params: {
  userId?: number;
  jobId?: number;
  jobType?: string;
  modelName: string;
  provider: string;
  promptSummary?: string;
  promptFull?: string;
  responseSummary?: string;
  responseFull?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  status?: string;
  errorMessage?: string;
}): Promise<number> {
  try {
    const auditEventId = await logAuditEvent({
      userId: params.userId,
      jobId: params.jobId,
      jobType: params.jobType,
      eventType: 'llm_call',
      eventData: {
        model: params.modelName,
        provider: params.provider,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        latencyMs: params.latencyMs,
        status: params.status
      }
    });

    const [result] = await db.insert(llmCalls).values({
      userId: params.userId,
      jobId: params.jobId,
      jobType: params.jobType,
      auditEventId: auditEventId > 0 ? auditEventId : undefined,
      modelName: params.modelName,
      provider: params.provider,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      promptSummary: params.promptSummary,
      promptFull: params.promptFull,
      responseSummary: params.responseSummary,
      responseFull: params.responseFull,
      latencyMs: params.latencyMs,
      status: params.status || 'success',
      errorMessage: params.errorMessage
    }).returning({ id: llmCalls.id });

    console.log(`[AUDIT] LLM call logged: ${params.provider}/${params.modelName} (id: ${result.id})`);
    return result.id;
  } catch (error) {
    console.error('[AUDIT] Failed to log LLM call:', error);
    return -1;
  }
}

export async function logChunkProcessing(params: {
  userId?: number;
  jobId?: number;
  jobType?: string;
  chunkIndex: number;
  inputWordCount: number;
  outputWordCount: number;
  targetWordCount: number;
  minWordCount?: number;
  maxWordCount?: number;
  passed: boolean;
  failureReason?: string;
  retryNumber?: number;
  llmCallId?: number;
}): Promise<number> {
  try {
    await logAuditEvent({
      userId: params.userId,
      jobId: params.jobId,
      jobType: params.jobType,
      eventType: 'chunk_processing',
      eventData: {
        chunkIndex: params.chunkIndex,
        inputWordCount: params.inputWordCount,
        outputWordCount: params.outputWordCount,
        targetWordCount: params.targetWordCount,
        passed: params.passed,
        failureReason: params.failureReason
      }
    });

    const [result] = await db.insert(chunkProcessingLogs).values({
      userId: params.userId,
      jobId: params.jobId,
      jobType: params.jobType,
      chunkIndex: params.chunkIndex,
      inputWordCount: params.inputWordCount,
      outputWordCount: params.outputWordCount,
      targetWordCount: params.targetWordCount,
      minWordCount: params.minWordCount,
      maxWordCount: params.maxWordCount,
      passed: params.passed,
      failureReason: params.failureReason,
      retryNumber: params.retryNumber || 0,
      llmCallId: params.llmCallId
    }).returning({ id: chunkProcessingLogs.id });

    console.log(`[AUDIT] Chunk ${params.chunkIndex} logged: ${params.outputWordCount}/${params.targetWordCount} words, passed: ${params.passed}`);
    return result.id;
  } catch (error) {
    console.error('[AUDIT] Failed to log chunk processing:', error);
    return -1;
  }
}

export async function logLengthEnforcement(params: {
  userId?: number;
  jobId: number;
  jobType: string;
  targetWords: number;
  finalWords?: number;
  targetMet?: boolean;
  iterationsRequired?: number;
  failureReason?: string;
}): Promise<number> {
  try {
    await logAuditEvent({
      userId: params.userId,
      jobId: params.jobId,
      jobType: params.jobType,
      eventType: 'length_enforcement',
      eventData: {
        targetWords: params.targetWords,
        finalWords: params.finalWords,
        targetMet: params.targetMet,
        iterationsRequired: params.iterationsRequired
      }
    });

    const [result] = await db.insert(lengthEnforcementLogs).values({
      userId: params.userId,
      jobId: params.jobId,
      jobType: params.jobType,
      targetWords: params.targetWords,
      finalWords: params.finalWords,
      targetMet: params.targetMet,
      iterationsRequired: params.iterationsRequired,
      failureReason: params.failureReason
    }).returning({ id: lengthEnforcementLogs.id });

    console.log(`[AUDIT] Length enforcement logged: ${params.finalWords}/${params.targetWords} words, met: ${params.targetMet}`);
    return result.id;
  } catch (error) {
    console.error('[AUDIT] Failed to log length enforcement:', error);
    return -1;
  }
}

export async function createJobHistoryEntry(params: {
  userId: number;
  jobId: number;
  jobType: string;
  jobTitle?: string;
  inputSummary?: string;
  outputSummary?: string;
  inputWordCount?: number;
  outputWordCount?: number;
  targetWordCount?: number;
  targetMet?: boolean;
  status: string;
}): Promise<number> {
  try {
    await logAuditEvent({
      userId: params.userId,
      jobId: params.jobId,
      jobType: params.jobType,
      eventType: 'job_created',
      eventData: {
        jobTitle: params.jobTitle,
        status: params.status,
        inputWordCount: params.inputWordCount
      }
    });

    const [result] = await db.insert(jobHistory).values({
      userId: params.userId,
      jobId: params.jobId,
      jobType: params.jobType,
      jobTitle: params.jobTitle,
      inputSummary: params.inputSummary,
      outputSummary: params.outputSummary,
      inputWordCount: params.inputWordCount,
      outputWordCount: params.outputWordCount,
      targetWordCount: params.targetWordCount,
      targetMet: params.targetMet,
      status: params.status
    }).returning({ id: jobHistory.id });

    console.log(`[AUDIT] Job history created: ${params.jobType} (id: ${result.id})`);
    return result.id;
  } catch (error) {
    console.error('[AUDIT] Failed to create job history:', error);
    return -1;
  }
}

export async function updateJobHistoryStatus(params: {
  jobId: number;
  jobType: string;
  status: string;
  outputSummary?: string;
  outputWordCount?: number;
  targetMet?: boolean;
}): Promise<void> {
  try {
    await logAuditEvent({
      jobId: params.jobId,
      jobType: params.jobType,
      eventType: 'job_status_update',
      eventData: {
        status: params.status,
        outputWordCount: params.outputWordCount,
        targetMet: params.targetMet
      }
    });
    console.log(`[AUDIT] Job status updated: ${params.jobType} ${params.jobId} -> ${params.status}`);
  } catch (error) {
    console.error('[AUDIT] Failed to update job history status:', error);
  }
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

export function summarizeText(text: string, maxLength: number = 200): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}
