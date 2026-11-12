export type ScalarMetric = number | null;

export const subtractMetric = (
  total: ScalarMetric,
  available: ScalarMetric,
): ScalarMetric => {
  if (total === null || available === null) {
    return null;
  }

  return Math.max(0, total - available);
};

export const usageRatio = (
  used: ScalarMetric,
  total: ScalarMetric,
): ScalarMetric => {
  if (used === null || total === null) {
    return null;
  }

  return total > 0 ? used / total : 0;
};

export const targetStatus = (value: ScalarMetric): boolean | null =>
  value === null ? null : value > 0;
