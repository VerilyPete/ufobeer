import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('cloudflare:email', () => {
	const EmailMessage = vi.fn();
	return { EmailMessage };
});

import { EmailMessage } from 'cloudflare:email';
import { resetForTesting } from '../src/cooldown';
import { FROM_ADDRESS, TO_ADDRESS } from '../src/format';

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

function makeEnv(): { SEND_EMAIL: { send: ReturnType<typeof vi.fn> } } {
	return {
		SEND_EMAIL: { send: vi.fn().mockResolvedValue(undefined) },
	};
}

describe('tail handler', () => {
	beforeEach(() => {
		resetForTesting();
		vi.restoreAllMocks();
	});

	it('does not send email when all traces are ok', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'ok' }), makeTrace({ outcome: 'canceled' })];

		await worker.tail(traces, env);

		expect(env.SEND_EMAIL.send).not.toHaveBeenCalled();
	});

	it('sends email via SEND_EMAIL.send() when errors found', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'exception', exceptions: [{ timestamp: 0, name: 'TypeError', message: 'oops', stack: '' }] })];

		await worker.tail(traces, env);

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
	});

	it('constructs EmailMessage with correct from/to addresses', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'exception' })];

		await worker.tail(traces, env);

		expect(EmailMessage).toHaveBeenCalledWith(
			FROM_ADDRESS,
			TO_ADDRESS,
			expect.any(String),
		);
	});

	it('respects cooldown and does not send duplicate alerts within window', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		const traces = [makeTrace({ outcome: 'exception' })];

		await worker.tail(traces, env);
		await worker.tail(traces, env);

		expect(env.SEND_EMAIL.send).toHaveBeenCalledOnce();
	});

	it('does not throw when SEND_EMAIL.send() fails', async () => {
		const { default: worker } = await import('../src/index');
		const env = makeEnv();
		env.SEND_EMAIL.send.mockRejectedValue(new Error('email service down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const traces = [makeTrace({ outcome: 'exception' })];

		await expect(worker.tail(traces, env)).resolves.toBeUndefined();

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

		await expect(worker.tail(traces, env)).resolves.toBeUndefined();

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

		await expect(worker.tail([], env)).resolves.toBeUndefined();

		expect(consoleSpy).toHaveBeenCalled();
	});
});
