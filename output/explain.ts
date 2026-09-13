import { civilFromDays } from '../util/dates.js';
import type { EpochDay } from '../util/dates.js';
import { formatPlanAmount } from '../util/money.js';
import type { Money } from '../util/money.js';
import type { PaymentRequest } from '../data/types.js';
import type { ReconstructedState } from '../finance/state.js';
import type { EngineResult } from '../finance/engine.js';
import type { SpendingChange } from '../finance/ledger.js';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'] as const;

export function formatLongDate(day: EpochDay): string {
  const { year, month, day: dayOfMonth } = civilFromDays(day);
  return `${dayOfMonth} ${MONTH_NAMES[month - 1] ?? ''} ${year}`;
}

export function formatGroupedAmount(value: Money): string {
  const plain = formatPlanAmount(value);
  const negative = plain.startsWith('-');
  const unsigned = negative ? plain.slice(1) : plain;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction}`;
}

export function describeMoneyForExplanation(value: Money): string {
  return `${value.currency} ${formatGroupedAmount(value)}`;
}

function describeChange(change: SpendingChange): string {
  const subject = change.description.trim().toLowerCase();
  if (change.kind === 'stop') {
    return `stop the ${subject}`;
  }
  const amount = change.newAmount === null ? '' : describeMoneyForExplanation(change.newAmount);
  return `reduce the ${subject} to ${amount}`;
}

function joinChanges(changes: readonly SpendingChange[]): string {
  const parts = changes.map(describeChange);
  if (parts.length === 0) {
    return '';
  }
  if (parts.length === 1) {
    return parts[0] ?? '';
  }
  const head = parts.slice(0, -1).join(', ');
  return `${head} and ${parts[parts.length - 1] ?? ''}`;
}

export function singleLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function buildExplanation(
  request: PaymentRequest,
  state: ReconstructedState,
  result: EngineResult,
): string {
  return singleLine(composeExplanation(request, state, result));
}

function composeExplanation(
  request: PaymentRequest,
  state: ReconstructedState,
  result: EngineResult,
): string {
  const minimum = describeMoneyForExplanation(state.profile.minimumBalanceToKeep);
  const requested = describeMoneyForExplanation(request.requestedAmount);
  const plan = result.plan;
  const binding = result.bindingConstraint;
  const limitedBy =
    binding.descriptor === null
      ? ''
      : `, limited by the ${binding.descriptor.trim().toLowerCase()} on ${formatLongDate(binding.troughDate)}`;
  const recovery = result.recovery;
  const recoveredBy =
    recovery === null
      ? ''
      : ` The balance recovers with the ${recovery.descriptor.trim().toLowerCase()} on ${formatLongDate(recovery.date)}.`;

  if (plan === null) {
    return `Do not make this payment by ${formatLongDate(request.desiredCompletionDate)}. None of the available options keeps the ${minimum} minimum protected.`;
  }

  const first = plan.payments[0];
  if (plan.method === 'wait' && first !== undefined) {
    return `Pay ${describeMoneyForExplanation(first.amount)} in full on ${formatLongDate(first.date)}. Paying earlier would take the balance below the ${minimum} minimum.${recoveredBy}`;
  }

  if (plan.method === 'installments' && first !== undefined) {
    return `Use ${plan.payments.length} installments of ${describeMoneyForExplanation(first.amount)}, starting ${formatLongDate(first.date)}. This leaves at least ${minimum} available${limitedBy}.`;
  }

  if (plan.method === 'partial_payment' && first !== undefined) {
    const second = plan.payments[1];
    if (second !== undefined) {
      return `Pay ${describeMoneyForExplanation(first.amount)} today and the remaining ${describeMoneyForExplanation(second.amount)} on ${formatLongDate(second.date)}. This completes the full request and keeps the ${minimum} minimum protected${limitedBy}.`;
    }
  }

  if (plan.changes.length > 0 && first !== undefined) {
    return `${capitalise(joinChanges(plan.changes))}, then pay ${describeMoneyForExplanation(first.amount)} today. This leaves at least ${minimum} available.`;
  }

  if (first !== undefined) {
    return `Pay ${describeMoneyForExplanation(first.amount)} today. This leaves at least ${minimum} available over the next 90 days.`;
  }

  return `Do not proceed with the ${requested} request. The full amount cannot be completed safely within 90 days.`;
}
