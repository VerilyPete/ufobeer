/**
 * Structured logging utilities for consistent log format.
 *
 * All logs are JSON-formatted for easy parsing in Cloudflare's dashboard.
 */

export interface LogData {
  [key: string]: unknown;
}

/**
 * Log an informational event.
 * @param event - Event name (e.g., 'beer.sync.complete')
 * @param data - Additional context data
 */
export function log(event: string, data: LogData = {}): void {
  console.log(JSON.stringify({
    level: 'info',
    event,
    ...data,
    timestamp: Date.now(),
  }));
}

/**
 * Log a warning event.
 * @param event - Event name
 * @param data - Additional context data
 */
export function logWarn(event: string, data: LogData = {}): void {
  console.warn(JSON.stringify({
    level: 'warn',
    event,
    ...data,
    timestamp: Date.now(),
  }));
}

/**
 * Log an error event.
 * @param event - Event name
 * @param error - Error object or message
 * @param data - Additional context data
 */
export function logError(
  event: string,
  error: unknown,
  data: LogData = {}
): void {
  console.error(JSON.stringify({
    level: 'error',
    event,
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : String(error),
    ...data,
    timestamp: Date.now(),
  }));
}

/**
 * Log with request context.
 * @param requestId - Request ID for correlation
 * @param event - Event name
 * @param data - Additional context data
 */
export function logWithContext(
  requestId: string,
  event: string,
  data: LogData = {}
): void {
  log(event, { requestId, ...data });
}

/**
 * Truncate a value for logging.
 * @param value - Value to truncate
 * @param maxLength - Maximum string length
 * @returns Truncated string representation
 */
export function truncateForLog(value: unknown, maxLength: number = 500): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength) + `... [truncated, ${str.length - maxLength} chars]`;
}
