/**
 * Unit tests for beer sync endpoint handlers.
 *
 * Tests validateBeerInput function and syncBeersWithBatchHandling function
 * for proper input validation and D1 batch failure handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { validateBeerInput, syncBeersWithBatchHandling } from '../../src/handlers/beers';
import { SYNC_CONSTANTS } from '../../src/types';

describe('handleBeerSync', () => {
  describe('validateBeerInput', () => {
    it('should reject empty id', () => {
      const result = validateBeerInput({ id: '', brew_name: 'Test' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('id');
    });

    it('should reject missing id', () => {
      const result = validateBeerInput({ brew_name: 'Test' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('id');
    });

    it('should reject non-string id', () => {
      const result = validateBeerInput({ id: 123, brew_name: 'Test' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('id');
    });

    it('should reject id exceeding max length', () => {
      const result = validateBeerInput({
        id: 'x'.repeat(SYNC_CONSTANTS.MAX_ID_LENGTH + 1),
        brew_name: 'Test'
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('id');
      expect(result.error).toContain('max');
    });

    it('should accept id at max length', () => {
      const result = validateBeerInput({
        id: 'x'.repeat(SYNC_CONSTANTS.MAX_ID_LENGTH),
        brew_name: 'Test Beer'
      });
      expect(result.valid).toBe(true);
    });

    it('should reject missing brew_name', () => {
      const result = validateBeerInput({ id: '123' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('brew_name');
    });

    it('should reject empty brew_name', () => {
      const result = validateBeerInput({ id: '123', brew_name: '' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('brew_name');
    });

    it('should reject non-string brew_name', () => {
      const result = validateBeerInput({ id: '123', brew_name: 456 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('brew_name');
    });

    it('should reject brew_name exceeding max length', () => {
      const result = validateBeerInput({
        id: '123',
        brew_name: 'x'.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH + 1)
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('brew_name');
      expect(result.error).toContain('max length');
    });

    it('should accept brew_name at max length', () => {
      const result = validateBeerInput({
        id: '123',
        brew_name: 'x'.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH)
      });
      expect(result.valid).toBe(true);
    });

    it('should reject brew_description exceeding max length', () => {
      const result = validateBeerInput({
        id: '123',
        brew_name: 'Test',
        brew_description: 'x'.repeat(SYNC_CONSTANTS.MAX_DESC_LENGTH + 1)
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('brew_description');
      expect(result.error).toContain('max length');
    });

    it('should accept brew_description at max length', () => {
      const result = validateBeerInput({
        id: '123',
        brew_name: 'Test',
        brew_description: 'x'.repeat(SYNC_CONSTANTS.MAX_DESC_LENGTH)
      });
      expect(result.valid).toBe(true);
    });

    it('should accept valid input with all fields', () => {
      const result = validateBeerInput({
        id: '123',
        brew_name: 'Test Beer',
        brewer: 'Test Brewery',
        brew_description: 'A great beer'
      });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid input with minimal fields', () => {
      const result = validateBeerInput({
        id: '123',
        brew_name: 'Test Beer'
      });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid input without brew_description', () => {
      const result = validateBeerInput({
        id: '123',
        brew_name: 'Test Beer',
        brewer: 'Test Brewery'
      });
      expect(result.valid).toBe(true);
    });

    it('should accept valid input with undefined brew_description', () => {
      const result = validateBeerInput({
        id: '123',
        brew_name: 'Test Beer',
        brew_description: undefined
      });
      expect(result.valid).toBe(true);
    });

    it('should reject null input', () => {
      const result = validateBeerInput(null);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('object');
    });

    it('should reject undefined input', () => {
      const result = validateBeerInput(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('object');
    });

    it('should reject non-object input', () => {
      const result = validateBeerInput('not an object');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('object');
    });
  });

  describe('syncBeersWithBatchHandling', () => {
    it('should report succeeded count correctly when all succeed', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([
          { success: true },
          { success: true },
          { success: true }
        ])
      };
      const statements = [{}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle partial failures', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([
          { success: true },
          { success: false, error: 'Constraint violation' },
          { success: true }
        ])
      };
      const statements = [{}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Statement 1 failed');
      expect(result.errors[0]).toContain('Constraint violation');
    });

    it('should handle multiple partial failures', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([
          { success: false, error: 'Error 1' },
          { success: true },
          { success: false, error: 'Error 2' },
          { success: false, error: 'Error 3' },
          { success: true }
        ])
      };
      const statements = [{}, {}, {}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(3);
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0]).toContain('Statement 0 failed');
      expect(result.errors[1]).toContain('Statement 2 failed');
      expect(result.errors[2]).toContain('Statement 3 failed');
    });

    it('should handle total batch failure', async () => {
      const mockDb = {
        batch: vi.fn().mockRejectedValue(new Error('D1 unavailable'))
      };
      const statements = [{}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(3);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Batch failed');
      expect(result.errors[0]).toContain('D1 unavailable');
    });

    it('should handle empty statement array', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([])
      };
      const statements: D1PreparedStatement[] = [];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle results without explicit error message', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([
          { success: true },
          { success: false }, // No error property
          { success: true }
        ])
      };
      const statements = [{}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain('Unknown error');
    });

    it('should handle non-Error rejection', async () => {
      const mockDb = {
        batch: vi.fn().mockRejectedValue('String error')
      };
      const statements = [{}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(2);
      expect(result.errors[0]).toContain('Batch failed');
      expect(result.errors[0]).toContain('String error');
    });
  });
});
