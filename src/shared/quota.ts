// Detects provider quota / rate-limit errors that say when to retry, and formats the countdown.

export interface QuotaBlock {
  /** Epoch ms when the provider said to try again. */
  until: number;
  model?: string;
  /** The provider's own message, e.g. "Large-model token quota exceeded for job family …". */
  message: string;
}

const LIMIT_HINT = /quota exceeded|rate[_ ]limit|too many requests|status_code:\s*(402|429)/i;
const RETRY_IN = /try again in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b|hours?|hrs?|h\b)/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

export function parseQuotaError(text: string, now = Date.now()): QuotaBlock | undefined {
  if (!LIMIT_HINT.test(text)) return undefined;
  const retry = RETRY_IN.exec(text);
  if (!retry) return undefined;
  const unit = retry[2][0].toLowerCase();
  const until = now + Math.round(Number(retry[1]) * UNIT_MS[unit]);
  const model = /model_name:\s*([\w.:/-]+)/.exec(text)?.[1];
  const quoted = /['"]message['"]:\s*(?:"([^"]+)"|'([^']+)')/.exec(text);
  const message = (quoted?.[1] ?? quoted?.[2] ?? text.replace(/^\W*The agent run failed:\s*/, '')).trim();
  return { until, model, message };
}

/** `2:58:07` or `4:05`. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
