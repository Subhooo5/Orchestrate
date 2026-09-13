import { addDays } from '../util/dates.js';
import type { EpochDay } from '../util/dates.js';
import { money, zeroMoney } from '../util/money.js';
import type { CurrencyCode, Money } from '../util/money.js';
import { isSettledHistory, ledgerDate, signedDirection } from './inclusion.js';
import { projectSeries } from './recurrence.js';
import type { RecurringSeries } from './recurrence.js';
import { StateInvariantError } from './state.js';
import type { ReconstructedState } from './state.js';

export const FORECAST_WINDOW_DAYS = 90;
export const WINDOW_INCLUDES_REQUEST_DATE = true;
export const INTRA_DAY_DEBITS_FIRST: boolean = false;

export type LedgerSourceKind = 'confirmed_future' | 'reserved_pending' | 'projected_recurring';

export interface LedgerSource {
  readonly date: EpochDay;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly seriesId: string | null;
  readonly kind: LedgerSourceKind;
  readonly label: string;
  readonly descriptor: string;
  readonly amountKnown: boolean;
}

export interface SpendingChange {
  readonly kind: 'stop' | 'reduce_to';
  readonly eventId: string;
  readonly seriesId: string;
  readonly category: string;
  readonly description: string;
  readonly newAmount: Money | null;
}

export interface Payment {
  readonly date: EpochDay;
  readonly amount: Money;
}

export interface SafetyResult {
  readonly safe: boolean;
  readonly trough: Money;
  readonly troughDate: EpochDay;
  readonly blockedOnEvidence: boolean;
}

export function forecastHorizon(requestDate: EpochDay): EpochDay {
  return addDays(requestDate, FORECAST_WINDOW_DAYS);
}

function windowStart(requestDate: EpochDay): EpochDay {
  return WINDOW_INCLUDES_REQUEST_DATE ? requestDate : addDays(requestDate, 1);
}

function seriesKeyOf(category: string, direction: string, currency: CurrencyCode): string {
  return `${category}|${direction}|${currency}`;
}

const forwardLedgerCache = new WeakMap<ReconstructedState, Map<EpochDay, LedgerSource[]>>();

export function buildForwardLedger(
  state: ReconstructedState,
  requestDate: EpochDay,
): LedgerSource[] {
  let perDate = forwardLedgerCache.get(state);
  if (perDate === undefined) {
    perDate = new Map<EpochDay, LedgerSource[]>();
    forwardLedgerCache.set(state, perDate);
  }
  const memoised = perDate.get(requestDate);
  if (memoised !== undefined) {
    return memoised;
  }
  const built = buildForwardLedgerUncached(state, requestDate);
  perDate.set(requestDate, built);
  return built;
}

function buildForwardLedgerUncached(
  state: ReconstructedState,
  requestDate: EpochDay,
): LedgerSource[] {
  const horizon = forecastHorizon(requestDate);
  const sources: LedgerSource[] = [];
  const seriesByKey = new Map<string, RecurringSeries>();
  for (const series of [...state.recurringIncome, ...state.recurringExpenses]) {
    seriesByKey.set(seriesKeyOf(series.category, series.direction, series.currency), series);
  }

  const explicit = [...state.confirmedFutureEvents, ...state.reservedPendingEvents];
  for (const entry of explicit) {
    if (isSettledHistory(entry.event)) {
      throw new StateInvariantError(
        `settled event ${entry.event.eventId} must never reach the forward ledger`,
      );
    }
    const date = ledgerDate(entry.event);
    if (date < requestDate || date > horizon) {
      continue;
    }
    const owner = seriesByKey.get(
      seriesKeyOf(entry.event.category, entry.event.direction, entry.event.currency),
    );
    const magnitude = entry.amount === null ? 0n : entry.amount.minor;
    const credit = signedDirection(entry.event) === 1;
    sources.push({
      date,
      debitMinor: credit ? 0n : magnitude,
      creditMinor: credit ? magnitude : 0n,
      seriesId: owner?.seriesId ?? null,
      kind: entry.event.status === 'scheduled' ? 'confirmed_future' : 'reserved_pending',
      label: `${entry.event.eventId} ${entry.event.category}`,
      descriptor: entry.event.description,
      amountKnown: entry.amount !== null,
    });
  }

  for (const series of [...state.recurringIncome, ...state.recurringExpenses]) {
    for (const projection of projectSeries(series, windowStart(requestDate), horizon)) {
      const magnitude = projection.amount === null ? 0n : projection.amount.minor;
      const credit = series.direction === 'credit';
      sources.push({
        date: projection.date,
        debitMinor: credit ? 0n : magnitude,
        creditMinor: credit ? magnitude : 0n,
        seriesId: series.seriesId,
        kind: 'projected_recurring',
        label: `${series.category} projected`,
        descriptor: series.category.replace(/_/g, ' '),
        amountKnown: projection.amount !== null,
      });
    }
  }

  return sources.sort((left, right) => left.date - right.date || left.label.localeCompare(right.label));
}

function applyChanges(
  sources: readonly LedgerSource[],
  changes: readonly SpendingChange[],
): LedgerSource[] {
  if (changes.length === 0) {
    return [...sources];
  }
  const stopped = new Set<string>();
  const reduced = new Map<string, bigint>();
  for (const change of changes) {
    if (change.kind === 'stop') {
      stopped.add(change.seriesId);
    } else if (change.newAmount !== null) {
      reduced.set(change.seriesId, change.newAmount.minor);
    }
  }
  const result: LedgerSource[] = [];
  for (const source of sources) {
    if (source.seriesId !== null && stopped.has(source.seriesId)) {
      continue;
    }
    const floor = source.seriesId === null ? undefined : reduced.get(source.seriesId);
    if (floor !== undefined && source.debitMinor > floor) {
      result.push({ ...source, debitMinor: floor });
      continue;
    }
    result.push(source);
  }
  return result;
}

export interface SeriesContribution {
  readonly index: number;
  readonly debitMinor: bigint;
}

export interface ForecastBase {
  readonly requestDate: EpochDay;
  readonly start: EpochDay;
  readonly horizon: EpochDay;
  readonly length: number;
  readonly debits: readonly bigint[];
  readonly credits: readonly bigint[];
  readonly bySeries: ReadonlyMap<string, readonly SeriesContribution[]>;
  readonly blockedOnEvidence: boolean;
  readonly sources: readonly LedgerSource[];
}

export function buildForecastBase(
  sources: readonly LedgerSource[],
  requestDate: EpochDay,
): ForecastBase {
  const start = windowStart(requestDate);
  const horizon = forecastHorizon(requestDate);
  const length = horizon - start + 1;
  const debits = new Array<bigint>(length).fill(0n);
  const credits = new Array<bigint>(length).fill(0n);
  const bySeries = new Map<string, SeriesContribution[]>();
  let blockedOnEvidence = false;

  for (const source of sources) {
    if (!source.amountKnown) {
      blockedOnEvidence = true;
    }
    const index = source.date - start;
    if (index < 0 || index >= length) {
      continue;
    }
    if (source.debitMinor !== 0n) {
      debits[index] = (debits[index] ?? 0n) + source.debitMinor;
      if (source.seriesId !== null) {
        const list = bySeries.get(source.seriesId);
        const entry: SeriesContribution = { index, debitMinor: source.debitMinor };
        if (list === undefined) {
          bySeries.set(source.seriesId, [entry]);
        } else {
          list.push(entry);
        }
      }
    }
    if (source.creditMinor !== 0n) {
      credits[index] = (credits[index] ?? 0n) + source.creditMinor;
    }
  }

  return { requestDate, start, horizon, length, debits, credits, bySeries, blockedOnEvidence, sources };
}

const forecastBaseCache = new WeakMap<readonly LedgerSource[], ForecastBase>();

export function forecastBaseFor(
  sources: readonly LedgerSource[],
  requestDate: EpochDay,
): ForecastBase {
  const cached = forecastBaseCache.get(sources);
  if (cached !== undefined && cached.requestDate === requestDate) {
    return cached;
  }
  const built = buildForecastBase(sources, requestDate);
  forecastBaseCache.set(sources, built);
  return built;
}

function changeDeltas(base: ForecastBase, changes: readonly SpendingChange[]): Map<number, bigint> {
  const deltas = new Map<number, bigint>();
  for (const change of changes) {
    const contributions = base.bySeries.get(change.seriesId);
    if (contributions === undefined) {
      continue;
    }
    const floor = change.kind === 'stop' ? null : change.newAmount?.minor ?? null;
    for (const contribution of contributions) {
      const removed =
        floor === null
          ? contribution.debitMinor
          : contribution.debitMinor > floor
            ? contribution.debitMinor - floor
            : 0n;
      if (removed !== 0n) {
        deltas.set(contribution.index, (deltas.get(contribution.index) ?? 0n) + removed);
      }
    }
  }
  return deltas;
}

export function reliefWithinWindow(base: ForecastBase, change: SpendingChange): bigint {
  const contributions = base.bySeries.get(change.seriesId);
  if (contributions === undefined) {
    return 0n;
  }
  const floor = change.kind === 'stop' ? null : change.newAmount?.minor ?? null;
  let total = 0n;
  for (const contribution of contributions) {
    total +=
      floor === null
        ? contribution.debitMinor
        : contribution.debitMinor > floor
          ? contribution.debitMinor - floor
          : 0n;
  }
  return total;
}

export function evaluateBase(
  state: ReconstructedState,
  base: ForecastBase,
  payments: readonly Payment[],
  changes: readonly SpendingChange[],
): SafetyResult {
  const currency = state.homeCurrency;
  const minimum: bigint = state.profile.minimumBalanceToKeep.minor;
  const deltas = changeDeltas(base, changes);
  const paymentByIndex = new Map<number, bigint>();
  for (const payment of payments) {
    const index = payment.date - base.start;
    if (index < 0 || index >= base.length) {
      continue;
    }
    paymentByIndex.set(index, (paymentByIndex.get(index) ?? 0n) + payment.amount.minor);
  }

  let balance: bigint = state.profile.currentAvailableBalance.minor;
  let trough: bigint = balance;
  let troughDate = base.start;
  let safe = true;

  for (let index = 0; index < base.length; index += 1) {
    const debit =
      (base.debits[index] ?? 0n) - (deltas.get(index) ?? 0n) + (paymentByIndex.get(index) ?? 0n);
    const credit = base.credits[index] ?? 0n;
    if (INTRA_DAY_DEBITS_FIRST) {
      const afterDebits = balance - debit;
      if (afterDebits < trough) {
        trough = afterDebits;
        troughDate = base.start + index;
      }
      if (afterDebits < minimum) {
        safe = false;
      }
      balance = afterDebits + credit;
    } else {
      balance = balance + credit - debit;
      if (balance < trough) {
        trough = balance;
        troughDate = base.start + index;
      }
      if (balance < minimum) {
        safe = false;
      }
    }
  }

  return {
    safe,
    trough: money(trough, currency),
    troughDate,
    blockedOnEvidence: base.blockedOnEvidence,
  };
}

export function dailyBalances(
  state: ReconstructedState,
  base: ForecastBase,
): bigint[] {
  const balances = new Array<bigint>(base.length).fill(0n);
  let balance: bigint = state.profile.currentAvailableBalance.minor;
  for (let index = 0; index < base.length; index += 1) {
    balance = balance + (base.credits[index] ?? 0n) - (base.debits[index] ?? 0n);
    balances[index] = balance;
  }
  return balances;
}

export function dominantDebitOn(
  base: ForecastBase,
  date: EpochDay,
): LedgerSource | null {
  let best: LedgerSource | null = null;
  for (const source of base.sources) {
    if (source.date !== date || source.debitMinor === 0n) {
      continue;
    }
    if (best === null || source.debitMinor > best.debitMinor) {
      best = source;
    }
  }
  return best;
}

export function dominantCreditBetween(
  base: ForecastBase,
  from: EpochDay,
  to: EpochDay,
): LedgerSource | null {
  let best: LedgerSource | null = null;
  for (const source of base.sources) {
    if (source.date < from || source.date > to || source.creditMinor === 0n) {
      continue;
    }
    if (best === null || source.creditMinor > best.creditMinor) {
      best = source;
    }
  }
  return best;
}

export function evaluateSafety(
  state: ReconstructedState,
  requestDate: EpochDay,
  sources: readonly LedgerSource[],
  payments: readonly Payment[],
  changes: readonly SpendingChange[],
): SafetyResult {
  return evaluateBase(state, forecastBaseFor(sources, requestDate), payments, changes);
}

export function isPlanSafe(
  state: ReconstructedState,
  requestDate: EpochDay,
  sources: readonly LedgerSource[],
  payments: readonly Payment[],
  changes: readonly SpendingChange[] = [],
): boolean {
  return evaluateSafety(state, requestDate, sources, payments, changes).safe;
}

export function openingBalance(state: ReconstructedState): Money {
  return state.profile.currentAvailableBalance;
}

export function zeroFor(state: ReconstructedState): Money {
  return zeroMoney(state.homeCurrency);
}
