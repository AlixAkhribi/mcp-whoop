import { z } from "zod";

/**
 * One metric's spread over the days that carried it. Every field is null when
 * no day did: absence is an answer, and a zero would be a false one.
 */
export const spreadSchema = z.object({
	mean: z.number().nullable(),
	min: z.number().nullable(),
	max: z.number().nullable(),
});

export type Spread = z.infer<typeof spreadSchema>;

/** Means read to the hundredth; the readings themselves read as WHOOP sent. */
export function roundToHundredths(value: number): number {
	return Math.round(value * 100) / 100;
}

/** The mean, low and high of the values present, the mean rounded as asked. */
export function calculateSpread(
	values: readonly number[],
	round: (value: number) => number,
): Spread {
	if (values.length === 0) {
		return { mean: null, min: null, max: null };
	}
	const total = values.reduce((sum, value) => sum + value, 0);

	return {
		mean: round(total / values.length),
		min: Math.min(...values),
		max: Math.max(...values),
	};
}
