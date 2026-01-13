/**
 * Unit tests for date utility functions.
 *
 * Tests cover month-end calculations for all month types:
 * - 28-day months (February non-leap)
 * - 29-day months (February leap year)
 * - 30-day months (Apr, Jun, Sep, Nov)
 * - 31-day months (Jan, Mar, May, Jul, Aug, Oct, Dec)
 *
 * This tests fix for Issue 3.3: Month-End Date Bug where
 * hardcoded '-31' suffix caused incorrect date ranges in
 * Feb, Apr, Jun, Sep, Nov.
 */

import { describe, it, expect } from 'vitest';
import { getToday, getMonthStart, getMonthEnd } from '../../src/utils/date';

describe('DateUtils', () => {
  describe('getToday', () => {
    it('should return date in YYYY-MM-DD format', () => {
      const result = getToday(new Date('2025-06-15T12:00:00Z'));
      expect(result).toBe('2025-06-15');
    });

    it('should handle single-digit months with zero padding', () => {
      const result = getToday(new Date('2025-03-05T00:00:00Z'));
      expect(result).toBe('2025-03-05');
    });

    it('should handle end of year', () => {
      const result = getToday(new Date('2025-12-31T23:59:59Z'));
      expect(result).toBe('2025-12-31');
    });

    it('should handle beginning of year', () => {
      const result = getToday(new Date('2025-01-01T00:00:00Z'));
      expect(result).toBe('2025-01-01');
    });
  });

  describe('getMonthStart', () => {
    it('should return first day of month', () => {
      const result = getMonthStart(new Date('2025-06-15'));
      expect(result).toBe('2025-06-01');
    });

    it('should handle January', () => {
      const result = getMonthStart(new Date('2025-01-31'));
      expect(result).toBe('2025-01-01');
    });

    it('should handle December', () => {
      const result = getMonthStart(new Date('2025-12-15'));
      expect(result).toBe('2025-12-01');
    });

    it('should pad single-digit months', () => {
      const result = getMonthStart(new Date('2025-02-28'));
      expect(result).toBe('2025-02-01');
    });
  });

  describe('getMonthEnd', () => {
    describe('February (28/29 days)', () => {
      it('should return 28 for February 2025 (non-leap year)', () => {
        const result = getMonthEnd(new Date('2025-02-15'));
        expect(result).toBe('2025-02-28');
      });

      it('should return 29 for February 2024 (leap year)', () => {
        const result = getMonthEnd(new Date('2024-02-15'));
        expect(result).toBe('2024-02-29');
      });

      it('should return 29 for February 2028 (leap year)', () => {
        const result = getMonthEnd(new Date('2028-02-01'));
        expect(result).toBe('2028-02-29');
      });

      it('should return 28 for February 2100 (non-leap century year)', () => {
        // Century years are not leap years unless divisible by 400
        const result = getMonthEnd(new Date('2100-02-15'));
        expect(result).toBe('2100-02-28');
      });

      it('should return 29 for February 2000 (leap century year)', () => {
        // Years divisible by 400 are leap years
        const result = getMonthEnd(new Date('2000-02-15'));
        expect(result).toBe('2000-02-29');
      });
    });

    describe('30-day months (Apr, Jun, Sep, Nov)', () => {
      it('should return 30 for April', () => {
        const result = getMonthEnd(new Date('2025-04-15'));
        expect(result).toBe('2025-04-30');
      });

      it('should return 30 for June', () => {
        const result = getMonthEnd(new Date('2025-06-15'));
        expect(result).toBe('2025-06-30');
      });

      it('should return 30 for September', () => {
        const result = getMonthEnd(new Date('2025-09-15'));
        expect(result).toBe('2025-09-30');
      });

      it('should return 30 for November', () => {
        const result = getMonthEnd(new Date('2025-11-15'));
        expect(result).toBe('2025-11-30');
      });
    });

    describe('31-day months (Jan, Mar, May, Jul, Aug, Oct, Dec)', () => {
      it('should return 31 for January', () => {
        const result = getMonthEnd(new Date('2025-01-15'));
        expect(result).toBe('2025-01-31');
      });

      it('should return 31 for March', () => {
        const result = getMonthEnd(new Date('2025-03-15'));
        expect(result).toBe('2025-03-31');
      });

      it('should return 31 for May', () => {
        const result = getMonthEnd(new Date('2025-05-15'));
        expect(result).toBe('2025-05-31');
      });

      it('should return 31 for July', () => {
        const result = getMonthEnd(new Date('2025-07-15'));
        expect(result).toBe('2025-07-31');
      });

      it('should return 31 for August', () => {
        const result = getMonthEnd(new Date('2025-08-15'));
        expect(result).toBe('2025-08-31');
      });

      it('should return 31 for October', () => {
        const result = getMonthEnd(new Date('2025-10-15'));
        expect(result).toBe('2025-10-31');
      });

      it('should return 31 for December', () => {
        const result = getMonthEnd(new Date('2025-12-15'));
        expect(result).toBe('2025-12-31');
      });
    });

    describe('year boundary handling', () => {
      it('should handle December correctly (no year overflow)', () => {
        // This tests that month + 1 for December (11 + 1 = 12)
        // with day 0 correctly gives December 31, not rolling into next year
        const result = getMonthEnd(new Date('2025-12-25'));
        expect(result).toBe('2025-12-31');
      });

      it('should handle January correctly', () => {
        const result = getMonthEnd(new Date('2025-01-01'));
        expect(result).toBe('2025-01-31');
      });

      it('should handle year transition dates', () => {
        // Test the last day of 2024 and first day of 2025
        const dec2024 = getMonthEnd(new Date('2024-12-31'));
        const jan2025 = getMonthEnd(new Date('2025-01-01'));

        expect(dec2024).toBe('2024-12-31');
        expect(jan2025).toBe('2025-01-31');
      });
    });

    describe('edge cases', () => {
      it('should work when called on first day of month', () => {
        const result = getMonthEnd(new Date('2025-06-01'));
        expect(result).toBe('2025-06-30');
      });

      it('should work when called on last day of month', () => {
        const result = getMonthEnd(new Date('2025-06-30'));
        expect(result).toBe('2025-06-30');
      });

      it('should work for all months sequentially', () => {
        // Comprehensive test: verify all 12 months of 2025
        const expectedDays: Record<number, number> = {
          1: 31,   // January
          2: 28,   // February (2025 is not a leap year)
          3: 31,   // March
          4: 30,   // April
          5: 31,   // May
          6: 30,   // June
          7: 31,   // July
          8: 31,   // August
          9: 30,   // September
          10: 31,  // October
          11: 30,  // November
          12: 31,  // December
        };

        for (let month = 1; month <= 12; month++) {
          const dateStr = `2025-${String(month).padStart(2, '0')}-15`;
          const result = getMonthEnd(new Date(dateStr));
          const expectedDay = expectedDays[month];
          const expectedResult = `2025-${String(month).padStart(2, '0')}-${String(expectedDay).padStart(2, '0')}`;
          expect(result).toBe(expectedResult);
        }
      });
    });
  });

  describe('integration: getMonthStart and getMonthEnd together', () => {
    it('should produce valid date range for February', () => {
      const feb = new Date('2025-02-15');
      const start = getMonthStart(feb);
      const end = getMonthEnd(feb);

      expect(start).toBe('2025-02-01');
      expect(end).toBe('2025-02-28');
      expect(start < end).toBe(true);
    });

    it('should produce valid date range for any month', () => {
      // Test a 30-day month
      const june = new Date('2025-06-15');
      expect(getMonthStart(june)).toBe('2025-06-01');
      expect(getMonthEnd(june)).toBe('2025-06-30');

      // Test a 31-day month
      const july = new Date('2025-07-15');
      expect(getMonthStart(july)).toBe('2025-07-01');
      expect(getMonthEnd(july)).toBe('2025-07-31');
    });
  });
});
