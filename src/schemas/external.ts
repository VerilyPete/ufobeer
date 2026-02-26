import { z } from 'zod';

export const PerplexityResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().optional(),
      }).optional(),
    })
  ).optional().default([]),
});

export const FlyingSaucerBeerSchema = z.object({
  id: z.string().min(1),
  brew_name: z.string(),
  brewer: z.string().optional(),
  brew_description: z.string().optional(),
  container_type: z.string().optional(),
}).passthrough();

export const FlyingSaucerResponseSchema = z.array(z.unknown());

export type PerplexityResponse = z.infer<typeof PerplexityResponseSchema>;
export type FlyingSaucerBeer = z.infer<typeof FlyingSaucerBeerSchema>;
