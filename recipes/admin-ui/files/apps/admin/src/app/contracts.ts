import { z } from 'zod';

const stockSchema = z.object({
  available: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const titleSchema = z.object({
  id: z.string(),
  name: z.string(),
  genre: z.string(),
  releaseYear: z.number().int(),
  availability: stockSchema,
});

const rentalSchema = z.object({
  id: z.string(),
  titleName: z.string(),
  copyBarcode: z.string(),
  customerName: z.string(),
  dueAt: z.string(),
});

export const titlesResponseSchema = z.object({
  titles: z.array(titleSchema),
});

export const rentalsResponseSchema = z.object({
  rentals: z.array(rentalSchema),
});

export type TitleSummary = z.infer<typeof titleSchema>;
export type RentalSummary = z.infer<typeof rentalSchema>;
