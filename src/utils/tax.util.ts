export const DEFAULT_TAX_RATE = 0.18;

// Simple 2-decimal rounding for display + storage consistency.
export const computeTaxAmount = (
  taxableAmount: number,
  rate = DEFAULT_TAX_RATE
) => {
  const base = Number.isFinite(taxableAmount)
    ? taxableAmount
    : 0;
  const taxable = Math.max(0, base);

  const raw = taxable * rate;
  return Math.round(raw * 100) / 100;
};

