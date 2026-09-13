import { parseDate } from '../util/dates.js';
import type { EpochDay } from '../util/dates.js';
import { isCurrencyCode, multiplyMoneyByRatio, parseMoney } from '../util/money.js';
import type { Money } from '../util/money.js';
import type {
  EventStatus,
  FinancialEvent,
  UserFinancialState,
} from '../data/types.js';
import type { ReconstructedState } from '../finance/state.js';
import type { RecurringSeries } from '../finance/recurrence.js';
import { EMPTY_EVIDENCE } from './schema.js';
import type { Evidence, IncomeSignal } from './schema.js';

export const APPLY_EXTRACTED_AMOUNTS = true;
export const APPLY_AMENDMENTS = true;
export const APPLY_INCOME_ADJUSTMENTS = true;
export const APPLY_INCOME_SUPPRESSION = false;

export const MULTIPLIER_SCALE = 1_000_000;

export interface ResolvedEvidence {
  readonly amountsByEventId: ReadonlyMap<string, Money>;
  readonly statusByEventId: ReadonlyMap<string, EventStatus>;
  readonly dateByEventId: ReadonlyMap<string, EpochDay>;
  readonly amendedAmountByEventId: ReadonlyMap<string, Money>;
  readonly cancelledEventIds: ReadonlySet<string>;
  readonly incomeSignals: readonly IncomeSignal[];
  readonly discarded: readonly string[];
}

export const EMPTY_RESOLVED: ResolvedEvidence = {
  amountsByEventId: new Map(),
  statusByEventId: new Map(),
  dateByEventId: new Map(),
  amendedAmountByEventId: new Map(),
  cancelledEventIds: new Set(),
  incomeSignals: [],
  discarded: [],
};

function parseMoneyForEvent(event: FinancialEvent, amount: string, currency: string): Money | null {
  const code = currency.trim().toUpperCase();
  const target = isCurrencyCode(code) ? code : event.currency;
  const cleaned = amount.replace(/[,\s]/g, '').replace(/[^0-9.\-]/g, '');
  if (cleaned.length === 0) {
    return null;
  }
  try {
    return parseMoney(cleaned, target);
  } catch {
    return null;
  }
}

export function resolveEvidence(
  evidence: Evidence,
  events: readonly FinancialEvent[],
): ResolvedEvidence {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const discarded: string[] = [];

  const owns = (eventId: string, label: string): FinancialEvent | null => {
    const event = byId.get(eventId);
    if (event === undefined) {
      discarded.push(`${label} references ${eventId}, which is not one of this user's events`);
      return null;
    }
    return event;
  };

  const cancelledEventIds = new Set<string>();
  for (const cancellation of evidence.cancellations) {
    const event = owns(cancellation.eventId, 'cancellation');
    if (event === null) {
      continue;
    }
    if (event.status === 'settled') {
      discarded.push(`cancellation of settled ${event.eventId} ignored; settled beats an estimate`);
      continue;
    }
    cancelledEventIds.add(event.eventId);
  }

  const amountsByEventId = new Map<string, Money>();
  for (const extracted of APPLY_EXTRACTED_AMOUNTS ? evidence.extractedAmounts : []) {
    const event = owns(extracted.eventId, 'extractedAmount');
    if (event === null) {
      continue;
    }
    if (event.amount !== null) {
      discarded.push(`extractedAmount for ${event.eventId} ignored; the event already has an amount`);
      continue;
    }
    const parsed = parseMoneyForEvent(event, extracted.amount, extracted.currency);
    if (parsed === null) {
      discarded.push(`extractedAmount for ${event.eventId} was not a parsable amount`);
      continue;
    }
    amountsByEventId.set(event.eventId, parsed);
  }

  const statusByEventId = new Map<string, EventStatus>();
  const dateByEventId = new Map<string, EpochDay>();
  const amendedAmountByEventId = new Map<string, Money>();
  const sortedAmendments = [...(APPLY_AMENDMENTS ? evidence.amendments : [])].sort(
    (left, right) => (left.effectiveFrom ?? '').localeCompare(right.effectiveFrom ?? ''),
  );
  for (const amendment of sortedAmendments) {
    const event = owns(amendment.eventId, 'amendment');
    if (event === null) {
      continue;
    }
    if (event.status === 'settled') {
      discarded.push(`amendment to settled ${event.eventId} ignored; settled beats an estimate`);
      continue;
    }
    if (amendment.field === 'amount') {
      const parsed = parseMoneyForEvent(event, amendment.value, event.currency);
      if (parsed === null) {
        discarded.push(`amendment amount for ${event.eventId} was not parsable`);
        continue;
      }
      amendedAmountByEventId.set(event.eventId, parsed);
    } else if (amendment.field === 'date') {
      try {
        dateByEventId.set(event.eventId, parseDate(amendment.value.trim().slice(0, 10)));
      } catch {
        discarded.push(`amendment date for ${event.eventId} was not a valid date`);
      }
    } else {
      const value = amendment.value.trim().toLowerCase();
      if (value === 'cancelled' || value === 'failed') {
        cancelledEventIds.add(event.eventId);
      } else if (value === 'settled' || value === 'scheduled' || value === 'pending') {
        statusByEventId.set(event.eventId, value);
      } else {
        discarded.push(`amendment status "${amendment.value}" for ${event.eventId} is not a known status`);
      }
    }
  }

  return {
    amountsByEventId,
    statusByEventId,
    dateByEventId,
    amendedAmountByEventId,
    cancelledEventIds,
    incomeSignals: evidence.incomeSignals,
    discarded,
  };
}

export function applyResolvedEvidence(
  state: UserFinancialState,
  resolved: ResolvedEvidence,
): UserFinancialState {
  const events = state.events.map((event) => {
    const filled = resolved.amountsByEventId.get(event.eventId);
    const amended = resolved.amendedAmountByEventId.get(event.eventId);
    const status = resolved.statusByEventId.get(event.eventId);
    const date = resolved.dateByEventId.get(event.eventId);
    const cancelled = resolved.cancelledEventIds.has(event.eventId);
    if (
      filled === undefined &&
      amended === undefined &&
      status === undefined &&
      date === undefined &&
      !cancelled
    ) {
      return event;
    }
    return {
      ...event,
      amount: amended ?? filled ?? event.amount,
      status: cancelled ? ('cancelled' as EventStatus) : status ?? event.status,
      settlementDate: date ?? event.settlementDate,
    };
  });
  return {
    ...state,
    events,
    eventsById: new Map(events.map((event) => [event.eventId, event])),
    eventsWithMissingAmount: events.filter((event) => event.amount === null),
  };
}

function currentAmountOf(series: RecurringSeries): Money | null {
  for (const phase of series.phaseAmounts) {
    if (phase !== null) {
      return phase;
    }
  }
  return series.lastKnownAmount;
}

function adjustedAmountFor(series: RecurringSeries, signal: IncomeSignal): Money | null {
  if (signal.amount !== null && signal.amount.trim().length > 0) {
    const cleaned = signal.amount.replace(/[,\s]/g, '').replace(/[^0-9.\-]/g, '');
    if (cleaned.length > 0) {
      try {
        return parseMoney(cleaned, series.currency);
      } catch {
        return null;
      }
    }
  }
  if (signal.multiplier !== null && Number.isFinite(signal.multiplier) && signal.multiplier > 0) {
    const base = currentAmountOf(series);
    if (base === null) {
      return null;
    }
    const numerator = BigInt(Math.round(signal.multiplier * MULTIPLIER_SCALE));
    return multiplyMoneyByRatio(base, numerator, BigInt(MULTIPLIER_SCALE));
  }
  return null;
}

export interface IncomeSignalOutcome {
  readonly suppressedCategories: readonly string[];
  readonly adjustedCategories: readonly string[];
  readonly discardedSignals: readonly string[];
}

export function applyIncomeSignals(
  state: ReconstructedState,
  signals: readonly IncomeSignal[],
  requestDate: EpochDay,
): { state: ReconstructedState; outcome: IncomeSignalOutcome } {
  if (signals.length === 0) {
    return {
      state,
      outcome: { suppressedCategories: [], adjustedCategories: [], discardedSignals: [] },
    };
  }
  const suppressed = new Set<string>();
  const adjusted = new Set<string>();
  const discardedSignals: string[] = [];
  let income = state.recurringIncome;

  for (const signal of signals) {
    const category = signal.seriesCategory.trim().toLowerCase();
    const matches = income.filter((series) => series.category.toLowerCase() === category);
    if (matches.length === 0) {
      discardedSignals.push(`no recurring income series named ${signal.seriesCategory}`);
      continue;
    }
    if (signal.kind === 'variable_unreliable' || signal.kind === 'suspend') {
      if (!APPLY_INCOME_SUPPRESSION) {
        continue;
      }
      suppressed.add(category);
      income = income.filter((series) => series.category.toLowerCase() !== category);
      continue;
    }
    if (!APPLY_INCOME_ADJUSTMENTS) {
      continue;
    }
    let effectiveFrom = requestDate;
    if (signal.effectiveFrom !== null && signal.effectiveFrom.trim().length >= 10) {
      try {
        effectiveFrom = parseDate(signal.effectiveFrom.trim().slice(0, 10));
      } catch {
        effectiveFrom = requestDate;
      }
    }
    let applied = false;
    income = income.map((series) => {
      if (series.category.toLowerCase() !== category) {
        return series;
      }
      const replacement = adjustedAmountFor(series, signal);
      if (replacement === null) {
        return series;
      }
      applied = true;
      return {
        ...series,
        adjustments: [...series.adjustments, { effectiveFrom, amount: replacement }],
      };
    });
    if (applied) {
      adjusted.add(category);
    } else {
      discardedSignals.push(
        `income signal for ${signal.seriesCategory} carried neither a usable amount nor a multiplier`,
      );
    }
  }

  return {
    state: { ...state, recurringIncome: income },
    outcome: {
      suppressedCategories: [...suppressed].sort(),
      adjustedCategories: [...adjusted].sort(),
      discardedSignals,
    },
  };
}

export function emptyEvidence(): Evidence {
  return EMPTY_EVIDENCE;
}
