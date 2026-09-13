import { dayOfMonth, formatDate } from '../util/dates.js';
import type { EpochDay } from '../util/dates.js';
import { money } from '../util/money.js';
import type { Money } from '../util/money.js';
import type { RecurringSeries } from './recurrence.js';
import type { ReconstructedState } from './state.js';
import { buildForwardLedger, evaluateSafety } from './ledger.js';

export const AMOUNT_RULES = ['last', 'mean', 'median', 'min', 'max', 'phase_mean', 'phase_median'] as const;

export type AmountRule = (typeof AMOUNT_RULES)[number];

export const SUB_MONTHLY_INTERVAL_DAYS = 28;

export interface SeriesStats {
  readonly seriesId: string;
  readonly category: string;
  readonly direction: string;
  readonly cadenceKind: string;
  readonly intervalDays: number | null;
  readonly modalGap: number;
  readonly medianGap: number;
  readonly anchorDay: number;
  readonly modalAnchorDay: number;
  readonly occurrences: number;
  readonly projectedAmount: Money | null;
  readonly minAmount: Money | null;
  readonly meanAmount: Money | null;
  readonly medianAmount: Money | null;
  readonly lastAmount: Money | null;
}

function knownAmounts(series: RecurringSeries): bigint[] {
  const values: bigint[] = [];
  for (const occurrence of series.occurrences) {
    if (occurrence.amount !== null) {
      values.push(occurrence.amount.minor);
    }
  }
  return values;
}

function medianBigint(values: readonly bigint[]): bigint {
  if (values.length === 0) {
    return 0n;
  }
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0n;
  }
  return ((sorted[middle - 1] ?? 0n) + (sorted[middle] ?? 0n)) / 2n;
}

function meanBigint(values: readonly bigint[]): bigint {
  if (values.length === 0) {
    return 0n;
  }
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total / BigInt(values.length);
}

function modalNumber(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = values[0] ?? 0;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function medianNumber(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

export function describeSeriesStats(series: RecurringSeries): SeriesStats {
  const amounts = knownAmounts(series);
  const currency = series.currency;
  const gaps: number[] = [];
  const days: number[] = [];
  for (let index = 0; index < series.occurrences.length; index += 1) {
    const current = series.occurrences[index];
    if (current === undefined) {
      continue;
    }
    days.push(dayOfMonth(current.date));
    const previous = series.occurrences[index - 1];
    if (previous !== undefined) {
      gaps.push(current.date - previous.date);
    }
  }
  const asMoney = (value: bigint): Money | null =>
    amounts.length === 0 ? null : money(value, currency);
  const lastOccurrence = series.occurrences[series.occurrences.length - 1];
  return {
    seriesId: series.seriesId,
    category: series.category,
    direction: series.direction,
    cadenceKind: series.cadence.kind,
    intervalDays: series.cadence.intervalDays,
    modalGap: modalNumber(gaps),
    medianGap: medianNumber(gaps),
    anchorDay: lastOccurrence === undefined ? 0 : dayOfMonth(lastOccurrence.date),
    modalAnchorDay: modalNumber(days),
    occurrences: series.occurrences.length,
    projectedAmount: series.phaseAmounts[0] ?? series.lastKnownAmount,
    minAmount: asMoney(amounts.reduce((a, b) => (b < a ? b : a), amounts[0] ?? 0n)),
    meanAmount: asMoney(meanBigint(amounts)),
    medianAmount: asMoney(medianBigint(amounts)),
    lastAmount: series.lastKnownAmount,
  };
}

function chooseAmount(series: RecurringSeries, rule: AmountRule): bigint | null {
  const amounts = knownAmounts(series);
  if (amounts.length === 0) {
    return null;
  }
  switch (rule) {
    case 'last':
      return series.lastKnownAmount?.minor ?? null;
    case 'mean':
      return meanBigint(amounts);
    case 'median':
      return medianBigint(amounts);
    case 'min':
      return amounts.reduce((a, b) => (b < a ? b : a), amounts[0] ?? 0n);
    case 'max':
      return amounts.reduce((a, b) => (b > a ? b : a), amounts[0] ?? 0n);
    case 'phase_mean':
      return meanBigint(amounts);
    case 'phase_median':
      return medianBigint(amounts);
  }
}

function phaseAmountsFor(series: RecurringSeries, rule: AmountRule): (Money | null)[] {
  const cycleLength = Math.max(1, series.phaseAmounts.length);
  const buckets: bigint[][] = Array.from({ length: cycleLength }, () => []);
  for (let index = 1; index < series.occurrences.length; index += 1) {
    const occurrence = series.occurrences[index];
    if (occurrence === undefined || occurrence.amount === null) {
      continue;
    }
    const bucket = buckets[(index - 1) % cycleLength];
    if (bucket !== undefined) {
      bucket.push(occurrence.amount.minor);
    }
  }
  return buckets.map((values, phase) => {
    if (values.length === 0) {
      return series.phaseAmounts[phase] ?? series.lastKnownAmount;
    }
    const chosen = rule === 'phase_median' ? medianBigint(values) : meanBigint(values);
    return money(chosen, series.currency);
  });
}

function withAmountRule(series: RecurringSeries, rule: AmountRule): RecurringSeries {
  if (rule === 'last') {
    return series;
  }
  if (rule === 'phase_mean' || rule === 'phase_median') {
    const phases = phaseAmountsFor(series, rule);
    return { ...series, lastKnownAmount: phases[0] ?? series.lastKnownAmount, phaseAmounts: phases };
  }
  const chosen = chooseAmount(series, rule);
  if (chosen === null) {
    return series;
  }
  const replacement = money(chosen, series.currency);
  return {
    ...series,
    lastKnownAmount: replacement,
    phaseAmounts: series.phaseAmounts.map(() => replacement),
  };
}

function isSubMonthly(series: RecurringSeries): boolean {
  return (
    series.cadence.kind === 'fixed_interval' &&
    (series.cadence.intervalDays ?? 0) > 0 &&
    (series.cadence.intervalDays ?? 0) < SUB_MONTHLY_INTERVAL_DAYS
  );
}

export interface ProjectionVariant {
  readonly name: string;
  readonly incomeRule: AmountRule;
  readonly expenseRule: AmountRule;
  readonly dropSubMonthly: boolean;
}

export const PROJECTION_VARIANTS: readonly ProjectionVariant[] = [
  { name: 'current (last/per-phase)', incomeRule: 'last', expenseRule: 'last', dropSubMonthly: false },
  { name: 'mean both', incomeRule: 'mean', expenseRule: 'mean', dropSubMonthly: false },
  { name: 'median both', incomeRule: 'median', expenseRule: 'median', dropSubMonthly: false },
  { name: 'min both', incomeRule: 'min', expenseRule: 'min', dropSubMonthly: false },
  { name: 'max both', incomeRule: 'max', expenseRule: 'max', dropSubMonthly: false },
  { name: 'safer (income min, expense max)', incomeRule: 'min', expenseRule: 'max', dropSubMonthly: false },
  { name: 'income median, expense mean', incomeRule: 'median', expenseRule: 'mean', dropSubMonthly: false },
  { name: 'drop sub-monthly series', incomeRule: 'last', expenseRule: 'last', dropSubMonthly: true },
  { name: 'mean both + drop sub-monthly', incomeRule: 'mean', expenseRule: 'mean', dropSubMonthly: true },
  { name: 'per-phase mean', incomeRule: 'phase_mean', expenseRule: 'phase_mean', dropSubMonthly: false },
  { name: 'per-phase median', incomeRule: 'phase_median', expenseRule: 'phase_median', dropSubMonthly: false },
  { name: 'income per-phase mean, expense mean', incomeRule: 'phase_mean', expenseRule: 'mean', dropSubMonthly: false },
];

export function applyVariant(
  state: ReconstructedState,
  variant: ProjectionVariant,
): ReconstructedState {
  const income = state.recurringIncome
    .filter((series) => !(variant.dropSubMonthly && isSubMonthly(series)))
    .map((series) => withAmountRule(series, variant.incomeRule));
  const expenses = state.recurringExpenses
    .filter((series) => !(variant.dropSubMonthly && isSubMonthly(series)))
    .map((series) => withAmountRule(series, variant.expenseRule));
  return { ...state, recurringIncome: income, recurringExpenses: expenses };
}

export interface TroughProbe {
  readonly trough: Money;
  readonly troughDate: EpochDay;
}

export function probeTrough(
  state: ReconstructedState,
  requestDate: EpochDay,
  variant: ProjectionVariant,
): TroughProbe {
  const adjusted = applyVariant(state, variant);
  const sources = buildForwardLedger(adjusted, requestDate);
  const result = evaluateSafety(adjusted, requestDate, sources, [], []);
  return { trough: result.trough, troughDate: result.troughDate };
}

export function describeDate(day: EpochDay): string {
  return formatDate(day);
}
