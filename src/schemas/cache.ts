import { z } from 'zod';
import { FlyingSaucerBeerSchema } from './external';

const CachedBeerSchema = FlyingSaucerBeerSchema.extend({
  enriched_abv: z.number().nullable(),
  enrichment_confidence: z.number().nullable(),
  enrichment_source: z.string().nullable(),
});

export const CachedBeersArraySchema = z.array(CachedBeerSchema);

export type CachedBeer = z.infer<typeof CachedBeerSchema>;
