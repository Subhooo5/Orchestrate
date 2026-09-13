# Token Usage and Cost Analysis

This report describes **the final cold full-dataset run that produced output.csv**.

## Provider and models

| Provider | Model | Calls | Cache hits | Live calls | Input tokens | Output tokens |
|---|---|---:|---:|---:|---:|---:|
| OpenAI | `gpt-5` | 209 | 0 | 209 | 217,583 | 284,263 |

## Per-model cost

| Model | Input cost | Output cost | Total cost |
|---|---:|---:|---:|
| `gpt-5` | $0.2720 | $2.8426 | $3.1146 |

## Overall totals

- Requests processed: **250**
- Distinct extractions: **209**
- Model calls: **209** (209 live, 0 replayed from cache)
- Input tokens: **217,583**
- Output tokens: **284,263**
- Total tokens: **501,846**
- Average tokens per request: **2,007**
- Estimated total cost: **$3.1146**
- Estimated cost per request: **$0.0125**

Pricing basis: $1.25 per million input tokens and $10 per million output tokens.

## Determinism

`temperature: 0` was requested on every call. **209** call(s) were rejected by the model for supplying `temperature` and were retried without it, so those ran at the provider default. Reproducibility for those calls rests on the populated on-disk cache in `code/evidence/cache/`, not on temperature.

Cache-replayed calls report the token counts and cost recorded when that extraction was first performed; they are not re-billed. A run served entirely from the shipped cache therefore shows the true cost of producing these results, at $0 incremental spend.

No API keys, credentials, or sensitive configuration values appear in this report.
