import type { z } from 'zod';

export function mapZodIssueToErrorCode(issue: z.ZodIssue): string {
  const colonIdx = issue.message.indexOf(':');
  if (colonIdx > 0 && /^[A-Z_]+$/.test(issue.message.slice(0, colonIdx))) {
    return issue.message.slice(0, colonIdx);
  }
  return 'INVALID_REQUEST';
}

export function extractZodErrorMessage(issue: z.ZodIssue): string {
  const colonIdx = issue.message.indexOf(':');
  if (colonIdx > 0 && /^[A-Z_]+$/.test(issue.message.slice(0, colonIdx))) {
    return issue.message.slice(colonIdx + 1).trim();
  }
  return issue.message;
}
