import { z } from 'zod';
import { CURRENCY_CODES } from '../util/money.js';
import type { ConversionRate, CurrencyCode, Money } from '../util/money.js';
import type { EpochDay } from '../util/dates.js';

export const EVENT_TYPES = [
  'expense',
  'subscription',
  'income',
  'debt_payment',
  'investment_purchase',
  'investment_valuation',
  'investment_sale',
  'refund',
] as const;

export const EVENT_DIRECTIONS = ['debit', 'credit', 'non_cash'] as const;

export const EVENT_STATUSES = [
  'settled',
  'pending',
  'scheduled',
  'cancelled',
  'failed',
  'unrealized',
] as const;

export const FLEXIBILITIES = ['fixed', 'reducible', 'stoppable', 'reducible_or_stoppable'] as const;

export const REQUEST_TYPES = [
  'purchase',
  'travel',
  'education',
  'family_transfer',
  'debt_repayment',
  'investment',
  'housing',
  'emergency_expense',
  'other',
] as const;

export const PAYMENT_METHODS = [
  'full_payment',
  'partial_payment',
  'installments',
  'wait',
  'not_recommended',
] as const;

export const OPTION_PAYMENT_METHODS = ['full_payment', 'installments'] as const;

export const AFFORDABILITY_STATUSES = [
  'affordable_now',
  'affordable_with_plan',
  'affordable_later',
  'not_affordable',
] as const;

export const MESSAGE_SOURCE_TYPES = [
  'employer',
  'service_provider',
  'financial_service',
  'bank',
  'merchant',
] as const;

export const OUTPUT_COLUMNS = [
  'request_id',
  'amount_safe_to_pay',
  'affordability_status',
  'recommended_payment_method',
  'payment_plan',
  'earliest_date_for_full_payment',
  'spending_changes_needed',
  'decision_explanation',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type EventDirection = (typeof EVENT_DIRECTIONS)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type Flexibility = (typeof FLEXIBILITIES)[number];
export type RequestType = (typeof REQUEST_TYPES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type OptionPaymentMethod = (typeof OPTION_PAYMENT_METHODS)[number];
export type AffordabilityStatus = (typeof AFFORDABILITY_STATUSES)[number];
export type MessageSourceType = (typeof MESSAGE_SOURCE_TYPES)[number];
export type OutputColumn = (typeof OUTPUT_COLUMNS)[number];

const text = z.string();

export const financialProfileRowSchema = z.object({
  user_id: z.string().min(1),
  home_currency: z.enum(CURRENCY_CODES),
  current_available_balance: text,
  minimum_balance_to_keep: text,
  financial_priorities: text,
  expense_categories_to_protect: text,
  expense_categories_user_is_willing_to_reduce: text,
  expense_categories_user_is_willing_to_stop: text,
  payment_methods_user_will_consider: text,
  max_installment_months: text,
});

export const financialEventRowSchema = z.object({
  event_id: z.string().min(1),
  user_id: z.string().min(1),
  event_type: z.enum(EVENT_TYPES),
  description: text,
  category: text,
  direction: z.enum(EVENT_DIRECTIONS),
  amount: text,
  currency: z.enum(CURRENCY_CODES),
  event_date: text,
  settlement_date: text,
  status: z.enum(EVENT_STATUSES),
  linked_event_id: text,
  flexibility: z.enum(FLEXIBILITIES),
  minimum_allowed_amount: text,
});

export const exchangeRateRowSchema = z.object({
  rate_date: text,
  from_currency: z.enum(CURRENCY_CODES),
  to_currency: z.enum(CURRENCY_CODES),
  rate: text,
});

export const requestRowSchema = z.object({
  request_id: z.string().min(1),
  user_id: z.string().min(1),
  request_date: text,
  request_type: z.enum(REQUEST_TYPES),
  requested_amount: text,
  desired_completion_date: text,
  allows_partial_payment: text,
  request_text: text,
});

export const sampleRequestRowSchema = requestRowSchema.extend({
  amount_safe_to_pay: text,
  affordability_status: z.enum(AFFORDABILITY_STATUSES),
  recommended_payment_method: z.enum(PAYMENT_METHODS),
  payment_plan: text,
  earliest_date_for_full_payment: text,
  spending_changes_needed: text,
  decision_explanation: text,
});

export const paymentOptionRowSchema = z.object({
  payment_option_id: z.string().min(1),
  request_id: z.string().min(1),
  payment_method: z.enum(OPTION_PAYMENT_METHODS),
  payment_amount: text,
  number_of_payments: text,
  first_payment_date: text,
  payment_frequency_days: text,
  financing_fee: text,
  total_payable_amount: text,
});

export const messageRowSchema = z.object({
  message_id: z.string().min(1),
  user_id: z.string().min(1),
  request_id: text,
  related_event_id: text,
  sent_at: text,
  source_type: z.enum(MESSAGE_SOURCE_TYPES),
  message_text: text,
});

export const imageRowSchema = z.object({
  image_id: z.string().min(1),
  user_id: z.string().min(1),
  request_id: text,
  related_event_id: text,
});

export type FinancialProfileRow = z.infer<typeof financialProfileRowSchema>;
export type FinancialEventRow = z.infer<typeof financialEventRowSchema>;
export type ExchangeRateRow = z.infer<typeof exchangeRateRowSchema>;
export type RequestRow = z.infer<typeof requestRowSchema>;
export type SampleRequestRow = z.infer<typeof sampleRequestRowSchema>;
export type PaymentOptionRow = z.infer<typeof paymentOptionRowSchema>;
export type MessageRow = z.infer<typeof messageRowSchema>;
export type ImageRow = z.infer<typeof imageRowSchema>;

export interface FinancialProfile {
  readonly userId: string;
  readonly homeCurrency: CurrencyCode;
  readonly currentAvailableBalance: Money;
  readonly minimumBalanceToKeep: Money;
  readonly financialPriorities: readonly string[];
  readonly expenseCategoriesToProtect: readonly string[];
  readonly expenseCategoriesUserIsWillingToReduce: readonly string[];
  readonly expenseCategoriesUserIsWillingToStop: readonly string[];
  readonly paymentMethodsUserWillConsider: readonly PaymentMethod[];
  readonly maxInstallmentMonths: number | null;
}

export interface FinancialEvent {
  readonly eventId: string;
  readonly userId: string;
  readonly eventType: EventType;
  readonly description: string;
  readonly category: string;
  readonly direction: EventDirection;
  readonly amount: Money | null;
  readonly currency: CurrencyCode;
  readonly eventDate: EpochDay;
  readonly settlementDate: EpochDay | null;
  readonly status: EventStatus;
  readonly linkedEventId: string | null;
  readonly flexibility: Flexibility;
  readonly minimumAllowedAmount: Money | null;
}

export interface ExchangeRateRecord {
  readonly rateDate: EpochDay;
  readonly rate: ConversionRate;
}

export interface PaymentRequest {
  readonly requestId: string;
  readonly userId: string;
  readonly requestDate: EpochDay;
  readonly requestType: RequestType;
  readonly requestedAmount: Money;
  readonly desiredCompletionDate: EpochDay;
  readonly allowsPartialPayment: boolean;
  readonly requestText: string;
}

export interface SampleExpectedOutput {
  readonly amountSafeToPay: Money;
  readonly amountSafeToPayText: string;
  readonly affordabilityStatus: AffordabilityStatus;
  readonly recommendedPaymentMethod: PaymentMethod;
  readonly paymentPlanText: string;
  readonly earliestDateForFullPayment: EpochDay | null;
  readonly earliestDateForFullPaymentText: string;
  readonly spendingChangesNeededText: string;
  readonly decisionExplanation: string;
}

export interface SampleRequest extends PaymentRequest {
  readonly expected: SampleExpectedOutput;
}

export interface PaymentOption {
  readonly paymentOptionId: string;
  readonly requestId: string;
  readonly paymentMethod: OptionPaymentMethod;
  readonly paymentAmount: Money;
  readonly numberOfPayments: number;
  readonly firstPaymentDate: EpochDay;
  readonly paymentFrequencyDays: number | null;
  readonly financingFee: Money;
  readonly totalPayableAmount: Money;
}

export interface Message {
  readonly messageId: string;
  readonly userId: string;
  readonly requestId: string | null;
  readonly relatedEventId: string | null;
  readonly sentAt: string;
  readonly sentOn: EpochDay;
  readonly sourceType: MessageSourceType;
  readonly messageText: string;
}

export interface ImageRecord {
  readonly imageId: string;
  readonly userId: string;
  readonly requestId: string | null;
  readonly relatedEventId: string | null;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly exists: boolean;
}

export interface UserFinancialState {
  readonly userId: string;
  readonly profile: FinancialProfile;
  readonly events: readonly FinancialEvent[];
  readonly eventsById: ReadonlyMap<string, FinancialEvent>;
  readonly eventsWithMissingAmount: readonly FinancialEvent[];
  readonly requests: readonly PaymentRequest[];
  readonly paymentOptionsByRequestId: ReadonlyMap<string, readonly PaymentOption[]>;
  readonly messages: readonly Message[];
  readonly messagesByEventId: ReadonlyMap<string, readonly Message[]>;
  readonly images: readonly ImageRecord[];
  readonly imagesByEventId: ReadonlyMap<string, readonly ImageRecord[]>;
  readonly exchangeRates: readonly ExchangeRateRecord[];
  readonly foreignCurrencies: readonly CurrencyCode[];
}

export interface RequestContext {
  readonly request: PaymentRequest;
  readonly profile: FinancialProfile;
  readonly state: UserFinancialState;
  readonly events: readonly FinancialEvent[];
  readonly eventsWithMissingAmount: readonly FinancialEvent[];
  readonly paymentOptions: readonly PaymentOption[];
  readonly messages: readonly Message[];
  readonly images: readonly ImageRecord[];
  readonly exchangeRates: readonly ExchangeRateRecord[];
}
