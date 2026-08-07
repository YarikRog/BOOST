import { TelegramLogger, AlertSink } from './telegram-logger';

/** Collects what would have been sent to Telegram. */
function makeSink() {
  const sent: Array<{ source: string; message: string }> = [];
  const sink: AlertSink = {
    alertAdmin: async (source, message) => {
      sent.push({ source, message });
    },
  };
  return { sink, sent };
}

function makeLogger() {
  const logger = new TelegramLogger();
  // Keep the console quiet; only the forwarding behaviour is under test.
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  jest
    .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)) as TelegramLogger, 'error')
    .mockImplementation(() => undefined);
  return logger;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('TelegramLogger', () => {
  it('stays silent until a sink is attached', async () => {
    const logger = makeLogger();
    logger.error('before boot');
    await flush();
    // No sink yet — must not throw, and nothing to deliver.
    expect(true).toBe(true);
  });

  it('forwards an error once a sink is attached', async () => {
    const logger = makeLogger();
    const { sink, sent } = makeSink();
    logger.attachSink(sink);

    logger.error('Expiry sweep failed: connection refused', 'ExpiryWorker');
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain('Expiry sweep failed');
    expect(sent[0].source).toBe('ExpiryWorker');
  });

  it('deduplicates the same failure instead of repeating it', async () => {
    const logger = makeLogger();
    const { sink, sent } = makeSink();
    logger.attachSink(sink);

    for (let i = 0; i < 50; i++) logger.error('Redis error: connect ECONNREFUSED', 'RedisService');
    await flush();

    // One reconnect storm must not mean 50 Telegram messages.
    expect(sent).toHaveLength(1);
  });

  it('treats failures differing only by id or number as one', async () => {
    const logger = makeLogger();
    const { sink, sent } = makeSink();
    logger.attachSink(sink);

    logger.error('Reminder for 3f7c1a2b-9d4e-4f11-8a01-6b2c5d8e9f00 failed: timeout');
    logger.error('Reminder for 8e2d4c6a-1b3f-4a55-9c77-0d1e2f3a4b5c failed: timeout');
    await flush();

    expect(sent).toHaveLength(1);
  });

  it('caps distinct errors per window rather than flooding the chat', async () => {
    const logger = makeLogger();
    const { sink, sent } = makeSink();
    logger.attachSink(sink);

    for (let i = 0; i < 40; i++) logger.error(`distinct failure kind ${String.fromCharCode(65 + i)}`);
    await flush();

    expect(sent.length).toBeLessThanOrEqual(12);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('never alerts about a failure of the alert channel itself', async () => {
    const logger = makeLogger();
    const { sink, sent } = makeSink();
    logger.attachSink(sink);

    // This is the message alertAdmin logs when Telegram rejects it. Forwarding
    // it would try Telegram again and recurse.
    logger.error('alertAdmin failed to notify: 403 Forbidden');
    await flush();

    expect(sent).toHaveLength(0);
  });

  it('survives a sink that throws', async () => {
    const logger = makeLogger();
    logger.attachSink({
      alertAdmin: async () => {
        throw new Error('Telegram down');
      },
    });

    expect(() => logger.error('something broke')).not.toThrow();
    await flush();
  });
});
