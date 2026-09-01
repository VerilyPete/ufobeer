import { EmailMessage } from 'cloudflare:email';
import { filterErrorTraces } from './filter';
import { buildSubject, buildBody, buildRawEmail, FROM_ADDRESS, DEGRADED_COOLDOWN_MARKER } from './format';
import { checkCooldown } from './cooldown';
import { reserveEmailSlot, MAX_EMAILS_PER_WINDOW } from './emailCap';
import type { Env } from './types';

// Cooldown key for the outer fallback path, kept separate from per-error
// keys so a storm of distinct trace-processing errors still shares one
// budget instead of getting a fresh cooldown window each time.
const FALLBACK_COOLDOWN_KEY = 'fallback:tail-handler-error';

function cooldownKey(trace: TraceItem): string {
	const firstException = trace.exceptions[0];
	const suffix = firstException ? firstException.name : 'error-logs';
	return `${trace.outcome}:${suffix}`;
}

async function sendEmail(env: Env, raw: string): Promise<void> {
	const message = new EmailMessage(FROM_ADDRESS, env.TO_ADDRESS, raw);
	await env.SEND_EMAIL.send(message);
}

export default {
	async tail(traces: readonly TraceItem[], env: Env): Promise<void> {
		try {
			const errors = filterErrorTraces(traces);
			if (errors.length === 0) return;

			const firstError = errors[0]!;
			const key = cooldownKey(firstError);
			const cooldown = await checkCooldown(env.COOLDOWN_KV, key);
			if (!cooldown.shouldSend) return;

			// Applied unconditionally, on top of the per-key cooldown above: many
			// distinct cooldown keys can each independently clear their own
			// cooldown, so this bounds total send volume regardless of how many
			// distinct error identities are behind it.
			const cap = await reserveEmailSlot(env.COOLDOWN_KV);
			if (!cap.allowed) {
				console.error('Per-window email cap reached; suppressing alert', { cap: MAX_EMAILS_PER_WINDOW });
				return;
			}

			const subject = buildSubject(firstError);
			const body = buildBody(errors, cooldown.suppressedCount, cooldown.degraded || cap.degraded);
			const raw = buildRawEmail(subject, body, env.TO_ADDRESS);
			try {
				await sendEmail(env, raw);
			} catch (err) {
				console.error('Failed to send alert email', err);
			}
		} catch (outerErr) {
			console.error('Tail handler error, sending fallback alert', outerErr);
			try {
				const cooldown = await checkCooldown(env.COOLDOWN_KV, FALLBACK_COOLDOWN_KEY);
				if (!cooldown.shouldSend) return;

				const cap = await reserveEmailSlot(env.COOLDOWN_KV);
				if (!cap.allowed) {
					console.error('Per-window email cap reached; suppressing fallback alert', { cap: MAX_EMAILS_PER_WINDOW });
					return;
				}

				const degraded = cooldown.degraded || cap.degraded;
				const subject = `[UFO Beer] Tail worker failed to process ${traces.length} trace(s)`;
				const bodyText = `The tail worker encountered an error while processing traces.\n\nTrace count: ${traces.length}`;
				const body = degraded ? `${DEGRADED_COOLDOWN_MARKER}\n\n${bodyText}` : bodyText;
				const raw = buildRawEmail(subject, body, env.TO_ADDRESS);
				await sendEmail(env, raw);
			} catch (fallbackErr) {
				console.error('Fallback email also failed', fallbackErr);
			}
		}
	},
};
