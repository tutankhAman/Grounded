import {
  DEFAULT_RESOLVER_THRESHOLDS,
  type EntityConfirm,
  EntityConfirmSchema,
} from "@grounded/db";
import { distance } from "fastest-levenshtein";

export interface RawEntityMention {
  context?: string | null;
  factId: string;
  name: string;
  type?: string | null;
}

export interface EntityCluster {
  canonicalName: string;
  contextSample: string | null;
  entityType: string | null;
  factIds: string[];
  mentions: RawEntityMention[];
  surfaceForms: string[];
}

export interface ClusterOptions {
  embeddings?: Map<string, number[]>;
  embeddingThreshold?: number;
  stringThreshold?: number;
}

interface FormCountEntry {
  count: number;
  key: string;
  original: string;
}

const CORP_SUFFIXES: [RegExp, string][] = [
  [/\bcorporation\b/gi, "corp"],
  [/\bincorporated\b/gi, "inc"],
  [/\blimited\b/gi, "ltd"],
  [/\bcompany\b/gi, "co"],
  [/\bl\.l\.c\b/gi, "llc"],
  [/\bp\.l\.c\b/gi, "plc"],
];

const LEADING_THE_REGEX = /^the\s+/i;
const NON_ALPHANUM_REGEX = /[^\w\s]/g;
const WHITESPACE_REGEX = /\s+/g;
const OUTER_QUOTES_START_REGEX = /^["'‘“]+/;
const OUTER_QUOTES_END_REGEX = /["'’”]+$/;
const JSON_BLOCK_REGEX = /\{[\s\S]*\}/;

/**
 * Normalizes an entity name for display: trims whitespace and outer punctuation.
 */
export const normalizeName = (name: string): string =>
  name
    .trim()
    .replace(OUTER_QUOTES_START_REGEX, "")
    .replace(OUTER_QUOTES_END_REGEX, "")
    .replace(WHITESPACE_REGEX, " ")
    .trim();

/**
 * Normalizes corporate suffixes and removes punctuation for comparison.
 */
export const normalizeForComparison = (name: string): string => {
  let normalized = name.toLowerCase().trim().replace(LEADING_THE_REGEX, "");
  for (const [regex, replacement] of CORP_SUFFIXES) {
    normalized = normalized.replace(regex, replacement);
  }
  return normalized
    .replace(NON_ALPHANUM_REGEX, " ")
    .replace(WHITESPACE_REGEX, " ")
    .trim();
};

/**
 * Computes Levenshtein-based similarity between two strings in [0, 1].
 */
export const stringSimilarity = (a: string, b: string): number => {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (s1 === s2) {
    return 1.0;
  }
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) {
    return 1.0;
  }
  const dist = distance(s1, s2);
  return 1 - dist / maxLen;
};

/**
 * Decides whether two surface forms should merge based on string similarity
 * or standardized corporate suffix comparison.
 */
export const shouldMergeString = (
  a: string,
  b: string,
  threshold = DEFAULT_RESOLVER_THRESHOLDS.stringSimilarityThreshold
): boolean => {
  const normA = normalizeName(a);
  const normB = normalizeName(b);
  if (!(normA && normB)) {
    return false;
  }
  if (normA.toLowerCase() === normB.toLowerCase()) {
    return true;
  }

  // Check direct string similarity
  if (stringSimilarity(normA, normB) >= threshold) {
    return true;
  }

  // Check corporate-suffix and punctuation normalized similarity
  const compA = normalizeForComparison(normA);
  const compB = normalizeForComparison(normB);
  if (compA === compB && compA.length > 0) {
    return true;
  }

  return stringSimilarity(compA, compB) >= threshold;
};

/**
 * Builds the text input for entity embedding: "entity: <canonical> | <context>"
 */
export const buildEntityEmbeddingInput = (
  canonicalName: string,
  contextSample?: string | null
): string => {
  const name = normalizeName(canonicalName);
  const context = contextSample?.trim();
  return context ? `entity: ${name} | ${context}` : `entity: ${name}`;
};

/**
 * Computes cosine similarity between two vectors.
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i] ?? 0;
    const valB = b[i] ?? 0;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

/**
 * Checks if similarity meets the entity match threshold.
 */
export const decideEntityMatch = (
  similarity: number,
  threshold = DEFAULT_RESOLVER_THRESHOLDS.entityMatchThreshold
): boolean => similarity >= threshold;

const getFormCounts = (members: RawEntityMention[]): FormCountEntry[] => {
  const counts = new Map<string, number>();
  const originalMap = new Map<string, string>();

  for (const m of members) {
    const cleaned = normalizeName(m.name);
    if (!cleaned) {
      continue;
    }
    const key = cleaned.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const existing = originalMap.get(key);
    if (!existing || cleaned.length > existing.length) {
      originalMap.set(key, cleaned);
    }
  }

  const entries: FormCountEntry[] = [];
  for (const [key, count] of counts.entries()) {
    entries.push({
      count,
      key,
      original: originalMap.get(key) ?? key,
    });
  }

  entries.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    if (b.original.length !== a.original.length) {
      return b.original.length - a.original.length;
    }
    return a.original.localeCompare(b.original);
  });

  return entries;
};

const electEntityType = (members: RawEntityMention[]): string | null => {
  const counts = new Map<string, number>();
  for (const m of members) {
    const t = m.type?.trim();
    if (t) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  let bestType: string | null = null;
  let maxCount = 0;
  for (const [t, count] of counts.entries()) {
    if (count > maxCount) {
      bestType = t;
      maxCount = count;
    }
  }
  return bestType;
};

const electContextSample = (
  members: RawEntityMention[],
  winnerKey: string
): string | null => {
  let winnerContext: string | null = null;
  let fallbackContext: string | null = null;

  for (const m of members) {
    const ctx = m.context?.trim();
    if (!ctx) {
      continue;
    }
    const isWinner = normalizeName(m.name).toLowerCase() === winnerKey;
    if (isWinner && (!winnerContext || ctx.length > winnerContext.length)) {
      winnerContext = ctx;
    }
    if (!fallbackContext || ctx.length > fallbackContext.length) {
      fallbackContext = ctx;
    }
  }

  return winnerContext ?? fallbackContext;
};

/**
 * Elects the canonical name, most frequent entity type, and best context sample
 * from a cluster of mentions according to frequency, length, and tie-breakers.
 */
export const electCanonical = (
  members: RawEntityMention[]
): {
  canonicalName: string;
  contextSample: string | null;
  entityType: string | null;
} => {
  if (members.length === 0) {
    return { canonicalName: "", contextSample: null, entityType: null };
  }

  const sortedCandidates = getFormCounts(members);
  const [winner] = sortedCandidates;
  if (!winner) {
    const [firstMember] = members;
    const fallback = firstMember?.name ?? "Unknown";
    return { canonicalName: fallback, contextSample: null, entityType: null };
  }

  return {
    canonicalName: winner.original,
    contextSample: electContextSample(members, winner.key),
    entityType: electEntityType(members),
  };
};

/**
 * Union-Find Disjoint Set implementation for clustering.
 */
class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array(size).fill(0);
  }

  find(i: number): number {
    let root = i;
    while (root !== (this.parent[root] ?? root)) {
      root = this.parent[root] ?? root;
    }
    let curr = i;
    while (curr !== root) {
      const nxt = this.parent[curr] ?? root;
      this.parent[curr] = root;
      curr = nxt;
    }
    return root;
  }

  union(i: number, j: number): void {
    const rootI = this.find(i);
    const rootJ = this.find(j);
    if (rootI === rootJ) {
      return;
    }
    const rankI = this.rank[rootI] ?? 0;
    const rankJ = this.rank[rootJ] ?? 0;
    if (rankI < rankJ) {
      this.parent[rootI] = rootJ;
    } else if (rankI > rankJ) {
      this.parent[rootJ] = rootI;
    } else {
      this.parent[rootJ] = rootI;
      this.rank[rootI] = rankI + 1;
    }
  }
}

interface MentionIndexMap {
  nameToIndices: Map<string, number[]>;
  uniqueNames: string[];
}

const buildUniqueNameIndex = (
  mentions: RawEntityMention[]
): MentionIndexMap => {
  const uniqueNames: string[] = [];
  const nameToIndices = new Map<string, number[]>();

  for (let i = 0; i < mentions.length; i++) {
    const mention = mentions[i];
    if (!mention) {
      continue;
    }
    const norm = normalizeName(mention.name).toLowerCase();
    if (!nameToIndices.has(norm)) {
      nameToIndices.set(norm, []);
      uniqueNames.push(norm);
    }
    nameToIndices.get(norm)?.push(i);
  }

  return { nameToIndices, uniqueNames };
};

const shouldMergeNames = (
  nameA: string,
  nameB: string,
  stringThresh: number,
  embeddingThresh: number,
  embeddings?: Map<string, number[]>
): boolean => {
  if (shouldMergeString(nameA, nameB, stringThresh)) {
    return true;
  }
  if (!embeddings) {
    return false;
  }
  const embA = embeddings.get(nameA);
  const embB = embeddings.get(nameB);
  if (!(embA && embB)) {
    return false;
  }
  return cosineSimilarity(embA, embB) >= embeddingThresh;
};

const groupIndicesByCluster = (
  uniqueNames: string[],
  nameToIndices: Map<string, number[]>,
  uf: UnionFind
): Map<number, number[]> => {
  const clusterGroups = new Map<number, number[]>();
  for (let i = 0; i < uniqueNames.length; i++) {
    const root = uf.find(i);
    if (!clusterGroups.has(root)) {
      clusterGroups.set(root, []);
    }
    const name = uniqueNames[i];
    if (name) {
      const mentionIndices = nameToIndices.get(name) ?? [];
      clusterGroups.get(root)?.push(...mentionIndices);
    }
  }
  return clusterGroups;
};

/**
 * Clusters entity mentions within a single document.
 */
export const clusterSurfaceForms = (
  mentions: RawEntityMention[],
  options?: ClusterOptions
): EntityCluster[] => {
  if (mentions.length === 0) {
    return [];
  }

  const stringThresh =
    options?.stringThreshold ??
    DEFAULT_RESOLVER_THRESHOLDS.stringSimilarityThreshold;
  const embeddingThresh =
    options?.embeddingThreshold ??
    DEFAULT_RESOLVER_THRESHOLDS.entityMatchThreshold;
  const embeddings = options?.embeddings;

  const { nameToIndices, uniqueNames } = buildUniqueNameIndex(mentions);
  const uf = new UnionFind(uniqueNames.length);

  for (let i = 0; i < uniqueNames.length; i++) {
    for (let j = i + 1; j < uniqueNames.length; j++) {
      const nameA = uniqueNames[i];
      const nameB = uniqueNames[j];
      if (
        nameA &&
        nameB &&
        shouldMergeNames(
          nameA,
          nameB,
          stringThresh,
          embeddingThresh,
          embeddings
        )
      ) {
        uf.union(i, j);
      }
    }
  }

  const clusterGroups = groupIndicesByCluster(uniqueNames, nameToIndices, uf);
  const clusters: EntityCluster[] = [];

  for (const mentionIndices of clusterGroups.values()) {
    const clusterMentions = mentionIndices
      .map((idx) => mentions[idx])
      .filter((m): m is RawEntityMention => m !== undefined);
    const { canonicalName, contextSample, entityType } =
      electCanonical(clusterMentions);

    const surfaceForms = Array.from(
      new Set(clusterMentions.map((m) => normalizeName(m.name)))
    );
    const factIds = Array.from(new Set(clusterMentions.map((m) => m.factId)));

    clusters.push({
      canonicalName,
      contextSample,
      entityType,
      factIds,
      mentions: clusterMentions,
      surfaceForms,
    });
  }

  return clusters;
};

/**
 * Builds the LLM prompt for across-document confirmation.
 */
export const buildEntityConfirmPrompt = (params: {
  contextA?: string | null;
  contextB?: string | null;
  nameA: string;
  nameB: string;
}): string => {
  const ctxA = params.contextA?.trim() || "No context provided";
  const ctxB = params.contextB?.trim() || "No context provided";

  return `Are these two entities the same real-world entity?
Entity A: "${params.nameA}" — context: "${ctxA}"
Entity B: "${params.nameB}" — context: "${ctxB}"
Answer YES or NO with one sentence of reasoning.`;
};

/**
 * Parses the LLM confirmation response into { same: boolean, reasoning: string }.
 */
export const parseConfirmResponse = (text: string): EntityConfirm => {
  const trimmed = text.trim();

  try {
    const jsonMatch = trimmed.match(JSON_BLOCK_REGEX);
    if (jsonMatch) {
      const [matchedText] = jsonMatch;
      const parsed = JSON.parse(matchedText);
      const validated = EntityConfirmSchema.safeParse(parsed);
      if (validated.success) {
        return validated.data;
      }
      if (typeof parsed.same === "boolean") {
        return {
          reasoning: String(parsed.reasoning ?? trimmed).trim(),
          same: parsed.same,
        };
      }
    }
  } catch {
    // Continue to text parsing
  }

  const upper = trimmed.toUpperCase();
  const yesIndex = upper.indexOf("YES");
  const noIndex = upper.indexOf("NO");

  let same = false;
  if (yesIndex !== -1 && noIndex === -1) {
    same = true;
  } else if (noIndex !== -1 && yesIndex === -1) {
    same = false;
  } else if (yesIndex !== -1 && noIndex !== -1) {
    same = yesIndex < noIndex;
  }

  return {
    reasoning: trimmed,
    same,
  };
};
