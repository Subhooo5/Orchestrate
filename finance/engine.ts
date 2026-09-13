import { addDays, compareDays, formatDate } from '../util/dates.js';
import type { EpochDay } from '../util/dates.js';
import {
  addMoney,
  compareMoney,
  formatMinimalAmount,
  formatPlanAmount,
  isPositiveMoney,
  money,
  subtractMoney,
  sumMoney,
  zeroMoney,
} from '../util/money.js';
import type { Money } from '../util/money.js';
import type {
  AffordabilityStatus,
  PaymentMethod,
  PaymentOption,
  PaymentRequest,
  RequestContext,
} from '../data/types.js';
import type { ReconstructedState } from './state.js';
import {
  FORECAST_WINDOW_DAYS,
  INTRA_DAY_DEBITS_FIRST,
  buildForwardLedger,
  dailyBalances,
  dominantCreditBetween,
  dominantDebitOn,
  evaluateBase,
  evaluateSafety,
  forecastBaseFor,
  forecastHorizon,
  isPlanSafe,
  reliefWithinWindow,
} from './ledger.js';
import type { LedgerSource, Payment, SpendingChange } from './ledger.js';

export const MAX_SPENDING_CHANGES = 3;

export interface CandidatePlan {
  readonly method: PaymentMethod;
  readonly payments: readonly Payment[];
  readonly changes: readonly SpendingChange[];
  readonly paymentOptionId: string | null;
  readonly totalPaid: Money;
  readonly completesFullRequest: boolean;
  readonly lastPaymentDate: EpochDay | null;
}

export interface BindingConstraint {
  readonly troughDate: EpochDay;
  readonly descriptor: string | null;
  readonly amount: Money | null;
}

export interface RecoverySource {
  readonly date: EpochDay;
  readonly descriptor: string;
  readonly amount: Money;
}

export interface EngineResult {
  readonly requestId: string;
  readonly amountSafeToPay: Money;
  readonly earliestDateForFullPayment: EpochDay | null;
  readonly status: AffordabilityStatus;
  readonly method: PaymentMethod;
  readonly plan: CandidatePlan | null;
  readonly blockedOnEvidence: boolean;
  readonly troughWithoutPayment: Money;
  readonly bindingConstraint: BindingConstraint;
  readonly recovery: RecoverySource | null;
}

export function solveAmountSafeToPay(
  state: ReconstructedState,
  request: PaymentRequest,
  sources: readonly LedgerSource[],
): Money {
  const currency = state.homeCurrency;
  const cap: bigint = request.requestedAmount.minor;
  if (cap <= 0n) {
    return zeroMoney(currency);
  }
  const baseline = evaluateSafety(state, request.requestDate, sources, [], []);
  const headroom: bigint = baseline.trough.minor - state.profile.minimumBalanceToKeep.minor;
  if (headroom <= 0n) {
    return zeroMoney(currency);
  }
  return money(headroom < cap ? headroom : cap, currency);
}

export function solveEarliestFullPaymentDate(
  state: ReconstructedState,
  request: PaymentRequest,
  sources: readonly LedgerSource[],
): EpochDay | null {
  const base = forecastBaseFor(sources, request.requestDate);
  const horizon = forecastHorizon(request.requestDate);
  if (INTRA_DAY_DEBITS_FIRST || base.start !== request.requestDate) {
    for (let day = request.requestDate; day <= horizon; day += 1) {
      if (isPlanSafe(state, request.requestDate, sources, [
        { date: day, amount: request.requestedAmount },
      ])) {
        return day;
      }
    }
    return null;
  }

  const minimum: bigint = state.profile.minimumBalanceToKeep.minor;
  const amount: bigint = request.requestedAmount.minor;
  const balances = dailyBalances(state, base);
  const length = base.length;
  const suffixMin = new Array<bigint>(length).fill(0n);
  for (let index = length - 1; index >= 0; index -= 1) {
    const current = balances[index] ?? 0n;
    const next = index + 1 < length ? suffixMin[index + 1] ?? current : current;
    suffixMin[index] = current < next ? current : next;
  }

  let prefixMin: bigint | null = null;
  for (let index = 0; index < length; index += 1) {
    if (prefixMin !== null && prefixMin < minimum) {
      return null;
    }
    if ((suffixMin[index] ?? 0n) - amount >= minimum) {
      return base.start + index;
    }
    const current = balances[index] ?? 0n;
    prefixMin = prefixMin === null || current < prefixMin ? current : prefixMin;
  }
  return null;
}

export function optionIsExpandable(option: PaymentOption): boolean {
  return option.numberOfPayments <= 1 || option.paymentFrequencyDays !== null;
}

export function expandInstallmentOption(option: PaymentOption): Payment[] {
  if (!optionIsExpandable(option)) {
    throw new Error(
      `${option.paymentOptionId} has ${option.numberOfPayments} payments but no payment_frequency_days`,
    );
  }
  const payments: Payment[] = [];
  let date = option.firstPaymentDate;
  for (let index = 0; index < option.numberOfPayments; index += 1) {
    payments.push({ date, amount: option.paymentAmount });
    date = addDays(date, option.paymentFrequencyDays ?? 0);
  }
  return payments;
}

function totalOf(payments: readonly Payment[], currency: Money['currency']): Money {
  return sumMoney(
    payments.map((payment) => payment.amount),
    currency,
  );
}

function lastDateOf(payments: readonly Payment[]): EpochDay | null {
  let last: EpochDay | null = null;
  for (const payment of payments) {
    if (last === null || payment.date > last) {
      last = payment.date;
    }
  }
  return last;
}

function makePlan(
  method: PaymentMethod,
  payments: readonly Payment[],
  changes: readonly SpendingChange[],
  paymentOptionId: string | null,
  request: PaymentRequest,
  currency: Money['currency'],
): CandidatePlan {
  const total = totalOf(payments, currency);
  const last = lastDateOf(payments);
  const completes =
    compareMoney(total, request.requestedAmount) >= 0 &&
    last !== null &&
    compareDays(last, request.desiredCompletionDate) <= 0;
  return {
    method,
    payments: [...payments].sort((left, right) => left.date - right.date),
    changes,
    paymentOptionId,
    totalPaid: total,
    completesFullRequest: completes,
    lastPaymentDate: last,
  };
}

export function eligibleSeriesChanges(
  state: ReconstructedState,
  asOf: EpochDay,
): SpendingChange[] {
  const profile = state.profile;
  const protectedCategories = new Set(profile.expenseCategoriesToProtect);
  const willStop = new Set(profile.expenseCategoriesUserIsWillingToStop);
  const willReduce = new Set(profile.expenseCategoriesUserIsWillingToReduce);
  const changes: SpendingChange[] = [];
  for (const series of state.recurringExpenses) {
    if (protectedCategories.has(series.category)) {
      continue;
    }
    const priorOccurrences = series.occurrences.filter((occurrence) => occurrence.date <= asOf);
    const last = priorOccurrences[priorOccurrences.length - 1];
    if (last === undefined) {
      continue;
    }
    const allowsStop =
      series.flexibility === 'stoppable' || series.flexibility === 'reducible_or_stoppable';
    const allowsReduce =
      series.flexibility === 'reducible' || series.flexibility === 'reducible_or_stoppable';
    if (allowsStop && willStop.has(series.category)) {
      changes.push({
        kind: 'stop',
        eventId: last.eventId,
        seriesId: series.seriesId,
        category: series.category,
        description: last.description,
        newAmount: null,
      });
    }
    if (allowsReduce && willReduce.has(series.category) && series.minimumAllowedAmount !== null) {
      changes.push({
        kind: 'reduce_to',
        eventId: last.eventId,
        seriesId: series.seriesId,
        category: series.category,
        description: last.description,
        newAmount: series.minimumAllowedAmount,
      });
    }
  }
  return changes;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) {
    return [[]];
  }
  const result: T[][] = [];
  for (let index = 0; index <= items.length - size; index += 1) {
    const head = items[index];
    if (head === undefined) {
      continue;
    }
    for (const tail of combinations(items.slice(index + 1), size - 1)) {
      result.push([head, ...tail]);
    }
  }
  return result;
}

function changesAreConsistent(changes: readonly SpendingChange[]): boolean {
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.seriesId)) {
      return false;
    }
    seen.add(change.seriesId);
  }
  return true;
}

export function findSmallestSafeChangeSet(
  state: ReconstructedState,
  request: PaymentRequest,
  sources: readonly LedgerSource[],
  payments: readonly Payment[],
): SpendingChange[] | null {
  const available = eligibleSeriesChanges(state, request.requestDate);
  const base = forecastBaseFor(sources, request.requestDate);
  const baseline = evaluateBase(state, base, payments, []);
  if (baseline.safe) {
    return [];
  }
  const gap: bigint = state.profile.minimumBalanceToKeep.minor - baseline.trough.minor;
  const relief = new Map<string, bigint>();
  for (const change of available) {
    relief.set(`${change.kind}:${change.eventId}`, reliefWithinWindow(base, change));
  }
  for (let size = 1; size <= Math.min(MAX_SPENDING_CHANGES, available.length); size += 1) {
    for (const combination of combinations(available, size)) {
      if (!changesAreConsistent(combination)) {
        continue;
      }
      let total = 0n;
      for (const change of combination) {
        total += relief.get(`${change.kind}:${change.eventId}`) ?? 0n;
      }
      if (total < gap) {
        continue;
      }
      if (evaluateBase(state, base, payments, combination).safe) {
        return combination;
      }
    }
  }
  return null;
}

export function generateCandidatePlans(
  context: RequestContext,
  state: ReconstructedState,
  sources: readonly LedgerSource[],
  amountSafeToPay: Money,
  earliestFullDate: EpochDay | null,
): CandidatePlan[] {
  const request = context.request;
  const currency = state.homeCurrency;
  const accepted = new Set(state.profile.paymentMethodsUserWillConsider);
  const plans: CandidatePlan[] = [];

  const fullToday: Payment[] = [{ date: request.requestDate, amount: request.requestedAmount }];
  if (accepted.has('full_payment')) {
    if (isPlanSafe(state, request.requestDate, sources, fullToday)) {
      plans.push(makePlan('full_payment', fullToday, [], null, request, currency));
    } else {
      const changes = findSmallestSafeChangeSet(state, request, sources, fullToday);
      if (changes !== null && changes.length > 0) {
        plans.push(makePlan('full_payment', fullToday, changes, null, request, currency));
      }
    }
  }

  if (
    accepted.has('partial_payment') &&
    request.allowsPartialPayment &&
    isPositiveMoney(amountSafeToPay) &&
    compareMoney(amountSafeToPay, request.requestedAmount) < 0 &&
    earliestFullDate !== null &&
    compareDays(earliestFullDate, request.desiredCompletionDate) <= 0
  ) {
    const remainder = subtractMoney(request.requestedAmount, amountSafeToPay);
    const payments: Payment[] = [
      { date: request.requestDate, amount: amountSafeToPay },
      { date: earliestFullDate, amount: remainder },
    ];
    if (isPlanSafe(state, request.requestDate, sources, payments)) {
      plans.push(makePlan('partial_payment', payments, [], null, request, currency));
    }
  }

  if (accepted.has('installments')) {
    const maxMonths = state.profile.maxInstallmentMonths;
    for (const option of context.paymentOptions) {
      if (option.paymentMethod !== 'installments') {
        continue;
      }
      if (maxMonths !== null && option.numberOfPayments > maxMonths) {
        continue;
      }
      if (!optionIsExpandable(option)) {
        continue;
      }
      const payments = expandInstallmentOption(option);
      if (isPlanSafe(state, request.requestDate, sources, payments)) {
        plans.push(
          makePlan('installments', payments, [], option.paymentOptionId, request, currency),
        );
      }
    }
  }

  if (
    accepted.has('full_payment') &&
    earliestFullDate !== null &&
    earliestFullDate > request.requestDate &&
    compareDays(earliestFullDate, request.desiredCompletionDate) <= 0
  ) {
    const payments: Payment[] = [{ date: earliestFullDate, amount: request.requestedAmount }];
    plans.push(makePlan('wait', payments, [], null, request, currency));
  }

  return plans;
}

export function comparePlans(left: CandidatePlan, right: CandidatePlan): number {
  if (left.completesFullRequest !== right.completesFullRequest) {
    return left.completesFullRequest ? -1 : 1;
  }
  if (left.changes.length !== right.changes.length) {
    return left.changes.length - right.changes.length;
  }
  const byTotal = compareMoney(left.totalPaid, right.totalPaid);
  if (byTotal !== 0) {
    return byTotal;
  }
  const leftStart = left.payments[0]?.date ?? Number.MAX_SAFE_INTEGER;
  const rightStart = right.payments[0]?.date ?? Number.MAX_SAFE_INTEGER;
  if (leftStart !== rightStart) {
    return leftStart - rightStart;
  }
  if (left.payments.length !== right.payments.length) {
    return left.payments.length - right.payments.length;
  }
  const leftOption = left.paymentOptionId ?? '';
  const rightOption = right.paymentOptionId ?? '';
  return leftOption.localeCompare(rightOption);
}

function statusForPlan(
  plan: CandidatePlan,
  request: PaymentRequest,
  earliestFullDate: EpochDay | null,
  acceptsFullPayment: boolean,
): AffordabilityStatus {
  if (plan.method === 'wait') {
    return 'affordable_later';
  }
  if (plan.method === 'partial_payment' || plan.method === 'installments') {
    return 'affordable_with_plan';
  }
  if (plan.changes.length > 0) {
    return 'affordable_with_plan';
  }
  if (acceptsFullPayment && earliestFullDate !== null && earliestFullDate === request.requestDate) {
    return 'affordable_now';
  }
  return 'affordable_with_plan';
}

export function decide(
  context: RequestContext,
  state: ReconstructedState,
): EngineResult {
  const request = context.request;
  const currency = state.homeCurrency;
  const sources = buildForwardLedger(state, request.requestDate);
  const base = forecastBaseFor(sources, request.requestDate);
  const baseline = evaluateBase(state, base, [], []);
  const dominant = dominantDebitOn(base, baseline.troughDate);
  const bindingConstraint: BindingConstraint = {
    troughDate: baseline.troughDate,
    descriptor: dominant?.descriptor ?? null,
    amount: dominant === null ? null : money(dominant.debitMinor, currency),
  };
  const amountSafeToPay = solveAmountSafeToPay(state, request, sources);
  const earliestFullDate = solveEarliestFullPaymentDate(state, request, sources);
  const acceptsFullPayment = state.profile.paymentMethodsUserWillConsider.includes('full_payment');

  const plans = generateCandidatePlans(context, state, sources, amountSafeToPay, earliestFullDate)
    .filter((plan) => plan.completesFullRequest)
    .sort(comparePlans);

  const recoverySource =
    earliestFullDate === null || earliestFullDate <= request.requestDate
      ? null
      : dominantCreditBetween(base, request.requestDate + 1, earliestFullDate);
  const recovery: RecoverySource | null =
    recoverySource === null
      ? null
      : {
          date: recoverySource.date,
          descriptor: recoverySource.descriptor,
          amount: money(recoverySource.creditMinor, currency),
        };

  const chosen = plans[0];
  if (chosen === undefined) {
    return {
      requestId: request.requestId,
      amountSafeToPay,
      earliestDateForFullPayment: earliestFullDate,
      status: 'not_affordable',
      method: 'not_recommended',
      plan: null,
      blockedOnEvidence: baseline.blockedOnEvidence,
      troughWithoutPayment: baseline.trough,
      bindingConstraint,
      recovery,
    };
  }

  return {
    requestId: request.requestId,
    amountSafeToPay,
    earliestDateForFullPayment: earliestFullDate,
    status: statusForPlan(chosen, request, earliestFullDate, acceptsFullPayment),
    method: chosen.method,
    plan: chosen,
    blockedOnEvidence: baseline.blockedOnEvidence,
    troughWithoutPayment: baseline.trough,
    bindingConstraint,
    recovery,
  };
}

export function formatPaymentPlan(plan: CandidatePlan | null): string {
  if (plan === null || plan.payments.length === 0) {
    return 'none';
  }
  return plan.payments
    .map((payment) => `${formatDate(payment.date)}:${formatPlanAmount(payment.amount)}`)
    .join('|');
}

export function formatSpendingChanges(plan: CandidatePlan | null): string {
  if (plan === null || plan.changes.length === 0) {
    return 'none';
  }
  return plan.changes
    .map((change) =>
      change.kind === 'stop'
        ? `stop:${change.eventId}`
        : `reduce_to:${change.eventId}:${change.newAmount === null ? '' : formatPlanAmount(change.newAmount)}`,
    )
    .join('|');
}

export function formatAmountSafeToPay(result: EngineResult): string {
  return formatMinimalAmount(result.amountSafeToPay);
}

export function formatEarliestDate(result: EngineResult): string {
  return result.earliestDateForFullPayment === null
    ? ''
    : formatDate(result.earliestDateForFullPayment);
}

export function windowDays(): number {
  return FORECAST_WINDOW_DAYS;
}

export function totalPaidOrZero(plan: CandidatePlan | null, currency: Money['currency']): Money {
  return plan === null ? zeroMoney(currency) : plan.totalPaid;
}

export function addOrZero(left: Money | null, right: Money): Money {
  return left === null ? right : addMoney(left, right);
}
