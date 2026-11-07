import { describe, expect, it } from 'vitest';
import { cleanBeerName } from '../../src/utils/beer-name';

describe('cleanBeerName', () => {
  it.each([
    ["New Holland Dragon\\'s Milk Reserve - Triple Mash Stout (BTL)", "New Holland Dragon's Milk Reserve - Triple Mash Stout (BTL)"],
    ["Brasserie D\\'achouffe", "Brasserie D'achouffe"],
    ['The \\"Big\\" Ale', 'The "Big" Ale'],
  ])('removes the backslash from an escaped quote: %s', (name, expected) => {
    expect(cleanBeerName(name)).toBe(expected);
  });

  it('repairs mojibake', () => {
    expect(cleanBeerName('Eureka Heights Un Poquito MÃ¡s')).toBe('Eureka Heights Un Poquito Más');
  });

  it.each([
    ['True Anomaly Valentina ', 'True Anomaly Valentina'],
    ['Lagunitas Brewing  Company', 'Lagunitas Brewing Company'],
    ['3 Fonteinen Hommage 19|20 Blend 10  (BTL)', '3 Fonteinen Hommage 19|20 Blend 10 (BTL)'],
  ])('collapses and trims whitespace: %j', (name, expected) => {
    expect(cleanBeerName(name)).toBe(expected);
  });

  it.each([
    ['Eureka Heights Un Poquito MÃƒÂ¡s', 'Eureka Heights Un Poquito Más'],
    ["Blue Owl Bob\\\\'s Cold One", "Blue Owl Bob's Cold One"],
  ])('repairs every layer in one pass, so cleaning again changes nothing: %s', (name, expected) => {
    expect(cleanBeerName(name)).toBe(expected);
    expect(cleanBeerName(cleanBeerName(name))).toBe(expected);
  });

  it('leaves a name with more mojibake layers than real data ever has exactly as sent', () => {
    const name = `${'Â'.repeat(4999)}¢`;

    expect(cleanBeerName(name)).toBe(name);
  });

  it('scans long runs of backslashes that escape nothing in linear time', () => {
    const names = Array.from({ length: 200 }, (_, index) => `${index}${'\\'.repeat(5000)}`);

    const started = performance.now();
    const cleaned = names.map(cleanBeerName);
    const elapsedMs = performance.now() - started;

    expect(cleaned).toEqual(names);
    expect(elapsedMs).toBeLessThan(500);
  });

  it.each([
    'Clausthaler Classic N/A (BTL)',
    'Mystery Beer (CAN/BTL)',
    'Boulevard Tank 7 w/ Glass',
    '(512) Helles Lager',
    'New Magnolia Dry Hopped Kolsh',
    'AC\\DC Lager',
    "Green's Gluten Free Tripel Ale (CAN)",
  ])('leaves a name that needs no repair unchanged: %s', (name) => {
    expect(cleanBeerName(name)).toBe(name);
  });
});
