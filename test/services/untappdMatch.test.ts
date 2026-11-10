import { describe, expect, it } from 'vitest';
import { abvFromPage, isUntappdBeerUrl, matchesBeer, parseUntappdTitle } from '../../src/services/untappdMatch';
import anniversary from '../fixtures/exa/18th-anniversary.json';
import kaiser from '../fixtures/exa/avery-kaiser.json';
import tank7 from '../fixtures/exa/boulevard-tank-7.json';
import pecanPorter from '../fixtures/exa/512-wba-pecan-porter.json';
import mangoLittleThing from '../fixtures/exa/sierra-nevada-mango-little-thing.json';

type Recorded = { readonly results: ReadonlyArray<{ readonly url: string; readonly title: string; readonly text: string }> };

function firstAbv(recorded: Recorded, ours: { ourName: string; ourBrewer: string }): number | null {
  for (const result of recorded.results) {
    const title = parseUntappdTitle(result.title);
    if (!isUntappdBeerUrl(result.url) || title === null || !matchesBeer(ours, title)) continue;
    const abv = abvFromPage(result.text, title);
    if (abv !== null) return abv;
  }
  return null;
}

describe('parseUntappdTitle', () => {
  it.each([
    ['18th Anniversary - (512) Brewing Company | Photos', { beer: '18th Anniversary', brewery: '(512) Brewing Company' }],
    ['17th Anniversary - (512) Brewing Company - Untappd', { beer: '17th Anniversary', brewery: '(512) Brewing Company' }],
    ["D'Or - Tropical Fruit Beer - Brouwerij Lindemans - Untappd", { beer: "D'Or - Tropical Fruit Beer", brewery: 'Brouwerij Lindemans' }],
    ['Tank 7 - Boulevard Brewing Co.', { beer: 'Tank 7', brewery: 'Boulevard Brewing Co.' }],
    ['The Kaiser - Avery Brewing Co. - Variants - Untappd', { beer: 'The Kaiser', brewery: 'Avery Brewing Co.' }],
  ])('parses %j', (title, expected) => {
    expect(parseUntappdTitle(title)).toEqual(expected);
  });

  it.each(['Untappd', 'Just A Name - Untappd', ''])('returns null for %j (no beer and brewery)', (title) => {
    expect(parseUntappdTitle(title)).toBeNull();
  });
});

describe('isUntappdBeerUrl', () => {
  it.each([
    'https://untappd.com/b/512-brewing-company-18th-anniversary/7661138',
    'https://untappd.com/b/512-brewing-company-18th-anniversary/7661138/photos',
    'https://www.untappd.com/b/avery-brewing-co-the-kaiser/20840',
  ])('accepts beer page %j', (url) => {
    expect(isUntappdBeerUrl(url)).toBe(true);
  });

  it.each([
    'https://untappd.com/512Brewing',
    'https://untappd.com/boulevard/beer',
    'https://untappd.com/shop/items/4372-boulevard-brewing-co-tank-7',
    'https://business.untappd.com/b/anything/1',
    'https://awards.untappd.com/beers/5741/',
    'https://untappd.com.evil.example/b/x/1',
    'http://untappd.com/b/x/1',
    'not a url',
  ])('rejects %j', (url) => {
    expect(isUntappdBeerUrl(url)).toBe(false);
  });
});

describe('matchesBeer', () => {
  const title = (t: string) => {
    const parsed = parseUntappdTitle(t);
    if (parsed === null) throw new Error(`unparseable title ${t}`);
    return parsed;
  };

  it.each([
    ['(512) 18th Anniversary', '(512) Brewing Co.', '18th Anniversary - (512) Brewing Company | Photos', true],
    ['(512) 18th Anniversary', '(512) Brewing Co.', '17th Anniversary - (512) Brewing Company - Untappd', false],
    ['(512) 18th Anniversary', '(512) Brewing Co.', 'Hazy Double IPA - (512) Brewing Company - Untappd', false],
    ['(512) Whiskey Barrel Aged Pecan Porter', '(512) Brewing Co.', '(512) Whiskey Barrel Aged Double Pecan Porter - (512) Brewing Company - Untappd', false],
    ['Avery Kaiser (CAN)', 'Avery Brewing Co.', 'The Kaiser - Avery Brewing Co. - Untappd', true],
    ['Firestone Walker Pivo Pilsner', 'Firestone Walker Brewing', 'Pivo Pils - Firestone Walker Brewing Company - Untappd', false],
    ['(2024) Reserve', 'Acme Brewing', '(2025) Reserve - Acme Brewing - Untappd', false],
    ['(2024) Reserve', 'Acme Brewing', '(2024) Reserve - Acme Brewing - Untappd', true],
    ['Light', 'Lone Star Brewing', 'Light - Lone Pint Brewery - Untappd', false],
    ['Traquair House (BTL)', 'Traquair', 'House Ale - Traquair House Brewery - Untappd', false],
    ['Double IPA', 'Acme Brewing', 'Double Double IPA - Acme Brewing - Untappd', false],
    ['Reserve', 'Acme Brewing', 'Reserve X - Acme Brewing - Untappd', false],
    ['Reserve', 'X Brewing', 'Reserve X - X Brewing - Untappd', false],
    ['Sierra Nevada Pale Ale', 'Sierra Nevada Brewing Co.', 'Pale Ale - Sierra Nevada Brewing Co. - Untappd', true],
    ['Lindemans Kriek', "Brouwerij Lindeman's", 'Kriek - Brouwerij Lindemans - Untappd', true],
    ['Kaiser', 'Avery Brewing Co.', 'The Kaiser (2026) - Avery Brewing Co. - Untappd', false],
    ['Pale Ale', 'Brewing Co.', 'Pale Ale - Brewing Company - Untappd', false],
    ['Pale Ale', 'Traquair', 'Pale Ale - Traquair House Brewery - Untappd', false],
    ['Double IPA', 'Double Mountain Brewery', 'IPA - Double Mountain Brewery - Untappd', false],
    ['Reserve', 'X Brewing', 'X X Reserve - X Brewing - Untappd', false],
    ['Double Mountain IPA', 'Double Mountain Brewery', 'IPA - Double Mountain Brewery - Untappd', true],
    ['Reserve', 'Acme Brewing', 'Reserve - Acme Other Brewing - Untappd', false],
    ['Reserve', 'Acme Brewing', 'Reserve - Acme x Other Brewing - Untappd', false],
    ['Lightning Panther', 'Eureka Heights', 'Lightning Panther - Eureka Heights Brew Co - Untappd', true],
    ['桜 IPA', 'Acme Brewing', '梅 IPA - Acme Brewing - Untappd', false],
    ['桜 IPA', 'Acme Brewing', '桜 IPA - Acme Brewing - Untappd', true],
    ['Reserve', 'Acme Brewing', 'Reserve - 東京 Acme Brewing - Untappd', false],
    ['का IPA', 'Acme Brewing', 'कि IPA - Acme Brewing - Untappd', false],
    ['กิ IPA', 'Acme Brewing', 'กุ IPA - Acme Brewing - Untappd', false],
    ['Reserve', 'का Brewing', 'Reserve - कि Brewing - Untappd', false],
    ['का IPA', 'का Brewing', 'का IPA - का Brewing - Untappd', true],
    ['Kölsch', 'Acme Brewing', 'Kolsch - Acme Brewing - Untappd', true],
    ['й IPA', 'Acme Brewing', 'и IPA - Acme Brewing - Untappd', false],
    ['Reserve', 'й Brewing', 'Reserve - и Brewing - Untappd', false],
    ['ё Lager', 'Acme Brewing', 'е Lager - Acme Brewing - Untappd', false],
    ['Crème Brûlée Stout', 'Acme Brewing', 'Creme Brulee Stout - Acme Brewing - Untappd', true],
    ['Kölsch', 'Acme Brewing', 'Ko\u0308lsch - Acme Brewing - Untappd', true],
    ['Avery Kaiser (2026)', 'Avery Brewing Co.', 'The Kaiser (2026) - Avery Brewing Co. - Untappd', true],
  ])('%j by %j against %j matches: %j', (ourName, ourBrewer, untappdTitle, expected) => {
    expect(matchesBeer({ ourName, ourBrewer }, title(untappdTitle))).toBe(expected);
  });

  it('never matches a beer whose core is empty on both sides', () => {
    expect(matchesBeer({ ourName: 'The Ale', ourBrewer: 'Acme Brewing' }, { beer: 'Beer', brewery: 'Acme Brewing' })).toBe(false);
  });
});

describe('abvFromPage', () => {
  const target = { beer: '18th Anniversary', brewery: '(512) Brewing Company' };
  const page = (body: string) => `18th Anniversary - (512) Brewing Company - Untappd\n\n \n\n# 18th Anniversary\n\n (512) Brewing Company \n\n${body}`;
  const counters = 'IPA - Imperial / Double\n\n Total (?) 16 \n\n Unique (?) 16 \n\n Monthly (?) 16 \n\n You 0 \n\n';

  it('reads the stats block that follows the matched heading', () => {
    expect(abvFromPage(page(`${counters} 8% ABV \n\n 30 IBU \n\n(3.84)`), target)).toBe(8);
  });

  it('returns null when the check-in counters are missing, so no line can pose as the style', () => {
    expect(abvFromPage(page(' 8% ABV \n\n 30 IBU \n\n'), target)).toBeNull();
    expect(abvFromPage('# Target\nAcme Brewing\nOther Beer\n8% ABV\n30 IBU', { beer: 'Target', brewery: 'Acme Brewing' })).toBeNull();
  });

  it('reads the stats block when the page has counters but no style line', () => {
    expect(abvFromPage(page(' Total (?) 1.2M+ \n\n Unique (?) 980K+ \n\n Monthly (?) 12,000 \n\n You 0 \n\n 8% ABV \n\n 30 IBU'), target)).toBe(8);
  });

  it('reads a decimal ABV and an N/A IBU', () => {
    expect(abvFromPage(page(`${counters} 8.25% ABV \n\n N/A IBU \n\n`), target)).toBe(8.25);
  });

  it('returns null for an N/A ABV, never a later similar beer', () => {
    expect(abvFromPage(page(`${counters} N/A ABV \n\n N/A IBU \n\n### Similar beers\n\nOther\n\n 8% ABV \n\n 30 IBU`), target)).toBeNull();
  });

  it('returns null when the target has no stats but a related ABV appears early', () => {
    expect(abvFromPage(page(`${counters}Other Beer 8% ABV \n\n`), target)).toBeNull();
  });

  it("returns null when a related beer's complete block sits where the target's should be", () => {
    expect(abvFromPage(page(`${counters}Other Beer\n\n(512) Brewing Company\n\n 8% ABV \n\n 30 IBU \n\n`), target)).toBeNull();
  });

  it("returns null when the text doesn't open with the matched beer's heading", () => {
    const text = `17th Anniversary - (512) Brewing Company - Untappd\n\n# 17th Anniversary\n\n (512) Brewing Company \n\n${counters} 8% ABV \n\n 60 IBU`;
    expect(abvFromPage(text, target)).toBeNull();
  });

  it('returns null when the heading names another brewery', () => {
    const text = `18th Anniversary - Other Brewing - Untappd\n\n# 18th Anniversary\n\n Other Brewing \n\n${counters} 8% ABV \n\n 30 IBU`;
    expect(abvFromPage(text, target)).toBeNull();
  });

  it('returns null when the heading is buried below other content', () => {
    expect(abvFromPage(`Title\n\nSome intro\n\n${page(`${counters} 8% ABV \n\n 30 IBU`)}`, target)).toBeNull();
  });

  it('returns null when the ABV field is past the first 600 characters', () => {
    const longStyle = `${'IPA '.repeat(160)}\n\n Total (?) 16 \n\n Unique (?) 16 \n\n Monthly (?) 16 \n\n You 0 \n\n`;
    expect(abvFromPage(page(`${longStyle} 8% ABV \n\n 30 IBU`), target)).toBeNull();
  });

  it("returns null when another section's heading sits where the style line belongs", () => {
    const text = '# Target\nAcme Brewing\n## Other Beer\nTotal (?) 16\nUnique (?) 16\nMonthly (?) 16\nYou 0\n8% ABV\n30 IBU';
    expect(abvFromPage(text, { beer: 'Target', brewery: 'Acme Brewing' })).toBeNull();
  });

  it('returns null when other lines stand where the check-in counters belong', () => {
    expect(abvFromPage(page('IPA\n\nOther Beer\n\nAcme Brewing\n\nSomething\n\nElse\n\n 8% ABV \n\n 30 IBU'), target)).toBeNull();
  });

  it('returns null when the ABV has no IBU field after it', () => {
    expect(abvFromPage(page(`${counters} 8% ABV \n\n(3.84)`), target)).toBeNull();
  });

  it('returns null for an out-of-range ABV', () => {
    expect(abvFromPage(page(`${counters} 71% ABV \n\n 30 IBU`), target)).toBeNull();
  });
});

describe('recorded Exa responses', () => {
  it('finds 8% for (512) 18th Anniversary', () => {
    expect(firstAbv(anniversary, { ourName: '(512) 18th Anniversary', ourBrewer: '(512) Brewing Co.' })).toBe(8);
  });

  it('finds 8% for Avery Kaiser from the main beer page, not a vintage', () => {
    expect(firstAbv(kaiser, { ourName: 'Avery Kaiser (CAN)', ourBrewer: 'Avery Brewing Co.' })).toBe(8);
  });

  it('finds 8.5% for Boulevard Tank 7', () => {
    expect(firstAbv(tank7, { ourName: 'Boulevard Tank 7', ourBrewer: 'Boulevard Brewing Co.' })).toBe(8.5);
  });

  it('finds 6% for Sierra Nevada Mango Little Thing (CAN)', () => {
    expect(firstAbv(mangoLittleThing, { ourName: 'Sierra Nevada Mango Little Thing (CAN)', ourBrewer: 'Sierra Nevada Brewing Co.' })).toBe(6);
  });

  it('finds 8% for an exact vintage, The Kaiser (2026), from its vintage page', () => {
    expect(firstAbv(kaiser, { ourName: 'Avery Kaiser (2026)', ourBrewer: 'Avery Brewing Co.' })).toBe(8);
  });

  it('reads the Kaiser variants page on its own', () => {
    const variants = kaiser.results.find(r => r.url.endsWith('/variants'));
    expect(variants).toBeDefined();
    const title = parseUntappdTitle(variants!.title);
    expect(title).not.toBeNull();
    expect(matchesBeer({ ourName: 'Avery Kaiser (CAN)', ourBrewer: 'Avery Brewing Co.' }, title!)).toBe(true);
    expect(abvFromPage(variants!.text, title!)).toBe(8);
  });

  it('refuses the Double Pecan Porter and its vintages for the plain Pecan Porter', () => {
    expect(firstAbv(pecanPorter, { ourName: '(512) Whiskey Barrel Aged Pecan Porter', ourBrewer: '(512) Brewing Co.' })).toBeNull();
  });

  it('reads the matched page only: the 17th Anniversary result never answers for the 18th', () => {
    const seventeenth = anniversary.results.find(r => r.url.includes('17th-anniversary'));
    expect(seventeenth).toBeDefined();
    expect(abvFromPage(seventeenth!.text, { beer: '18th Anniversary', brewery: '(512) Brewing Company' })).toBeNull();
  });
});
