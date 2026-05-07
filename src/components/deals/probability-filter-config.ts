export const PROBABILITY_BUCKETS = [
  { value: "0-19", label: "0-19%", min: 0, max: 19 },
  { value: "20-39", label: "20-39%", min: 20, max: 39 },
  { value: "40-59", label: "40-59%", min: 40, max: 59 },
  { value: "60-79", label: "60-79%", min: 60, max: 79 },
  { value: "80-100", label: "80-100%", min: 80, max: 100 },
] as const;

export type ProbabilityBucketValue = (typeof PROBABILITY_BUCKETS)[number]["value"];

export function isProbabilityBucketValue(v: string): v is ProbabilityBucketValue {
  return PROBABILITY_BUCKETS.some((b) => b.value === v);
}

export function expandProbabilityBuckets(
  values: ProbabilityBucketValue[],
): { gte: number; lte: number }[] {
  return values
    .map((v) => PROBABILITY_BUCKETS.find((b) => b.value === v))
    .filter((b): b is (typeof PROBABILITY_BUCKETS)[number] => Boolean(b))
    .map((b) => ({ gte: b.min, lte: b.max }));
}
