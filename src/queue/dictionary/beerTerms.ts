/**
 * Beer vocabulary missing from the general English word list. The cleanup
 * guard treats these as real words: they are never "corrected" into other
 * words, and a misspelling one edit away may be corrected into them.
 *
 * Add a term when the offline cleanup evaluation shows a real beer word
 * being rejected or altered. Keep entries lowercase.
 */
export const BEER_TERMS: readonly string[] = [
  // Hop varieties
  'ahtanum', 'amarillo', 'azacca', 'belma', 'bravo', 'calypso', 'cashmere', 'citra',
  'ekuanot', 'galena', 'hallertau', 'hallertauer', 'idaho', 'kazbek', 'mandarina',
  'motueka', 'nelson', 'riwaka', 'saaz', 'sabro', 'sauvin', 'simcoe', 'sorachi',
  'spalt', 'strata', 'talus', 'tettnang', 'tettnanger', 'wakatu', 'willamette', 'zappa',
  'fuggle', 'fuggles', 'goldings', 'chinook', 'centennial', 'cascade', 'columbus',
  // Styles
  'altbier', 'barleywine', 'berliner', 'bière', 'biere', 'bock', 'brut', 'doppelbock',
  'dubbel', 'dunkel', 'dunkelweizen', 'eisbock', 'festbier', 'framboise', 'gose',
  'grisette', 'gueuze', 'geuze', 'hefe', 'hefeweizen', 'helles', 'kellerbier', 'kölsch',
  'kolsch', 'kriek', 'lambic', 'maibock', 'märzen', 'marzen', 'neipa', 'oktoberfest',
  'pilsener', 'pilsner', 'pils', 'quad', 'quadrupel', 'rauchbier', 'saison', 'schwarzbier',
  'tripel', 'weisse', 'weissbier', 'weizen', 'weizenbock', 'witbier', 'zwickel',
  // Brewing and tasting terms
  'adjunct', 'adjuncts', 'brett', 'bretty', 'brettanomyces', 'cacao', 'caramalt',
  'crowler', 'crushable', 'dryhopped', 'esters', 'estery', 'firkin', 'hoppy', 'hoppiness',
  'ibu', 'ibus', 'kveik', 'lacto', 'lactobacillus', 'lactose', 'malty', 'maltiness',
  'melanoidin', 'mouthfeel', 'nitro', 'pedio', 'phenolic', 'piloncillo', 'quaffable',
  'sessionable', 'sparge', 'tepache', 'wort', 'yuzu',
];
