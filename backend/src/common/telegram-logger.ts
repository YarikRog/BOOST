import { ConsoleLogger, LogLevel } from '@nestjs/common';

/** Sink the logger forwards to. Kept minimal so tests can substitute it. */
export interface AlertSink {
  alertAdmin(source: string, message: string): Promise<void>;
}

/**
 * Console logger that also pushes `error()` to the admin's Telegram.
 *
 * Nest's logger is where every silent failure already lands — a failed sweep,
 * a dropped Redis connection, a reminder that could not be released. Those
 * previously only reached Railway's log view, which nobody watches during a
 * pilot, so an outage could run for hours unnoticed.
 *
 * Forwarding *everything* verbatim would be worse than silence: ioredis emits
 * an error per reconnect attempt, so one outage could mean hundreds of Telegram
 * messages and a muted chat. Hence deduplication plus a hard per-window cap,
 * with a single summary of whatever was suppressed.
 */
export class TelegramLogger extends ConsoleLogger {
  private static readonly DEDUPE_WINDOW_MS = 15 * 60 * 1000;
  private static readonly RATE_WINDOW_MS = 5 * 60 * 1000;
  private static readonly MAX_ALERTS_PER_WINDOW = 12;

  private sink?: AlertSink;
  private readonly lastSentAt = new Map<string, number>();
  private windowStartedAt = Date.now();
  private sentThisWindow = 0;
  private suppressedThisWindow = 0;
  /** Guards against alerting about a failure that happened while alerting. */
  private inAlert = false;

  /** Wired after the app boots, once BotService exists. */
  attachSink(sink: AlertSink): void {
    this.sink = sink;
  }

  error(message: unknown, ...rest: unknown[]): void {
    super.error(message as string, ...(rest as string[]));
    this.forward(message, rest);
  }

  private forward(message: unknown, rest: unknown[]): void {
    if (!this.sink || this.inAlert) return;

    const context = rest.find((r) => typeof r === 'string' && !r.includes('\n'));
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    if (!text) return;

    // A failure inside the alert path must not alert — that is the loop.
    if (text.startsWith('alertAdmin failed')) return;

    const now = Date.now();
    if (now - this.windowStartedAt > TelegramLogger.RATE_WINDOW_MS) {
      const suppressed = this.suppressedThisWindow;
      this.windowStartedAt = now;
      this.sentThisWindow = 0;
      this.suppressedThisWindow = 0;
      if (suppressed > 0) {
        void this.send('rate-limit', `…і ще ${suppressed} помилок за останні 5 хв (не надіслані).`);
      }
    }

    // Numbers and UUIDs vary per occurrence; strip them so the same failure
    // about different rows collapses into one alert instead of N.
    const fingerprint = text.replace(/[0-9a-f-]{16,}/gi, '#').replace(/\d+/g, '#').slice(0, 200);
    const lastSent = this.lastSentAt.get(fingerprint);
    if (lastSent && now - lastSent < TelegramLogger.DEDUPE_WINDOW_MS) return;

    if (this.sentThisWindow >= TelegramLogger.MAX_ALERTS_PER_WINDOW) {
      this.suppressedThisWindow++;
      return;
    }

    this.lastSentAt.set(fingerprint, now);
    this.sentThisWindow++;
    if (this.lastSentAt.size > 500) this.lastSentAt.clear(); // bounded memory
    void this.send(typeof context === 'string' ? context : 'log', text);
  }

  private async send(source: string, text: string): Promise<void> {
    this.inAlert = true;
    try {
      await this.sink?.alertAdmin(source, text);
    } catch {
      /* the alert channel itself is down; the console line above still stands */
    } finally {
      this.inAlert = false;
    }
  }

  /** Levels kept as-is; only `error` is forwarded. */
  setLogLevels(levels: LogLevel[]): void {
    super.setLogLevels(levels);
  }
}
