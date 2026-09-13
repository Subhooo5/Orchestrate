import type { CurrencyCode, Money } from '../util/money.js';
import type { EpochDay } from '../util/dates.js';
import type {
  ExchangeRateRecord,
  FinancialEvent,
  FinancialProfile,
  UserFinancialState,
} from '../data/types.js';
import { classifyInclusion, isSettledHistory, ledgerDate } from './inclusion.js';
import type { ExclusionReason } from './inclusion.js';
import { buildExchangeRateIndex, normalizeAmount } from './currency.js';
import type { ExchangeRateIndex } from './currency.js';
import { classifyLinkedPairs, findDuplicateEventIds } from './lifecycle.js';
import type { LinkedPair } from './lifecycle.js';
import { detectRecurringSeries } from './recurrence.js';
import type { RecurringSeries } from './recurrence.js';

export class StateInvariantError extends Error {}

export interface NormalizedEvent {
  readonly event: FinancialEvent;
  readonly date: EpochDay;
  readonly amount: Money | null;
  readonly converted: boolean;
}

export interface ExcludedEvent {
  readonly event: FinancialEvent;
  readonly date: EpochDay;
  readonly reason: ExclusionReason;
}

export interface ReconstructedState {
  readonly userId: string;
  readonly profile: FinancialProfile;
  readonly homeCurrency: CurrencyCode;
  readonly recurringExpenses: readonly RecurringSeries[];
  readonly recurringIncome: readonly RecurringSeries[];
  readonly confirmedFutureEvents: readonly NormalizedEvent[];
  readonly reservedPendingEvents: readonly NormalizedEvent[];
  readonly oneTimeEvents: readonly NormalizedEvent[];
  readonly excludedEvents: readonly ExcludedEvent[];
  readonly amountPendingEvidence: readonly NormalizedEvent[];
  readonly linkedPairs: readonly LinkedPair[];
  readonly exchangeRates: ExchangeRateIndex;
}

function normalize(
  event: FinancialEvent,
  homeCurrency: CurrencyCode,
  index: ExchangeRateIndex,
): NormalizedEvent {
  return {
    event,
    date: ledgerDate(event),
    amount: normalizeAmount(event, homeCurrency, index),
    converted: event.currency !== homeCurrency,
  };
}

function byDate(left: NormalizedEvent, right: NormalizedEvent): number {
  return left.date - right.date || left.event.eventId.localeCompare(right.event.eventId);
}

export function forwardLedgerEvents(state: ReconstructedState): readonly NormalizedEvent[] {
  return [...state.confirmedFutureEvents, ...state.reservedPendingEvents].sort(byDate);
}

const reconstructedCache = new WeakMap<UserFinancialState, ReconstructedState>();

export function reconstructState(
  state: UserFinancialState,
  exchangeRates: readonly ExchangeRateRecord[],
): ReconstructedState {
  const memoised = reconstructedCache.get(state);
  if (memoised !== undefined) {
    return memoised;
  }
  const built = reconstructStateUncached(state, exchangeRates);
  reconstructedCache.set(state, built);
  return built;
}

function reconstructStateUncached(
  state: UserFinancialState,
  exchangeRates: readonly ExchangeRateRecord[],
): ReconstructedState {
  const homeCurrency = state.profile.homeCurrency;
  const index = buildExchangeRateIndex(exchangeRates);
  const duplicates = findDuplicateEventIds(state.events, state.eventsById);
  const usableEvents = state.events.filter((event) => !duplicates.has(event.eventId));
  const detection = detectRecurringSeries(usableEvents, homeCurrency, index);
  const seriesEventIds = new Set<string>();
  for (const series of detection.series) {
    for (const occurrence of series.occurrences) {
      seriesEventIds.add(occurrence.eventId);
    }
  }
  const oneTimeIds = new Set(detection.oneTimeEventIds);

  const confirmedFutureEvents: NormalizedEvent[] = [];
  const reservedPendingEvents: NormalizedEvent[] = [];
  const oneTimeEvents: NormalizedEvent[] = [];
  const excludedEvents: ExcludedEvent[] = [];
  const amountPendingEvidence: NormalizedEvent[] = [];

  for (const event of state.events) {
    if (duplicates.has(event.eventId)) {
      excludedEvents.push({ event, date: ledgerDate(event), reason: 'duplicate_of_parent' });
      continue;
    }
    const verdict = classifyInclusion(event);
    if (!verdict.included) {
      if (verdict.reason !== null) {
        excludedEvents.push({ event, date: ledgerDate(event), reason: verdict.reason });
      }
      continue;
    }
    const normalized = normalize(event, homeCurrency, index);
    if (event.amount === null) {
      amountPendingEvidence.push(normalized);
    }
    if (verdict.classification === 'confirmed_future') {
      confirmedFutureEvents.push(normalized);
    } else if (verdict.classification === 'reserved_pending') {
      reservedPendingEvents.push(normalized);
    } else if (oneTimeIds.has(event.eventId)) {
      oneTimeEvents.push(normalized);
    }
  }

  assertBucketsDisjoint(
    state.events,
    confirmedFutureEvents,
    reservedPendingEvents,
    oneTimeEvents,
    excludedEvents,
    seriesEventIds,
  );

  return {
    userId: state.userId,
    profile: state.profile,
    homeCurrency,
    recurringExpenses: detection.series.filter((series) => series.direction === 'debit'),
    recurringIncome: detection.series.filter((series) => series.direction === 'credit'),
    confirmedFutureEvents: confirmedFutureEvents.sort(byDate),
    reservedPendingEvents: reservedPendingEvents.sort(byDate),
    oneTimeEvents: oneTimeEvents.sort(byDate),
    excludedEvents: excludedEvents.sort(
      (left, right) => left.date - right.date || left.event.eventId.localeCompare(right.event.eventId),
    ),
    amountPendingEvidence: amountPendingEvidence.sort(byDate),
    linkedPairs: classifyLinkedPairs(state.events, state.eventsById),
    exchangeRates: index,
  };
}

function assertBucketsDisjoint(
  allEvents: readonly FinancialEvent[],
  confirmedFuture: readonly NormalizedEvent[],
  reservedPending: readonly NormalizedEvent[],
  oneTime: readonly NormalizedEvent[],
  excluded: readonly ExcludedEvent[],
  seriesEventIds: ReadonlySet<string>,
): void {
  const forwardBuckets: readonly (readonly NormalizedEvent[])[] = [
    confirmedFuture,
    reservedPending,
    oneTime,
  ];
  const seen = new Set<string>();
  for (const bucket of forwardBuckets) {
    for (const entry of bucket) {
      if (seen.has(entry.event.eventId)) {
        throw new StateInvariantError(
          `${entry.event.eventId} appears in more than one forward-ledger bucket`,
        );
      }
      seen.add(entry.event.eventId);
    }
  }
  for (const entry of excluded) {
    if (seen.has(entry.event.eventId)) {
      throw new StateInvariantError(
        `${entry.event.eventId} is both excluded and in a forward-ledger bucket`,
      );
    }
    seen.add(entry.event.eventId);
  }
  for (const event of allEvents) {
    if (seen.has(event.eventId) || seriesEventIds.has(event.eventId)) {
      continue;
    }
    throw new StateInvariantError(`${event.eventId} is in no bucket and no recurring series`);
  }
}

export function assertNoSettledInForwardLedger(entries: readonly NormalizedEvent[]): void {
  for (const entry of entries) {
    if (isSettledHistory(entry.event)) {
      throw new StateInvariantError(
        `settled event ${entry.event.eventId} must never be applied to the forward ledger; ` +
          'current_available_balance is as-of request_date and already reflects all settled history',
      );
    }
  }
}
