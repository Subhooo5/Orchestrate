import { classifyInclusion, isReservedPending } from './inclusion.js';
import type { FinancialEvent } from '../data/types.js';

export type LifecyclePattern =
  | 'expense_refunded'
  | 'expense_refund_pending'
  | 'expense_duplicate_pending'
  | 'cancelled_then_retried'
  | 'failed_then_rescheduled'
  | 'investment_valuation'
  | 'investment_sold'
  | 'unclassified';

export interface LinkedPair {
  readonly parentId: string;
  readonly childId: string;
  readonly pattern: LifecyclePattern;
  readonly parentIncluded: boolean;
  readonly childIncluded: boolean;
  readonly bothIncluded: boolean;
  readonly duplicateOfParent: boolean;
}

function shape(event: FinancialEvent): string {
  return `${event.status}/${event.direction}/${event.eventType}`;
}

function classifyPattern(parent: FinancialEvent, child: FinancialEvent): LifecyclePattern {
  const from = shape(parent);
  const to = shape(child);
  if (from === 'settled/debit/expense' && to === 'settled/credit/refund') {
    return 'expense_refunded';
  }
  if (from === 'settled/debit/expense' && to === 'pending/credit/refund') {
    return 'expense_refund_pending';
  }
  if (from === 'settled/debit/expense' && to === 'pending/debit/expense') {
    return 'expense_duplicate_pending';
  }
  if (parent.status === 'cancelled' && child.status === 'settled') {
    return 'cancelled_then_retried';
  }
  if (parent.status === 'failed' && child.status === 'scheduled') {
    return 'failed_then_rescheduled';
  }
  if (parent.eventType === 'investment_purchase' && child.eventType === 'investment_valuation') {
    return 'investment_valuation';
  }
  if (parent.eventType === 'investment_purchase' && child.eventType === 'investment_sale') {
    return 'investment_sold';
  }
  return 'unclassified';
}

function repeatsParentCharge(parent: FinancialEvent, child: FinancialEvent): boolean {
  if (parent.amount === null || child.amount === null) {
    return false;
  }
  return (
    parent.amount.minor === child.amount.minor &&
    parent.amount.currency === child.amount.currency &&
    parent.category === child.category &&
    parent.direction === child.direction
  );
}

export function isDuplicateOfParent(parent: FinancialEvent, child: FinancialEvent): boolean {
  return (
    isReservedPending(child) &&
    classifyInclusion(parent).included &&
    repeatsParentCharge(parent, child)
  );
}

export function classifyLinkedPairs(
  events: readonly FinancialEvent[],
  eventsById: ReadonlyMap<string, FinancialEvent>,
): LinkedPair[] {
  const pairs: LinkedPair[] = [];
  for (const child of events) {
    if (child.linkedEventId === null) {
      continue;
    }
    const parent = eventsById.get(child.linkedEventId);
    if (parent === undefined) {
      continue;
    }
    const parentIncluded = classifyInclusion(parent).included;
    const childIncluded = classifyInclusion(child).included;
    pairs.push({
      parentId: parent.eventId,
      childId: child.eventId,
      pattern: classifyPattern(parent, child),
      parentIncluded,
      childIncluded,
      bothIncluded: parentIncluded && childIncluded,
      duplicateOfParent: isDuplicateOfParent(parent, child),
    });
  }
  return pairs;
}

export function findDuplicateEventIds(
  events: readonly FinancialEvent[],
  eventsById: ReadonlyMap<string, FinancialEvent>,
): Set<string> {
  const duplicates = new Set<string>();
  for (const pair of classifyLinkedPairs(events, eventsById)) {
    if (pair.duplicateOfParent) {
      duplicates.add(pair.childId);
    }
  }
  return duplicates;
}
