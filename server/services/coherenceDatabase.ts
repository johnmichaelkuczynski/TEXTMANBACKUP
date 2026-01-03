import { db } from "../db";
import { coherenceDocuments, coherenceChunks } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import type { 
  CoherenceState, 
  CoherenceModeType, 
  ChunkEvaluationResult,
  LogicalConsistencyState,
  LogicalCohesivenessState,
  ScientificExplanatoryState,
  ThematicPsychologicalState,
  InstructionalState,
  MotivationalState,
  MathematicalState,
  PhilosophicalState
} from "@shared/schema";
import { v4 as uuidv4 } from "uuid";

// Initialize state template for a given mode (using hyphenated format)
export function createInitialState(mode: CoherenceModeType): CoherenceState {
  switch (mode) {
    case "logical-consistency":
      return {
        mode: "logical-consistency",
        assertions: [],
        negations: [],
        disjoint_pairs: []
      };
    case "logical-cohesiveness":
      return {
        mode: "logical-cohesiveness",
        thesis: "",
        support_queue: [],
        current_stage: "setup",
        bridge_required: ""
      };
    case "scientific-explanatory":
      return {
        mode: "scientific-explanatory",
        causal_nodes: [],
        causal_edges: [],
        level: "",
        active_feedback_loops: [],
        mechanism_requirements: []
      };
    case "thematic-psychological":
      return {
        mode: "thematic-psychological",
        dominant_affect: "",
        tempo: "",
        stance: ""
      };
    case "instructional":
      return {
        mode: "instructional",
        goal: "",
        steps_done: [],
        prereqs: [],
        open_loops: []
      };
    case "motivational":
      return {
        mode: "motivational",
        direction: "encourage",
        intensity: 3,
        target: ""
      };
    case "mathematical":
      return {
        mode: "mathematical",
        givens: [],
        proved: [],
        goal: "",
        proof_method: "",
        dependencies: []
      };
    case "philosophical":
      return {
        mode: "philosophical",
        core_concepts: {},
        distinctions: [],
        dialectic: { objections_raised: [], replies_pending: [] },
        no_equivocation: []
      };
    default:
      throw new Error(`Unknown coherence mode: ${mode}`);
  }
}

// Generate unique document ID
export function generateDocumentId(): string {
  return uuidv4();
}

// Initialize a coherence run
export async function initializeCoherenceRun(
  documentId: string,
  mode: CoherenceModeType,
  initialState: CoherenceState
): Promise<void> {
  try {
    console.log(`[DB] Inserting coherenceDocuments, documentId: ${documentId}, mode: ${mode}`);
    await db.insert(coherenceDocuments)
      .values({
        documentId,
        coherenceMode: mode,
        globalState: initialState
      })
      .onConflictDoUpdate({
        target: [coherenceDocuments.documentId, coherenceDocuments.coherenceMode],
        set: {
          globalState: initialState,
          updatedAt: sql`NOW()`
        }
      });
    console.log(`[DB] Successfully inserted coherenceDocuments`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert coherenceDocuments:`, dbError.message, dbError.stack);
    throw new Error(`Database insert failed for coherenceDocuments: ${dbError.message}`);
  }
}

// Read current state from database
export async function readCoherenceState(
  documentId: string,
  mode: CoherenceModeType
): Promise<CoherenceState | null> {
  const result = await db.select({ globalState: coherenceDocuments.globalState })
    .from(coherenceDocuments)
    .where(and(
      eq(coherenceDocuments.documentId, documentId),
      eq(coherenceDocuments.coherenceMode, mode)
    ))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return result[0].globalState as CoherenceState;
}

// Update state after chunk processing
export async function updateCoherenceState(
  documentId: string,
  mode: CoherenceModeType,
  newState: CoherenceState
): Promise<void> {
  try {
    console.log(`[DB] Updating coherenceDocuments state, documentId: ${documentId}, mode: ${mode}`);
    await db.update(coherenceDocuments)
      .set({
        globalState: newState,
        updatedAt: sql`NOW()`
      })
      .where(and(
        eq(coherenceDocuments.documentId, documentId),
        eq(coherenceDocuments.coherenceMode, mode)
      ));
    console.log(`[DB] Successfully updated coherenceDocuments state`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to update coherenceDocuments state:`, dbError.message, dbError.stack);
  }
}

// Write chunk evaluation result
export async function writeChunkEvaluation(
  documentId: string,
  mode: CoherenceModeType,
  chunkIndex: number,
  chunkText: string,
  evaluationResult: ChunkEvaluationResult,
  stateAfter: CoherenceState
): Promise<void> {
  try {
    console.log(`[DB] Inserting coherenceChunks, documentId: ${documentId}, mode: ${mode}, chunkIndex: ${chunkIndex}`);
    await db.insert(coherenceChunks)
      .values({
        documentId,
        coherenceMode: mode,
        chunkIndex,
        chunkText,
        evaluationResult,
        stateAfter
      })
      .onConflictDoUpdate({
        target: [coherenceChunks.documentId, coherenceChunks.coherenceMode, coherenceChunks.chunkIndex],
        set: {
          evaluationResult,
          stateAfter
        }
      });
    console.log(`[DB] Successfully inserted coherenceChunks`);
  } catch (dbError: any) {
    console.error(`[DB] FAILED to insert coherenceChunks:`, dbError.message, dbError.stack);
    throw new Error(`Database insert failed for coherenceChunks: ${dbError.message}`);
  }
}

// Read all chunk evaluations for a document
export async function readAllChunkEvaluations(
  documentId: string,
  mode: CoherenceModeType
): Promise<{ chunkIndex: number; chunkText: string | null; evaluationResult: ChunkEvaluationResult; stateAfter: CoherenceState }[]> {
  const results = await db.select()
    .from(coherenceChunks)
    .where(and(
      eq(coherenceChunks.documentId, documentId),
      eq(coherenceChunks.coherenceMode, mode)
    ))
    .orderBy(coherenceChunks.chunkIndex);

  return results.map(r => ({
    chunkIndex: r.chunkIndex,
    chunkText: r.chunkText,
    evaluationResult: r.evaluationResult as ChunkEvaluationResult,
    stateAfter: r.stateAfter as CoherenceState
  }));
}

// Apply state update from chunk evaluation
export function applyStateUpdate(
  currentState: CoherenceState,
  stateUpdate: Partial<CoherenceState>
): CoherenceState {
  const mode = currentState.mode;
  
  switch (mode) {
    case "logical-consistency": {
      const s = currentState as LogicalConsistencyState;
      const u = stateUpdate as Partial<LogicalConsistencyState>;
      return {
        ...s,
        assertions: u.assertions !== undefined 
          ? [...s.assertions, ...u.assertions.filter(a => !s.assertions.includes(a))]
          : s.assertions,
        negations: u.negations !== undefined
          ? [...s.negations, ...u.negations.filter(n => !s.negations.includes(n))]
          : s.negations,
        disjoint_pairs: u.disjoint_pairs !== undefined
          ? [...s.disjoint_pairs, ...u.disjoint_pairs]
          : s.disjoint_pairs
      };
    }
    
    case "logical-cohesiveness": {
      const s = currentState as LogicalCohesivenessState;
      const u = stateUpdate as Partial<LogicalCohesivenessState>;
      return {
        ...s,
        thesis: u.thesis || s.thesis,
        support_queue: u.support_queue !== undefined
          ? [...s.support_queue.filter(sq => !u.support_queue?.includes(sq)), ...u.support_queue.filter(sq => !s.support_queue.includes(sq))]
          : s.support_queue,
        current_stage: u.current_stage || s.current_stage,
        bridge_required: u.bridge_required !== undefined ? u.bridge_required : s.bridge_required
      };
    }
    
    case "scientific-explanatory": {
      const s = currentState as ScientificExplanatoryState;
      const u = stateUpdate as Partial<ScientificExplanatoryState>;
      // Remove resolved loops (any loops marked for removal in update)
      const resolvedLoopNames = (u as any).resolved_loops || [];
      const filteredLoops = s.active_feedback_loops.filter(l => !resolvedLoopNames.includes(l.name));
      const newLoops = u.active_feedback_loops || [];
      return {
        ...s,
        causal_nodes: u.causal_nodes !== undefined
          ? [...s.causal_nodes, ...u.causal_nodes.filter(n => !s.causal_nodes.includes(n))]
          : s.causal_nodes,
        causal_edges: u.causal_edges !== undefined
          ? [...s.causal_edges, ...u.causal_edges]
          : s.causal_edges,
        level: u.level || s.level,
        active_feedback_loops: [...filteredLoops, ...newLoops],
        mechanism_requirements: u.mechanism_requirements !== undefined
          ? [...s.mechanism_requirements, ...u.mechanism_requirements.filter(m => !s.mechanism_requirements.includes(m))]
          : s.mechanism_requirements
      };
    }
    
    case "thematic-psychological": {
      const s = currentState as ThematicPsychologicalState;
      const u = stateUpdate as Partial<ThematicPsychologicalState>;
      return {
        ...s,
        dominant_affect: u.dominant_affect || s.dominant_affect,
        tempo: u.tempo || s.tempo,
        stance: u.stance || s.stance
      };
    }
    
    case "instructional": {
      const s = currentState as InstructionalState;
      const u = stateUpdate as Partial<InstructionalState>;
      // prereqs in update means satisfied - remove them from pending
      const satisfiedPrereqs = (u as any).prereqs_satisfied || [];
      const closedLoops = (u as any).loops_closed || [];
      return {
        ...s,
        goal: u.goal || s.goal,
        steps_done: u.steps_done !== undefined
          ? [...s.steps_done, ...u.steps_done.filter(st => !s.steps_done.includes(st))]
          : s.steps_done,
        prereqs: s.prereqs.filter(p => !satisfiedPrereqs.includes(p)),
        open_loops: [
          ...s.open_loops.filter(l => !closedLoops.includes(l)),
          ...(u.open_loops || []).filter(l => !s.open_loops.includes(l))
        ]
      };
    }
    
    case "motivational": {
      const s = currentState as MotivationalState;
      const u = stateUpdate as Partial<MotivationalState>;
      return {
        ...s,
        direction: u.direction || s.direction,
        intensity: u.intensity !== undefined ? u.intensity : s.intensity,
        target: u.target || s.target
      };
    }
    
    case "mathematical": {
      const s = currentState as MathematicalState;
      const u = stateUpdate as Partial<MathematicalState>;
      return {
        ...s,
        givens: u.givens !== undefined
          ? [...s.givens, ...u.givens.filter(g => !s.givens.includes(g))]
          : s.givens,
        proved: u.proved !== undefined
          ? [...s.proved, ...u.proved.filter(p => !s.proved.includes(p))]
          : s.proved,
        goal: u.goal || s.goal,
        proof_method: u.proof_method || s.proof_method,
        dependencies: u.dependencies !== undefined
          ? [...s.dependencies, ...u.dependencies]
          : s.dependencies
      };
    }
    
    case "philosophical": {
      const s = currentState as PhilosophicalState;
      const u = stateUpdate as Partial<PhilosophicalState>;
      // New objections go to both raised and pending
      const newObjections = (u as any).new_objections || [];
      const repliedObjections = (u as any).objections_replied || [];
      return {
        ...s,
        core_concepts: u.core_concepts !== undefined
          ? { ...s.core_concepts, ...u.core_concepts }
          : s.core_concepts,
        distinctions: u.distinctions !== undefined
          ? [...s.distinctions, ...u.distinctions.filter(d => !s.distinctions.includes(d))]
          : s.distinctions,
        dialectic: {
          objections_raised: [...s.dialectic.objections_raised, ...newObjections],
          replies_pending: [
            ...s.dialectic.replies_pending.filter(r => !repliedObjections.includes(r)),
            ...newObjections
          ]
        },
        no_equivocation: s.no_equivocation // Violations are logged, not added
      };
    }
    
    default:
      return currentState;
  }
}

// Check for violations based on mode
export function checkViolations(
  state: CoherenceState,
  stateUpdate: Partial<CoherenceState>
): { location: string; type: string; description: string }[] {
  const violations: { location: string; type: string; description: string }[] = [];
  
  switch (state.mode) {
    case "logical-consistency": {
      const s = state as LogicalConsistencyState;
      const u = stateUpdate as Partial<LogicalConsistencyState>;
      // Check if new assertions contradict negations
      if (u.assertions) {
        for (const assertion of u.assertions) {
          if (s.negations.includes(assertion)) {
            violations.push({
              location: `assertion: "${assertion}"`,
              type: "contradiction",
              description: `Asserts "${assertion}" but this was previously negated`
            });
          }
        }
      }
      // Check if new negations contradict assertions
      if (u.negations) {
        for (const negation of u.negations) {
          if (s.assertions.includes(negation)) {
            violations.push({
              location: `negation: "${negation}"`,
              type: "contradiction",
              description: `Negates "${negation}" but this was previously asserted`
            });
          }
        }
      }
      // Check disjoint pairs
      if (u.assertions) {
        for (const assertion of u.assertions) {
          for (const [a, b] of s.disjoint_pairs) {
            if (assertion === a && s.assertions.includes(b)) {
              violations.push({
                location: `assertion: "${assertion}"`,
                type: "disjoint_violation",
                description: `Asserts "${assertion}" but "${b}" was already asserted, and they are disjoint`
              });
            }
            if (assertion === b && s.assertions.includes(a)) {
              violations.push({
                location: `assertion: "${assertion}"`,
                type: "disjoint_violation",
                description: `Asserts "${assertion}" but "${a}" was already asserted, and they are disjoint`
              });
            }
          }
        }
      }
      break;
    }
    
    case "logical-cohesiveness": {
      const s = state as LogicalCohesivenessState;
      const u = stateUpdate as Partial<LogicalCohesivenessState>;
      // Check stage regression
      const stageOrder = ["setup", "development", "conclusion"];
      if (u.current_stage) {
        const currentIndex = stageOrder.indexOf(s.current_stage);
        const newIndex = stageOrder.indexOf(u.current_stage);
        if (newIndex < currentIndex) {
          violations.push({
            location: `stage: ${s.current_stage} -> ${u.current_stage}`,
            type: "stage_regression",
            description: `Stage regressed from "${s.current_stage}" to "${u.current_stage}" without justification`
          });
        }
      }
      break;
    }
    
    case "motivational": {
      const s = state as MotivationalState;
      const u = stateUpdate as Partial<MotivationalState>;
      // Check intensity swing
      if (u.intensity !== undefined) {
        const swing = Math.abs(u.intensity - s.intensity);
        if (swing > 2) {
          violations.push({
            location: `intensity: ${s.intensity} -> ${u.intensity}`,
            type: "intensity_swing",
            description: `Intensity changed by ${swing} levels (max allowed is 2 without transition)`
          });
        }
      }
      break;
    }
    
    case "mathematical": {
      const s = state as MathematicalState;
      const u = stateUpdate as Partial<MathematicalState>;
      // Check for use of unproved lemmas
      if (u.dependencies) {
        for (const dep of u.dependencies) {
          for (const d of dep.depends_on) {
            if (!s.proved.includes(d) && !s.givens.includes(d)) {
              violations.push({
                location: `step: "${dep.step}"`,
                type: "unproved_dependency",
                description: `Step depends on "${d}" which is neither given nor proved`
              });
            }
          }
        }
      }
      break;
    }
  }
  
  return violations;
}
