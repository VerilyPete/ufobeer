/**
 * Tests for application-wide constants.
 *
 * Documents the exact values of all exported constants from src/constants.ts.
 * These tests catch inadvertent changes to values that affect business logic
 * across the codebase (cleanup thresholds, ABV validation, rate limiting, etc.).
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_CLEANUP_LENGTH_RATIO,
  MAX_CLEANUP_LENGTH_RATIO,
  ABV_CONFIDENCE_FROM_DESCRIPTION,
  ABV_CONFIDENCE_FROM_PERPLEXITY,
  MAX_BEER_ABV,
  MIN_BEER_ABV,
  AUDIT_CLEANUP_PROBABILITY,
  AUDIT_RETENTION_DAYS,
  D1_MAX_PARAMS_PER_STATEMENT,
  D1_MAX_STATEMENTS_PER_BATCH,
} from '../src/constants';

describe('AI cleanup constants', () => {
  it('should set MIN_CLEANUP_LENGTH_RATIO to 0.7', () => {
    expect(MIN_CLEANUP_LENGTH_RATIO).toBe(0.7);
  });

  it('should set MAX_CLEANUP_LENGTH_RATIO to 1.1', () => {
    expect(MAX_CLEANUP_LENGTH_RATIO).toBe(1.1);
  });

  it('should set ABV_CONFIDENCE_FROM_DESCRIPTION to 0.9', () => {
    expect(ABV_CONFIDENCE_FROM_DESCRIPTION).toBe(0.9);
  });

  it('should set ABV_CONFIDENCE_FROM_PERPLEXITY to 0.7', () => {
    expect(ABV_CONFIDENCE_FROM_PERPLEXITY).toBe(0.7);
  });
});

describe('ABV validation constants', () => {
  it('should set MAX_BEER_ABV to 70', () => {
    expect(MAX_BEER_ABV).toBe(70);
  });

  it('should set MIN_BEER_ABV to 0', () => {
    expect(MIN_BEER_ABV).toBe(0);
  });
});

describe('audit and cleanup constants', () => {
  it('should set AUDIT_CLEANUP_PROBABILITY to 0.001', () => {
    expect(AUDIT_CLEANUP_PROBABILITY).toBe(0.001);
  });

  it('should set AUDIT_RETENTION_DAYS to 30', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(30);
  });
});

describe('D1 batching constants', () => {
  it('should set D1_MAX_PARAMS_PER_STATEMENT to 90', () => {
    expect(D1_MAX_PARAMS_PER_STATEMENT).toBe(90);
  });

  it('should set D1_MAX_STATEMENTS_PER_BATCH to 100', () => {
    expect(D1_MAX_STATEMENTS_PER_BATCH).toBe(100);
  });
});
