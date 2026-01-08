The app is generating output but audit_events has 0 rows. The app is not writing to the database.
You created the tables. You did not make the app use them.
Find the EXACT lines of code where:

LLM calls are made
Chunks are processed
Documents are generatedimport OpenAI from "openai";
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_OPENAI_MODEL = "gpt-5.2";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4.5";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR || "default_key",
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_ENV_VAR || "default_key",
});

const PRESET_TEXT: Record<string, string> = {
  // (full preset dict as before)
};

function expandPresets(selected: string[] = []): string[] {
  // (full function as before)
}

function buildPresetBlock(selectedPresets?: string[], customInstructions?: string): string {
  // (full function as before)
}

const GOOD_WRITING_SAMPLE = ` (full sample as before) `;

function buildRewritePrompt(params: {
  inputText: string;
  styleText?: string;
  contentMixText?: string;
  selectedPresets?: string[];
  customInstructions?: string;
}): string {
  // (full function with cardinal rules as before)
}

export interface RewriteParams {
  // (full interface as before)
}

export class AIProviderService {
  async rewriteWithOpenAI(params: RewriteParams): Promise<string> {
    // (full method as before)
  }
  async rewriteWithAnthropic(params: RewriteParams): Promise<string> {
    // (full method as before)
  }
  async rewriteWithPerplexity(params: RewriteParams): Promise<string> {
    // (full method as before)
  }
  async rewriteWithDeepSeek(params: RewriteParams): Promise<string> {
    // (full method as before)
  }
  async rewrite(provider: string, params: RewriteParams): Promise<string> {
    // (full method as before, with fixed loop)
  }
  private cleanMarkup(text: string): string {
    // (full method as before)
  }
}

export const aiProviderService = new AIProviderService();