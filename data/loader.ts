import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import type { ZodType } from 'zod';
import { parseMoney, parseOptionalMoney, parseRate } from '../util/money.js';
import type { CurrencyCode } from '../util/money.js';
import { parseDate, parseDateFromTimestamp, parseOptionalDate } from '../util/dates.js';
import {
  AFFORDABILITY_STATUSES,
  PAYMENT_METHODS,
  exchangeRateRowSchema,
  financialEventRowSchema,
  financialProfileRowSchema,
  imageRowSchema,
  messageRowSchema,
  paymentOptionRowSchema,
  requestRowSchema,
  sampleRequestRowSchema,
} from './types.js';
import type {
  AffordabilityStatus,
  ExchangeRateRecord,
  FinancialEvent,
  FinancialProfile,
  ImageRecord,
  Message,
  PaymentMethod,
  PaymentOption,
  PaymentRequest,
  SampleRequest,
} from './types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(MODULE_DIR, '..', '..');

export const DATASET_DIR = process.env['DATASET_DIR']
  ? resolve(process.env['DATASET_DIR'])
  : join(REPO_ROOT, 'dataset');

export const IMAGES_DIR = join(DATASET_DIR, 'media', 'images');

export const DATASET_FILES = {
  requests: 'requests.csv',
  sampleRequests: 'sample_requests.csv',
  financialProfiles: 'financial_profiles.csv',
  financialEvents: 'financial_events.csv',
  exchangeRates: 'exchange_rates.csv',
  requestPaymentOptions: 'request_payment_options.csv',
  messages: 'messages.csv',
  images: 'images.csv',
  outputTemplate: 'output.csv',
} as const;

export class DatasetError extends Error {}

function readCsvRecords(fileName: string): Record<string, string>[] {
  const path = join(DATASET_DIR, fileName);
  if (!existsSync(path)) {
    throw new DatasetError(`dataset file not found: ${path}`);
  }
  return parse(readFileSync(path), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: false,
  }) as Record<string, string>[];
}

function parseRows<T>(fileName: string, schema: ZodType<T>): T[] {
  const records = readCsvRecords(fileName);
  return records.map((record, index) => {
    const result = schema.safeParse(record);
    if (!result.success) {
      throw new DatasetError(
        `${fileName} row ${index + 2} failed validation: ${JSON.stringify(result.error.issues)}`,
      );
    }
    return result.data;
  });
}

function splitList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed
    .split('|')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseBoolean(value: string, context: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new DatasetError(`${context}: expected true or false, received "${value}"`);
}

function parseCount(value: string, context: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new DatasetError(`${context}: expected a non-negative integer, received "${value}"`);
  }
  return Number(trimmed);
}

function parseOptionalCount(value: string, context: string): number | null {
  return value.trim().length === 0 ? null : parseCount(value, context);
}

function parsePaymentMethods(value: string, context: string): PaymentMethod[] {
  return splitList(value).map((entry) => {
    if (!(PAYMENT_METHODS as readonly string[]).includes(entry)) {
      throw new DatasetError(`${context}: unknown payment method "${entry}"`);
    }
    return entry as PaymentMethod;
  });
}

function loadProfiles(): Map<string, FinancialProfile> {
  const rows = parseRows(DATASET_FILES.financialProfiles, financialProfileRowSchema);
  const profiles = new Map<string, FinancialProfile>();
  for (const row of rows) {
    const currency = row.home_currency;
    const profile: FinancialProfile = {
      userId: row.user_id,
      homeCurrency: currency,
      currentAvailableBalance: parseMoney(row.current_available_balance, currency),
      minimumBalanceToKeep: parseMoney(row.minimum_balance_to_keep, currency),
      financialPriorities: splitList(row.financial_priorities),
      expenseCategoriesToProtect: splitList(row.expense_categories_to_protect),
      expenseCategoriesUserIsWillingToReduce: splitList(
        row.expense_categories_user_is_willing_to_reduce,
      ),
      expenseCategoriesUserIsWillingToStop: splitList(row.expense_categories_user_is_willing_to_stop),
      paymentMethodsUserWillConsider: parsePaymentMethods(
        row.payment_methods_user_will_consider,
        `${DATASET_FILES.financialProfiles} ${row.user_id}`,
      ),
      maxInstallmentMonths: parseOptionalCount(
        row.max_installment_months,
        `${DATASET_FILES.financialProfiles} ${row.user_id} max_installment_months`,
      ),
    };
    if (profiles.has(profile.userId)) {
      throw new DatasetError(`duplicate profile for ${profile.userId}`);
    }
    profiles.set(profile.userId, profile);
  }
  return profiles;
}

function loadEvents(): FinancialEvent[] {
  const rows = parseRows(DATASET_FILES.financialEvents, financialEventRowSchema);
  return rows.map((row) => ({
    eventId: row.event_id,
    userId: row.user_id,
    eventType: row.event_type,
    description: row.description,
    category: row.category,
    direction: row.direction,
    amount: parseOptionalMoney(row.amount, row.currency),
    currency: row.currency,
    eventDate: parseDate(row.event_date),
    settlementDate: parseOptionalDate(row.settlement_date),
    status: row.status,
    linkedEventId: emptyToNull(row.linked_event_id),
    flexibility: row.flexibility,
    minimumAllowedAmount: parseOptionalMoney(row.minimum_allowed_amount, row.currency),
  }));
}

function loadExchangeRates(): ExchangeRateRecord[] {
  const rows = parseRows(DATASET_FILES.exchangeRates, exchangeRateRowSchema);
  return rows.map((row) => ({
    rateDate: parseDate(row.rate_date),
    rate: parseRate(row.rate, row.from_currency, row.to_currency),
  }));
}

function requireCurrency(
  profiles: ReadonlyMap<string, FinancialProfile>,
  userId: string,
  context: string,
): CurrencyCode {
  const profile = profiles.get(userId);
  if (profile === undefined) {
    throw new DatasetError(`${context}: no financial profile for ${userId}`);
  }
  return profile.homeCurrency;
}

function loadRequests(profiles: ReadonlyMap<string, FinancialProfile>): PaymentRequest[] {
  const rows = parseRows(DATASET_FILES.requests, requestRowSchema);
  return rows.map((row) => {
    const currency = requireCurrency(profiles, row.user_id, `${DATASET_FILES.requests} ${row.request_id}`);
    return {
      requestId: row.request_id,
      userId: row.user_id,
      requestDate: parseDate(row.request_date),
      requestType: row.request_type,
      requestedAmount: parseMoney(row.requested_amount, currency),
      desiredCompletionDate: parseDate(row.desired_completion_date),
      allowsPartialPayment: parseBoolean(
        row.allows_partial_payment,
        `${DATASET_FILES.requests} ${row.request_id}`,
      ),
      requestText: row.request_text,
    };
  });
}

function loadSampleRequests(profiles: ReadonlyMap<string, FinancialProfile>): SampleRequest[] {
  const rows = parseRows(DATASET_FILES.sampleRequests, sampleRequestRowSchema);
  return rows.map((row) => {
    const context = `${DATASET_FILES.sampleRequests} ${row.request_id}`;
    const currency = requireCurrency(profiles, row.user_id, context);
    const status: AffordabilityStatus = row.affordability_status;
    if (!(AFFORDABILITY_STATUSES as readonly string[]).includes(status)) {
      throw new DatasetError(`${context}: unknown affordability status "${status}"`);
    }
    return {
      requestId: row.request_id,
      userId: row.user_id,
      requestDate: parseDate(row.request_date),
      requestType: row.request_type,
      requestedAmount: parseMoney(row.requested_amount, currency),
      desiredCompletionDate: parseDate(row.desired_completion_date),
      allowsPartialPayment: parseBoolean(row.allows_partial_payment, context),
      requestText: row.request_text,
      expected: {
        amountSafeToPay: parseMoney(row.amount_safe_to_pay, currency),
        amountSafeToPayText: row.amount_safe_to_pay.trim(),
        affordabilityStatus: status,
        recommendedPaymentMethod: row.recommended_payment_method,
        paymentPlanText: row.payment_plan.trim(),
        earliestDateForFullPayment: parseOptionalDate(row.earliest_date_for_full_payment),
        earliestDateForFullPaymentText: row.earliest_date_for_full_payment.trim(),
        spendingChangesNeededText: row.spending_changes_needed.trim(),
        decisionExplanation: row.decision_explanation,
      },
    };
  });
}

function loadPaymentOptions(
  profiles: ReadonlyMap<string, FinancialProfile>,
  userIdByRequestId: ReadonlyMap<string, string>,
): PaymentOption[] {
  const rows = parseRows(DATASET_FILES.requestPaymentOptions, paymentOptionRowSchema);
  return rows.map((row) => {
    const context = `${DATASET_FILES.requestPaymentOptions} ${row.payment_option_id}`;
    const userId = userIdByRequestId.get(row.request_id);
    if (userId === undefined) {
      throw new DatasetError(`${context}: no request row for ${row.request_id}`);
    }
    const currency = requireCurrency(profiles, userId, context);
    return {
      paymentOptionId: row.payment_option_id,
      requestId: row.request_id,
      paymentMethod: row.payment_method,
      paymentAmount: parseMoney(row.payment_amount, currency),
      numberOfPayments: parseCount(row.number_of_payments, `${context} number_of_payments`),
      firstPaymentDate: parseDate(row.first_payment_date),
      paymentFrequencyDays: parseOptionalCount(
        row.payment_frequency_days,
        `${context} payment_frequency_days`,
      ),
      financingFee: parseMoney(row.financing_fee, currency),
      totalPayableAmount: parseMoney(row.total_payable_amount, currency),
    };
  });
}

function loadMessages(): Message[] {
  const rows = parseRows(DATASET_FILES.messages, messageRowSchema);
  return rows.map((row) => ({
    messageId: row.message_id,
    userId: row.user_id,
    requestId: emptyToNull(row.request_id),
    relatedEventId: emptyToNull(row.related_event_id),
    sentAt: row.sent_at.trim(),
    sentOn: parseDateFromTimestamp(row.sent_at),
    sourceType: row.source_type,
    messageText: row.message_text,
  }));
}

function loadImages(): ImageRecord[] {
  const rows = parseRows(DATASET_FILES.images, imageRowSchema);
  return rows.map((row) => {
    const relativePath = join('dataset', 'media', 'images', `${row.image_id}.png`);
    const absolutePath = join(IMAGES_DIR, `${row.image_id}.png`);
    return {
      imageId: row.image_id,
      userId: row.user_id,
      requestId: emptyToNull(row.request_id),
      relatedEventId: emptyToNull(row.related_event_id),
      relativePath,
      absolutePath,
      exists: existsSync(absolutePath),
    };
  });
}

function loadOutputColumns(): string[] {
  const path = join(DATASET_DIR, DATASET_FILES.outputTemplate);
  if (!existsSync(path)) {
    throw new DatasetError(`dataset file not found: ${path}`);
  }
  const header = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] ?? '';
  return header
    .replace(/^﻿/, '')
    .split(',')
    .map((column) => column.trim());
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const existing = groups.get(groupKey);
    if (existing === undefined) {
      groups.set(groupKey, [item]);
    } else {
      existing.push(item);
    }
  }
  return groups;
}

export interface Dataset {
  readonly profilesByUserId: ReadonlyMap<string, FinancialProfile>;
  readonly requests: readonly PaymentRequest[];
  readonly requestsById: ReadonlyMap<string, PaymentRequest>;
  readonly requestsByUserId: ReadonlyMap<string, readonly PaymentRequest[]>;
  readonly sampleRequests: readonly SampleRequest[];
  readonly sampleRequestsById: ReadonlyMap<string, SampleRequest>;
  readonly events: readonly FinancialEvent[];
  readonly eventsById: ReadonlyMap<string, FinancialEvent>;
  readonly eventsByUserId: ReadonlyMap<string, readonly FinancialEvent[]>;
  readonly exchangeRates: readonly ExchangeRateRecord[];
  readonly paymentOptions: readonly PaymentOption[];
  readonly paymentOptionsByRequestId: ReadonlyMap<string, readonly PaymentOption[]>;
  readonly messages: readonly Message[];
  readonly messagesByUserId: ReadonlyMap<string, readonly Message[]>;
  readonly images: readonly ImageRecord[];
  readonly imagesByUserId: ReadonlyMap<string, readonly ImageRecord[]>;
  readonly outputColumns: readonly string[];
}

export function loadDataset(): Dataset {
  const profilesByUserId = loadProfiles();
  const requests = loadRequests(profilesByUserId);
  const sampleRequests = loadSampleRequests(profilesByUserId);

  const userIdByRequestId = new Map<string, string>();
  for (const request of [...requests, ...sampleRequests]) {
    if (userIdByRequestId.has(request.requestId)) {
      throw new DatasetError(`duplicate request id ${request.requestId}`);
    }
    userIdByRequestId.set(request.requestId, request.userId);
  }

  const events = loadEvents();
  const paymentOptions = loadPaymentOptions(profilesByUserId, userIdByRequestId);
  const messages = loadMessages();
  const images = loadImages();

  const eventsById = new Map<string, FinancialEvent>();
  for (const event of events) {
    if (eventsById.has(event.eventId)) {
      throw new DatasetError(`duplicate event id ${event.eventId}`);
    }
    eventsById.set(event.eventId, event);
  }

  const sortedEvents = (items: FinancialEvent[]): FinancialEvent[] =>
    [...items].sort(
      (left, right) =>
        left.eventDate - right.eventDate || left.eventId.localeCompare(right.eventId),
    );

  const eventsByUserId = new Map<string, FinancialEvent[]>();
  for (const [userId, userEvents] of groupBy(events, (event) => event.userId)) {
    eventsByUserId.set(userId, sortedEvents(userEvents));
  }

  return {
    profilesByUserId,
    requests,
    requestsById: new Map(requests.map((request) => [request.requestId, request])),
    requestsByUserId: groupBy(requests, (request) => request.userId),
    sampleRequests,
    sampleRequestsById: new Map(sampleRequests.map((request) => [request.requestId, request])),
    events,
    eventsById,
    eventsByUserId,
    exchangeRates: loadExchangeRates(),
    paymentOptions,
    paymentOptionsByRequestId: groupBy(paymentOptions, (option) => option.requestId),
    messages,
    messagesByUserId: groupBy(messages, (message) => message.userId),
    images,
    imagesByUserId: groupBy(images, (image) => image.userId),
    outputColumns: loadOutputColumns(),
  };
}
