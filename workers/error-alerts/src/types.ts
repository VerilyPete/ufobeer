type AlertEnv = {
	readonly SEND_EMAIL: SendEmail;
	readonly TO_ADDRESS: string;
	readonly COOLDOWN_KV: KVNamespace;
};

export type { AlertEnv as Env };
