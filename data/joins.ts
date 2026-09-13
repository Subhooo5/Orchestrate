import { DatasetError } from './loader.js';
import type { Dataset } from './loader.js';
import type { CurrencyCode } from '../util/money.js';
import type {
  ExchangeRateRecord,
  FinancialEvent,
  ImageRecord,
  Message,
  PaymentOption,
  PaymentRequest,
  RequestContext,
  SampleRequest,
  UserFinancialState,
} from './types.js';

function groupByKey<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    if (groupKey === null) {
      continue;
    }
    const existing = groups.get(groupKey);
    if (existing === undefined) {
      groups.set(groupKey, [item]);
    } else {
      existing.push(item);
    }
  }
  return groups;
}

function collectForeignCurrencies(
  events: readonly FinancialEvent[],
  homeCurrency: CurrencyCode,
): CurrencyCode[] {
  const currencies = new Set<CurrencyCode>();
  for (const event of events) {
    if (event.currency !== homeCurrency) {
      currencies.add(event.currency);
    }
  }
  return [...currencies].sort();
}

function scopeExchangeRates(
  dataset: Dataset,
  homeCurrency: CurrencyCode,
  foreignCurrencies: readonly CurrencyCode[],
): ExchangeRateRecord[] {
  if (foreignCurrencies.length === 0) {
    return [];
  }
  const wanted = new Set(foreignCurrencies);
  return dataset.exchangeRates
    .filter((record) => record.rate.to === homeCurrency && wanted.has(record.rate.from))
    .sort((left, right) => left.rateDate - right.rateDate);
}

export function buildUserFinancialState(dataset: Dataset, userId: string): UserFinancialState {
  const profile = dataset.profilesByUserId.get(userId);
  if (profile === undefined) {
    throw new DatasetError(`no financial profile for ${userId}`);
  }

  const events = dataset.eventsByUserId.get(userId) ?? [];
  const messages = dataset.messagesByUserId.get(userId) ?? [];
  const images = dataset.imagesByUserId.get(userId) ?? [];
  const requests = dataset.requestsByUserId.get(userId) ?? [];

  const eventsById = new Map<string, FinancialEvent>(events.map((event) => [event.eventId, event]));

  const paymentOptionsByRequestId = new Map<string, readonly PaymentOption[]>();
  for (const request of requests) {
    paymentOptionsByRequestId.set(
      request.requestId,
      dataset.paymentOptionsByRequestId.get(request.requestId) ?? [],
    );
  }
  for (const sample of dataset.sampleRequests) {
    if (sample.userId === userId) {
      paymentOptionsByRequestId.set(
        sample.requestId,
        dataset.paymentOptionsByRequestId.get(sample.requestId) ?? [],
      );
    }
  }

  const foreignCurrencies = collectForeignCurrencies(events, profile.homeCurrency);

  return {
    userId,
    profile,
    events,
    eventsById,
    eventsWithMissingAmount: events.filter((event) => event.amount === null),
    requests,
    paymentOptionsByRequestId,
    messages,
    messagesByEventId: groupByKey(messages, (message) => message.relatedEventId),
    images,
    imagesByEventId: groupByKey(images, (image) => image.relatedEventId),
    exchangeRates: scopeExchangeRates(dataset, profile.homeCurrency, foreignCurrencies),
    foreignCurrencies,
  };
}

function isRelevantToRequest(
  ownerRequestId: string | null,
  requestId: string,
  relatedEventId: string | null,
  eventsById: ReadonlyMap<string, FinancialEvent>,
): boolean {
  if (ownerRequestId !== null) {
    return ownerRequestId === requestId;
  }
  if (relatedEventId !== null) {
    return eventsById.has(relatedEventId);
  }
  return true;
}

export function buildRequestContext(
  dataset: Dataset,
  request: PaymentRequest | SampleRequest,
  state?: UserFinancialState,
): RequestContext {
  const userState = state ?? buildUserFinancialState(dataset, request.userId);
  if (userState.userId !== request.userId) {
    throw new DatasetError(
      `state for ${userState.userId} cannot serve request ${request.requestId} of ${request.userId}`,
    );
  }

  const messages: Message[] = userState.messages.filter((message) =>
    isRelevantToRequest(message.requestId, request.requestId, message.relatedEventId, userState.eventsById),
  );
  const images: ImageRecord[] = userState.images.filter((image) =>
    isRelevantToRequest(image.requestId, request.requestId, image.relatedEventId, userState.eventsById),
  );

  return {
    request,
    profile: userState.profile,
    state: userState,
    events: userState.events,
    eventsWithMissingAmount: userState.eventsWithMissingAmount,
    paymentOptions: userState.paymentOptionsByRequestId.get(request.requestId) ?? [],
    messages,
    images,
    exchangeRates: userState.exchangeRates,
  };
}

export function findRequest(dataset: Dataset, requestId: string): PaymentRequest | SampleRequest {
  const request = dataset.requestsById.get(requestId) ?? dataset.sampleRequestsById.get(requestId);
  if (request === undefined) {
    throw new DatasetError(`no request with id ${requestId}`);
  }
  return request;
}

export function buildRequestContextById(dataset: Dataset, requestId: string): RequestContext {
  return buildRequestContext(dataset, findRequest(dataset, requestId));
}

export function buildAllUserFinancialStates(dataset: Dataset): Map<string, UserFinancialState> {
  const states = new Map<string, UserFinancialState>();
  for (const userId of dataset.profilesByUserId.keys()) {
    states.set(userId, buildUserFinancialState(dataset, userId));
  }
  return states;
}
