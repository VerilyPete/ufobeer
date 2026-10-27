/**
 * The only spelling fixes the cleanup guard accepts from the model. Every
 * pair was reviewed by a person against the beer descriptions it occurs in.
 * Candidate pairs are proposed by scripts/find-spelling-candidates.mjs; a
 * pair is added here only after review, because a plausible correction can
 * still change meaning ("tripel" is a beer style, not a typo of "triple").
 *
 * Pairs adapted from codespell's dictionary.txt
 * (https://github.com/codespell-project/codespell), a derivative work of
 * English Wikipedia, licensed under the Creative Commons Attribution-ShareAlike
 * 3.0 License (https://creativecommons.org/licenses/by-sa/3.0/). This list is
 * released under the same licence.
 *
 * Keys are lowercase misspellings; values are lowercase corrections.
 */
export const APPROVED_SPELLING_CORRECTIONS: ReadonlyMap<string, string> = new Map([
  ['afficianados', 'aficionados'],
  ['alchohol', 'alcohol'],
  ['artifical', 'artificial'],
  ['ballanced', 'balanced'],
  ['brillant', 'brilliant'],
  ['conjuntion', 'conjunction'],
  ['endevour', 'endeavour'],
  ['enought', 'enough'],
  ['fnish', 'finish'],
  ['imorted', 'imported'],
  ['intial', 'initial'],
  ['marshmellows', 'marshmallows'],
  ['noticable', 'noticeable'],
  ['opague', 'opaque'],
  ['perserved', 'preserved'],
  ['pleasent', 'pleasant'],
  ['proprotions', 'proportions'],
  ['slighty', 'slightly'],
  ['stil', 'still'],
]);
