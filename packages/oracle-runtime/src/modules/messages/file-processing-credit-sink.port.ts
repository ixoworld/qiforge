/**
 * Aggregated usage reported by FileProcessingService after parsing one or
 * more attachments. The credits plugin folds this into the same per-user
 * Redis budget the LLM-call middleware decrements from.
 */
export interface FileProcessingUsage {
  cost: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Optional sink for billing pre-flight file-processing LLM calls. The
 * credits plugin provides this via its `getNestModules()`; when credits is
 * not loaded, file processing runs without a billing side effect.
 */
export interface FileProcessingCreditSink {
  deductForFileProcessing(
    userDid: string,
    usage: FileProcessingUsage,
  ): Promise<void>;
}

export const FILE_PROCESSING_CREDIT_SINK = Symbol(
  'FILE_PROCESSING_CREDIT_SINK',
);
