/**
 * Date utility functions for quota and scheduling calculations.
 *
 * These functions provide consistent date string formatting used throughout
 * the application for quota tracking, enrichment limits, and scheduling.
 *
 * @module utils/date
 */

/**
 * Get today's date in YYYY-MM-DD format.
 * @param date - Date object (defaults to current date)
 * @returns Date string in YYYY-MM-DD format
 */
export function getToday(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Get the first day of the month for a given date.
 * @param date - Date object (defaults to current date)
 * @returns Date string for first of month (YYYY-MM-01)
 */
export function getMonthStart(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/**
 * Get the last day of the month for a given date.
 *
 * Uses the JavaScript Date rollover trick: passing 0 as the day
 * to the Date constructor gives the last day of the previous month.
 * So `new Date(year, month + 1, 0)` gives the last day of `month`.
 *
 * @param date - Date object (defaults to current date)
 * @returns Date string for last day of month (YYYY-MM-DD)
 */
export function getMonthEnd(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const monthStr = String(month + 1).padStart(2, '0');
  return `${year}-${monthStr}-${String(lastDay).padStart(2, '0')}`;
}
