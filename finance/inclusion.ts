import type { EpochDay } from '../util/dates.js';
import type { FinancialEvent } from '../data/types.js';

export const CASH_STATUSES = ['settled', 'scheduled'] as const;

export const CASH_DIRECTIONS = ['debit', 'credit'] as const;

export type ExclusionReason =
  | 'pending_credit_ignored'
  | 'cancelled'
  | 'failed'
  | 'unrealized_investment'
  | 'non_cash_valuation'
  | 'duplicate_of_parent';

export type CashClassification = 'settled_history' | 'confirmed_future' | 'reserved_pending';

export interface InclusionVerdict {
  readonly included: boolean;
  readonly classification: CashClassification | null;
  readonly reason: ExclusionReason | null;
}

function included(classification: CashClassification): InclusionVerdict {
  return { included: true, classification, reason: null };
}

function excluded(reason: ExclusionReason): InclusionVerdict {
  return { included: false, classification: null, reason };
}

export function classifyInclusion(event: FinancialEvent): InclusionVerdict {
  if (event.direction === 'non_cash') {
    return excluded('non_cash_valuation');
  }
  switch (event.status) {
    case 'settled':
      return included('settled_history');
    case 'scheduled':
      return included('confirmed_future');
    case 'pending':
      return event.direction === 'credit'
        ? excluded('pending_credit_ignored')
        : included('reserved_pending');
    case 'cancelled':
      return excluded('cancelled');
    case 'failed':
      return excluded('failed');
    case 'unrealized':
      return excluded('unrealized_investment');
  }
}

export function isCashEvent(event: FinancialEvent): boolean {
  return classifyInclusion(event).included;
}

export function isSettledHistory(event: FinancialEvent): boolean {
  return classifyInclusion(event).classification === 'settled_history';
}

export function isConfirmedFutureEvent(event: FinancialEvent): boolean {
  return classifyInclusion(event).classification === 'confirmed_future';
}

export function isReservedPending(event: FinancialEvent): boolean {
  return classifyInclusion(event).classification === 'reserved_pending';
}

export function isForwardLedgerEvent(event: FinancialEvent): boolean {
  const classification = classifyInclusion(event).classification;
  return classification === 'confirmed_future' || classification === 'reserved_pending';
}

export function ledgerDate(event: FinancialEvent): EpochDay {
  return event.settlementDate ?? event.eventDate;
}

export function signedDirection(event: FinancialEvent): 1 | -1 {
  return event.direction === 'credit' ? 1 : -1;
}
