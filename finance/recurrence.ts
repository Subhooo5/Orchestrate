import { addDays, addMonthsClamped, dayOfMonth } from '../util/dates.js';
import type { EpochDay } from '../util/dates.js';
import { money } from '../util/money.js';
import type { CurrencyCode, Money } from '../util/money.js';
import type { EventDirection, FinancialEvent, Flexibility } from '../data/types.js';
import { isCashEvent, ledgerDate } from './inclusion.js';
import { normalizeAmount, normalizeMinimumAllowedAmount } from './currency.js';
import type { ExchangeRateIndex } from './currency.js';

export const MONTHLY_TOLERANCE_DAYS = 3;
export const FIXED_TOLERANCE_DAYS = 0;
export const ALTERNATING_TOLERANCE_DAYS = 3;
export const MIN_MONTHLY_OCCURRENCES = 2;
export const MIN_INTERVAL_OCCURRENCES = 3;
export const MAX_ANCHOR_SHIFT = 2;
export const MONTHLY_GAP_MIN = 28;
export const MONTHLY_GAP_MAX = 31;
export const PROJECTION_STEP_LIMIT = 4000;

export const PHASE_AMOUNT_RULE: 'last' | 'median' = 'median';

export type CadenceKind = 'monthly' | 'fixed_interval' | 'alternating_interval';

export interface Cadence {
  readonly kind: CadenceKind;
  readonly intervalDays: number | null;
  readonly cycleDays: readonly number[] | null;
  readonly anchorDayOfMonth: number | null;
}

export interface SeriesOccurrence {
  readonly eventId: string;
  readonly date: EpochDay;
  readonly amount: Money | null;
  readonly description: string;
}

export interface SeriesAdjustment {
  readonly effectiveFrom: EpochDay;
  readonly amount: Money;
}

export interface RecurringSeries {
  readonly seriesId: string;
  readonly userId: string;
  readonly category: string;
  readonly direction: EventDirection;
  readonly currency: CurrencyCode;
  readonly cadence: Cadence;
  readonly occurrences: readonly SeriesOccurrence[];
  readonly firstDate: EpochDay;
  readonly lastDate: EpochDay;
  readonly lastKnownAmount: Money | null;
  readonly amountPendingEvidence: boolean;
  readonly flexibility: Flexibility;
  readonly minimumAllowedAmount: Money | null;
  readonly descriptions: readonly string[];
  readonly nextCycleIndex: number;
  readonly phaseAmounts: readonly (Money | null)[];
  readonly adjustments: readonly SeriesAdjustment[];
}

export interface ProjectedOccurrence {
  readonly seriesId: string;
  readonly category: string;
  readonly direction: EventDirection;
  readonly date: EpochDay;
  readonly amount: Money | null;
}

export interface SeriesDetection {
  readonly series: readonly RecurringSeries[];
  readonly oneTimeEventIds: readonly string[];
}

interface GroupKey {
  readonly userId: string;
  readonly category: string;
  readonly direction: EventDirection;
  readonly currency: CurrencyCode;
}

function groupKeyText(key: GroupKey): string {
  return `${key.userId}|${key.category}|${key.direction}|${key.currency}`;
}

function gapsOf(dates: readonly EpochDay[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1];
    const current = dates[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    gaps.push(current - previous);
  }
  return gaps;
}

function medianOfBigints(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0n;
  }
  return ((sorted[middle - 1] ?? 0n) + (sorted[middle] ?? 0n)) / 2n;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return Math.round((lower + upper) / 2);
}

function spreadOf(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.max(...values) - Math.min(...values);
}

function modalDayOfMonth(dates: readonly EpochDay[]): number {
  const counts = new Map<number, number>();
  for (const date of dates) {
    const day = dayOfMonth(date);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  let best = dayOfMonth(dates[0] ?? 0);
  let bestCount = -1;
  for (const [day, count] of counts) {
    if (count > bestCount || (count === bestCount && day < best)) {
      best = day;
      bestCount = count;
    }
  }
  return best;
}

function monthlyCadence(dates: readonly EpochDay[]): Cadence {
  return {
    kind: 'monthly',
    intervalDays: null,
    cycleDays: null,
    anchorDayOfMonth: modalDayOfMonth(dates),
  };
}

function fixedCadence(intervalDays: number): Cadence {
  return { kind: 'fixed_interval', intervalDays, cycleDays: null, anchorDayOfMonth: null };
}

function alternatingCadence(cycleDays: readonly number[]): Cadence {
  return { kind: 'alternating_interval', intervalDays: null, cycleDays, anchorDayOfMonth: null };
}

function detectAlternating(gaps: readonly number[]): Cadence | null {
  if (gaps.length < 3) {
    return null;
  }
  const even = gaps.filter((_, index) => index % 2 === 0);
  const odd = gaps.filter((_, index) => index % 2 === 1);
  if (even.length === 0 || odd.length === 0) {
    return null;
  }
  if (spreadOf(even) > ALTERNATING_TOLERANCE_DAYS || spreadOf(odd) > ALTERNATING_TOLERANCE_DAYS) {
    return null;
  }
  const first = medianOf(even);
  const second = medianOf(odd);
  if (first <= 0 || second <= 0 || first === second) {
    return null;
  }
  return alternatingCadence([first, second]);
}

function candidateCadences(dates: readonly EpochDay[]): Cadence[] {
  const gaps = gapsOf(dates);
  if (gaps.length === 0) {
    return [];
  }
  const candidates: Cadence[] = [];
  if (gaps.some((gap) => gap >= MONTHLY_GAP_MIN && gap <= MONTHLY_GAP_MAX)) {
    candidates.push(monthlyCadence(dates));
  }
  const frequency = new Map<number, number>();
  for (const gap of gaps) {
    if (gap > 0) {
      frequency.set(gap, (frequency.get(gap) ?? 0) + 1);
    }
  }
  const ordered = [...frequency.entries()].sort(
    (left, right) => right[1] - left[1] || left[0] - right[0],
  );
  for (const [gap] of ordered) {
    candidates.push(fixedCadence(gap));
  }
  const alternating = detectAlternating(gaps);
  if (alternating !== null) {
    candidates.push(alternating);
  }
  return candidates;
}

function toleranceFor(cadence: Cadence): number {
  switch (cadence.kind) {
    case 'monthly':
      return MONTHLY_TOLERANCE_DAYS;
    case 'fixed_interval':
      return FIXED_TOLERANCE_DAYS;
    case 'alternating_interval':
      return ALTERNATING_TOLERANCE_DAYS;
  }
}

function minimumOccurrencesFor(cadence: Cadence): number {
  return cadence.kind === 'monthly' ? MIN_MONTHLY_OCCURRENCES : MIN_INTERVAL_OCCURRENCES;
}

function monthsBetweenEstimate(from: EpochDay, to: EpochDay): number {
  return Math.max(1, Math.round((to - from) / 30.44));
}

interface SpineWalk {
  readonly kept: readonly number[];
  readonly dropped: readonly number[];
  readonly nextCycleIndex: number;
}

function walkSpine(dates: readonly EpochDay[], cadence: Cadence, start: number): SpineWalk {
  const kept: number[] = [start];
  const dropped: number[] = [];
  for (let index = 0; index < start; index += 1) {
    dropped.push(index);
  }
  const tolerance = toleranceFor(cadence);
  let cycleIndex = 0;
  for (let index = start + 1; index < dates.length; index += 1) {
    const current = dates[index];
    const anchorIndex = kept[kept.length - 1];
    const anchor = anchorIndex === undefined ? undefined : dates[anchorIndex];
    if (current === undefined || anchor === undefined || current <= anchor) {
      dropped.push(index);
      continue;
    }
    let matched = false;
    if (cadence.kind === 'monthly') {
      const months = monthsBetweenEstimate(anchor, current);
      const expected = addMonthsClamped(anchor, months);
      matched = Math.abs(current - expected) <= tolerance;
    } else if (cadence.kind === 'fixed_interval') {
      const interval = cadence.intervalDays ?? 0;
      matched = interval > 0 && (current - anchor) % interval === 0;
    } else {
      const cycle = cadence.cycleDays ?? [];
      const step = cycle[cycleIndex % cycle.length] ?? 0;
      matched = step > 0 && Math.abs(current - anchor - step) <= tolerance;
    }
    if (matched) {
      kept.push(index);
      if (cadence.kind === 'alternating_interval') {
        cycleIndex += 1;
      }
    } else {
      dropped.push(index);
    }
  }
  const cycleLength = cadence.cycleDays?.length ?? 1;
  return { kept, dropped: dropped.sort((a, b) => a - b), nextCycleIndex: cycleIndex % cycleLength };
}

interface BestFit {
  readonly cadence: Cadence;
  readonly walk: SpineWalk;
}

function bestFit(dates: readonly EpochDay[]): BestFit | null {
  let best: BestFit | null = null;
  for (const cadence of candidateCadences(dates)) {
    const limit = Math.min(MAX_ANCHOR_SHIFT, Math.max(0, dates.length - 1));
    for (let start = 0; start <= limit; start += 1) {
      const walk = walkSpine(dates, cadence, start);
      if (walk.kept.length < minimumOccurrencesFor(cadence)) {
        continue;
      }
      if (best === null || walk.kept.length > best.walk.kept.length) {
        best = { cadence, walk };
      }
    }
  }
  return best;
}

export function detectRecurringSeries(
  events: readonly FinancialEvent[],
  homeCurrency: CurrencyCode,
  rates: ExchangeRateIndex,
): SeriesDetection {
  const groups = new Map<string, { key: GroupKey; events: FinancialEvent[] }>();
  for (const event of events) {
    if (!isCashEvent(event)) {
      continue;
    }
    const key: GroupKey = {
      userId: event.userId,
      category: event.category,
      direction: event.direction,
      currency: event.currency,
    };
    const text = groupKeyText(key);
    const existing = groups.get(text);
    if (existing === undefined) {
      groups.set(text, { key, events: [event] });
    } else {
      existing.events.push(event);
    }
  }

  const series: RecurringSeries[] = [];
  const oneTimeEventIds: string[] = [];

  for (const [seriesId, group] of [...groups.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    const sorted = [...group.events].sort(
      (left, right) => ledgerDate(left) - ledgerDate(right) || left.eventId.localeCompare(right.eventId),
    );
    const dates = sorted.map(ledgerDate);
    const fit = bestFit(dates);
    if (fit === null) {
      for (const event of sorted) {
        oneTimeEventIds.push(event.eventId);
      }
      continue;
    }
    for (const index of fit.walk.dropped) {
      const event = sorted[index];
      if (event !== undefined) {
        oneTimeEventIds.push(event.eventId);
      }
    }
    const occurrences: SeriesOccurrence[] = [];
    for (const index of fit.walk.kept) {
      const event = sorted[index];
      if (event === undefined) {
        continue;
      }
      occurrences.push({
        eventId: event.eventId,
        date: ledgerDate(event),
        amount: normalizeAmount(event, homeCurrency, rates),
        description: event.description,
      });
    }
    const lastIndex = fit.walk.kept[fit.walk.kept.length - 1];
    const lastEvent = lastIndex === undefined ? undefined : sorted[lastIndex];
    const firstOccurrence = occurrences[0];
    const lastOccurrence = occurrences[occurrences.length - 1];
    if (lastEvent === undefined || firstOccurrence === undefined || lastOccurrence === undefined) {
      continue;
    }
    const known = [...occurrences].reverse().find((occurrence) => occurrence.amount !== null);
    const cycleLength = fit.cadence.cycleDays?.length ?? 1;
    const phaseAmounts: (Money | null)[] = [];
    for (let phase = 0; phase < cycleLength; phase += 1) {
      const values: bigint[] = [];
      let latest: Money | null = null;
      for (let index = 1; index < occurrences.length; index += 1) {
        if ((index - 1) % cycleLength !== phase) {
          continue;
        }
        const candidate = occurrences[index];
        if (candidate !== undefined && candidate.amount !== null) {
          latest = candidate.amount;
          values.push(candidate.amount.minor);
        }
      }
      if (values.length === 0) {
        phaseAmounts.push(known?.amount ?? null);
        continue;
      }
      if (PHASE_AMOUNT_RULE === 'last') {
        phaseAmounts.push(latest);
        continue;
      }
      phaseAmounts.push(money(medianOfBigints(values), group.key.currency));
    }
    series.push({
      seriesId,
      userId: group.key.userId,
      category: group.key.category,
      direction: group.key.direction,
      currency: group.key.currency,
      cadence: fit.cadence,
      occurrences,
      firstDate: firstOccurrence.date,
      lastDate: lastOccurrence.date,
      lastKnownAmount: known?.amount ?? null,
      amountPendingEvidence: lastOccurrence.amount === null,
      flexibility: lastEvent.flexibility,
      minimumAllowedAmount: normalizeMinimumAllowedAmount(lastEvent, homeCurrency, rates),
      descriptions: [...new Set(occurrences.map((occurrence) => occurrence.description))],
      nextCycleIndex: fit.walk.nextCycleIndex,
      phaseAmounts,
      adjustments: [],
    });
  }

  return { series, oneTimeEventIds };
}

function nextDate(from: EpochDay, cadence: Cadence, cycleIndex: number): EpochDay {
  switch (cadence.kind) {
    case 'monthly':
      return addMonthsClamped(from, 1);
    case 'fixed_interval':
      return addDays(from, cadence.intervalDays ?? 0);
    case 'alternating_interval': {
      const cycle = cadence.cycleDays ?? [];
      return addDays(from, cycle[cycleIndex % cycle.length] ?? 0);
    }
  }
}

function adjustmentFor(series: RecurringSeries, date: EpochDay): Money | null {
  let chosen: Money | null = null;
  let chosenFrom = Number.NEGATIVE_INFINITY;
  for (const adjustment of series.adjustments) {
    if (adjustment.effectiveFrom <= date && adjustment.effectiveFrom >= chosenFrom) {
      chosen = adjustment.amount;
      chosenFrom = adjustment.effectiveFrom;
    }
  }
  return chosen;
}

export function projectSeries(
  series: RecurringSeries,
  from: EpochDay,
  through: EpochDay,
): ProjectedOccurrence[] {
  const projected: ProjectedOccurrence[] = [];
  if (through < from) {
    return projected;
  }
  let cursor = series.lastDate;
  let cycleIndex = series.nextCycleIndex;
  for (let step = 0; step < PROJECTION_STEP_LIMIT; step += 1) {
    const candidate = nextDate(cursor, series.cadence, cycleIndex);
    if (candidate <= cursor) {
      break;
    }
    const phaseIndex = cycleIndex;
    cursor = candidate;
    cycleIndex += 1;
    if (cursor > through) {
      break;
    }
    if (cursor >= from) {
      const phase = series.phaseAmounts.length === 0 ? null : series.phaseAmounts[phaseIndex % series.phaseAmounts.length] ?? null;
      const override = adjustmentFor(series, cursor);
      projected.push({
        seriesId: series.seriesId,
        category: series.category,
        direction: series.direction,
        date: cursor,
        amount: override ?? phase ?? series.lastKnownAmount,
      });
    }
  }
  return projected;
}

export function describeCadence(cadence: Cadence): string {
  switch (cadence.kind) {
    case 'monthly':
      return `monthly(day ${cadence.anchorDayOfMonth ?? '?'})`;
    case 'fixed_interval':
      return `every ${cadence.intervalDays ?? '?'}d`;
    case 'alternating_interval':
      return `alternating(${(cadence.cycleDays ?? []).join(',')})d`;
  }
}
