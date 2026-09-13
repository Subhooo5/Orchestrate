import { DATASET_DIR, loadDataset } from './data/loader.js';
import type { Dataset } from './data/loader.js';
import { buildRequestContext, findRequest } from './data/joins.js';
import type {
  FinancialEvent,
  PaymentRequest,
  RequestContext,
  SampleRequest,
  UserFinancialState,
} from './data/types.js';
import { OUTPUT_COLUMNS } from './data/types.js';
import {
  ROUNDING_RULE,
  conversionIsExact,
  describeMoney,
  formatMinimalAmount,
  formatPlanAmount,
  multiplyMoneyByCount,
  compareMoney,
  money,
  parseMoney,
} from './util/money.js';
import { buildExchangeRateIndex, requireRate } from './finance/currency.js';
import { reconstructState } from './finance/state.js';
import type { ReconstructedState } from './finance/state.js';

import { describeCadence, projectSeries } from './finance/recurrence.js';
import type { RecurringSeries } from './finance/recurrence.js';
import { isCashEvent, ledgerDate } from './finance/inclusion.js';
import {
  decide,
  formatAmountSafeToPay,
  formatEarliestDate,
  formatPaymentPlan,
  formatSpendingChanges,
} from './finance/engine.js';
import {
  FORECAST_WINDOW_DAYS,
  INTRA_DAY_DEBITS_FIRST,
  WINDOW_INCLUDES_REQUEST_DATE,
  buildForwardLedger,
  evaluateSafety,
} from './finance/ledger.js';
import {
  PROJECTION_VARIANTS,
  describeSeriesStats,
  probeTrough,
} from './finance/diagnostic.js';
import {
  combine,
  evidenceEnabled,
  extractFromImage,
  extractFromMessages,
  recordedUsage,
  scopeEventsForPrompt,
} from './evidence/extractor.js';
import type { Evidence } from './evidence/schema.js';
import { EMPTY_EVIDENCE } from './evidence/schema.js';
import {
  applyIncomeSignals,
  applyResolvedEvidence,
  resolveEvidence,
} from './evidence/resolve.js';
import { assertAllExtractionsRan, requireEvidenceOrFail } from './evidence/extractor.js';
import type { RunMode } from './evidence/extractor.js';
import { buildExplanation } from './output/explain.js';
import { validateOutputFile, validateRow } from './output/validate.js';
import type { OutputRow, Violation } from './output/validate.js';
import { writeOutput } from './output/writer.js';
import { billableRecords, writeUsageReport } from './output/usage.js';

import { buildUserFinancialState } from './data/joins.js';
import { addDays, formatDate, formatOptionalDate } from './util/dates.js';
import type { EpochDay } from './util/dates.js';

const DEFAULT_REQUEST_ID = 'request_19';
const SERIES_PREVIEW_LIMIT = 14;
const BUCKET_PREVIEW_LIMIT = 8;
const BACKTEST_TRAIN_FRACTION = 0.65;
const BACKTEST_MATCH_TOLERANCE_DAYS = 3;
const EVENT_PREVIEW_LIMIT = 12;
const MESSAGE_PREVIEW_LIMIT = 4;
const TEXT_PREVIEW_LIMIT = 160;

let verboseOutput = false;

export function setVerboseOutput(enabled: boolean): void {
  verboseOutput = enabled;
}

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function detail(text = ''): void {
  if (verboseOutput) {
    line(text);
  }
}

function heading(title: string): void {
  line();
  line(title);
  line('-'.repeat(title.length));
}

function detailHeading(title: string): void {
  if (verboseOutput) {
    heading(title);
  }
}

function truncate(text: string, limit = TEXT_PREVIEW_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function tally<T>(items: readonly T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = key(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => `${name}=${count}`)
    .join(' ');
}

function describeEvent(event: FinancialEvent): string {
  const amount = event.amount === null ? '<missing>' : describeMoney(event.amount);
  const settlement = formatOptionalDate(event.settlementDate);
  const minimum =
    event.minimumAllowedAmount === null ? '' : ` min=${describeMoney(event.minimumAllowedAmount)}`;
  const linked = event.linkedEventId === null ? '' : ` linked=${event.linkedEventId}`;
  return [
    event.eventId.padEnd(12),
    formatDate(event.eventDate),
    `settles=${settlement.padEnd(10)}`,
    event.status.padEnd(10),
    event.direction.padEnd(8),
    event.eventType.padEnd(19),
    event.category.padEnd(16),
    event.flexibility.padEnd(21),
    amount.padStart(16),
    `${minimum}${linked}`,
    `| ${event.description}`,
  ].join(' ');
}

function reportDatasetSummary(dataset: Dataset): void {
  heading('Dataset');
  line(`directory                 ${DATASET_DIR}`);
  line(`financial_profiles        ${dataset.profilesByUserId.size}`);
  line(`requests                  ${dataset.requests.length}`);
  line(`sample_requests           ${dataset.sampleRequests.length}`);
  line(`financial_events          ${dataset.events.length}`);
  line(`exchange_rates            ${dataset.exchangeRates.length}`);
  line(`request_payment_options   ${dataset.paymentOptions.length}`);
  line(`messages                  ${dataset.messages.length}`);
  line(`images                    ${dataset.images.length}`);
  line(`output template columns   ${dataset.outputColumns.join(',')}`);

  const missingImages = dataset.images.filter((image) => !image.exists);
  const blankAmounts = dataset.events.filter((event) => event.amount === null);
  line(`events with blank amount  ${blankAmounts.length}`);
  line(`image files missing       ${missingImages.length}`);
}

function reportOutputContract(dataset: Dataset): void {
  heading('Output contract');
  const expected = OUTPUT_COLUMNS.join(',');
  const actual = dataset.outputColumns.join(',');
  line(`template matches OUTPUT_COLUMNS   ${expected === actual ? 'yes' : `no (${actual})`}`);
}

interface Check {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
}

function runCheck(name: string, expected: string, actual: string): Check {
  return { name, expected, actual };
}

function paymentPlanAmountTexts(planText: string): string[] {
  if (planText.length === 0 || planText === 'none') {
    return [];
  }
  return planText.split('|').map((entry) => {
    const separator = entry.indexOf(':');
    if (separator === -1) {
      throw new Error(`malformed payment plan entry: "${entry}"`);
    }
    return entry.slice(separator + 1).trim();
  });
}

function reduceToAmountTexts(changesText: string): string[] {
  if (changesText.length === 0 || changesText === 'none') {
    return [];
  }
  const amounts: string[] = [];
  for (const entry of changesText.split('|')) {
    const parts = entry.split(':');
    if (parts[0] === 'reduce_to' && parts.length === 3) {
      amounts.push((parts[2] ?? '').trim());
    }
  }
  return amounts;
}

interface ForeignConversion {
  readonly eventId: string;
  readonly exact: boolean;
}

function foreignConversions(dataset: Dataset): ForeignConversion[] {
  const index = buildExchangeRateIndex(dataset.exchangeRates);
  const conversions: ForeignConversion[] = [];
  for (const event of dataset.events) {
    const profile = dataset.profilesByUserId.get(event.userId);
    if (profile === undefined || event.amount === null) {
      continue;
    }
    if (event.currency === profile.homeCurrency) {
      continue;
    }
    const rate = requireRate(
      index,
      event.settlementDate ?? event.eventDate,
      event.currency,
      profile.homeCurrency,
      event.eventId,
    );
    conversions.push({ eventId: event.eventId, exact: conversionIsExact(event.amount, rate) });
  }
  return conversions;
}

function reportRoundingRule(dataset: Dataset): void {
  heading('Money rounding rule');
  line(`rule                      ${ROUNDING_RULE}`);
  line('representation            integer minor units (x100), bigint, exact for every dataset value');

  const checks: Check[] = [];

  for (const sample of dataset.sampleRequests) {
    checks.push(
      runCheck(
        `${sample.requestId} amount_safe_to_pay minimal`,
        sample.expected.amountSafeToPayText,
        formatMinimalAmount(sample.expected.amountSafeToPay),
      ),
    );
  }

  let planAmountCount = 0;
  let changeAmountCount = 0;
  for (const sample of dataset.sampleRequests) {
    const profile = dataset.profilesByUserId.get(sample.userId);
    if (profile === undefined) {
      continue;
    }
    for (const amountText of paymentPlanAmountTexts(sample.expected.paymentPlanText)) {
      planAmountCount += 1;
      checks.push(
        runCheck(
          `${sample.requestId} payment_plan amount ${amountText}`,
          amountText,
          formatPlanAmount(parseMoney(amountText, profile.homeCurrency)),
        ),
      );
    }
    for (const amountText of reduceToAmountTexts(sample.expected.spendingChangesNeededText)) {
      changeAmountCount += 1;
      checks.push(
        runCheck(
          `${sample.requestId} reduce_to amount ${amountText}`,
          amountText,
          formatPlanAmount(parseMoney(amountText, profile.homeCurrency)),
        ),
      );
    }
  }
  line(`payment_plan amounts round-tripped   ${planAmountCount}`);
  line(`reduce_to amounts round-tripped      ${changeAmountCount}`);

  const conversions = foreignConversions(dataset);
  const inexact = conversions.filter((conversion) => !conversion.exact);
  checks.push(
    runCheck('foreign conversions requiring rounding', '0', String(inexact.length)),
  );
  line(`foreign events converted             ${conversions.length}`);

  let optionMismatches = 0;
  for (const option of dataset.paymentOptions) {
    if (option.paymentMethod !== 'installments') {
      continue;
    }
    const total = multiplyMoneyByCount(option.paymentAmount, option.numberOfPayments);
    if (compareMoney(total, option.totalPayableAmount) !== 0) {
      optionMismatches += 1;
    }
  }
  checks.push(
    runCheck('installment payment_amount x n == total_payable', '0', String(optionMismatches)),
  );

  const failures = checks.filter((check) => check.expected !== check.actual);
  line(`checks passed             ${checks.length - failures.length}/${checks.length}`);
  for (const failure of failures) {
    line(`  FAIL ${failure.name}: expected "${failure.expected}" got "${failure.actual}"`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

function reportUserFinancialState(state: UserFinancialState): void {
  const { profile } = state;
  heading(`UserFinancialState ${state.userId}`);
  line(`home_currency                          ${profile.homeCurrency}`);
  line(`current_available_balance              ${describeMoney(profile.currentAvailableBalance)}`);
  line(`minimum_balance_to_keep                ${describeMoney(profile.minimumBalanceToKeep)}`);
  line(`financial_priorities                   ${profile.financialPriorities.join('|') || '(none)'}`);
  line(`expense_categories_to_protect          ${profile.expenseCategoriesToProtect.join('|') || '(none)'}`);
  line(`categories willing to reduce           ${profile.expenseCategoriesUserIsWillingToReduce.join('|') || '(none)'}`);
  line(`categories willing to stop             ${profile.expenseCategoriesUserIsWillingToStop.join('|') || '(none)'}`);
  line(`payment_methods_user_will_consider     ${profile.paymentMethodsUserWillConsider.join('|') || '(none)'}`);
  line(`max_installment_months                 ${profile.maxInstallmentMonths ?? '(none)'}`);

  line();
  line(`events                                 ${state.events.length}`);
  if (state.events.length > 0) {
    const first = state.events[0];
    const last = state.events[state.events.length - 1];
    if (first !== undefined && last !== undefined) {
      line(`event date range                       ${formatDate(first.eventDate)} .. ${formatDate(last.eventDate)}`);
    }
  }
  line(`  by status                            ${tally(state.events, (event) => event.status)}`);
  line(`  by direction                         ${tally(state.events, (event) => event.direction)}`);
  line(`  by event_type                        ${tally(state.events, (event) => event.eventType)}`);
  line(`  by flexibility                       ${tally(state.events, (event) => event.flexibility)}`);
  line(`foreign currencies                     ${state.foreignCurrencies.join('|') || '(none)'}`);
  line(`scoped exchange rates                  ${state.exchangeRates.length}`);
  line(`messages                               ${state.messages.length}`);
  line(`images                                 ${state.images.length}`);
  line(`events with blank amount               ${state.eventsWithMissingAmount.length}`);

  for (const event of state.eventsWithMissingAmount) {
    const linkedImages = state.imagesByEventId.get(event.eventId) ?? [];
    const evidence = linkedImages.map((image) => image.relativePath).join(', ') || '(no image)';
    line(`  ${event.eventId} ${formatDate(event.eventDate)} ${event.category} -> ${evidence}`);
  }

  const preview = state.events.slice(-EVENT_PREVIEW_LIMIT);
  line();
  line(`last ${preview.length} events (raw, unclassified)`);
  for (const event of preview) {
    line(`  ${describeEvent(event)}`);
  }
}

function reportRequestContext(context: RequestContext, sample: SampleRequest | undefined): void {
  const { request } = context;
  heading(`RequestContext ${request.requestId}`);
  line(`user_id                                ${request.userId}`);
  line(`request_date                           ${formatDate(request.requestDate)}`);
  line(`request_type                           ${request.requestType}`);
  line(`requested_amount                       ${describeMoney(request.requestedAmount)}`);
  line(`desired_completion_date                ${formatDate(request.desiredCompletionDate)}`);
  line(`allows_partial_payment                 ${request.allowsPartialPayment}`);
  line(`request_text                           ${truncate(request.requestText)}`);

  line();
  line(`payment options                        ${context.paymentOptions.length}`);
  for (const option of context.paymentOptions) {
    const frequency = option.paymentFrequencyDays === null ? '-' : `${option.paymentFrequencyDays}d`;
    line(
      `  ${option.paymentOptionId.padEnd(18)} ${option.paymentMethod.padEnd(13)} ` +
        `${formatPlanAmount(option.paymentAmount).padStart(14)} x${String(option.numberOfPayments).padStart(3)} ` +
        `from ${formatDate(option.firstPaymentDate)} every ${frequency.padStart(4)} ` +
        `fee=${formatPlanAmount(option.financingFee).padStart(12)} total=${formatPlanAmount(option.totalPayableAmount).padStart(14)}`,
    );
  }

  line();
  line(`relevant messages                      ${context.messages.length}`);
  for (const message of context.messages.slice(0, MESSAGE_PREVIEW_LIMIT)) {
    const scope = message.requestId ?? 'user-level';
    const event = message.relatedEventId ?? '-';
    line(`  ${message.messageId} ${message.sentAt} ${message.sourceType} scope=${scope} event=${event}`);
    line(`    ${truncate(message.messageText)}`);
  }
  if (context.messages.length > MESSAGE_PREVIEW_LIMIT) {
    line(`  ... ${context.messages.length - MESSAGE_PREVIEW_LIMIT} more`);
  }

  line();
  line(`relevant images                        ${context.images.length}`);
  for (const image of context.images) {
    line(
      `  ${image.imageId} event=${image.relatedEventId ?? '-'} ${image.relativePath} exists=${image.exists}`,
    );
  }

  if (sample !== undefined) {
    line();
    line('published expected output (sample_requests.csv)');
    line(`  amount_safe_to_pay                   ${sample.expected.amountSafeToPayText}`);
    line(`  affordability_status                 ${sample.expected.affordabilityStatus}`);
    line(`  recommended_payment_method           ${sample.expected.recommendedPaymentMethod}`);
    line(`  payment_plan                         ${sample.expected.paymentPlanText}`);
    line(`  earliest_date_for_full_payment       ${sample.expected.earliestDateForFullPaymentText || '(empty)'}`);
    line(`  spending_changes_needed              ${sample.expected.spendingChangesNeededText}`);
    line(`  decision_explanation                 ${truncate(sample.expected.decisionExplanation)}`);
  }
}

function describeSeries(series: RecurringSeries): string {
  const amount = series.lastKnownAmount === null ? '<pending>' : describeMoney(series.lastKnownAmount);
  const minimum =
    series.minimumAllowedAmount === null ? '' : ` min=${describeMoney(series.minimumAllowedAmount)}`;
  return [
    series.category.padEnd(18),
    series.direction.padEnd(7),
    describeCadence(series.cadence).padEnd(22),
    `n=${String(series.occurrences.length).padStart(3)}`,
    `${formatDate(series.firstDate)}..${formatDate(series.lastDate)}`,
    amount.padStart(18),
    series.flexibility.padEnd(21),
    minimum,
  ].join(' ');
}

function reportReconstructedState(reconstructed: ReconstructedState): void {
  heading(`ReconstructedState ${reconstructed.userId}`);
  line(`home_currency                  ${reconstructed.homeCurrency}`);
  line(`recurring income series        ${reconstructed.recurringIncome.length}`);
  line(`recurring expense series       ${reconstructed.recurringExpenses.length}`);
  line(`confirmed future events        ${reconstructed.confirmedFutureEvents.length}`);
  line(`one-time events                ${reconstructed.oneTimeEvents.length}`);
  line(`excluded events                ${reconstructed.excludedEvents.length}`);
  line(`amount pending evidence        ${reconstructed.amountPendingEvidence.length}`);
  line(`reserved pending events        ${reconstructed.reservedPendingEvents.length}`);
  line(`linked lifecycle pairs         ${reconstructed.linkedPairs.length}`);
  line(`duplicates excluded            ${reconstructed.linkedPairs.filter((pair) => pair.duplicateOfParent).length}`);

  line();
  line('recurring income');
  for (const series of reconstructed.recurringIncome) {
    line(`  ${describeSeries(series)}`);
  }
  line();
  line('recurring expenses');
  for (const series of reconstructed.recurringExpenses.slice(0, SERIES_PREVIEW_LIMIT)) {
    line(`  ${describeSeries(series)}`);
  }
  if (reconstructed.recurringExpenses.length > SERIES_PREVIEW_LIMIT) {
    line(`  ... ${reconstructed.recurringExpenses.length - SERIES_PREVIEW_LIMIT} more`);
  }

  line();
  line('confirmed future events (all scheduled rows)');
  for (const entry of reconstructed.confirmedFutureEvents) {
    const amount = entry.amount === null ? '<pending>' : describeMoney(entry.amount);
    line(
      `  ${entry.event.eventId.padEnd(12)} ${formatDate(entry.date)} ${entry.event.direction.padEnd(7)} ` +
        `${entry.event.category.padEnd(16)} ${amount.padStart(18)} | ${entry.event.description}`,
    );
  }

  line();
  line('one-time events (off-cadence or unique)');
  for (const entry of reconstructed.oneTimeEvents.slice(0, BUCKET_PREVIEW_LIMIT)) {
    const amount = entry.amount === null ? '<pending>' : describeMoney(entry.amount);
    line(
      `  ${entry.event.eventId.padEnd(12)} ${formatDate(entry.date)} ${entry.event.category.padEnd(16)} ` +
        `${amount.padStart(18)} | ${entry.event.description}`,
    );
  }
  if (reconstructed.oneTimeEvents.length > BUCKET_PREVIEW_LIMIT) {
    line(`  ... ${reconstructed.oneTimeEvents.length - BUCKET_PREVIEW_LIMIT} more`);
  }

  if (reconstructed.amountPendingEvidence.length > 0) {
    line();
    line('amount pending evidence (never treated as zero)');
    for (const entry of reconstructed.amountPendingEvidence) {
      line(
        `  ${entry.event.eventId.padEnd(12)} ${formatDate(entry.date)} ${entry.event.category.padEnd(16)} | ${entry.event.description}`,
      );
    }
  }

  if (reconstructed.linkedPairs.length > 0) {
    line();
    line('linked lifecycle pairs');
    for (const pair of reconstructed.linkedPairs) {
      line(
        `  ${pair.parentId.padEnd(12)} -> ${pair.childId.padEnd(12)} ${pair.pattern.padEnd(28)} ` +
          `parent_in=${String(pair.parentIncluded).padEnd(5)} child_in=${String(pair.childIncluded).padEnd(5)} ` +
          `both=${pair.bothIncluded}`,
      );
    }
  }

  for (const pair of reconstructed.linkedPairs) {
    if (pair.duplicateOfParent) {
      line(`  DUPLICATE ${pair.childId} repeats parent ${pair.parentId}; excluded from the ledger`);
    }
  }
}

interface BacktestResult {
  readonly userId: string;
  readonly cutoff: EpochDay;
  readonly horizon: EpochDay;
  readonly trainedSeries: number;
  readonly projected: number;
  readonly matched: number;
  readonly missed: number;
  readonly missedBeyondHistory: number;
  readonly missedWithinHistory: number;
  readonly unexplained: number;
  readonly rows: readonly string[];
}

function backtestProjector(dataset: Dataset, userId: string): BacktestResult | null {
  const full = buildUserFinancialState(dataset, userId);
  const cashEvents = full.events.filter(isCashEvent);
  if (cashEvents.length < 8) {
    return null;
  }
  const dates = cashEvents.map(ledgerDate).sort((left, right) => left - right);
  const splitIndex = Math.floor(dates.length * BACKTEST_TRAIN_FRACTION);
  const cutoff = dates[splitIndex] ?? dates[dates.length - 1] ?? 0;
  const horizon = dates[dates.length - 1] ?? cutoff;
  if (horizon <= cutoff) {
    return null;
  }

  const trainEvents = full.events.filter((event) => ledgerDate(event) <= cutoff);
  const trainState = {
    ...full,
    events: trainEvents,
    eventsById: new Map(trainEvents.map((event) => [event.eventId, event])),
    eventsWithMissingAmount: trainEvents.filter((event) => event.amount === null),
  };
  const trained = reconstructState(trainState, dataset.exchangeRates);
  const series = [...trained.recurringIncome, ...trained.recurringExpenses];

  const actual = cashEvents
    .filter((event) => ledgerDate(event) > cutoff)
    .map((event) => ({ event, date: ledgerDate(event), used: false }));

  const lastRecorded = new Map<string, EpochDay>();
  for (const event of cashEvents) {
    const key = `${event.category}|${event.direction}`;
    const date = ledgerDate(event);
    const current = lastRecorded.get(key);
    if (current === undefined || date > current) {
      lastRecorded.set(key, date);
    }
  }

  let projectedCount = 0;
  let matched = 0;
  let missed = 0;
  let missedBeyondHistory = 0;
  let missedWithinHistory = 0;
  const rows: string[] = [];

  for (const entry of series) {
    const projections = projectSeries(entry, addDays(cutoff, 1), horizon);
    projectedCount += projections.length;
    let seriesMatched = 0;
    for (const projection of projections) {
      const candidate = actual
        .filter(
          (item) =>
            !item.used &&
            item.event.category === projection.category &&
            item.event.direction === projection.direction &&
            Math.abs(item.date - projection.date) <= BACKTEST_MATCH_TOLERANCE_DAYS,
        )
        .sort(
          (left, right) =>
            Math.abs(left.date - projection.date) - Math.abs(right.date - projection.date),
        )[0];
      if (candidate === undefined) {
        missed += 1;
        const recorded = lastRecorded.get(`${entry.category}|${entry.direction}`);
        if (recorded === undefined || projection.date > recorded) {
          missedBeyondHistory += 1;
        } else {
          missedWithinHistory += 1;
        }
      } else {
        candidate.used = true;
        matched += 1;
        seriesMatched += 1;
      }
    }
    if (projections.length > 0) {
      const first = projections[0];
      const firstText = first === undefined ? '-' : formatDate(first.date);
      rows.push(
        `  ${entry.category.padEnd(18)} ${entry.direction.padEnd(7)} ` +
          `${describeCadence(entry.cadence).padEnd(22)} projected=${String(projections.length).padStart(3)} ` +
          `matched=${String(seriesMatched).padStart(3)} first=${firstText}`,
      );
    }
  }

  return {
    userId,
    cutoff,
    horizon,
    trainedSeries: series.length,
    projected: projectedCount,
    matched,
    missed,
    missedBeyondHistory,
    missedWithinHistory,
    unexplained: actual.filter((item) => !item.used).length,
    rows,
  };
}

function reportBacktest(dataset: Dataset, userId: string): void {
  const result = backtestProjector(dataset, userId);
  heading(`Projector backtest ${userId}`);
  if (result === null) {
    line('not enough cash events to backtest');
    return;
  }
  const rate = result.projected === 0 ? 0 : Math.round((result.matched / result.projected) * 1000) / 10;
  line(`train window ends              ${formatDate(result.cutoff)}`);
  line(`holdout horizon                ${formatDate(result.horizon)}`);
  line(`series trained on history      ${result.trainedSeries}`);
  line(`occurrences projected          ${result.projected}`);
  line(`matched real later events      ${result.matched} (${rate}%)`);
  line(`projected past recorded end    ${result.missedBeyondHistory}`);
  line(`mismatched within history      ${result.missedWithinHistory}`);
  line(`real events not projected      ${result.unexplained}`);
  line();
  for (const row of result.rows) {
    line(row);
  }
}

function reportSpendingChangeGrounding(dataset: Dataset): void {
  heading('Spending-change grounding against sample ground truth');
  const checks: Check[] = [];
  let examined = 0;
  for (const sample of dataset.sampleRequests) {
    const text = sample.expected.spendingChangesNeededText;
    if (text.length === 0 || text === 'none') {
      continue;
    }
    const full = buildUserFinancialState(dataset, sample.userId);
    const history = full.events.filter((event) => ledgerDate(event) <= sample.requestDate);
    const reconstructed = reconstructState(
      {
        ...full,
        events: history,
        eventsById: new Map(history.map((event) => [event.eventId, event])),
        eventsWithMissingAmount: history.filter((event) => event.amount === null),
      },
      dataset.exchangeRates,
    );
    const series = [...reconstructed.recurringIncome, ...reconstructed.recurringExpenses];
    for (const entry of text.split('|')) {
      const parts = entry.split(':');
      const kind = parts[0] ?? '';
      const eventId = parts[1] ?? '';
      examined += 1;
      const owner = series.find((candidate) =>
        candidate.occurrences.some((occurrence) => occurrence.eventId === eventId),
      );
      checks.push(
        runCheck(`${sample.requestId} ${eventId} is in a recurring series`, 'yes', owner === undefined ? 'no' : 'yes'),
      );
      if (owner === undefined) {
        continue;
      }
      const last = owner.occurrences[owner.occurrences.length - 1];
      checks.push(
        runCheck(
          `${sample.requestId} ${eventId} is the latest occurrence`,
          'yes',
          last !== undefined && last.eventId === eventId ? 'yes' : 'no',
        ),
      );
      const allowsStop = owner.flexibility === 'stoppable' || owner.flexibility === 'reducible_or_stoppable';
      const allowsReduce = owner.flexibility === 'reducible' || owner.flexibility === 'reducible_or_stoppable';
      if (kind === 'stop') {
        checks.push(runCheck(`${sample.requestId} ${eventId} permits stop`, 'yes', allowsStop ? 'yes' : 'no'));
      }
      if (kind === 'reduce_to') {
        checks.push(runCheck(`${sample.requestId} ${eventId} permits reduce`, 'yes', allowsReduce ? 'yes' : 'no'));
        const expectedFloor = parts[2] ?? '';
        const actualFloor =
          owner.minimumAllowedAmount === null ? '' : formatPlanAmount(owner.minimumAllowedAmount);
        checks.push(
          runCheck(`${sample.requestId} ${eventId} floor equals minimum_allowed_amount`, expectedFloor, actualFloor),
        );
      }
      line(
        `  ${sample.requestId} ${kind.padEnd(9)} ${eventId.padEnd(12)} -> ${owner.category.padEnd(14)} ` +
          `${describeCadence(owner.cadence).padEnd(22)} n=${String(owner.occurrences.length).padStart(2)} ${owner.flexibility}`,
      );
    }
  }
  const failures = checks.filter((check) => check.expected !== check.actual);
  line();
  line(`spending changes examined      ${examined}`);
  line(`checks passed                  ${checks.length - failures.length}/${checks.length}`);
  for (const failure of failures) {
    line(`  FAIL ${failure.name}: expected "${failure.expected}" got "${failure.actual}"`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

function evidenceFreeSamples(dataset: Dataset): SampleRequest[] {
  const withMessages = new Set(dataset.messages.map((message) => message.userId));
  const withImages = new Set(dataset.images.map((image) => image.userId));
  return dataset.sampleRequests.filter(
    (sample) => !withMessages.has(sample.userId) && !withImages.has(sample.userId),
  );
}

function reportProjectionDiagnostic(dataset: Dataset): void {
  const samples = evidenceFreeSamples(dataset);
  heading(`Projection diagnostic (${samples.length} evidence-free samples)`);
  line('implied ground-truth trough = minimum_balance_to_keep + expected amount_safe_to_pay');
  line('a sample whose expected amount equals requested_amount is capped, so its trough is a lower bound');
  line();

  const rows: { sample: SampleRequest; implied: bigint; capped: boolean }[] = [];
  for (const sample of samples) {
    const context = buildRequestContext(dataset, sample);
    const state = reconstructState(context.state, dataset.exchangeRates);
    const implied =
      state.profile.minimumBalanceToKeep.minor + sample.expected.amountSafeToPay.minor;
    const capped = compareMoney(sample.expected.amountSafeToPay, sample.requestedAmount) === 0;
    rows.push({ sample, implied, capped });
    const sources = buildForwardLedger(state, sample.requestDate);
    const actual = evaluateSafety(state, sample.requestDate, sources, [], []);
    const gap = actual.trough.minor - implied;
    line(
      `${sample.requestId} ${sample.userId.padEnd(9)} ${state.homeCurrency} ` +
        `implied=${formatMinimalAmount(money(implied, state.homeCurrency)).padStart(16)}${capped ? ' (cap)' : '     '} ` +
        `engine=${formatMinimalAmount(actual.trough).padStart(16)} on ${formatDate(actual.troughDate)} ` +
        `gap=${formatMinimalAmount(money(gap, state.homeCurrency)).padStart(16)}`,
    );
  }

  line();
  line('per-series projection statistics');
  for (const { sample } of rows) {
    const context = buildRequestContext(dataset, sample);
    const state = reconstructState(context.state, dataset.exchangeRates);
    line(`  ${sample.requestId} ${sample.userId}`);
    for (const series of [...state.recurringIncome, ...state.recurringExpenses]) {
      const stats = describeSeriesStats(series);
      const spread = (value: ReturnType<typeof describeSeriesStats>['minAmount']): string =>
        value === null ? '-' : formatMinimalAmount(value);
      line(
        `    ${stats.category.padEnd(16)} ${stats.direction.padEnd(6)} ${stats.cadenceKind.padEnd(20)} ` +
          `n=${String(stats.occurrences).padStart(2)} modalGap=${String(stats.modalGap).padStart(3)} ` +
          `medGap=${String(stats.medianGap).padStart(3)} anchor=${String(stats.anchorDay).padStart(2)}/${String(stats.modalAnchorDay).padStart(2)} ` +
          `proj=${spread(stats.projectedAmount).padStart(14)} min=${spread(stats.minAmount).padStart(14)} ` +
          `mean=${spread(stats.meanAmount).padStart(14)} med=${spread(stats.medianAmount).padStart(14)} ` +
          `last=${spread(stats.lastAmount).padStart(14)}`,
      );
    }
  }

  line();
  line('hypothesis sweep: absolute trough error per sample (lower is better)');
  const header = ['variant'.padEnd(34), ...rows.map((row) => row.sample.requestId.replace('request_', 'r'))];
  line(`  ${header.join('  ')}`);
  let bestName = '';
  let bestTotal: bigint | null = null;
  for (const variant of PROJECTION_VARIANTS) {
    const cells: string[] = [];
    let total = 0n;
    let regressed = false;
    for (const { sample, implied, capped } of rows) {
      const context = buildRequestContext(dataset, sample);
      const state = reconstructState(context.state, dataset.exchangeRates);
      const probe = probeTrough(state, sample.requestDate, variant);
      const diff = probe.trough.minor - implied;
      const magnitude = diff < 0n ? -diff : diff;
      if (capped) {
        cells.push(diff >= 0n ? 'ok' : 'LOW');
        if (diff < 0n) {
          regressed = true;
        }
        continue;
      }
      const scale = implied === 0n ? 1n : implied < 0n ? -implied : implied;
      const pct = Number((magnitude * 1000n) / scale) / 10;
      total += BigInt(Math.round(pct * 10));
      cells.push(`${pct}%`);
    }
    line(`  ${variant.name.padEnd(34)}  ${cells.join('  ')}${regressed ? '  [breaks a capped row]' : ''}`);
    if (!regressed && (bestTotal === null || total < bestTotal)) {
      bestTotal = total;
      bestName = variant.name;
    }
  }
  line();
  line(`lowest aggregate percentage trough error: ${bestName} (${bestTotal === null ? 0 : Number(bestTotal) / 10}%)`);
  line('a variant is adopted only if it wins here AND does not regress the sample regression gate');
}

function toOutputRow(
  context: RequestContext,
  state: ReconstructedState,
  result: ReturnType<typeof decide>,
): OutputRow {
  return {
    requestId: context.request.requestId,
    amountSafeToPay: formatAmountSafeToPay(result),
    affordabilityStatus: result.status,
    recommendedPaymentMethod: result.method,
    paymentPlan: formatPaymentPlan(result.plan),
    earliestDateForFullPayment: formatEarliestDate(result),
    spendingChangesNeeded: formatSpendingChanges(result.plan),
    decisionExplanation: buildExplanation(context.request, state, result),
  };
}

const EXTRACTION_CONCURRENCY = 8;

const EXTRACTION_ATTEMPTS = 3;

async function withRetry<T>(task: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < EXTRACTION_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      }
    }
  }
  throw new Error(
    `${label} failed after ${EXTRACTION_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function prewarmEvidence(
  dataset: Dataset,
  requests: readonly (SampleRequest | PaymentRequest)[],
): Promise<void> {
  const queue = [...requests];
  let completed = 0;
  const total = queue.length;
  const workers = Array.from({ length: EXTRACTION_CONCURRENCY }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) {
        return;
      }
      await withRetry(() => gatherEvidence(dataset, next), `evidence for ${next.requestId}`);
      completed += 1;
      if (completed % 25 === 0 || completed === total) {
        detail(`  extracted evidence for ${completed}/${total} requests`);
      }
    }
  });
  await Promise.all(workers);
}

async function produceFinalOutput(dataset: Dataset, mode: RunMode): Promise<void> {
  detailHeading('Final output');
  const useEvidence = requireEvidenceOrFail(mode);
  if (!useEvidence) {
    line('');
    line('  ############################################################');
    line('  #  EVIDENCE LAYER DISABLED - OPENAI_API_KEY IS NOT SET     #');
    line('  #  This output is engine-only and MUST NOT be submitted.   #');
    line('  ############################################################');
    line('');
  }

  if (useEvidence) {
    await prewarmEvidence(dataset, dataset.requests);
  }

  const rows: OutputRow[] = [];
  const violations: Violation[] = [];
  let blocked = 0;

  for (const request of dataset.requests) {
    const outcome = await decideWithEvidence(dataset, request, useEvidence);
    const context = outcome.context;
    const row = toOutputRow(context, outcome.state, outcome.result);
    rows.push(row);
    violations.push(...validateRow(context, outcome.state, outcome.result, row));
    if (outcome.result.blockedOnEvidence) {
      blocked += 1;
    }
  }

  violations.push(
    ...validateOutputFile(
      rows,
      dataset.requests.map((request) => request.requestId),
      OUTPUT_COLUMNS,
      OUTPUT_COLUMNS,
    ),
  );

  detail(`rows produced                 ${rows.length}`);
  detail(`rows still blocked on evidence ${blocked}`);
  detail(`validator violations          ${violations.length}`);
  if (violations.length > 0) {
    line();
    line(`VALIDATION FAILED - ${violations.length} violation(s); output.csv was NOT written:`);
    for (const violation of violations) {
      line(`  ${violation.requestId}  ${violation.rule}: ${violation.detail}`);
    }
    throw new Error(
      `${violations.length} validation failures; output.csv was NOT written or overwritten`,
    );
  }

  const expectedExtractions = useEvidence ? countExpectedExtractions(dataset) : 0;
  assertAllExtractionsRan(expectedExtractions, mode);

  const path = writeOutput(rows);
  detail(`wrote                         ${path}`);
  const reportPath = writeUsageReport(
    recordedUsage(),
    dataset.requests.length,
    mode === 'final'
      ? 'the final cold full-dataset run that produced output.csv'
      : 'a development run',
  );
  detail(`wrote                         ${reportPath}`);
}

function countExpectedExtractions(dataset: Dataset): number {
  let expected = 0;
  for (const request of dataset.requests) {
    const context = buildRequestContext(dataset, request);
    if (context.messages.length > 0) {
      expected += 1;
    }
    for (const image of context.images) {
      if (image.relatedEventId !== null) {
        expected += 1;
      }
    }
  }
  return expected;
}

async function gatherEvidence(
  dataset: Dataset,
  sample: SampleRequest | PaymentRequest,
): Promise<Evidence> {
  const context = buildRequestContext(dataset, sample);
  const parts: Evidence[] = [];
  if (context.messages.length > 0) {
    const reconstructed = reconstructState(context.state, dataset.exchangeRates);
    const representatives = new Set<string>();
    for (const series of [...reconstructed.recurringIncome, ...reconstructed.recurringExpenses]) {
      const last = series.occurrences[series.occurrences.length - 1];
      if (last !== undefined) {
        representatives.add(last.eventId);
      }
    }
    const forwardIds = new Set<string>();
    for (const entry of [
      ...reconstructed.confirmedFutureEvents,
      ...reconstructed.reservedPendingEvents,
    ]) {
      forwardIds.add(entry.event.eventId);
    }
    const scoped = scopeEventsForPrompt(
      context.messages,
      context.state.events,
      representatives,
      forwardIds,
    );
    parts.push(
      await extractFromMessages(
        sample.userId,
        context.messages,
        scoped,
        formatDate(sample.requestDate),
      ),
    );
  }
  for (const image of context.images) {
    if (image.relatedEventId === null) {
      continue;
    }
    const event = context.state.eventsById.get(image.relatedEventId);
    if (event === undefined) {
      continue;
    }
    parts.push(await extractFromImage(image, event));
  }
  return parts.length === 0 ? EMPTY_EVIDENCE : combine(parts);
}

interface EvidenceOutcome {
  readonly result: ReturnType<typeof decide>;
  readonly context: RequestContext;
  readonly state: ReconstructedState;
  readonly discarded: readonly string[];
  readonly suppressed: readonly string[];
  readonly adjusted: readonly string[];
  readonly filledAmounts: number;
}

async function decideWithEvidence(
  dataset: Dataset,
  sample: SampleRequest | PaymentRequest,
  useEvidence: boolean,
): Promise<EvidenceOutcome> {
  const context = buildRequestContext(dataset, sample);
  if (!useEvidence) {
    const plain = reconstructState(context.state, dataset.exchangeRates);
    return {
      result: decide(context, plain),
      context,
      state: plain,
      discarded: [],
      suppressed: [],
      adjusted: [],
      filledAmounts: 0,
    };
  }
  const evidence = await gatherEvidence(dataset, sample);
  const resolved = resolveEvidence(evidence, context.state.events);
  const amended = applyResolvedEvidence(context.state, resolved);
  const amendedContext = buildRequestContext(dataset, sample, amended);
  const reconstructed = reconstructState(amended, dataset.exchangeRates);
  const { state: adjustedState, outcome } = applyIncomeSignals(
    reconstructed,
    resolved.incomeSignals,
    sample.requestDate,
  );
  return {
    result: decide(amendedContext, adjustedState),
    context: amendedContext,
    state: adjustedState,
    discarded: resolved.discarded,
    suppressed: outcome.suppressedCategories,
    adjusted: outcome.adjustedCategories,
    filledAmounts: resolved.amountsByEventId.size,
  };
}

const PHASE_TWO_BASELINE: Record<string, number> = {
  amount_safe_to_pay: 4,
  affordability_status: 18,
  recommended_payment_method: 19,
  payment_plan: 18,
  earliest_date_for_full_payment: 17,
  spending_changes_needed: 22,
};

async function reportEvidenceGate(dataset: Dataset): Promise<void> {
  heading('Sample regression with evidence enabled');
  if (!evidenceEnabled()) {
    line('OPENAI_API_KEY is not set; evidence layer skipped');
    return;
  }
  const fields = [
    'amount_safe_to_pay',
    'affordability_status',
    'recommended_payment_method',
    'payment_plan',
    'earliest_date_for_full_payment',
    'spending_changes_needed',
  ] as const;
  const scores = new Map<string, FieldScore>();
  for (const field of fields) {
    scores.set(field, { field, passed: 0, total: 0 });
  }
  let exactRows = 0;
  let filledTotal = 0;
  const discardedAll: string[] = [];
  await prewarmEvidence(dataset, dataset.sampleRequests);

  for (const sample of dataset.sampleRequests) {
    const outcome = await decideWithEvidence(dataset, sample, true);
    const result = outcome.result;
    filledTotal += outcome.filledAmounts;
    discardedAll.push(...outcome.discarded);
    const actual: Record<string, string> = {
      amount_safe_to_pay: formatAmountSafeToPay(result),
      affordability_status: result.status,
      recommended_payment_method: result.method,
      payment_plan: formatPaymentPlan(result.plan),
      earliest_date_for_full_payment: formatEarliestDate(result),
      spending_changes_needed: formatSpendingChanges(result.plan),
    };
    const expected: Record<string, string> = {
      amount_safe_to_pay: sample.expected.amountSafeToPayText,
      affordability_status: sample.expected.affordabilityStatus,
      recommended_payment_method: sample.expected.recommendedPaymentMethod,
      payment_plan: sample.expected.paymentPlanText,
      earliest_date_for_full_payment: sample.expected.earliestDateForFullPaymentText,
      spending_changes_needed: sample.expected.spendingChangesNeededText,
    };
    const failures: string[] = [];
    for (const field of fields) {
      const score = scores.get(field);
      if (score === undefined) {
        continue;
      }
      score.total += 1;
      if (actual[field] === expected[field]) {
        score.passed += 1;
      } else {
        failures.push(field);
      }
    }
    if (failures.length === 0) {
      exactRows += 1;
    }
    const notes: string[] = [];
    if (outcome.filledAmounts > 0) {
      notes.push(`filled=${outcome.filledAmounts}`);
    }
    if (outcome.suppressed.length > 0) {
      notes.push(`income suppressed: ${outcome.suppressed.join(',')}`);
    }
    if (outcome.adjusted.length > 0) {
      notes.push(`income adjusted: ${outcome.adjusted.join(',')}`);
    }
    line(`${failures.length === 0 ? 'PASS' : 'FAIL'} ${sample.requestId}${notes.length > 0 ? `  [${notes.join('; ')}]` : ''}`);
    for (const field of failures) {
      line(`     ${field.padEnd(30)} expected "${expected[field]}"  got "${actual[field]}"`);
    }
  }

  line();
  line('per-field accuracy versus the phase 2 baseline');
  for (const field of fields) {
    const score = scores.get(field);
    if (score === undefined) {
      continue;
    }
    const before = PHASE_TWO_BASELINE[field] ?? 0;
    const delta = score.passed - before;
    const arrow = delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : 'same';
    const pct = score.total === 0 ? 0 : Math.round((score.passed / score.total) * 1000) / 10;
    line(
      `  ${field.padEnd(32)} ${String(score.passed).padStart(2)}/${score.total}  ${String(pct).padStart(5)}%   baseline ${String(before).padStart(2)}/25   ${arrow}`,
    );
  }
  line();
  line(`rows exactly correct   ${exactRows}/${dataset.sampleRequests.length}   baseline 4/25`);
  line(`blank amounts filled from images   ${filledTotal}`);
  line(`facts discarded by the ownership and hierarchy guards   ${discardedAll.length}`);
  for (const note of discardedAll.slice(0, 8)) {
    line(`  ${note}`);
  }

  const usage = billableRecords(recordedUsage());
  const live = usage.filter((entry) => !entry.cached);
  const inputTokens = usage.reduce((total, entry) => total + entry.inputTokens, 0);
  const outputTokens = usage.reduce((total, entry) => total + entry.outputTokens, 0);
  line();
  line(
    `model calls   ${usage.length} (${live.length} live, ${usage.length - live.length} replayed from cache)`,
  );
  line(`input tokens  ${inputTokens}`);
  line(`output tokens ${outputTokens}`);
}

interface FieldScore {
  readonly field: string;
  passed: number;
  total: number;
}

function reportSampleRegression(dataset: Dataset): void {
  heading('Sample regression (25 solved rows)');
  line(
    `window ${WINDOW_INCLUDES_REQUEST_DATE ? '[request_date' : '(request_date'}, request_date+${FORECAST_WINDOW_DAYS}]  ` +
      `intra-day ${INTRA_DAY_DEBITS_FIRST ? 'debits-first' : 'closing-balance'}`,
  );
  line();
  const fields = [
    'amount_safe_to_pay',
    'affordability_status',
    'recommended_payment_method',
    'payment_plan',
    'earliest_date_for_full_payment',
    'spending_changes_needed',
  ] as const;
  const scores = new Map<string, FieldScore>();
  for (const field of fields) {
    scores.set(field, { field, passed: 0, total: 0 });
  }
  let exactRows = 0;
  let blockedRows = 0;

  for (const sample of dataset.sampleRequests) {
    const context = buildRequestContext(dataset, sample);
    const state = reconstructState(context.state, dataset.exchangeRates);
    const result = decide(context, state);
    const actual: Record<string, string> = {
      amount_safe_to_pay: formatAmountSafeToPay(result),
      affordability_status: result.status,
      recommended_payment_method: result.method,
      payment_plan: formatPaymentPlan(result.plan),
      earliest_date_for_full_payment: formatEarliestDate(result),
      spending_changes_needed: formatSpendingChanges(result.plan),
    };
    const expected: Record<string, string> = {
      amount_safe_to_pay: sample.expected.amountSafeToPayText,
      affordability_status: sample.expected.affordabilityStatus,
      recommended_payment_method: sample.expected.recommendedPaymentMethod,
      payment_plan: sample.expected.paymentPlanText,
      earliest_date_for_full_payment: sample.expected.earliestDateForFullPaymentText,
      spending_changes_needed: sample.expected.spendingChangesNeededText,
    };
    if (result.blockedOnEvidence) {
      blockedRows += 1;
    }
    const failures: string[] = [];
    for (const field of fields) {
      const score = scores.get(field);
      if (score === undefined) {
        continue;
      }
      score.total += 1;
      if (actual[field] === expected[field]) {
        score.passed += 1;
      } else {
        failures.push(field);
      }
    }
    if (failures.length === 0) {
      exactRows += 1;
    }
    const marker = failures.length === 0 ? 'PASS' : 'FAIL';
    const evidence = result.blockedOnEvidence ? ' [pending evidence]' : '';
    line(`${marker} ${sample.requestId}${evidence}`);
    for (const field of failures) {
      line(`     ${field.padEnd(30)} expected "${expected[field]}"  got "${actual[field]}"`);
    }
  }

  line();
  line('per-field accuracy');
  for (const field of fields) {
    const score = scores.get(field);
    if (score === undefined) {
      continue;
    }
    const pct = score.total === 0 ? 0 : Math.round((score.passed / score.total) * 1000) / 10;
    line(`  ${field.padEnd(32)} ${String(score.passed).padStart(2)}/${score.total}  ${pct}%`);
  }
  line();
  line(`rows exactly correct on all six fields   ${exactRows}/${dataset.sampleRequests.length}`);
  line(`rows blocked on pending image evidence   ${blockedRows}`);
}

interface CoverageReport {
  readonly secondaryUserId: string;
}

function reportRecurrenceCoverage(dataset: Dataset, primaryUserId: string): CoverageReport {
  heading('Recurrence coverage and projector accuracy (all users)');
  const cadenceCounts = new Map<string, number>();
  let seriesTotal = 0;
  let oneTimeTotal = 0;
  let excludedTotal = 0;
  let pendingTotal = 0;
  const duplicateRows: string[] = [];
  let bestUser = '';
  let bestNonMonthly = -1;
  let projectedTotal = 0;
  let matchedTotal = 0;
  let missedBeyondTotal = 0;
  let missedWithinTotal = 0;
  let unexplainedTotal = 0;
  let backtestedUsers = 0;
  let perfectUsers = 0;

  for (const userId of dataset.profilesByUserId.keys()) {
    const reconstructed = reconstructState(
      buildUserFinancialState(dataset, userId),
      dataset.exchangeRates,
    );
    const series = [...reconstructed.recurringIncome, ...reconstructed.recurringExpenses];
    seriesTotal += series.length;
    oneTimeTotal += reconstructed.oneTimeEvents.length;
    excludedTotal += reconstructed.excludedEvents.length;
    pendingTotal += reconstructed.amountPendingEvidence.length;
    for (const pair of reconstructed.linkedPairs) {
      if (pair.duplicateOfParent) {
        duplicateRows.push(`  ${pair.childId} repeats ${pair.parentId} (${pair.pattern})`);
      }
    }
    let nonMonthly = 0;
    for (const entry of series) {
      cadenceCounts.set(entry.cadence.kind, (cadenceCounts.get(entry.cadence.kind) ?? 0) + 1);
      if (entry.cadence.kind !== 'monthly') {
        nonMonthly += 1;
      }
    }
    const better = nonMonthly > bestNonMonthly || (nonMonthly === bestNonMonthly && userId < bestUser);
    if (userId !== primaryUserId && better) {
      bestNonMonthly = nonMonthly;
      bestUser = userId;
    }
    const backtest = backtestProjector(dataset, userId);
    if (backtest !== null) {
      backtestedUsers += 1;
      projectedTotal += backtest.projected;
      matchedTotal += backtest.matched;
      missedBeyondTotal += backtest.missedBeyondHistory;
      missedWithinTotal += backtest.missedWithinHistory;
      unexplainedTotal += backtest.unexplained;
      if (backtest.missedWithinHistory === 0 && backtest.projected > 0) {
        perfectUsers += 1;
      }
    }
  }

  line(`recurring series detected      ${seriesTotal}`);
  for (const [kind, count] of [...cadenceCounts.entries()].sort(
    (left, right) => right[1] - left[1],
  )) {
    line(`  ${kind.padEnd(28)} ${count}`);
  }
  line(`one-time events                ${oneTimeTotal}`);
  line(`excluded events                ${excludedTotal}`);
  line(`amount pending evidence        ${pendingTotal}`);
  line(`duplicates excluded            ${duplicateRows.length}`);
  for (const row of duplicateRows) {
    line(row);
  }

  const rate = projectedTotal === 0 ? 0 : Math.round((matchedTotal / projectedTotal) * 1000) / 10;
  const withinRate =
    projectedTotal === 0 ? 0 : Math.round((missedWithinTotal / projectedTotal) * 10000) / 100;
  line();
  line(`users backtested                  ${backtestedUsers}`);
  line(`occurrences projected             ${projectedTotal}`);
  line(`matched real later events         ${matchedTotal} (${rate}%)`);
  line(`projected past recorded end       ${missedBeyondTotal} (history ends, not a projector error)`);
  line(`mismatched within active history  ${missedWithinTotal} (${withinRate}%)`);
  line(`real events not projected         ${unexplainedTotal}`);
  line(`users with no in-history mismatch ${perfectUsers}/${backtestedUsers}`);

  return { secondaryUserId: bestUser === '' ? primaryUserId : bestUser };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const developmentRun = args.includes('--dev') || process.env['DEV'] === '1';
  const verbose = args.includes('--verbose') || process.env['VERBOSE'] === '1';
  setVerboseOutput(verbose);
  const mode: RunMode = developmentRun ? 'development' : 'final';
  const requestId =
    args.find((value) => !value.startsWith('--')) ?? process.env['REQUEST_ID'] ?? DEFAULT_REQUEST_ID;
  const dataset = loadDataset();

  reportDatasetSummary(dataset);

  if (verbose) {
    reportOutputContract(dataset);
    reportRoundingRule(dataset);
    const request = findRequest(dataset, requestId);
    const context = buildRequestContext(dataset, request);
    reportUserFinancialState(context.state);
    reportRequestContext(context, dataset.sampleRequestsById.get(requestId));
    const primary = reconstructState(context.state, dataset.exchangeRates);
    reportReconstructedState(primary);
    reportBacktest(dataset, context.state.userId);
    reportSpendingChangeGrounding(dataset);
    reportProjectionDiagnostic(dataset);
    const coverage = reportRecurrenceCoverage(dataset, context.state.userId);
    const secondary = reconstructState(
      buildUserFinancialState(dataset, coverage.secondaryUserId),
      dataset.exchangeRates,
    );
    reportReconstructedState(secondary);
    reportBacktest(dataset, coverage.secondaryUserId);
    await reportEvidenceGate(dataset);
  }

  if (developmentRun) {
    return;
  }

  await produceFinalOutput(dataset, mode);
  line('output.csv generated successfully at repo root.');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
