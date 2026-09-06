import {
  rentalsResponseSchema,
  titlesResponseSchema,
  type RentalSummary,
  type TitleSummary,
} from './contracts';

const apiOrigin = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3333';

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${apiOrigin}/api${path}`);

  if (!response.ok) {
    throw new Error(`API request failed with ${response.status}`);
  }

  return response.json();
}

export async function listTitles(): Promise<TitleSummary[]> {
  return titlesResponseSchema.parse(await get('/titles')).titles;
}

export async function listRentals(): Promise<RentalSummary[]> {
  return rentalsResponseSchema.parse(await get('/rentals')).rentals;
}
