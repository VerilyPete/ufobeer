import { EmailMessage } from 'cloudflare:email';
import { filterErrorTraces } from './filter';
import { buildSubject, buildBody, buildRawEmail, FROM_ADDRESS, TO_ADDRESS } from './format';
import { shouldSendAlert, getSuppressedCount } from './cooldown';
import type { Env } from './types';

function cooldownKey(trace: TraceItem): string {
	const firstException = trace.exceptions[0];
	const suffix = firstException ? firstException.name : 'error-logs';
	return `${trace.outcome}:${suffix}`;
}

async function sendEmail(env: Env, raw: string): Promise<void> {
	const message = new EmailMessage(FROM_ADDRESS, TO_ADDRESS, raw);
	await env.SEND_EMAIL.send(message);
}

export default {
	async tail(traces: readonly TraceItem[], env: Env): Promise<void> {
		try {
			const errors = filterErrorTraces(traces);
			if (errors.length === 0) return;

			const firstError = errors[0]!;
			const key = cooldownKey(firstError);
			if (!shouldSendAlert(key)) return;

			const suppressedCount = getSuppressedCount(key);
			const subject = buildSubject(firstError);
			const body = buildBody(errors, suppressedCount);
			const raw = buildRawEmail(subject, body);
			try {
				await sendEmail(env, raw);
			} catch (err) {
				console.error('Failed to send alert email', err);
			}
		} catch (outerErr) {
			console.error('Tail handler error, sending fallback alert', outerErr);
			try {
				const subject = `[UFO Beer] Tail worker failed to process ${traces.length} trace(s)`;
				const body = `The tail worker encountered an error while processing traces.\n\nTrace count: ${traces.length}`;
				const raw = buildRawEmail(subject, body);
				await sendEmail(env, raw);
			} catch (fallbackErr) {
				console.error('Fallback email also failed', fallbackErr);
			}
		}
	},
};
