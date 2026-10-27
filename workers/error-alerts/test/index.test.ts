import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('cloudflare:email', () => {
	const EmailMessage = vi.fn();
	return { EmailMessage };
});

import { EmailMessage } from 'cloudflare:email';
import { FROM_ADDRESS, DEGRADED_COOLDOWN_MARKER } from '../src/format';
import { resetFallbackForTesting as resetCooldownFallback, type CooldownStore } from '../src/cooldown';
import { resetFallbackForTesting as resetCapFallback, MAX_EMAILS_PER_WINDOW } from '../src/emailCap';
import type { Env } from '../src/types';

function makeTrace(overrides: Partial<TraceItem> = {}): TraceItem {
	return {
		event: null,
		eventTimestamp: Date.now(),
		logs: [],
		exceptions: [],
		diagnosticsChannelEvents: [],
		scriptName: 'ufobeer',
		outcome: 'ok',
		executionModel: 'stateless',
		truncated: false,
		cpuTime: 5,
		wallTime: 100,
		...overrides,
	} as TraceItem;
}

function makeExceptionTrace(name: string): TraceItem {
	return makeTrace({
		outcome: 'exception',
		exceptions: [{ timestamp: Date.now(), name, message: 'boom', stack: '' }],
	});
}

const TEST_TO_ADDRESS = 'test-alerts@example.com';

function makeFakeKv(): CooldownStore & { readonly data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		async get(key: string) {
			return data.get(key) ?? null;
		},
		async put(key: string, value: string) {
			data.set(key, typeof value === 'string' ? value : String(value));
		},
	};
}

function makeThrowingKv(): CooldownStore {
	return {
		get: async () => {
			throw new Error('KV unavailable');
		},
		put: async () => {
			throw new Error('KV unavailable');
		},
	};
}

function makeEnv(
	kv: CooldownStore = makeFakeKv(),
): { SEND_EMAIL: { send: ReturnType<typeof vi.fn> }; TO_ADDRESS: string; COOLDOWN_KV: CooldownStore } {
	return {
		SEND_EMAIL: { send: vi.fn().mockResolvedValue(undefined) },
		TO_ADDRESS: TEST_TO_ADDRESS,
		COOLDOWN_KV: kv,
	};
}

describe('tail handler', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		resetCooldownFallback();
		resetCapFallback();
	});

	it('does not send email when all traces are ok', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'ok' }), makeTrace({ outcome: 'canceled' })];

		await worker.tail(traces, env as unknown as Env);

		expect(env.SEND_EMAIL.send).not.toHaveBeenCalled();
	});

	it('sends email via SEND_EMAIL.send() when errors found', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeExceptionTrace('TypeError')];

		await worker.tail(traces, env as unknown as Env);

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
	});

	it('constructs EmailMessage with correct from/to addresses', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'exception' })];

		await worker.tail(traces, env as unknown as Env);

		expect(EmailMessage).toHaveBeenCalledWith(
			FROM_ADDRESS,
			TEST_TO_ADDRESS,
			expect.any(String),
		);
	});

	it('respects cooldown and does not send duplicate alerts within window', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'exception' })];

		await worker.tail(traces, env as unknown as Env);
		await worker.tail(traces, env as unknown as Env);

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
	});

	it('does not throw when SEND_EMAIL.send() fails', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		env.SEND_EMAIL.send.mockRejectedValue(new Error('email service down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const traces = [makeTrace({ outcome: 'exception' })];

		await expect(worker.tail(traces, env as unknown as Env)).resolves.toBeUndefined();

		expect(consoleSpy).toHaveBeenCalled();
	});

	it('sends fallback email when filter/format throws', async () => {
		const filterModule = await import('../src/filter');
		vi.spyOn(filterModule, 'filterErrorTraces').mockImplementation(() => {
			throw new Error('unexpected parsing failure');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'exception' })];

		await expect(worker.tail(traces, env as unknown as Env)).resolves.toBeUndefined();

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
		const constructorCall = vi.mocked(EmailMessage).mock.calls[0];
		expect(constructorCall).toBeDefined();
		const rawEmail = constructorCall![2] as string;
		expect(rawEmail).toContain('failed to process');
	});

	it('fallback email does not throw on malformed trace data', async () => {
		const filterModule = await import('../src/filter');
		vi.spyOn(filterModule, 'filterErrorTraces').mockImplementation(() => {
			throw new Error('cyclic object');
		});
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		env.SEND_EMAIL.send
			.mockRejectedValueOnce(new Error('fallback send also failed'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(worker.tail([], env as unknown as Env)).resolves.toBeUndefined();

		expect(consoleSpy).toHaveBeenCalled();
	});

	it('cooldown-limits the fallback path so repeated tail-processing errors do not each email', async () => {
		const filterModule = await import('../src/filter');
		vi.spyOn(filterModule, 'filterErrorTraces').mockImplementation(() => {
			throw new Error('unexpected parsing failure');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'exception' })];

		await worker.tail(traces, env as unknown as Env);
		await worker.tail(traces, env as unknown as Env);
		await worker.tail(traces, env as unknown as Env);

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
	});

	// ---------------------------------------------------------------------
	// Durable store failure: degrade, don't silence the channel
	// ---------------------------------------------------------------------

	it('still sends (degraded) rather than going silent when the durable cooldown store fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { default: worker } = await import('../src/index');
		const env = makeEnv(makeThrowingKv());
		const traces = [makeTrace({ outcome: 'exception' })];

		await worker.tail(traces, env as unknown as Env);

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
	});

	it('bounds repeat alerts for the same key via the in-isolate fallback when KV is unavailable', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { default: worker } = await import('../src/index');
		const env = makeEnv(makeThrowingKv());
		const traces = [makeTrace({ outcome: 'exception' })];

		await worker.tail(traces, env as unknown as Env);
		await worker.tail(traces, env as unknown as Env);
		await worker.tail(traces, env as unknown as Env);

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
	});

	it('bounds the fallback path via the in-isolate fallback when KV is unavailable', async () => {
		const filterModule = await import('../src/filter');
		vi.spyOn(filterModule, 'filterErrorTraces').mockImplementation(() => {
			throw new Error('unexpected parsing failure');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { default: worker } = await import('../src/index');
		const env = makeEnv(makeThrowingKv());
		const traces = [makeTrace({ outcome: 'exception' })];

		await worker.tail(traces, env as unknown as Env);
		await worker.tail(traces, env as unknown as Env);

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
	});

	it('marks the email body as degraded only when the cooldown store is unavailable', async () => {
		const { default: worker } = await import('../src/index');

		const healthyEnv = makeEnv();
		await worker.tail([makeExceptionTrace('HealthyError')], healthyEnv as unknown as Env);
		const healthyRaw = vi.mocked(EmailMessage).mock.calls[0]![2] as string;
		expect(healthyRaw).not.toContain(DEGRADED_COOLDOWN_MARKER);

		vi.mocked(EmailMessage).mockClear();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const degradedEnv = makeEnv(makeThrowingKv());
		await worker.tail([makeExceptionTrace('DegradedError')], degradedEnv as unknown as Env);
		const degradedRaw = vi.mocked(EmailMessage).mock.calls[0]![2] as string;
		expect(degradedRaw).toContain(DEGRADED_COOLDOWN_MARKER);
	});

	// ---------------------------------------------------------------------
	// Per-window email volume cap: applies regardless of cooldown tier
	// ---------------------------------------------------------------------

	it('caps total email volume across distinct cooldown keys, even with a healthy KV', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();

		for (let i = 0; i < MAX_EMAILS_PER_WINDOW + 2; i++) {
			await worker.tail([makeExceptionTrace(`HealthyError${i}`)], env as unknown as Env);
		}

		expect(env.SEND_EMAIL.send).toHaveBeenCalledTimes(MAX_EMAILS_PER_WINDOW);
	});

	it('caps total email volume across distinct cooldown keys when KV is unavailable', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { default: worker } = await import('../src/index');
		const env = makeEnv(makeThrowingKv());

		for (let i = 0; i < MAX_EMAILS_PER_WINDOW + 2; i++) {
			await worker.tail([makeExceptionTrace(`DegradedError${i}`)], env as unknown as Env);
		}

		expect(env.SEND_EMAIL.send).toHaveBeenCalledTimes(MAX_EMAILS_PER_WINDOW);
	});
});
