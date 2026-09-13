import { z } from 'zod';

export const AMENDMENT_FIELDS = ['amount', 'date', 'status'] as const;

export const INCOME_SIGNAL_KINDS = [
  'increase',
  'decrease',
  'suspend',
  'variable_unreliable',
] as const;

export const amendmentSchema = z.object({
  eventId: z.string(),
  field: z.enum(AMENDMENT_FIELDS),
  value: z.string(),
  effectiveFrom: z.string().nullable(),
  confidence: z.number(),
});

export const cancellationSchema = z.object({
  eventId: z.string(),
});

export const extractedAmountSchema = z.object({
  eventId: z.string(),
  amount: z.string(),
  currency: z.string(),
});

export const incomeSignalSchema = z.object({
  seriesCategory: z.string(),
  kind: z.enum(INCOME_SIGNAL_KINDS),
  amount: z.string().nullable(),
  multiplier: z.number().nullable(),
  effectiveFrom: z.string().nullable(),
});

export const evidenceSchema = z.object({
  amendments: z.array(amendmentSchema),
  cancellations: z.array(cancellationSchema),
  extractedAmounts: z.array(extractedAmountSchema),
  incomeSignals: z.array(incomeSignalSchema),
});

export type Amendment = z.infer<typeof amendmentSchema>;
export type Cancellation = z.infer<typeof cancellationSchema>;
export type ExtractedAmount = z.infer<typeof extractedAmountSchema>;
export type IncomeSignal = z.infer<typeof incomeSignalSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

export const EMPTY_EVIDENCE: Evidence = {
  amendments: [],
  cancellations: [],
  extractedAmounts: [],
  incomeSignals: [],
};

export function mergeEvidence(parts: readonly Evidence[]): Evidence {
  return {
    amendments: parts.flatMap((part) => part.amendments),
    cancellations: parts.flatMap((part) => part.cancellations),
    extractedAmounts: parts.flatMap((part) => part.extractedAmounts),
    incomeSignals: parts.flatMap((part) => part.incomeSignals),
  };
}
