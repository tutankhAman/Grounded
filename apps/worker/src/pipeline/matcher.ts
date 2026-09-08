export interface ParsedNumber {
  currency?: string | null;
  hasExplicitMultiplier?: boolean;
  multiplier: number;
  physicalUnit?: string | null;
  rawUnit?: string | null;
  unit?: string | null;
  value: number;
}

export interface TimeScopeComparison {
  bothMissing: boolean;
  oneMissing: boolean;
  sameScope: boolean;
  scopeA?: string;
  scopeB?: string;
}

export interface QualifierComparison {
  differingKeys: { key: string; valA: unknown; valB: unknown }[];
  identical: boolean;
}

export interface FactLike {
  confidence?: number | null;
  currency?: string | null;
  id: string;
  predicate: string;
  qualifiers?: unknown;
  rawValue?: string | null;
  timeScope?: string | null;
  unit?: string | null;
  value: string;
}

export type RuleReconcileResult =
  | {
      decision: {
        confidence: number;
        explanation: string;
        method: "rule";
        relationType: "corroborates" | "reconciled";
      };
      escalate: false;
    }
  | {
      decision?: never;
      escalate: true;
      reason: string;
    };

const MULTIPLIERS: Record<string, number> = {
  b: 1e9,
  billion: 1e9,
  bn: 1e9,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
  k: 1e3,
  l: 1e5,
  lac: 1e5,
  lacs: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  m: 1e6,
  million: 1e6,
  mn: 1e6,
  t: 1e12,
  thousand: 1e3,
  trillion: 1e12,
};

const CURRENCY_MAP: Record<string, string> = {
  $: "USD",
  dollar: "USD",
  dollars: "USD",
  eur: "EUR",
  euro: "EUR",
  gbp: "GBP",
  inr: "INR",
  jpy: "JPY",
  pound: "GBP",
  pounds: "GBP",
  rs: "INR",
  rupee: "INR",
  rupees: "INR",
  usd: "USD",
  yen: "JPY",
  "£": "GBP",
  "¥": "JPY",
  "€": "EUR",
  "₹": "INR",
};

const SYSTEM_QUALIFIER_KEYS = new Set([
  "_entity",
  "printedPage",
  "quoteMismatch",
  "sourcePage",
  "visionOnly",
]);

const OUTER_QUOTE_REGEX = /^["'‘“]+|["'’”]+$/g;
const WHITESPACE_REGEX = /\s+/g;
const COMMA_DIGIT_REGEX = /(\d),(\d)/g;
const BASIS_POINTS_REGEX = /^([+-]?\d+(?:\.\d+)?)\s*(?:bps|basis\s*points)$/i;
const PERCENT_WORD_REGEX = /\s*(?:percent|pct)\b/gi;
const GARBAGE_TOKEN_REGEX = /^(?:n\/a|none|-|null|undefined)$/i;
const REGEX_ESCAPE_CHARS_REGEX = /[$()*+?.^/\\|}{[\]]/g;
const NUMERIC_TOKEN_REGEX = /[-+]?\d+(?:\.\d+)?/;
const PERCENT_UNIT_REGEX = /percent|pct|%/i;

const SORTED_MULTIPLIERS: [string, number][] = Object.entries(MULTIPLIERS).sort(
  (a, b) => b[0].length - a[0].length
);

const detectCurrency = (
  normalized: string,
  currencyHint?: string | null
): string | null => {
  for (const [sym, code] of Object.entries(CURRENCY_MAP)) {
    const escaped = sym.replace(REGEX_ESCAPE_CHARS_REGEX, "\\$&");
    const regex = new RegExp(`(?:^|[\\s\\d])${escaped}(?:[\\s\\d]|$)`, "i");
    if (
      regex.test(normalized) ||
      (currencyHint && currencyHint.toUpperCase() === code)
    ) {
      return code;
    }
  }
  if (currencyHint) {
    return (
      CURRENCY_MAP[currencyHint.toLowerCase()] ?? currencyHint.toUpperCase()
    );
  }
  return null;
};

const detectMultiplier = (
  normalized: string,
  unitHint?: string | null
): { multiplier: number; rawUnit: string | null } => {
  for (const [token, mult] of SORTED_MULTIPLIERS) {
    const regex = new RegExp(`(?:^|[\\d\\s])${token}(?:\\b|$)`, "i");
    if (regex.test(normalized)) {
      return { multiplier: mult, rawUnit: token };
    }
  }

  if (unitHint) {
    const unitLower = unitHint.toLowerCase().trim();
    for (const [token, mult] of SORTED_MULTIPLIERS) {
      if (unitLower === token || unitLower.startsWith(token)) {
        return { multiplier: mult, rawUnit: token };
      }
    }
  }

  return { multiplier: 1, rawUnit: null };
};

const expandTwoDigitYear = (yy: string, referenceCentury?: string): string => {
  if (yy.length !== 2) {
    return yy;
  }
  if (referenceCentury && referenceCentury.length === 2) {
    return `${referenceCentury}${yy}`;
  }
  const n = Number(yy);
  return n >= 70 ? `19${yy}` : `20${yy}`;
};

const RANGE_SCOPE_REGEX =
  /(?:(?:FY|FISCAL(?:\s+YEAR)?)\s*['’]?(\d{2,4})|(?:\b(19\d{2}|20\d{2})))\s*[-–/]\s*['’]?(\d{2,4})\b(?!\s*[-–/]\s*\d)/i;
const FY_SCOPE_REGEX = /(?:FY|FISCAL(?:\s+YEAR)?)\s*['’]?(\d{2,4})/i;
const QTR_SCOPE_REGEX = /([1-4]Q|Q[1-4])\s*(?:FY\s*)?['’]?(\d{2,4})/i;
const CY_SCOPE_REGEX = /CY\s*(\d{4})/i;
const YEAR_SCOPE_REGEX = /\b(19\d{2}|20\d{2})\b/;

/**
 * Normalizes a raw or formatted value string:
 * - Trims whitespace and quotes
 * - Collapses spaces
 * - Strips commas between digits
 * - Normalizes percent/bps notation
 * - Lowers case
 */
export const normalizeValue = (val: string): string => {
  if (!val) {
    return "";
  }

  let cleaned = val
    .trim()
    .replace(OUTER_QUOTE_REGEX, "")
    .replace(WHITESPACE_REGEX, " ");

  // Normalizes commas in numbers (e.g. 1,000,000 -> 1000000)
  cleaned = cleaned.replace(COMMA_DIGIT_REGEX, "$1$2");

  // Basis points: "50 bps" / "50 basis points" -> "0.5%"
  const bpsMatch = cleaned.match(BASIS_POINTS_REGEX);
  if (bpsMatch?.[1]) {
    const bpsVal = Number(bpsMatch[1]);
    if (Number.isFinite(bpsVal)) {
      return `${bpsVal / 100}%`;
    }
  }

  // Percent / pct -> %
  cleaned = cleaned.replace(PERCENT_WORD_REGEX, "%");

  return cleaned.toLowerCase();
};

/**
 * Parses numeric and unit information from a value string.
 */
export const parseNumeric = (
  val: string,
  unitHint?: string | null,
  currencyHint?: string | null
): ParsedNumber | null => {
  if (!val || val.trim() === "") {
    return null;
  }

  const normalized = normalizeValue(val);

  // Check for invalid garbage tokens like "n/a", "-", "none"
  if (GARBAGE_TOKEN_REGEX.test(normalized)) {
    return null;
  }

  // Currency detection
  const detectedCurrency = detectCurrency(normalized, currencyHint);

  // Multiplier detection
  const { multiplier: detectedMultiplier, rawUnit: detectedRawUnit } =
    detectMultiplier(normalized, unitHint);

  // Percentage detection
  const isPercent =
    normalized.includes("%") ||
    (unitHint !== null &&
      unitHint !== undefined &&
      PERCENT_UNIT_REGEX.test(unitHint));

  // Extract base numeric value
  const numMatch = normalized.match(NUMERIC_TOKEN_REGEX);
  if (!numMatch) {
    return null;
  }

  const rawNum = Number(numMatch[0]);
  if (!Number.isFinite(rawNum)) {
    return null;
  }

  const finalValue = isPercent ? rawNum : rawNum * detectedMultiplier;
  const hasExplicitMultiplier = detectedRawUnit !== null;

  let physicalUnit: string | null = null;
  if (isPercent) {
    physicalUnit = "percent";
  } else if (unitHint) {
    const trimmedHint = unitHint.trim().toLowerCase();
    if (!MULTIPLIERS[trimmedHint]) {
      physicalUnit = unitHint.trim();
    }
  }

  return {
    currency: detectedCurrency,
    hasExplicitMultiplier,
    multiplier: detectedMultiplier,
    physicalUnit,
    rawUnit: detectedRawUnit ?? unitHint ?? null,
    unit: isPercent ? "percent" : (detectedRawUnit ?? unitHint ?? null),
    value: finalValue,
  };
};

/**
 * Checks equality of two parsed numbers within a relative tolerance (1e-6),
 * rejecting cases where the parsed units are categorically incompatible
 * (e.g. a percentage compared against an absolute value, or two different
 * non-null units).
 */
export const convertUnits = (
  numA: ParsedNumber,
  numB: ParsedNumber
): { equal: boolean; relativeDiff: number } => {
  const isPercentA = numA.unit === "percent" || numA.physicalUnit === "percent";
  const isPercentB = numB.unit === "percent" || numB.physicalUnit === "percent";

  // A percentage can never be reconciled with a non-percentage value: "$50" vs
  // "50%" both parse to 50 but are categorically different facts. Escalate.
  if (isPercentA !== isPercentB) {
    return { equal: false, relativeDiff: Number.POSITIVE_INFINITY };
  }

  // Physical units mismatch check:
  // If distinct physical units are present on both operands, they are incompatible
  // (e.g. "kg" vs "meters").
  const physA = numA.physicalUnit ?? null;
  const physB = numB.physicalUnit ?? null;
  if (physA && physB && physA !== physB) {
    return { equal: false, relativeDiff: Number.POSITIVE_INFINITY };
  }

  // Multiplier tokens / unit compatibility:
  // When both operands have explicit multipliers (e.g. "billion" vs "M"), differing
  // spellings/scales are already reflected in .value, so they can be compared numerically.
  // In other cases where units are specified on both and differ, they are incompatible.
  const unitA = numA.unit ?? null;
  const unitB = numB.unit ?? null;
  if (unitA && unitB && unitA !== unitB) {
    const bothHaveExplicitMultiplier = Boolean(
      numA.hasExplicitMultiplier && numB.hasExplicitMultiplier
    );
    if (!bothHaveExplicitMultiplier) {
      return { equal: false, relativeDiff: Number.POSITIVE_INFINITY };
    }
  }

  const a = numA.value;
  const b = numB.value;

  if (a === 0 && b === 0) {
    return { equal: true, relativeDiff: 0 };
  }

  const diff = Math.abs(a - b);
  const max = Math.max(Math.abs(a), Math.abs(b));
  const relativeDiff = max === 0 ? 0 : diff / max;

  return {
    equal: relativeDiff <= 1e-6,
    relativeDiff,
  };
};

/**
 * Normalizes timeScope string into standard representation (e.g. FY2024, Q1-FY2024, CY2024).
 */
export const normalizeTimeScope = (scope?: string | null): string => {
  if (!scope) {
    return "";
  }
  const clean = scope.trim().replace(WHITESPACE_REGEX, " ").toUpperCase();

  // Multi-year / fiscal ranges: "2023-24", "2023-2024", "FY23-24" -> "FY2024"
  const rangeMatch = clean.match(RANGE_SCOPE_REGEX);
  if (rangeMatch) {
    const [, fyPart, yrPart, endPart] = rangeMatch;
    const startPart = fyPart ?? yrPart;
    if (startPart && endPart) {
      const startYear =
        startPart.length === 2 ? expandTwoDigitYear(startPart) : startPart;
      const referenceCentury = startYear.slice(0, 2);
      const endYear =
        endPart.length === 2
          ? expandTwoDigitYear(endPart, referenceCentury)
          : endPart;
      return `FY${endYear}`;
    }
  }

  // FY with 2 or 4 digits: "FY 24", "FY2024", "FISCAL 2024" -> "FY2024"
  const fyMatch = clean.match(FY_SCOPE_REGEX);
  if (fyMatch?.[1]) {
    const [, yr] = fyMatch;
    const fullYear = expandTwoDigitYear(yr);
    return `FY${fullYear}`;
  }

  // Quarters with FY: "Q1 FY24", "1Q2024", "Q1'24" -> "Q1-FY2024"
  const qtrMatch = clean.match(QTR_SCOPE_REGEX);
  if (qtrMatch?.[1] && qtrMatch?.[2]) {
    const [qtrToken, qtrYr] = [qtrMatch[1], qtrMatch[2]];
    const qtr = qtrToken.startsWith("Q") ? qtrToken : `Q${qtrToken[0]}`;
    const fullYear = expandTwoDigitYear(qtrYr);
    return `${qtr}-FY${fullYear}`;
  }

  // Calendar year: "CY 2024" -> "CY2024"
  const cyMatch = clean.match(CY_SCOPE_REGEX);
  if (cyMatch?.[1]) {
    return `CY${cyMatch[1]}`;
  }

  // Standalone 4-digit year: "2024" -> "2024"
  const yrMatch = clean.match(YEAR_SCOPE_REGEX);
  if (yrMatch?.[1]) {
    return yrMatch[1];
  }

  return clean.toLowerCase();
};

/**
 * Compares two timeScope strings.
 */
export const compareTimeScope = (
  scopeA?: string | null,
  scopeB?: string | null
): TimeScopeComparison => {
  const normA = normalizeTimeScope(scopeA);
  const normB = normalizeTimeScope(scopeB);

  const aEmpty = normA === "";
  const bEmpty = normB === "";

  if (aEmpty && bEmpty) {
    return {
      bothMissing: true,
      oneMissing: false,
      sameScope: true,
    };
  }

  if (aEmpty || bEmpty) {
    return {
      bothMissing: false,
      oneMissing: true,
      sameScope: false,
      scopeA: scopeA ?? undefined,
      scopeB: scopeB ?? undefined,
    };
  }

  return {
    bothMissing: false,
    oneMissing: false,
    sameScope: normA === normB,
    scopeA: scopeA ?? undefined,
    scopeB: scopeB ?? undefined,
  };
};

/**
 * Compares non-system qualifiers between two facts.
 */
export const compareQualifiers = (
  qualA: unknown,
  qualB: unknown
): QualifierComparison => {
  const objA = (qualA && typeof qualA === "object" ? qualA : {}) as Record<
    string,
    unknown
  >;
  const objB = (qualB && typeof qualB === "object" ? qualB : {}) as Record<
    string,
    unknown
  >;

  const stringifyQualifier = (val: unknown): string => {
    if (val === undefined) {
      return "";
    }
    return typeof val === "string"
      ? val.trim().toLowerCase()
      : JSON.stringify(val);
  };

  const differingKeys: { key: string; valA: unknown; valB: unknown }[] = [];

  const allKeys = new Set([...Object.keys(objA), ...Object.keys(objB)]);

  for (const k of allKeys) {
    if (SYSTEM_QUALIFIER_KEYS.has(k)) {
      continue;
    }

    const valA = objA[k];
    const valB = objB[k];

    // A qualifier present on only one side is a meaningful difference (e.g.
    // factA.region="APAC" vs factB with no region at all).
    if (valA === undefined && valB === undefined) {
      continue;
    }

    const strA = stringifyQualifier(valA);
    const strB = stringifyQualifier(valB);
    if (strA !== strB) {
      differingKeys.push({ key: k, valA, valB });
    }
  }

  return {
    differingKeys,
    identical: differingKeys.length === 0,
  };
};

const formatQualifierValue = (val: unknown): string => {
  if (typeof val === "string") {
    return val;
  }
  if (val === null || val === undefined) {
    return String(val);
  }
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
};

/**
 * Deterministic rule-based fact reconciliation pre-filter.
 * Order matters (first match wins):
 * 1. Exact value match -> corroborates (requires compatible time scopes)
 * 2. Unit-convertible equality -> corroborates (or reconciled if currencies differ)
 * 3. Time scope differs with differing values -> reconciled
 * 4. Currency differs with same amount -> reconciled
 * 5. Qualifier difference -> reconciled
 * 6. Missing scope on either side -> escalate
 * 7. Values differ + same scope + no qualifier delta -> escalate
 * 8. Unparseable numerics -> escalate
 */
export const ruleReconcile = (
  factA: FactLike,
  factB: FactLike
): RuleReconcileResult => {
  const normValA = normalizeValue(factA.value);
  const normValB = normalizeValue(factB.value);

  const rawTrimA = factA.rawValue?.trim().toLowerCase();
  const rawTrimB = factB.rawValue?.trim().toLowerCase();

  const timeComp = compareTimeScope(factA.timeScope, factB.timeScope);
  const hasDifferentPeriods = !(
    timeComp.bothMissing ||
    timeComp.oneMissing ||
    timeComp.sameScope
  );

  // 1. Exact value match (requires compatible time scopes)
  if (
    !hasDifferentPeriods &&
    ((normValA !== "" && normValA === normValB) ||
      (rawTrimA !== undefined && rawTrimA !== "" && rawTrimA === rawTrimB))
  ) {
    return {
      decision: {
        confidence: 0.95,
        explanation: `Both documents report identical values of "${factA.value}" for ${factA.predicate}.`,
        method: "rule",
        relationType: "corroborates",
      },
      escalate: false,
    };
  }

  // 2. Numeric parsing & unit conversion
  const numA = parseNumeric(factA.value, factA.unit, factA.currency);
  const numB = parseNumeric(factB.value, factB.unit, factB.currency);

  if (numA && numB) {
    const { equal } = convertUnits(numA, numB);

    if (equal && !hasDifferentPeriods) {
      // 4. Check currency delta on equal amounts
      if (numA.currency && numB.currency && numA.currency !== numB.currency) {
        return {
          decision: {
            confidence: 0.9,
            explanation: `Values are numerically identical (${numA.value}) but reported in different currencies: ${numA.currency} vs ${numB.currency}.`,
            method: "rule",
            relationType: "reconciled",
          },
          escalate: false,
        };
      }

      return {
        decision: {
          confidence: 0.95,
          explanation: `Values are numerically equivalent after unit normalization: "${factA.value}" matches "${factB.value}" for ${factA.predicate}.`,
          method: "rule",
          relationType: "corroborates",
        },
        escalate: false,
      };
    }
  }

  // 3. Time scope comparison
  if (hasDifferentPeriods) {
    return {
      decision: {
        confidence: 0.9,
        explanation: `Values differ ("${factA.value}" vs "${factB.value}") because they cover different time periods: "${factA.timeScope}" vs "${factB.timeScope}".`,
        method: "rule",
        relationType: "reconciled",
      },
      escalate: false,
    };
  }

  // 5. Qualifier delta comparison
  const qualComp = compareQualifiers(factA.qualifiers, factB.qualifiers);
  const [diff] = qualComp.differingKeys;
  if (diff) {
    const formattedValA = formatQualifierValue(diff.valA);
    const formattedValB = formatQualifierValue(diff.valB);
    return {
      decision: {
        confidence: 0.9,
        explanation: `Values differ ("${factA.value}" vs "${factB.value}") due to different ${diff.key} qualifier: "${formattedValA}" vs "${formattedValB}".`,
        method: "rule",
        relationType: "reconciled",
      },
      escalate: false,
    };
  }

  // 6. Missing scope on either side
  if (timeComp.oneMissing) {
    return {
      escalate: true,
      reason:
        "Missing time scope on one of the facts prevents deterministic reconciliation",
    };
  }

  // 7. Values differ + same time scope + no qualifier delta
  if (timeComp.sameScope && qualComp.identical) {
    return {
      escalate: true,
      reason:
        "Values differ under matching time scope and qualifiers; requires LLM judge",
    };
  }

  // 8. Default unparseable or ambiguous -> escalate
  return {
    escalate: true,
    reason:
      "Values differ and cannot be cleanly reconciled by deterministic rules; requires LLM judge",
  };
};
