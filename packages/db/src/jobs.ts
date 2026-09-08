export const PARSE_QUEUE = "document-processing" as const;

export interface ParseJob {
  documentId: string;
  filePath: string;
}

export interface ExtractJob {
  documentId: string;
}

export interface ParserThresholds {
  chunkTokenSplit: number;
  lowTextChars: number;
  lowTextMinItems: number;
  numericRatio: number;
  shortColWidthRatio: number;
}

export const DEFAULT_THRESHOLDS: Readonly<ParserThresholds> = Object.freeze({
  chunkTokenSplit: 6000,
  lowTextChars: 1000,
  lowTextMinItems: 15,
  numericRatio: 0.4,
  shortColWidthRatio: 0.25,
});

const parseEnvNumber = (
  envVal: string | undefined,
  fallback: number
): number => {
  if (envVal === undefined || envVal.trim() === "") {
    return fallback;
  }
  const parsed = Number(envVal);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getThresholds = (
  overrides?: Partial<ParserThresholds>
): ParserThresholds => ({
  chunkTokenSplit:
    overrides?.chunkTokenSplit ??
    parseEnvNumber(
      process.env.THRESHOLD_CHUNK_TOKEN_SPLIT,
      DEFAULT_THRESHOLDS.chunkTokenSplit
    ),
  lowTextChars:
    overrides?.lowTextChars ??
    parseEnvNumber(
      process.env.THRESHOLD_LOW_TEXT_CHARS,
      DEFAULT_THRESHOLDS.lowTextChars
    ),
  lowTextMinItems:
    overrides?.lowTextMinItems ??
    parseEnvNumber(
      process.env.THRESHOLD_LOW_TEXT_MIN_ITEMS,
      DEFAULT_THRESHOLDS.lowTextMinItems
    ),
  numericRatio:
    overrides?.numericRatio ??
    parseEnvNumber(
      process.env.THRESHOLD_NUMERIC_RATIO,
      DEFAULT_THRESHOLDS.numericRatio
    ),
  shortColWidthRatio:
    overrides?.shortColWidthRatio ??
    parseEnvNumber(
      process.env.THRESHOLD_SHORT_COL_WIDTH_RATIO,
      DEFAULT_THRESHOLDS.shortColWidthRatio
    ),
});
