export type AuditRow = { readonly id: string; readonly original: string; readonly hash: string | null };
export type Mismatch = { readonly id: string; readonly stored: string | null; readonly expected: string };
export function hashText(text: string): string;
export function findMismatches(rows: readonly AuditRow[]): Mismatch[];
