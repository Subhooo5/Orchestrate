import { compareDays, formatDate, parseDate } from '../util/dates.js';
import { compareMoney, formatPlanAmount, parseMoney, sumMoney } from '../util/money.js';
import type { Money } from '../util/money.js';
import type { PaymentOption, RequestContext } from '../data/types.js';
import type { ReconstructedState } from '../finance/state.js';
import { MAX_SPENDING_CHANGES, expandInstallmentOption } from '../finance/engine.js';
import type { EngineResult } from '../finance/engine.js';
import { buildForwardLedger, isPlanSafe } from '../finance/ledger.js';

export class ValidationError extends Error {}

export interface OutputRow {
  readonly requestId: string;
  readonly amountSafeToPay: string;
  readonly affordabilityStatus: string;
  readonly recommendedPaymentMethod: string;
  readonly paymentPlan: string;
  readonly earliestDateForFullPayment: string;
  readonly spendingChangesNeeded: string;
  readonly decisionExplanation: string;
}

export interface Violation {
  readonly requestId: string;
  readonly rule: string;
  readonly detail: string;
}

function optionMatchesPlan(option: PaymentOption, planText: string): boolean {
  if (option.paymentMethod !== 'installments') {
    return false;
  }
  if (option.paymentFrequencyDays === null && option.numberOfPayments > 1) {
    return false;
  }
  const expanded = expandInstallmentOption(option)
    .map((payment) => `${formatDate(payment.date)}:${formatPlanAmount(payment.amount)}`)
    .join('|');
  return expanded === planText;
}

function parsePlan(planText: string, currency: Money['currency']): { date: number; amount: Money }[] {
  if (planText === 'none' || planText.length === 0) {
    return [];
  }
  return planText.split('|').map((entry) => {
    const separator = entry.indexOf(':');
    return {
      date: parseDate(entry.slice(0, separator)),
      amount: parseMoney(entry.slice(separator + 1), currency),
    };
  });
}

export function validateOutputFile(
  rows: readonly OutputRow[],
  expectedRequestIds: readonly string[],
  columns: readonly string[],
  requiredColumns: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  if (columns.length !== requiredColumns.length) {
    violations.push({
      requestId: '(file)',
      rule: 'column_count',
      detail: `expected ${requiredColumns.length} columns, found ${columns.length}`,
    });
  }
  for (let index = 0; index < requiredColumns.length; index += 1) {
    if (columns[index] !== requiredColumns[index]) {
      violations.push({
        requestId: '(file)',
        rule: 'column_order',
        detail: `column ${index + 1} must be ${requiredColumns[index]}, found ${columns[index] ?? '(missing)'}`,
      });
    }
  }
  if (rows.length !== expectedRequestIds.length) {
    violations.push({
      requestId: '(file)',
      rule: 'row_count',
      detail: `expected ${expectedRequestIds.length} rows, found ${rows.length}`,
    });
  }
  for (let index = 0; index < expectedRequestIds.length; index += 1) {
    const expected = expectedRequestIds[index];
    const actual = rows[index]?.requestId;
    if (actual !== expected) {
      violations.push({
        requestId: expected ?? '(missing)',
        rule: 'row_order',
        detail: `row ${index + 1} must be ${expected}, found ${actual ?? '(missing)'}`,
      });
    }
  }
  return violations;
}

export function validateRow(
  context: RequestContext,
  state: ReconstructedState,
  result: EngineResult,
  row: OutputRow,
): Violation[] {
  const violations: Violation[] = [];
  const request = context.request;
  const currency = state.homeCurrency;
  const add = (rule: string, detail: string): void => {
    violations.push({ requestId: row.requestId, rule, detail });
  };

  if (
    compareMoney(result.amountSafeToPay, request.requestedAmount) > 0 ||
    result.amountSafeToPay.minor < 0n
  ) {
    add('amount_bounds', `${row.amountSafeToPay} is outside [0, ${formatPlanAmount(request.requestedAmount)}]`);
  }

  const payments = parsePlan(row.paymentPlan, currency);
  for (let index = 1; index < payments.length; index += 1) {
    const previous = payments[index - 1];
    const current = payments[index];
    if (previous !== undefined && current !== undefined && current.date <= previous.date) {
      add('plan_chronology', `payment ${index + 1} is not strictly after payment ${index}`);
    }
  }

  if (row.recommendedPaymentMethod === 'not_recommended' && row.paymentPlan !== 'none') {
    add('not_recommended_plan', `expected none, found ${row.paymentPlan}`);
  }
  if (row.recommendedPaymentMethod !== 'not_recommended' && row.paymentPlan === 'none') {
    add('missing_plan', `${row.recommendedPaymentMethod} must carry a plan`);
  }

  if (row.affordabilityStatus === 'affordable_now') {
    if (row.earliestDateForFullPayment !== formatDate(request.requestDate)) {
      add(
        'affordable_now_earliest',
        `expected ${formatDate(request.requestDate)}, found "${row.earliestDateForFullPayment}"`,
      );
    }
  }

  if (row.recommendedPaymentMethod === 'partial_payment') {
    if (row.affordabilityStatus !== 'affordable_with_plan') {
      add('partial_status', `partial_payment requires affordable_with_plan, found ${row.affordabilityStatus}`);
    }
    if (!request.allowsPartialPayment) {
      add('partial_not_allowed', 'request does not allow partial payment');
    }
    if (!state.profile.paymentMethodsUserWillConsider.includes('partial_payment')) {
      add('partial_not_accepted', 'user does not accept partial_payment');
    }
    if (payments.length !== 2) {
      add('partial_shape', `expected exactly two payments, found ${payments.length}`);
    } else {
      const first = payments[0];
      const second = payments[1];
      if (first !== undefined && second !== undefined) {
        if (first.date !== request.requestDate) {
          add('partial_first_date', `first payment must fall on ${formatDate(request.requestDate)}`);
        }
        if (result.earliestDateForFullPayment === null || second.date !== result.earliestDateForFullPayment) {
          add('partial_second_date', 'second payment must fall on earliest_date_for_full_payment');
        }
        if (compareMoney(sumMoney([first.amount, second.amount], currency), request.requestedAmount) !== 0) {
          add('partial_sum', 'the two payments must sum to requested_amount');
        }
        if (compareDays(second.date, request.desiredCompletionDate) > 0) {
          add('partial_deadline', 'second payment falls after desired_completion_date');
        }
      }
    }
  }

  if (row.recommendedPaymentMethod === 'installments') {
    const matched = context.paymentOptions.some((option) => optionMatchesPlan(option, row.paymentPlan));
    if (!matched) {
      add('installment_option_match', 'plan does not match any supplied payment option');
    }
  }

  if (row.recommendedPaymentMethod === 'wait' || row.affordabilityStatus === 'affordable_later') {
    if (payments.length !== 1) {
      add('wait_shape', `expected exactly one payment, found ${payments.length}`);
    } else {
      const only = payments[0];
      if (only !== undefined) {
        if (compareMoney(only.amount, request.requestedAmount) !== 0) {
          add('wait_amount', 'wait plan must pay the full requested amount');
        }
        if (result.earliestDateForFullPayment === null || only.date !== result.earliestDateForFullPayment) {
          add('wait_date', 'wait payment must fall on earliest_date_for_full_payment');
        }
        if (compareDays(only.date, request.desiredCompletionDate) > 0) {
          add('wait_deadline', 'wait payment falls after desired_completion_date');
        }
      }
    }
  }

  const plan = result.plan;
  if (plan !== null) {
    if (plan.changes.length > MAX_SPENDING_CHANGES) {
      add('too_many_changes', `${plan.changes.length} changes exceeds ${MAX_SPENDING_CHANGES}`);
    }
    const stopped = new Set<string>();
    const reduced = new Set<string>();
    for (const change of plan.changes) {
      const series = state.recurringExpenses.find((candidate) => candidate.seriesId === change.seriesId);
      if (series === undefined) {
        add('change_not_recurring', `${change.eventId} is not part of a recurring expense series`);
        continue;
      }
      const allowsStop =
        series.flexibility === 'stoppable' || series.flexibility === 'reducible_or_stoppable';
      const allowsReduce =
        series.flexibility === 'reducible' || series.flexibility === 'reducible_or_stoppable';
      if (change.kind === 'stop') {
        if (!allowsStop) {
          add('change_flexibility', `${change.eventId} is ${series.flexibility} and cannot be stopped`);
        }
        stopped.add(change.eventId);
      } else {
        if (!allowsReduce) {
          add('change_flexibility', `${change.eventId} is ${series.flexibility} and cannot be reduced`);
        }
        if (
          change.newAmount !== null &&
          series.minimumAllowedAmount !== null &&
          compareMoney(change.newAmount, series.minimumAllowedAmount) < 0
        ) {
          add('change_below_minimum', `${change.eventId} reduced below minimum_allowed_amount`);
        }
        reduced.add(change.eventId);
      }
    }
    for (const eventId of stopped) {
      if (reduced.has(eventId)) {
        add('change_conflict', `${eventId} is both stopped and reduced`);
      }
    }

    const serializedChanges = plan.changes
      .map((change) =>
        change.kind === 'stop'
          ? `stop:${change.eventId}`
          : `reduce_to:${change.eventId}:${change.newAmount === null ? '' : formatPlanAmount(change.newAmount)}`,
      )
      .join('|');
    const expectedChanges = serializedChanges.length === 0 ? 'none' : serializedChanges;
    if (row.spendingChangesNeeded !== expectedChanges) {
      add(
        'spending_changes_roundtrip',
        `serialized "${row.spendingChangesNeeded}" does not match the selected plan "${expectedChanges}"`,
      );
    }

    const sources = buildForwardLedger(state, request.requestDate);
    if (!isPlanSafe(state, request.requestDate, sources, plan.payments, plan.changes)) {
      add('plan_unsafe', 'the recommended plan fails the 90-day safety check');
    }
    if (!plan.completesFullRequest) {
      add('plan_incomplete', 'the recommended plan does not complete the request by desired_completion_date');
    }
  }

  return violations;
}
