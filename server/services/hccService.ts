import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db } from "../db";
import { 
  hccDocuments, hccParts, hccChapters, hccChunks,
  HccDocument, HccPart, HccChapter, HccChunk,
  HccBookSkeleton, HccPartSkeleton, HccChapterSkeleton, HccDelta,
  LengthEnforcementConfig
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { callAIWithFailover, cleanMarkdown } from "./aiFailover";

const anthropic = new Anthropic();
const openai = new OpenAI();

const PRIMARY_MODEL = "claude-sonnet-4-5-20250929";
const FALLBACK_MODEL = "gpt-4-turbo";

const VIRTUAL_PART_SIZE = 25000;
const VIRTUAL_CHAPTER_SIZE = 5000;
const TARGET_CHUNK_SIZE = 500;
const MAX_HCC_WORDS = 100000;
const CHUNK_DELAY_MS = 2000;
const MAX_CHUNK_RETRIES = 2;

async function callWithFallback(
  prompt: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  try {
    const message = await anthropic.messages.create({
      model: PRIMARY_MODEL,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "user", content: prompt }]
    });
    return message.content[0].type === 'text' ? message.content[0].text : '';
  } catch (error: any) {
    const status = error?.status || error?.response?.status;
    const isRetryable = status === 404 || status === 429 || status === 503 || status === 529;
    
    if (isRetryable) {
      console.log(`[HCC] Claude model error (${status}), falling back to GPT-4 Turbo`);
      try {
        const completion = await openai.chat.completions.create({
          model: FALLBACK_MODEL,
          max_tokens: maxTokens,
          temperature,
          messages: [{ role: "user", content: prompt }]
        });
        return completion.choices[0]?.message?.content || '';
      } catch (fallbackError: any) {
        console.error(`[HCC] Fallback to GPT-4 also failed:`, fallbackError?.message);
        throw fallbackError;
      }
    }
    throw error;
  }
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

export function parseTargetLength(customInstructions: string | null): { targetMin: number; targetMax: number } | null {
  if (!customInstructions) return null;
  
  const text = customInstructions.toLowerCase();
  
  const parseNumber = (numStr: string): number => {
    const cleaned = numStr.replace(/,/g, '').trim();
    if (cleaned.endsWith('k')) {
      return parseFloat(cleaned.slice(0, -1)) * 1000;
    }
    return parseInt(cleaned);
  };
  
  const rangeMatch = text.match(/(\d[\d,]*k?)\s*[-–—to]+\s*(\d[\d,]*k?)\s*words?/i);
  if (rangeMatch) {
    const min = parseNumber(rangeMatch[1]);
    const max = parseNumber(rangeMatch[2]);
    console.log(`[HCC] Parsed target range: ${min}-${max} words from "${rangeMatch[0]}"`);
    return { targetMin: min, targetMax: max };
  }
  
  const shortenMatch = text.match(/(?:shorten|reduce|compress|cut|trim)\s*(?:to|down\s*to)?\s*(\d[\d,]*k?)\s*words?/i);
  if (shortenMatch) {
    const target = parseNumber(shortenMatch[1]);
    console.log(`[HCC] Parsed shorten target: ${target} words from "${shortenMatch[0]}"`);
    return { targetMin: Math.round(target * 0.9), targetMax: Math.round(target * 1.1) };
  }
  
  const expandMatch = text.match(/(?:expand|enrich|elaborate)\s*(?:to)?\s*(\d[\d,]*k?)\s*words?/i);
  if (expandMatch) {
    const target = parseNumber(expandMatch[1]);
    console.log(`[HCC] Parsed expand target: ${target} words from "${expandMatch[0]}"`);
    return { targetMin: Math.round(target * 0.9), targetMax: Math.round(target * 1.1) };
  }
  
  const atLeastMatch = text.match(/at\s*least\s*(\d[\d,]*k?)\s*words?/i);
  const noMoreMatch = text.match(/no\s*more\s*than\s*(\d[\d,]*k?)\s*words?/i);
  if (atLeastMatch && noMoreMatch) {
    const min = parseNumber(atLeastMatch[1]);
    const max = parseNumber(noMoreMatch[1]);
    console.log(`[HCC] Parsed at-least/no-more: ${min}-${max} words`);
    return { targetMin: min, targetMax: max };
  }
  
  const noLessMatch = text.match(/no\s*(?:less|fewer)\s*(?:than)?\s*(\d[\d,]*k?)\s*words?/i);
  if (noLessMatch) {
    const min = parseNumber(noLessMatch[1]);
    console.log(`[HCC] Parsed no-less-than: ${min}+ words from "${noLessMatch[0]}"`);
    return { targetMin: min, targetMax: Math.round(min * 1.2) };
  }
  
  const approxMatch = text.match(/(?:approximately|around|about|roughly)\s*(\d[\d,]*k?)\s*words?/i);
  if (approxMatch) {
    const target = parseNumber(approxMatch[1]);
    console.log(`[HCC] Parsed approx target: ${target} words from "${approxMatch[0]}"`);
    return { targetMin: Math.round(target * 0.9), targetMax: Math.round(target * 1.1) };
  }
  
  const exactMatch = text.match(/(\d[\d,]*k?)\s*words?(?:\s*(?:\(|\[|no\s*less))?/i);
  if (exactMatch) {
    const target = parseNumber(exactMatch[1]);
    console.log(`[HCC] Parsed exact target: ${target} words from "${exactMatch[0]}"`);
    return { targetMin: Math.round(target * 0.9), targetMax: Math.round(target * 1.1) };
  }
  
  if (/expand|enrich|elaborate|develop/i.test(text) && !/\d/.test(text)) {
    console.log(`[HCC] Parsed expansion mode (no specific number)`);
    return { targetMin: -1, targetMax: -1 };
  }
  
  if (/compress|summarize|shorten|condense/i.test(text) && !/\d/.test(text)) {
    console.log(`[HCC] Parsed compression mode (no specific number)`);
    return { targetMin: -2, targetMax: -2 };
  }
  
  return null;
}

export function calculateLengthConfig(
  totalInputWords: number,
  targetMin: number | null,
  targetMax: number | null,
  customInstructions: string | null
): LengthEnforcementConfig {
  let actualMin = targetMin;
  let actualMax = targetMax;
  
  if (actualMin === -1 && actualMax === -1) {
    actualMin = Math.round(totalInputWords * 1.3);
    actualMax = Math.round(totalInputWords * 1.5);
  } else if (actualMin === -2 && actualMax === -2) {
    actualMin = Math.round(totalInputWords * 0.3);
    actualMax = Math.round(totalInputWords * 0.5);
  } else if (!actualMin || !actualMax) {
    actualMin = totalInputWords;
    actualMax = totalInputWords;
  }
  
  const targetMidWords = Math.round((actualMin + actualMax) / 2);
  const lengthRatio = targetMidWords / totalInputWords;
  
  let lengthMode: LengthEnforcementConfig['lengthMode'];
  if (lengthRatio < 0.5) lengthMode = 'heavy_compression';
  else if (lengthRatio < 0.8) lengthMode = 'moderate_compression';
  else if (lengthRatio < 1.2) lengthMode = 'maintain';
  else if (lengthRatio < 1.8) lengthMode = 'moderate_expansion';
  else lengthMode = 'heavy_expansion';
  
  return {
    targetMinWords: actualMin,
    targetMaxWords: actualMax,
    targetMidWords,
    lengthRatio,
    lengthMode
  };
}

function getLengthGuidance(mode: LengthEnforcementConfig['lengthMode']): string {
  switch (mode) {
    case 'heavy_compression':
      return `LENGTH MODE: HEAVY COMPRESSION
You must significantly compress this chunk while preserving core arguments.
- Remove examples, keep only the most critical one
- Remove repetition and redundancy
- Convert detailed explanations to concise statements
- Preserve thesis statements and key claims verbatim
- Remove transitional phrases and rhetorical flourishes`;
    
    case 'moderate_compression':
      return `LENGTH MODE: MODERATE COMPRESSION
You must compress this chunk while preserving argument structure.
- Keep the strongest 1-2 examples, remove weaker ones
- Tighten prose without losing meaning
- Preserve all key claims and their primary support
- Remove redundancy but keep necessary repetition for emphasis`;
    
    case 'maintain':
      return `LENGTH MODE: MAINTAIN LENGTH
Your output should be approximately the same length as input.
- Improve clarity and coherence without changing length significantly
- Replace weak examples with stronger ones of similar length
- Restructure sentences for better flow
- Do not add or remove substantial content`;
    
    case 'moderate_expansion':
      return `LENGTH MODE: MODERATE EXPANSION
You must expand this chunk while maintaining focus.
- Add 1-2 supporting examples or evidence for key claims
- Elaborate on implications of major points
- Add transitional sentences to improve flow
- Expand terse statements into fuller explanations
- Do NOT add tangential content or padding`;
    
    case 'heavy_expansion':
      return `LENGTH MODE: HEAVY EXPANSION
You must significantly expand this chunk with substantive additions.
- Add 2-3 concrete examples (historical, empirical, or hypothetical)
- Elaborate on each major claim with supporting analysis
- Add relevant context and background
- Develop implications and consequences of arguments
- Add appropriate qualifications and nuances
- Do NOT add filler or padding—all additions must be substantive`;
  }
}

interface DocumentStructure {
  parts: {
    title: string;
    startIndex: number;
    endIndex: number;
    chapters: {
      title: string;
      startIndex: number;
      endIndex: number;
    }[];
  }[];
}

export function detectDocumentStructure(text: string): DocumentStructure {
  const words = text.split(/\s+/);
  const totalWords = words.length;
  
  const partPatterns = [
    /^(PART|Part)\s+([IVXLCDM]+|[0-9]+)/m,
    /^(BOOK|Book)\s+([IVXLCDM]+|[0-9]+)/m,
    /^(SECTION|Section)\s+([IVXLCDM]+|[0-9]+)/m
  ];
  
  const chapterPatterns = [
    /^(CHAPTER|Chapter)\s+([0-9]+|[IVXLCDM]+)/m,
    /^([0-9]+)\.\s+[A-Z]/m
  ];
  
  let parts: DocumentStructure['parts'] = [];
  
  let hasParts = false;
  let hasChapters = false;
  
  for (const pattern of partPatterns) {
    if (pattern.test(text)) {
      hasParts = true;
      break;
    }
  }
  
  for (const pattern of chapterPatterns) {
    if (pattern.test(text)) {
      hasChapters = true;
      break;
    }
  }
  
  if (!hasParts && !hasChapters) {
    const numVirtualParts = Math.ceil(totalWords / VIRTUAL_PART_SIZE);
    
    for (let p = 0; p < numVirtualParts; p++) {
      const partStartWord = p * VIRTUAL_PART_SIZE;
      const partEndWord = Math.min((p + 1) * VIRTUAL_PART_SIZE, totalWords);
      const partWords = partEndWord - partStartWord;
      
      const numChapters = Math.ceil(partWords / VIRTUAL_CHAPTER_SIZE);
      const chapters = [];
      
      for (let c = 0; c < numChapters; c++) {
        chapters.push({
          title: `Section ${p * numChapters + c + 1}`,
          startIndex: partStartWord + c * VIRTUAL_CHAPTER_SIZE,
          endIndex: Math.min(partStartWord + (c + 1) * VIRTUAL_CHAPTER_SIZE, partEndWord)
        });
      }
      
      parts.push({
        title: `Part ${p + 1}`,
        startIndex: partStartWord,
        endIndex: partEndWord,
        chapters
      });
    }
  } else {
    const numVirtualParts = Math.ceil(totalWords / VIRTUAL_PART_SIZE);
    
    for (let p = 0; p < numVirtualParts; p++) {
      const partStartWord = p * VIRTUAL_PART_SIZE;
      const partEndWord = Math.min((p + 1) * VIRTUAL_PART_SIZE, totalWords);
      const partWords = partEndWord - partStartWord;
      
      const numChapters = Math.ceil(partWords / VIRTUAL_CHAPTER_SIZE);
      const chapters = [];
      
      for (let c = 0; c < numChapters; c++) {
        chapters.push({
          title: `Chapter ${p * numChapters + c + 1}`,
          startIndex: partStartWord + c * VIRTUAL_CHAPTER_SIZE,
          endIndex: Math.min(partStartWord + (c + 1) * VIRTUAL_CHAPTER_SIZE, partEndWord)
        });
      }
      
      parts.push({
        title: `Part ${p + 1}`,
        startIndex: partStartWord,
        endIndex: partEndWord,
        chapters
      });
    }
  }
  
  return { parts };
}

function getTextByWordRange(text: string, startWord: number, endWord: number): string {
  const words = text.split(/\s+/);
  return words.slice(startWord, endWord).join(' ');
}

export async function extractBookSkeleton(text: string): Promise<HccBookSkeleton> {
  const sampleSize = Math.min(countWords(text), 8000);
  const sampleText = text.split(/\s+/).slice(0, sampleSize).join(' ');
  
  const prompt = `You are analyzing a book-length document. Extract its GLOBAL STRUCTURE in a compressed form (~2000 tokens max).

DOCUMENT SAMPLE (first ${sampleSize} words):
${sampleText}

Extract and return as JSON:
{
  "masterThesis": "The central argument of the entire document in 1-2 sentences",
  "majorDivisions": [{"title": "Part/Section name", "summary": "2-3 sentence summary"}],
  "globalTerms": [{"term": "key term", "definition": "how it's used throughout"}],
  "coreCommitments": [{"type": "asserts|rejects|assumes", "claim": "core claim"}],
  "crossReferences": [{"from": "topic A", "to": "topic B", "relationship": "how they connect"}]
}

RULES:
1. masterThesis should capture the CORE PURPOSE of the entire work
2. majorDivisions should have 3-8 entries for major parts/sections
3. globalTerms are terms that must be used CONSISTENTLY throughout
4. coreCommitments are non-negotiable claims the document makes
5. Keep this COMPRESSED - these tokens will be injected into every chunk

Return ONLY valid JSON.`;

  const responseText = await callWithFallback(prompt, 4000, 0.2);
  
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('Failed to parse book skeleton:', e);
  }
  
  return {
    masterThesis: "Unable to extract thesis",
    majorDivisions: [],
    globalTerms: [],
    coreCommitments: [],
    crossReferences: []
  };
}

export async function compressSkeleton(skeleton: any, targetTokens: number): Promise<string> {
  const prompt = `Compress this skeleton to approximately ${targetTokens} tokens while preserving:
1. Thesis statements VERBATIM
2. Key term definitions VERBATIM
3. Core commitments
4. Replace examples with references
5. Compress argument chains to conclusions

SKELETON:
${JSON.stringify(skeleton, null, 2)}

Return a compressed text summary (not JSON).`;

  return await callWithFallback(prompt, targetTokens * 2, 0.2);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isOutputTruncated(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  
  const lastChar = trimmed[trimmed.length - 1];
  const validEndings = ['.', '!', '?', '"', "'", ')', ']', '—', ':'];
  
  if (!validEndings.includes(lastChar)) {
    const sentences = trimmed.match(/[.!?]["']?\s/g);
    if (!sentences || sentences.length < 2) {
      return true;
    }
  }
  
  return false;
}

export async function processChunkWithLength(
  chunkText: string,
  chapterSkeleton: string,
  lengthConfig: LengthEnforcementConfig,
  chunkInputWords: number,
  totalChunks: number,
  customInstructions: string | null,
  chunkIndex?: number,
  onCheckpoint?: (chunkIdx: number, output: string) => Promise<void>
): Promise<{ processedText: string; wordCount: number; delta: any }> {
  
  const chunkTargetWords = Math.round(chunkInputWords * lengthConfig.lengthRatio);
  const chunkMinWords = Math.round(chunkTargetWords * 0.80);
  const chunkMaxWords = Math.round(chunkTargetWords * 1.20);
  const lengthGuidance = getLengthGuidance(lengthConfig.lengthMode);
  
  console.log(`[HCC] Chunk ${chunkIndex ?? 0}: Input=${chunkInputWords} words, Target=${chunkTargetWords} words (min=${chunkMinWords}, max=${chunkMaxWords}), Ratio=${lengthConfig.lengthRatio.toFixed(2)}`);
  
  let attempt = 0;
  let processedText = '';
  let wordCount = 0;
  let delta = { new_claims: [], terms_used: [], conflicts: [], cross_refs: [] };
  
  while (attempt < MAX_CHUNK_RETRIES) {
    attempt++;
    
    const targetForAttempt = attempt === 1 ? chunkTargetWords : Math.round(chunkTargetWords * 0.85);
    const minForAttempt = Math.round(targetForAttempt * 0.75);
    const maxForAttempt = Math.round(targetForAttempt * 1.2);
    
    const prompt = `You are processing one chunk of a larger document. Maintain coherence with the established structure.

CHAPTER SKELETON (you must honor this):
${chapterSkeleton}

${customInstructions ? `ADDITIONAL INSTRUCTIONS:\n${customInstructions}\n` : ''}

*** CRITICAL OUTPUT LENGTH REQUIREMENT ***
This chunk is part of a ${totalChunks}-chunk document.
- Original chunk length: ${chunkInputWords} words
- YOUR OUTPUT MUST BE: ${minForAttempt}-${maxForAttempt} words
- Target: approximately ${targetForAttempt} words

HARD REQUIREMENTS:
1. Your output MUST be at least ${minForAttempt} words - shorter outputs FAIL
2. Your output MUST NOT exceed ${maxForAttempt} words - longer outputs FAIL
3. Your output MUST end with a complete sentence - no truncation allowed
4. Count your words before submitting

${attempt > 1 ? `RETRY ATTEMPT ${attempt}: Previous output was too short or truncated. YOU MUST produce ${minForAttempt}-${maxForAttempt} words this time.` : ''}

${lengthGuidance}

*** END LENGTH REQUIREMENT ***

CONSTRAINTS:
- Do NOT contradict any commitment in the skeleton
- Use key terms EXACTLY as defined in the skeleton
- If you detect a conflict between chunk content and skeleton, FLAG IT EXPLICITLY
- Preserve the chunk's contribution to the argument
- COMPLETE YOUR OUTPUT - do not stop mid-sentence

CHUNK TEXT:
${chunkText}

Provide your response in this format:

PROCESSED_TEXT:
[Your reconstructed chunk here, ${minForAttempt}-${maxForAttempt} words, ending with a complete sentence]

WORD_COUNT: [exact number of words in your output]

DELTA_REPORT:
{"new_claims": [], "terms_used": [], "conflicts": [], "cross_refs": []}`;

    const responseText = await callWithFallback(prompt, 4000, 0.3);
    
    const textMatch = responseText.match(/PROCESSED_TEXT:\s*([\s\S]*?)(?=WORD_COUNT:|DELTA_REPORT:|$)/i);
    if (textMatch) {
      processedText = cleanMarkdown(textMatch[1].trim());
      wordCount = countWords(processedText);
    }
    
    const deltaMatch = responseText.match(/DELTA_REPORT:\s*(\{[\s\S]*?\})/i);
    if (deltaMatch) {
      try {
        delta = JSON.parse(deltaMatch[1]);
      } catch (e) {}
    }
    
    const isTruncated = isOutputTruncated(processedText);
    const isTooShort = wordCount < minForAttempt;
    
    if (!isTruncated && !isTooShort) {
      console.log(`[HCC] Chunk ${chunkIndex ?? '?'} completed: ${wordCount} words (target: ${targetForAttempt})`);
      break;
    }
    
    if (attempt < MAX_CHUNK_RETRIES) {
      console.log(`[HCC] Chunk ${chunkIndex ?? '?'} validation failed (truncated: ${isTruncated}, short: ${isTooShort}, got ${wordCount} words). Retrying...`);
      await delay(1000);
    } else {
      console.log(`[HCC] Chunk ${chunkIndex ?? '?'} max retries reached. Proceeding with ${wordCount} words.`);
    }
  }
  
  if (onCheckpoint && chunkIndex !== undefined) {
    await onCheckpoint(chunkIndex, processedText);
  }
  
  return { processedText, wordCount, delta };
}

export async function stitchChapter(
  chapterSkeleton: string,
  chunks: { text: string; delta: any }[]
): Promise<{ output: string; delta: HccDelta }> {
  const chunksText = chunks.map((c, i) => `[CHUNK ${i + 1}]\n${c.text}`).join('\n\n');
  const deltasJson = JSON.stringify(chunks.map(c => c.delta));
  
  const prompt = `You are stitching together processed chunks into a coherent chapter.

CHAPTER SKELETON:
${chapterSkeleton}

CHUNK DELTAS:
${deltasJson}

PROCESSED CHUNKS:
${chunksText}

TASK:
1. Detect any contradictions between chunks
2. Detect any terminology drift
3. Identify missing premises or redundancies
4. Perform micro-repairs to fix issues
5. Assemble into a coherent chapter output

Return:
CHAPTER_OUTPUT:
[Stitched chapter text]

CHAPTER_DELTA:
{"netContribution": "summary", "newCommitments": [], "conflictsResolved": [], "conflictsFlagged": [], "crossReferences": []}`;

  const responseText = await callWithFallback(prompt, 16000, 0.3);
  
  const outputMatch = responseText.match(/CHAPTER_OUTPUT:\s*([\s\S]*?)(?=CHAPTER_DELTA:|$)/i);
  const deltaMatch = responseText.match(/CHAPTER_DELTA:\s*(\{[\s\S]*?\})/i);
  
  const output = outputMatch ? cleanMarkdown(outputMatch[1].trim()) : chunks.map(c => c.text).join('\n\n');
  let delta: HccDelta = {
    netContribution: '',
    newCommitments: [],
    conflictsResolved: [],
    conflictsFlagged: [],
    crossReferences: []
  };
  
  if (deltaMatch) {
    try {
      delta = JSON.parse(deltaMatch[1]);
    } catch (e) {}
  }
  
  return { output, delta };
}

export async function processHccDocument(
  text: string,
  customInstructions: string | null,
  userId?: number
): Promise<{ success: boolean; output: string; documentId?: number; error?: string }> {
  const startTime = Date.now();
  const wordCount = countWords(text);
  
  if (wordCount > MAX_HCC_WORDS) {
    return { success: false, output: '', error: `Document exceeds ${MAX_HCC_WORDS} word limit (got ${wordCount})` };
  }
  
  const parsedLength = parseTargetLength(customInstructions);
  const lengthConfig = calculateLengthConfig(
    wordCount,
    parsedLength?.targetMin ?? null,
    parsedLength?.targetMax ?? null,
    customInstructions
  );
  
  console.log(`[HCC] ═══════════════════════════════════════════════════════════════`);
  console.log(`[HCC] Starting HCC Processing`);
  console.log(`[HCC] Input: ${wordCount.toLocaleString()} words`);
  console.log(`[HCC] Target: ${lengthConfig.targetMinWords.toLocaleString()}-${lengthConfig.targetMaxWords.toLocaleString()} words (mid: ${lengthConfig.targetMidWords.toLocaleString()})`);
  console.log(`[HCC] Ratio: ${lengthConfig.lengthRatio.toFixed(3)} (${lengthConfig.lengthMode})`);
  console.log(`[HCC] Custom Instructions: ${customInstructions ? customInstructions.slice(0, 100) + '...' : 'None'}`);
  console.log(`[HCC] ═══════════════════════════════════════════════════════════════`);
  
  const structure = detectDocumentStructure(text);
  console.log(`[HCC] Detected structure: ${structure.parts.length} parts`);
  
  let docResult: any;
  try {
    console.log(`[DB] Inserting hccDocuments, wordCount: ${wordCount}`);
    [docResult] = await db.insert(hccDocuments).values({
      userId,
      originalText: text,
      wordCount,
      structureMap: structure,
      targetMinWords: lengthConfig.targetMinWords,
      targetMaxWords: lengthConfig.targetMaxWords,
      lengthRatio: String(lengthConfig.lengthRatio),
      lengthMode: lengthConfig.lengthMode,
      customInstructions,
      status: 'structure_detected'
    }).returning();
    console.log(`[DB] Successfully inserted hccDocuments, docId: ${docResult.id}`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert hccDocuments:`, dbError.message);
    return { success: false, output: '', error: `Database error: ${dbError.message}` };
  }
  
  const documentId = docResult.id;
  
  try {
    const bookSkeleton = await extractBookSkeleton(text);
    try {
      console.log(`[DB] Updating hccDocuments with skeleton, docId: ${documentId}`);
      await db.update(hccDocuments)
        .set({ bookSkeleton, status: 'skeletons_extracted' })
        .where(eq(hccDocuments.id, documentId));
      console.log(`[DB] Successfully updated hccDocuments with skeleton`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update hccDocuments with skeleton:`, dbError.message);
    }
    
    const compressedBook = await compressSkeleton(bookSkeleton, 500);
    
    let allChapterOutputs: string[] = [];
    
    for (let p = 0; p < structure.parts.length; p++) {
      const part = structure.parts[p];
      const partText = getTextByWordRange(text, part.startIndex, part.endIndex);
      
      let partResult: any;
      try {
        console.log(`[DB] Inserting hccParts, partIndex: ${p}`);
        [partResult] = await db.insert(hccParts).values({
          documentId,
          partIndex: p,
          partTitle: part.title,
          originalText: partText,
          wordCount: countWords(partText),
          compressedBookSkeleton: { compressed: compressedBook },
          status: 'processing'
        }).returning();
        console.log(`[DB] Successfully inserted hccParts, partId: ${partResult.id}`);
      } catch (dbError: any) {
        console.error(`[DB] FAILED to insert hccParts partIndex ${p}:`, dbError.message);
        continue;
      }
      
      const partId = partResult.id;
      const compressedPart = compressedBook;
      
      for (let c = 0; c < part.chapters.length; c++) {
        const chapter = part.chapters[c];
        const chapterText = getTextByWordRange(text, chapter.startIndex, chapter.endIndex);
        const chapterWords = countWords(chapterText);
        
        let chapterResult: any;
        try {
          console.log(`[DB] Inserting hccChapters, chapterIndex: ${c}`);
          [chapterResult] = await db.insert(hccChapters).values({
            partId,
            documentId,
            chapterIndex: c,
            chapterTitle: chapter.title,
            originalText: chapterText,
            wordCount: chapterWords,
            compressedPartSkeleton: { compressed: compressedPart },
            status: 'processing'
          }).returning();
          console.log(`[DB] Successfully inserted hccChapters, chapterId: ${chapterResult.id}`);
        } catch (dbError: any) {
          console.error(`[DB] FAILED to insert hccChapters chapterIndex ${c}:`, dbError.message);
          continue;
        }
        
        const chapterId = chapterResult.id;
        
        const chapterSkeleton = `Master Thesis: ${bookSkeleton.masterThesis}\nContext: ${compressedPart}`;
        
        const chapterChunks = smartChunk(chapterText);
        const processedChunks: { text: string; delta: any }[] = [];
        
        for (let k = 0; k < chapterChunks.length; k++) {
          const chunk = chapterChunks[k];
          const chunkTargetWords = Math.round(chunk.wordCount * lengthConfig.lengthRatio);
          
          let chunkRecord: any;
          try {
            console.log(`[DB] Inserting hccChunks, chunkIndex: ${k}`);
            [chunkRecord] = await db.insert(hccChunks).values({
              chapterId,
              documentId,
              chunkIndex: k,
              chunkInputText: chunk.text,
              chunkInputWords: chunk.wordCount,
              targetWords: chunkTargetWords,
              minWords: Math.round(chunkTargetWords * 0.80),
              maxWords: Math.round(chunkTargetWords * 1.20),
              status: 'processing'
            }).returning();
            console.log(`[DB] Successfully inserted hccChunks, chunkId: ${chunkRecord.id}`);
          } catch (dbError: any) {
            console.error(`[DB] FAILED to insert hccChunks chunkIndex ${k}:`, dbError.message);
            continue;
          }
          
          const checkpointCallback = async (chunkIdx: number, output: string) => {
            try {
              console.log(`[DB] Updating hccChunks checkpoint, chunkId: ${chunkRecord.id}`);
              await db.update(hccChunks)
                .set({ chunkOutputText: output, chunkOutputWords: countWords(output), status: 'completed' })
                .where(eq(hccChunks.id, chunkRecord.id));
              console.log(`[HCC] Checkpoint saved for chunk ${chunkIdx}`);
            } catch (dbError: any) {
              console.error(`[DB] FAILED to update hccChunks checkpoint:`, dbError.message);
            }
          };
          
          const result = await processChunkWithLength(
            chunk.text,
            chapterSkeleton,
            lengthConfig,
            chunk.wordCount,
            chapterChunks.length,
            customInstructions,
            k,
            checkpointCallback
          );
          
          processedChunks.push({ text: result.processedText, delta: result.delta });
          
          if (k < chapterChunks.length - 1) {
            console.log(`[HCC] Waiting ${CHUNK_DELAY_MS}ms before next chunk...`);
            await delay(CHUNK_DELAY_MS);
          }
        }
        
        const stitchedChapter = await stitchChapter(chapterSkeleton, processedChunks);
        
        try {
          console.log(`[DB] Updating hccChapters complete, chapterId: ${chapterId}`);
          await db.update(hccChapters)
            .set({ 
              chapterOutput: stitchedChapter.output,
              chapterDelta: stitchedChapter.delta,
              status: 'completed'
            })
            .where(eq(hccChapters.id, chapterId));
          console.log(`[DB] Successfully updated hccChapters complete`);
        } catch (dbError: any) {
          console.error(`[DB] FAILED to update hccChapters complete:`, dbError.message);
        }
        
        allChapterOutputs.push(stitchedChapter.output);
      }
      
      const partOutput = allChapterOutputs.slice(-part.chapters.length).join('\n\n');
      try {
        console.log(`[DB] Updating hccParts complete, partId: ${partId}`);
        await db.update(hccParts)
          .set({ partOutput, status: 'completed' })
          .where(eq(hccParts.id, partId));
        console.log(`[DB] Successfully updated hccParts complete`);
      } catch (dbError: any) {
        console.error(`[DB] FAILED to update hccParts complete:`, dbError.message);
      }
    }
    
    const finalOutput = allChapterOutputs.join('\n\n');
    const finalWordCount = countWords(finalOutput);
    const elapsedMs = Date.now() - startTime;
    const elapsedMinutes = (elapsedMs / 60000).toFixed(1);
    
    try {
      console.log(`[DB] Updating hccDocuments with final output, docId: ${documentId}`);
      await db.update(hccDocuments)
        .set({ finalOutput, status: 'complete' })
        .where(eq(hccDocuments.id, documentId));
      console.log(`[DB] Successfully updated hccDocuments with final output`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update hccDocuments with final output:`, dbError.message);
    }
    
    console.log(`[HCC] ═══════════════════════════════════════════════════════════════`);
    console.log(`[HCC] HCC Processing Complete`);
    console.log(`[HCC] Input: ${wordCount.toLocaleString()} words`);
    console.log(`[HCC] Output: ${finalWordCount.toLocaleString()} words`);
    console.log(`[HCC] Target: ${lengthConfig.targetMinWords.toLocaleString()}-${lengthConfig.targetMaxWords.toLocaleString()} words`);
    console.log(`[HCC] Ratio achieved: ${(finalWordCount / wordCount).toFixed(3)} (target: ${lengthConfig.lengthRatio.toFixed(3)})`);
    console.log(`[HCC] Processing time: ${elapsedMinutes} minutes (${elapsedMs.toLocaleString()} ms)`);
    console.log(`[HCC] Parts processed: ${structure.parts.length}`);
    console.log(`[HCC] ═══════════════════════════════════════════════════════════════`);
    
    return { success: true, output: finalOutput, documentId };
    
  } catch (error: any) {
    const elapsedMs = Date.now() - startTime;
    console.log(`[HCC] Processing FAILED after ${(elapsedMs / 60000).toFixed(1)} minutes: ${error.message}`);
    
    try {
      console.log(`[DB] Updating hccDocuments to failed status, docId: ${documentId}`);
      await db.update(hccDocuments)
        .set({ status: 'failed' })
        .where(eq(hccDocuments.id, documentId));
      console.log(`[DB] Successfully updated hccDocuments to failed status`);
    } catch (dbError: any) {
      console.error(`[DB] FAILED to update hccDocuments to failed status:`, dbError.message);
    }
    
    throw error;
  }
}

function smartChunk(text: string): { text: string; wordCount: number }[] {
  const words = text.trim().split(/\s+/);
  const totalWords = words.length;
  
  if (totalWords <= TARGET_CHUNK_SIZE) {
    return [{ text: text, wordCount: totalWords }];
  }
  
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: { text: string; wordCount: number }[] = [];
  let currentChunk = "";
  let currentWordCount = 0;
  
  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;
    
    const paraWords = trimmedPara.split(/\s+/).length;
    
    if (currentWordCount + paraWords > TARGET_CHUNK_SIZE && currentWordCount > 0) {
      chunks.push({ text: currentChunk.trim(), wordCount: currentWordCount });
      currentChunk = trimmedPara;
      currentWordCount = paraWords;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + trimmedPara;
      currentWordCount += paraWords;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push({ text: currentChunk.trim(), wordCount: currentWordCount });
  }
  
  return chunks;
}
