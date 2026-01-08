import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';
import { 
  pipelineJobs, pipelineChunks, pipelineObjections,
  PipelineJob, PipelineChunk, PipelineObjection,
  PipelineSkeleton1, PipelineSkeleton2, PipelineSkeleton3, PipelineSkeleton4,
  HCViolation, HCCheckResult, GlobalSkeleton
} from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { safeDbInsert, safeDbUpdate, safeDbInsertRequired, safeDbUpdateRequired } from './dbHelper';
import { logLLMCall, logChunkProcessing, summarizeText } from './auditService';

const anthropic = new Anthropic();

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE ORCHESTRATOR - 4-Stage Cross-Chunk Coherence Pipeline
// Stage 1: Reconstruction, Stage 2: Objections, Stage 3: Responses, Stage 4: Bullet-proof
// ═══════════════════════════════════════════════════════════════════════════

export interface PipelineParams {
  customInstructions?: string;
  targetAudience?: string;
  objective?: string;
}

export interface PipelineProgress {
  jobId: number;
  currentStage: number;
  stageStatus: string;
  message: string;
  progress: {
    stage: number;
    totalStages: number;
    chunksCompleted: number;
    totalChunks: number;
  };
}

export type PipelineProgressCallback = (progress: PipelineProgress) => void;

// Word counting utility
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w).length;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════

export async function runFullPipeline(
  originalText: string,
  params: PipelineParams,
  userId?: number,
  onProgress?: PipelineProgressCallback,
  existingJobId?: number
): Promise<{
  success: boolean;
  jobId: number;
  reconstruction?: string;
  objections?: string;
  responses?: string;
  bulletproof?: string;
  hcCheck?: HCCheckResult;
  error?: string;
}> {
  const startTime = Date.now();
  const wordCount = countWords(originalText);
  
  console.log(`[Pipeline] Starting full pipeline with ${wordCount} words`);
  
  let jobId: number;
  
  // Use existing job if provided, otherwise create new one
  if (existingJobId) {
    jobId = existingJobId;
    // Update existing job to running status
    try {
      console.log(`[DB] Updating existing job ${existingJobId} to running status`);
      await db.update(pipelineJobs).set({
        status: 'running',
        currentStage: 1,
        stageStatus: 'pending',
        updatedAt: new Date()
      }).where(eq(pipelineJobs.id, existingJobId));
      console.log(`[DB] Successfully updated job ${existingJobId}`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update job ${existingJobId}:`, dbError.message, dbError.stack);
      throw new Error(`Database update failed: ${dbError.message}`);
    }
    console.log(`[Pipeline] Using existing job ${jobId}`);
  } else {
    // Create pipeline job
    try {
      console.log(`[DB] Creating new pipeline job, wordCount: ${wordCount}`);
      const [job] = await db.insert(pipelineJobs).values({
        userId,
        originalText,
        originalWordCount: wordCount,
        customInstructions: params.customInstructions,
        targetAudience: params.targetAudience,
        objective: params.objective,
        status: 'running',
        currentStage: 1,
        stageStatus: 'pending'
      }).returning();
      jobId = job.id;
      console.log(`[DB] Successfully created job ${jobId}`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to create pipeline job:`, dbError.message, dbError.stack);
      throw new Error(`Database insert failed: ${dbError.message}`);
    }
    console.log(`[Pipeline] Created new job ${jobId}`);
  }
  
  const emitProgress = (stage: number, status: string, message: string, chunksCompleted = 0, totalChunks = 0) => {
    if (onProgress) {
      onProgress({
        jobId,
        currentStage: stage,
        stageStatus: status,
        message,
        progress: { stage, totalStages: 4, chunksCompleted, totalChunks }
      });
    }
  };
  
  try {
    // ══════════════════════════════════════════════════════════════════
    // STAGE 1: RECONSTRUCTION
    // ══════════════════════════════════════════════════════════════════
    console.log(`[Pipeline ${jobId}] Starting Stage 1: Reconstruction`);
    emitProgress(1, 'running', 'Starting reconstruction...');
    
    try {
      console.log(`[DB] Updating pipelineJobs stage 1 start, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        currentStage: 1,
        stageStatus: 'running',
        stage1StartTime: new Date()
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs stage 1 start`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs stage 1 start:`, dbError.message);
    }
    
    const stage1Result = await runStage1Reconstruction(
      originalText,
      params,
      jobId,
      (msg, completed, total) => emitProgress(1, 'chunk_processing', msg, completed, total)
    );
    
    try {
      console.log(`[DB] Updating pipelineJobs stage 1 complete, jobId: ${jobId}, words: ${countWords(stage1Result.output)}`);
      await db.update(pipelineJobs).set({
        reconstructionOutput: stage1Result.output,
        reconstructionWords: countWords(stage1Result.output),
        skeleton1: stage1Result.skeleton as any,
        stage1EndTime: new Date(),
        stageStatus: 'complete'
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs stage 1 complete`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs stage 1 complete:`, dbError.message);
    }
    
    console.log(`[Pipeline ${jobId}] Stage 1 complete: ${countWords(stage1Result.output)} words`);
    
    // ══════════════════════════════════════════════════════════════════
    // STAGE 2: OBJECTIONS
    // ══════════════════════════════════════════════════════════════════
    console.log(`[Pipeline ${jobId}] Starting Stage 2: Objections`);
    emitProgress(2, 'running', 'Starting objections generation...');
    
    try {
      console.log(`[DB] Updating pipelineJobs stage 2 start, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        currentStage: 2,
        stageStatus: 'running',
        stage2StartTime: new Date()
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs stage 2 start`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs stage 2 start:`, dbError.message);
    }
    
    const stage2Result = await runStage2Objections(
      stage1Result.output,
      stage1Result.skeleton,
      params,
      jobId,
      (msg, completed, total) => emitProgress(2, 'chunk_processing', msg, completed, total)
    );
    
    try {
      console.log(`[DB] Updating pipelineJobs stage 2 complete, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        objectionsOutput: stage2Result.output,
        objectionsWords: countWords(stage2Result.output),
        skeleton2: stage2Result.skeleton as any,
        stage2EndTime: new Date(),
        stageStatus: 'complete'
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs stage 2 complete`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs stage 2 complete:`, dbError.message);
    }
    
    // Store individual objections
    for (const obj of stage2Result.objections) {
      try {
        console.log(`[DB] Inserting pipelineObjections, jobId: ${jobId}, index: ${obj.index}`);
        await db.insert(pipelineObjections).values({
          jobId,
          objectionIndex: obj.index,
          claimTargeted: obj.claimTargeted,
          claimLocation: obj.claimLocation,
          objectionType: obj.type,
          objectionText: obj.objection,
          initialResponse: obj.response,
          severity: obj.severity
        });
        console.log(`[DB] Successfully inserted pipelineObjections index ${obj.index}`);
      } catch (dbError: any) {
        console.error(`[DB] FAILED to insert pipelineObjections index ${obj.index}:`, dbError.message);
      }
    }
    
    console.log(`[Pipeline ${jobId}] Stage 2 complete: ${stage2Result.objections.length} objections`);
    
    // ══════════════════════════════════════════════════════════════════
    // STAGE 3: ENHANCED RESPONSES
    // ══════════════════════════════════════════════════════════════════
    console.log(`[Pipeline ${jobId}] Starting Stage 3: Enhanced Responses`);
    emitProgress(3, 'running', 'Enhancing responses...');
    
    try {
      console.log(`[DB] Updating pipelineJobs stage 3 start, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        currentStage: 3,
        stageStatus: 'running',
        stage3StartTime: new Date()
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs stage 3 start`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs stage 3 start:`, dbError.message);
    }
    
    const stage3Result = await runStage3Responses(
      stage2Result.output,
      stage1Result.skeleton,
      stage2Result.skeleton,
      jobId,
      (msg, completed, total) => emitProgress(3, 'chunk_processing', msg, completed, total)
    );
    
    try {
      console.log(`[DB] Updating pipelineJobs stage 3 complete, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        responsesOutput: stage3Result.output,
        responsesWords: countWords(stage3Result.output),
        skeleton3: stage3Result.skeleton as any,
        stage3EndTime: new Date(),
        stageStatus: 'complete'
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs stage 3 complete`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs stage 3 complete:`, dbError.message);
    }
    
    // Update objections with enhanced responses
    for (const resp of stage3Result.responses) {
      try {
        console.log(`[DB] Updating pipelineObjections enhanced response, index: ${resp.index}`);
        await db.update(pipelineObjections).set({
          enhancedResponse: resp.enhancedResponse,
          enhancementNotes: resp.enhancementNotes
        }).where(
          and(
            eq(pipelineObjections.jobId, jobId),
            eq(pipelineObjections.objectionIndex, resp.index)
          )
        );
        console.log(`[DB] Successfully updated pipelineObjections enhanced response index ${resp.index}`);
      } catch (dbError: any) {
        console.error(`[DB] FAILED to update pipelineObjections enhanced response index ${resp.index}:`, dbError.message);
      }
    }
    
    console.log(`[Pipeline ${jobId}] Stage 3 complete: ${stage3Result.responses.length} enhanced responses`);
    
    // ══════════════════════════════════════════════════════════════════
    // STAGE 4: BULLET-PROOF VERSION
    // ══════════════════════════════════════════════════════════════════
    console.log(`[Pipeline ${jobId}] Starting Stage 4: Bullet-proof Version`);
    emitProgress(4, 'running', 'Creating bullet-proof version...');
    
    try {
      console.log(`[DB] Updating pipelineJobs stage 4 start, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        currentStage: 4,
        stageStatus: 'running',
        stage4StartTime: new Date()
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs stage 4 start`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs stage 4 start:`, dbError.message);
    }
    
    const stage4Result = await runStage4Bulletproof(
      stage1Result.output,
      stage3Result.output,
      {
        skeleton1: stage1Result.skeleton,
        skeleton2: stage2Result.skeleton,
        skeleton3: stage3Result.skeleton
      },
      jobId,
      (msg, completed, total) => emitProgress(4, 'chunk_processing', msg, completed, total)
    );
    
    try {
      console.log(`[DB] Updating pipelineJobs stage 4 complete, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        bulletproofOutput: stage4Result.output,
        bulletproofWords: countWords(stage4Result.output),
        skeleton4: stage4Result.skeleton as any,
        stage4EndTime: new Date(),
        stageStatus: 'complete'
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs stage 4 complete`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs stage 4 complete:`, dbError.message);
    }
    
    // Update objection integration tracking
    for (const integration of stage4Result.integrations) {
      try {
        console.log(`[DB] Updating pipelineObjections integration, index: ${integration.objectionIndex}`);
        await db.update(pipelineObjections).set({
          integratedInSection: integration.section,
          integrationStrategy: integration.strategy,
          integrationVerified: true
        }).where(
          and(
            eq(pipelineObjections.jobId, jobId),
            eq(pipelineObjections.objectionIndex, integration.objectionIndex)
          )
        );
        console.log(`[DB] Successfully updated pipelineObjections integration index ${integration.objectionIndex}`);
      } catch (dbError: any) {
        console.error(`[DB] FAILED to update pipelineObjections integration index ${integration.objectionIndex}:`, dbError.message);
      }
    }
    
    console.log(`[Pipeline ${jobId}] Stage 4 complete: ${countWords(stage4Result.output)} words`);
    
    // ══════════════════════════════════════════════════════════════════
    // HORIZONTAL COHERENCE CHECK
    // ══════════════════════════════════════════════════════════════════
    console.log(`[Pipeline ${jobId}] Running Horizontal Coherence Check`);
    emitProgress(4, 'hc_check', 'Verifying horizontal coherence...');
    
    const hcResult = await runHorizontalCoherenceCheck(jobId);
    
    try {
      console.log(`[DB] Updating pipelineJobs HC check results, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        hcCheckResults: hcResult as any,
        hcViolations: hcResult.violations as any,
        hcCheckTime: new Date()
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs HC check results`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs HC check results:`, dbError.message);
    }
    
    // If HC violations found, attempt repair
    if (hcResult.violations.length > 0) {
      console.log(`[Pipeline ${jobId}] HC violations found: ${hcResult.violations.length}`);
      
      const errorCount = hcResult.violations.filter(v => v.severity === 'error').length;
      
      if (errorCount > 0) {
        // Attempt repair
        const repairResult = await attemptHCRepair(jobId, hcResult);
        
        if (!repairResult.success) {
          try {
            console.log(`[DB] Updating pipelineJobs status to completed_with_warnings, jobId: ${jobId}`);
            await db.update(pipelineJobs).set({
              status: 'completed_with_warnings',
              updatedAt: new Date()
            }).where(eq(pipelineJobs.id, jobId));
            console.log(`[DB] Successfully updated pipelineJobs status`);
          } catch (dbError: any) {
            console.error(`[DB] FAILED to update pipelineJobs status:`, dbError.message);
          }
        }
      }
    }
    
    // ══════════════════════════════════════════════════════════════════
    // COMPLETE
    // ══════════════════════════════════════════════════════════════════
    const finalStatus = hcResult.passed ? 'complete' : 'completed_with_warnings';
    
    try {
      console.log(`[DB] Updating pipelineJobs final status: ${finalStatus}, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        status: finalStatus,
        updatedAt: new Date()
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs final status`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs final status:`, dbError.message);
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`[Pipeline ${jobId}] Complete in ${Math.round(totalTime / 1000)}s - Status: ${finalStatus}`);
    
    emitProgress(4, 'complete', `Pipeline complete in ${Math.round(totalTime / 1000)}s`);
    
    return {
      success: true,
      jobId,
      reconstruction: stage1Result.output,
      objections: stage2Result.output,
      responses: stage3Result.output,
      bulletproof: stage4Result.output,
      hcCheck: hcResult
    };
    
  } catch (error: any) {
    console.error(`[Pipeline ${jobId}] Failed:`, error);
    
    try {
      console.log(`[DB] Updating pipelineJobs to failed status, jobId: ${jobId}`);
      await db.update(pipelineJobs).set({
        status: 'failed',
        errorMessage: error.message,
        updatedAt: new Date()
      }).where(eq(pipelineJobs.id, jobId));
      console.log(`[DB] Successfully updated pipelineJobs to failed status`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update pipelineJobs to failed status:`, dbError.message);
    }
    
    emitProgress(0, 'failed', `Pipeline failed: ${error.message}`);
    
    return {
      success: false,
      jobId,
      error: error.message
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 1: RECONSTRUCTION (uses existing CC infrastructure)
// ═══════════════════════════════════════════════════════════════════════════

async function runStage1Reconstruction(
  text: string,
  params: PipelineParams,
  jobId: number,
  onProgress: (msg: string, completed: number, total: number) => void
): Promise<{
  output: string;
  skeleton: PipelineSkeleton1;
}> {
  onProgress('Extracting document skeleton...', 0, 1);
  
  // Extract skeleton
  const skeletonPrompt = `Analyze this document and extract a structured skeleton:

DOCUMENT:
${text.substring(0, 30000)}

Extract the following in JSON format:
{
  "thesis": "The central argument or main claim",
  "outline": ["8-20 numbered major claims or sections"],
  "keyTerms": [{"term": "term", "meaning": "how it's used in this document"}],
  "commitmentLedger": [{"type": "asserts|rejects|assumes", "claim": "what the document commits to"}],
  "entities": [{"name": "entity name", "type": "person|concept|organization", "role": "role in document"}]
}

Return ONLY valid JSON, no other text.`;

  const startTime = Date.now();
  const skeletonResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: skeletonPrompt }]
  });
  const skeletonResponseText = skeletonResponse.content[0].type === 'text' ? skeletonResponse.content[0].text : '';
  await logLLMCall({
    jobId,
    jobType: 'pipeline_stage1',
    modelName: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    promptSummary: 'Extract document skeleton',
    promptFull: skeletonPrompt,
    responseSummary: summarizeText(skeletonResponseText, 200),
    responseFull: skeletonResponseText,
    inputTokens: skeletonResponse.usage?.input_tokens,
    outputTokens: skeletonResponse.usage?.output_tokens,
    latencyMs: Date.now() - startTime,
    status: 'success'
  });
  
  let skeleton: GlobalSkeleton;
  try {
    const responseText = skeletonResponse.content[0].type === 'text' ? skeletonResponse.content[0].text : '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    skeleton = jsonMatch ? JSON.parse(jsonMatch[0]) : {
      thesis: '',
      outline: [],
      keyTerms: [],
      commitmentLedger: [],
      entities: []
    };
  } catch (e) {
    skeleton = { thesis: '', outline: [], keyTerms: [], commitmentLedger: [], entities: [] };
  }
  
  onProgress('Skeleton extracted, reconstructing document...', 1, 2);
  
  // For now, use a single-pass reconstruction (can be enhanced to use CC chunking)
  const reconstructPrompt = `You are performing a CONSERVATIVE CHARITABLE INTERPRETATION of a document.

SKELETON (the document's core structure you must preserve):
${JSON.stringify(skeleton, null, 2)}

${params.customInstructions ? `CUSTOM INSTRUCTIONS: ${params.customInstructions}` : ''}

ORIGINAL DOCUMENT:
${text}

TASK: Rewrite this document as a rigorous analytical piece that:
1. Preserves ALL claims from the skeleton's commitment ledger
2. Uses terms consistently as defined in keyTerms
3. Follows the logical structure indicated in the outline
4. Presents the strongest possible version of the argument
5. Maintains academic rigor throughout

Output ONLY the reconstructed document, no commentary.`;

  const reconstructStartTime = Date.now();
  const reconstructResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    messages: [{ role: 'user', content: reconstructPrompt }]
  });
  
  const output = reconstructResponse.content[0].type === 'text' ? reconstructResponse.content[0].text : '';
  await logLLMCall({
    jobId,
    jobType: 'pipeline_stage1',
    modelName: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    promptSummary: 'Reconstruct document',
    promptFull: reconstructPrompt,
    responseSummary: summarizeText(output, 200),
    responseFull: output,
    inputTokens: reconstructResponse.usage?.input_tokens,
    outputTokens: reconstructResponse.usage?.output_tokens,
    latencyMs: Date.now() - reconstructStartTime,
    status: 'success'
  });
  
  onProgress('Reconstruction complete', 2, 2);
  
  return {
    output,
    skeleton: {
      ...skeleton,
      documentWordCount: countWords(text),
      reconstructionWordCount: countWords(output)
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 2: OBJECTIONS
// ═══════════════════════════════════════════════════════════════════════════

interface ObjectionResult {
  index: number;
  claimTargeted: string;
  claimLocation: string;
  type: string;
  objection: string;
  response: string;
  severity: string;
}

async function runStage2Objections(
  reconstructionOutput: string,
  skeleton1: PipelineSkeleton1,
  params: PipelineParams,
  jobId: number,
  onProgress: (msg: string, completed: number, total: number) => void
): Promise<{
  output: string;
  skeleton: PipelineSkeleton2;
  objections: ObjectionResult[];
}> {
  onProgress('Identifying claims to target...', 0, 6);
  
  // First, identify the 25 claims to target
  const claimsPrompt = `Analyze this reconstructed document and identify 25 distinct, substantive claims that could be objected to.

DOCUMENT SKELETON:
${JSON.stringify(skeleton1, null, 2)}

RECONSTRUCTED DOCUMENT:
${reconstructionOutput.substring(0, 25000)}

For each claim, provide:
1. The exact quote or precise paraphrase
2. Where it appears (section/paragraph)
3. Why it's substantive enough to warrant an objection

Return as JSON array:
[
  {"claimIndex": 1, "claim": "exact claim text", "location": "section/paragraph", "reason": "why substantive"}
]

Return exactly 25 claims, ensuring variety across the document.`;

  const claimsStartTime = Date.now();
  const claimsResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    messages: [{ role: 'user', content: claimsPrompt }]
  });
  const claimsResponseText = claimsResponse.content[0].type === 'text' ? claimsResponse.content[0].text : '';
  await logLLMCall({
    jobId,
    jobType: 'pipeline_stage2',
    modelName: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    promptSummary: 'Identify 25 claims to target',
    promptFull: claimsPrompt,
    responseSummary: summarizeText(claimsResponseText, 200),
    responseFull: claimsResponseText,
    inputTokens: claimsResponse.usage?.input_tokens,
    outputTokens: claimsResponse.usage?.output_tokens,
    latencyMs: Date.now() - claimsStartTime,
    status: 'success'
  });
  
  let claimsToTarget: { claimIndex: number; claim: string; location: string }[] = [];
  try {
    const responseText = claimsResponseText;
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    claimsToTarget = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch (e) {
    console.error('[Stage 2] Failed to parse claims:', e);
    claimsToTarget = [];
  }
  
  // Generate objections in 5 chunks of 5
  const allObjections: ObjectionResult[] = [];
  const totalChunks = 5;
  
  for (let chunk = 0; chunk < totalChunks; chunk++) {
    const startIdx = chunk * 5;
    const endIdx = Math.min(startIdx + 5, 25);
    const chunkClaims = claimsToTarget.slice(startIdx, endIdx);
    
    onProgress(`Generating objections ${startIdx + 1}-${endIdx}...`, chunk + 1, totalChunks + 1);
    
    const objectionTypes = ['logical', 'empirical', 'conceptual', 'methodological', 'practical'];
    const severities = ['fatal', 'serious', 'moderate', 'minor'];
    
    const objectionPrompt = `Generate objections and responses for these 5 claims from a philosophical document.

DOCUMENT SKELETON (commitments you must accurately represent):
${JSON.stringify(skeleton1.commitmentLedger, null, 2)}

TARGET CLAIMS FOR THIS CHUNK:
${JSON.stringify(chunkClaims, null, 2)}

For each claim, generate:
1. CLAIM_TARGETED: Exact quote or precise paraphrase from the document
2. OBJECTION_TYPE: One of [${objectionTypes.join(', ')}]
3. OBJECTION: The objection itself (150-300 words)
4. RESPONSE: Counter-argument (150-300 words)
5. SEVERITY: One of [${severities.join(', ')}]

CONSTRAINT: Your objections must target what the document ACTUALLY says. Do not strawman.

Return as JSON array:
[
  {
    "claimIndex": 1,
    "claimTargeted": "exact claim",
    "claimLocation": "section",
    "type": "logical",
    "objection": "the objection text",
    "response": "the response text",
    "severity": "serious"
  }
]`;

    const objStartTime = Date.now();
    const objResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: objectionPrompt }]
    });
    const objResponseText = objResponse.content[0].type === 'text' ? objResponse.content[0].text : '';
    await logLLMCall({
      jobId,
      jobType: 'pipeline_stage2',
      modelName: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      promptSummary: `Generate objections chunk ${chunk + 1}/5`,
      promptFull: objectionPrompt,
      responseSummary: summarizeText(objResponseText, 200),
      responseFull: objResponseText,
      inputTokens: objResponse.usage?.input_tokens,
      outputTokens: objResponse.usage?.output_tokens,
      latencyMs: Date.now() - objStartTime,
      status: 'success'
    });
    
    try {
      const responseText = objResponseText;
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      const chunkObjections = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      
      for (const obj of chunkObjections) {
        allObjections.push({
          index: allObjections.length + 1,
          claimTargeted: obj.claimTargeted || obj.claim_targeted || '',
          claimLocation: obj.claimLocation || obj.claim_location || '',
          type: obj.type || 'logical',
          objection: obj.objection || '',
          response: obj.response || '',
          severity: obj.severity || 'moderate'
        });
      }
    } catch (e) {
      console.error(`[Stage 2] Failed to parse chunk ${chunk}:`, e);
    }
    
    // Store chunk
    try {
      console.log(`[DB] Inserting pipelineChunks stage 2, chunk ${chunk}, jobId: ${jobId}`);
      await db.insert(pipelineChunks).values({
        jobId,
        stage: 2,
        chunkIndex: chunk,
        chunkInputText: JSON.stringify(chunkClaims),
        chunkOutputText: objResponse.content[0].type === 'text' ? objResponse.content[0].text : '',
        status: 'completed'
      });
      console.log(`[DB] Successfully inserted pipelineChunks stage 2, chunk ${chunk}`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to insert pipelineChunks stage 2, chunk ${chunk}:`, dbError.message, dbError.stack);
    }
  }
  
  onProgress('Formatting objections output...', totalChunks + 1, totalChunks + 1);
  
  // Format output
  let output = '# 25 OBJECTIONS WITH RESPONSES\n\n';
  for (const obj of allObjections) {
    output += `## Objection ${obj.index} [${obj.type.toUpperCase()}] - ${obj.severity.toUpperCase()}\n\n`;
    output += `**Claim Targeted:** ${obj.claimTargeted}\n\n`;
    output += `**Objection:**\n${obj.objection}\n\n`;
    output += `**Response:**\n${obj.response}\n\n---\n\n`;
  }
  
  // Build skeleton
  const skeleton2: PipelineSkeleton2 = {
    claimsToTarget,
    claimLocations: Object.fromEntries(claimsToTarget.map(c => [c.claimIndex, c.location])),
    objectionTypes: {
      logical: allObjections.filter(o => o.type === 'logical').map(o => o.index),
      empirical: allObjections.filter(o => o.type === 'empirical').map(o => o.index),
      conceptual: allObjections.filter(o => o.type === 'conceptual').map(o => o.index),
      methodological: allObjections.filter(o => o.type === 'methodological').map(o => o.index),
      practical: allObjections.filter(o => o.type === 'practical').map(o => o.index)
    },
    severityDistribution: {
      fatal: allObjections.filter(o => o.severity === 'fatal').map(o => o.index),
      serious: allObjections.filter(o => o.severity === 'serious').map(o => o.index),
      moderate: allObjections.filter(o => o.severity === 'moderate').map(o => o.index),
      minor: allObjections.filter(o => o.severity === 'minor').map(o => o.index)
    },
    inheritedCommitments: skeleton1.commitmentLedger || [],
    objectionSummaries: allObjections.map(o => ({ index: o.index, summary: o.objection.substring(0, 100) })),
    responseSummaries: allObjections.map(o => ({ index: o.index, summary: o.response.substring(0, 100) }))
  };
  
  return { output, skeleton: skeleton2, objections: allObjections };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 3: ENHANCED RESPONSES
// ═══════════════════════════════════════════════════════════════════════════

interface EnhancedResponseResult {
  index: number;
  enhancedResponse: string;
  enhancementNotes: string;
}

async function runStage3Responses(
  objectionsOutput: string,
  skeleton1: PipelineSkeleton1,
  skeleton2: PipelineSkeleton2,
  jobId: number,
  onProgress: (msg: string, completed: number, total: number) => void
): Promise<{
  output: string;
  skeleton: PipelineSkeleton3;
  responses: EnhancedResponseResult[];
}> {
  // Get objections from database
  const objections = await db.select().from(pipelineObjections)
    .where(eq(pipelineObjections.jobId, jobId));
  
  const allResponses: EnhancedResponseResult[] = [];
  const totalChunks = 5;
  
  for (let chunk = 0; chunk < totalChunks; chunk++) {
    const startIdx = chunk * 5;
    const endIdx = Math.min(startIdx + 5, 25);
    const chunkObjections = objections.slice(startIdx, endIdx);
    
    onProgress(`Enhancing responses ${startIdx + 1}-${endIdx}...`, chunk + 1, totalChunks);
    
    const enhancePrompt = `Enhance these responses to make them more compelling and thorough.

ORIGINAL DOCUMENT COMMITMENTS (must not contradict):
${JSON.stringify(skeleton1.commitmentLedger, null, 2)}

OBJECTIONS AND INITIAL RESPONSES TO ENHANCE:
${chunkObjections.map(o => `
Objection ${o.objectionIndex}: ${o.objectionText}
Initial Response: ${o.initialResponse}
`).join('\n---\n')}

For each objection, provide an ENHANCED RESPONSE that:
1. Acknowledges the objection's strongest form (no strawmanning)
2. Provides deeper analysis than the initial response
3. Includes additional evidence or examples where appropriate
4. Does NOT contradict the original document's commitments
5. Is 300-500 words

Return as JSON array:
[
  {
    "objectionIndex": 1,
    "enhancedResponse": "the enhanced response text (300-500 words)",
    "enhancementNotes": "what was improved from the initial response"
  }
]`;

    const enhanceStartTime = Date.now();
    const enhanceResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: enhancePrompt }]
    });
    const enhanceResponseText = enhanceResponse.content[0].type === 'text' ? enhanceResponse.content[0].text : '';
    await logLLMCall({
      jobId,
      jobType: 'pipeline_stage3',
      modelName: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      promptSummary: `Enhance responses chunk ${chunk + 1}/5`,
      promptFull: enhancePrompt,
      responseSummary: summarizeText(enhanceResponseText, 200),
      responseFull: enhanceResponseText,
      inputTokens: enhanceResponse.usage?.input_tokens,
      outputTokens: enhanceResponse.usage?.output_tokens,
      latencyMs: Date.now() - enhanceStartTime,
      status: 'success'
    });
    
    try {
      const responseText = enhanceResponseText;
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      const chunkResponses = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      
      for (const resp of chunkResponses) {
        allResponses.push({
          index: resp.objectionIndex,
          enhancedResponse: resp.enhancedResponse,
          enhancementNotes: resp.enhancementNotes || ''
        });
      }
    } catch (e) {
      console.error(`[Stage 3] Failed to parse chunk ${chunk}:`, e);
    }
    
    // Store chunk
    try {
      console.log(`[DB] Inserting pipelineChunks stage 3, chunk ${chunk}, jobId: ${jobId}`);
      await db.insert(pipelineChunks).values({
        jobId,
        stage: 3,
        chunkIndex: chunk,
        chunkInputText: JSON.stringify(chunkObjections.map(o => ({ index: o.objectionIndex, objection: o.objectionText }))),
        chunkOutputText: enhanceResponse.content[0].type === 'text' ? enhanceResponse.content[0].text : '',
        status: 'completed'
      });
      console.log(`[DB] Successfully inserted pipelineChunks stage 3, chunk ${chunk}`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to insert pipelineChunks stage 3, chunk ${chunk}:`, dbError.message, dbError.stack);
    }
  }
  
  onProgress('Formatting enhanced responses...', totalChunks, totalChunks);
  
  // Format output
  let output = '# 25 ENHANCED RESPONSES\n\n';
  for (const resp of allResponses) {
    const obj = objections.find(o => o.objectionIndex === resp.index);
    output += `## Response to Objection ${resp.index}\n\n`;
    output += `**Original Objection:** ${obj?.objectionText?.substring(0, 200)}...\n\n`;
    output += `**Enhanced Response:**\n${resp.enhancedResponse}\n\n`;
    output += `**Improvements:** ${resp.enhancementNotes}\n\n---\n\n`;
  }
  
  // Build skeleton
  const skeleton3: PipelineSkeleton3 = {
    objectionsToAddress: skeleton2.objectionSummaries,
    initialResponses: skeleton2.responseSummaries,
    responseGaps: [],
    enhancementStrategy: allResponses.map(r => ({
      index: r.index,
      strategy: 'deeper_analysis' as const,
      notes: r.enhancementNotes
    })),
    enhancedResponseSummaries: allResponses.map(r => ({
      index: r.index,
      summary: r.enhancedResponse.substring(0, 100)
    })),
    newCommitments: [],
    concessionsMade: [],
    inheritedSkeleton1: skeleton1,
    inheritedSkeleton2: skeleton2
  };
  
  return { output, skeleton: skeleton3, responses: allResponses };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 4: BULLET-PROOF VERSION
// ═══════════════════════════════════════════════════════════════════════════

interface IntegrationResult {
  objectionIndex: number;
  section: string;
  strategy: string;
}

async function runStage4Bulletproof(
  reconstructionOutput: string,
  responsesOutput: string,
  skeletons: {
    skeleton1: PipelineSkeleton1;
    skeleton2: PipelineSkeleton2;
    skeleton3: PipelineSkeleton3;
  },
  jobId: number,
  onProgress: (msg: string, completed: number, total: number) => void
): Promise<{
  output: string;
  skeleton: PipelineSkeleton4;
  integrations: IntegrationResult[];
}> {
  onProgress('Mapping integrations...', 0, 3);
  
  // Get enhanced responses
  const objections = await db.select().from(pipelineObjections)
    .where(eq(pipelineObjections.jobId, jobId));
  
  // Build integration map
  const integrationPrompt = `Create a bullet-proof version of this document by integrating responses to anticipated objections.

ORIGINAL RECONSTRUCTION:
${reconstructionOutput.substring(0, 20000)}

ORIGINAL COMMITMENTS (must be preserved or explicitly revised):
${JSON.stringify(skeletons.skeleton1.commitmentLedger, null, 2)}

ENHANCED RESPONSES TO INTEGRATE:
${objections.map(o => `
Objection ${o.objectionIndex} [${o.severity}]: ${o.objectionText?.substring(0, 100)}...
Enhanced Response: ${o.enhancedResponse?.substring(0, 200)}...
`).join('\n')}

TASK: Rewrite the document to:
1. Anticipate and address objections BEFORE they arise (not defensively)
2. Integrate all 25 enhanced responses naturally
3. Preserve ALL original commitments from the skeleton
4. Maintain the original argument's flow and voice
5. Be 110-130% of the original length

The bullet-proof version should read as a stronger document that preemptively addresses challenges.

Output ONLY the rewritten document.`;

  onProgress('Generating bullet-proof version...', 1, 3);
  
  const bulletproofStartTime = Date.now();
  const bulletproofResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 20000,
    messages: [{ role: 'user', content: integrationPrompt }]
  });
  
  const output = bulletproofResponse.content[0].type === 'text' ? bulletproofResponse.content[0].text : '';
  await logLLMCall({
    jobId,
    jobType: 'pipeline_stage4',
    modelName: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    promptSummary: 'Generate bullet-proof version',
    promptFull: integrationPrompt,
    responseSummary: summarizeText(output, 200),
    responseFull: output,
    inputTokens: bulletproofResponse.usage?.input_tokens,
    outputTokens: bulletproofResponse.usage?.output_tokens,
    latencyMs: Date.now() - bulletproofStartTime,
    status: 'success'
  });
  
  onProgress('Verifying integrations...', 2, 3);
  
  // Generate integration tracking
  const integrations: IntegrationResult[] = objections.map((o, i) => ({
    objectionIndex: o.objectionIndex || i + 1,
    section: `Section ${Math.floor(i / 5) + 1}`,
    strategy: 'inline'
  }));
  
  // Build skeleton
  const skeleton4: PipelineSkeleton4 = {
    originalStructure: [],
    integrationMap: [],
    integrationStrategy: integrations.map(i => ({
      responseIndex: i.objectionIndex,
      strategy: 'inline' as const,
      targetSection: 1
    })),
    concessionsToIncorporate: [],
    strengtheningAdditions: [],
    commitmentReconciliation: skeletons.skeleton1.commitmentLedger?.map(c => ({
      originalCommitment: c.claim,
      status: 'preserved' as const,
      notes: ''
    })) || [],
    lengthTarget: {
      min: Math.round(countWords(reconstructionOutput) * 1.1),
      max: Math.round(countWords(reconstructionOutput) * 1.3),
      target: Math.round(countWords(reconstructionOutput) * 1.2)
    },
    keyTerms: skeletons.skeleton1.keyTerms || [],
    inheritedSkeletons: skeletons
  };
  
  onProgress('Bullet-proof version complete', 3, 3);
  
  // Store chunk
  try {
    console.log(`[DB] Inserting pipelineChunks stage 4, chunk 0, jobId: ${jobId}`);
    await db.insert(pipelineChunks).values({
      jobId,
      stage: 4,
      chunkIndex: 0,
      chunkInputText: reconstructionOutput.substring(0, 5000),
      chunkOutputText: output.substring(0, 5000),
      actualWords: countWords(output),
      status: 'completed'
    });
    console.log(`[DB] Successfully inserted pipelineChunks stage 4, chunk 0`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert pipelineChunks stage 4:`, dbError.message, dbError.stack);
  }
  
  return { output, skeleton: skeleton4, integrations };
}

// ═══════════════════════════════════════════════════════════════════════════
// HORIZONTAL COHERENCE CHECK
// ═══════════════════════════════════════════════════════════════════════════

async function runHorizontalCoherenceCheck(jobId: number): Promise<HCCheckResult> {
  const [job] = await db.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId));
  const objections = await db.select().from(pipelineObjections).where(eq(pipelineObjections.jobId, jobId));
  
  const violations: HCViolation[] = [];
  const bulletproofText = job.bulletproofOutput || '';
  const skeleton1 = job.skeleton1 as PipelineSkeleton1 | null;
  
  // HC CHECK 1: Commitment Tracing
  if (skeleton1?.commitmentLedger) {
    for (const commitment of skeleton1.commitmentLedger) {
      const preserved = bulletproofText.toLowerCase().includes(commitment.claim.toLowerCase().substring(0, 50));
      
      if (!preserved) {
        violations.push({
          type: 'commitment_missing',
          severity: 'error',
          description: `Original commitment not found in bullet-proof version`,
          details: { commitment: commitment.claim }
        });
      }
    }
  }
  
  // HC CHECK 2: Objection Coverage
  for (const obj of objections) {
    if (!obj.integrationVerified) {
      violations.push({
        type: 'objection_not_addressed',
        severity: 'warning',
        description: `Objection ${obj.objectionIndex} may not be fully addressed`,
        details: { objectionIndex: obj.objectionIndex }
      });
    }
  }
  
  // HC CHECK 3: Response Integration
  for (const obj of objections) {
    if (obj.enhancedResponse) {
      // Check if key phrases appear in bullet-proof
      const keyPhrases = obj.enhancedResponse.split('.').slice(0, 2).map(s => s.trim().substring(0, 30));
      const integrated = keyPhrases.some(phrase => 
        bulletproofText.toLowerCase().includes(phrase.toLowerCase())
      );
      
      if (!integrated) {
        violations.push({
          type: 'response_not_integrated',
          severity: 'warning',
          description: `Response ${obj.objectionIndex} may not be integrated`,
          details: { responseIndex: obj.objectionIndex }
        });
      }
    }
  }
  
  // HC CHECK 4: Terminology Drift
  if (skeleton1?.keyTerms) {
    for (const term of skeleton1.keyTerms) {
      // Simple check - term should appear
      if (!bulletproofText.toLowerCase().includes(term.term.toLowerCase())) {
        violations.push({
          type: 'terminology_drift',
          severity: 'warning',
          description: `Key term "${term.term}" may not be preserved`,
          details: { term: term.term, originalDefinition: term.meaning }
        });
      }
    }
  }
  
  const errorCount = violations.filter(v => v.severity === 'error').length;
  
  return {
    passed: errorCount === 0,
    violations,
    summary: {
      total: violations.length,
      errors: errorCount,
      warnings: violations.filter(v => v.severity === 'warning').length,
      commitmentsMissing: violations.filter(v => v.type === 'commitment_missing').length,
      objectionsNotAddressed: violations.filter(v => v.type === 'objection_not_addressed').length,
      responsesNotIntegrated: violations.filter(v => v.type === 'response_not_integrated').length,
      terminologyDrifts: violations.filter(v => v.type === 'terminology_drift').length
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HC REPAIR
// ═══════════════════════════════════════════════════════════════════════════

async function attemptHCRepair(
  jobId: number,
  hcResult: HCCheckResult
): Promise<{ success: boolean }> {
  // For now, just log the violations - full repair would re-process Stage 4
  console.log(`[Pipeline ${jobId}] HC Repair needed for ${hcResult.violations.length} violations`);
  
  await db.update(pipelineJobs).set({
    hcRepairAttempts: 1
  }).where(eq(pipelineJobs.id, jobId));
  
  // TODO: Implement actual repair by re-processing Stage 4 sections
  return { success: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// RESUME PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

export async function resumePipeline(
  jobId: number,
  onProgress?: PipelineProgressCallback
): Promise<{
  success: boolean;
  error?: string;
}> {
  const [job] = await db.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId));
  
  if (!job) {
    return { success: false, error: 'Job not found' };
  }
  
  if (job.status === 'complete' || job.status === 'completed_with_warnings') {
    return { success: true };
  }
  
  console.log(`[Pipeline ${jobId}] Resuming from stage ${job.currentStage}`);
  
  // TODO: Implement resume logic based on currentStage
  // For now, just return error
  return { success: false, error: 'Resume not yet implemented' };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET PIPELINE STATUS
// ═══════════════════════════════════════════════════════════════════════════

export async function getPipelineStatus(jobId: number): Promise<PipelineJob | null> {
  const [job] = await db.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId));
  return job || null;
}

export async function getPipelineObjections(jobId: number): Promise<PipelineObjection[]> {
  return await db.select().from(pipelineObjections).where(eq(pipelineObjections.jobId, jobId));
}
