// Small, dependency-free statistics helpers for habit/recovery correlation.
//
// Everything here is pure (no I/O). The goal is to produce the same kind of
// "this behavior changes your recovery by X%, confidence: high/medium/low"
// summary that the Whoop Journal gives, but backed by an actual two-sample
// t-test (boolean habits) or Pearson correlation (numeric habits) instead of
// just eyeballing two averages.

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample variance (n-1 denominator). Returns 0 for n < 2. */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
}

export function stddev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

// ── log-gamma (Lanczos) + regularized incomplete beta ──────────────────────
// Used to turn a t-statistic into a two-tailed p-value without pulling in a
// stats library. Standard Numerical Recipes formulation.

function gammaln(x: number): number {
  // Standard Numerical Recipes Lanczos coefficients; a couple have more
  // decimal digits than a JS double can store, which is expected here.
  /* eslint-disable no-loss-of-precision */
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  /* eslint-enable no-loss-of-precision */
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  // eslint-disable-next-line no-loss-of-precision
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    gammaln(a + b) -
      gammaln(a) -
      gammaln(b) +
      a * Math.log(x) +
      b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-tailed p-value for a t-statistic with `df` degrees of freedom. */
function tDistTwoTailedP(t: number, df: number): number {
  if (!isFinite(t)) return 0;
  if (df <= 0) return NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** Map a p-value to a Whoop-style confidence label. */
export function confidenceLabel(p: number): string {
  if (!isFinite(p) || isNaN(p)) return "inconclusive";
  if (p < 0.05) return "high";
  if (p < 0.1) return "medium";
  if (p < 0.2) return "low";
  return "inconclusive";
}

export interface GroupComparison {
  nWith: number;
  nWithout: number;
  meanWith: number;
  meanWithout: number;
  delta: number; // meanWith - meanWithout
  percentChange: number; // delta relative to meanWithout
  t: number;
  df: number;
  pValue: number;
  cohensD: number;
  confidence: string;
}

/**
 * Welch's unequal-variance two-sample t-test, comparing the recovery metric on
 * days the habit happened (`withHabit`) vs days it didn't (`without`).
 */
export function compareGroups(
  withHabit: number[],
  without: number[]
): GroupComparison | null {
  if (withHabit.length < 2 || without.length < 2) return null;
  const n1 = withHabit.length;
  const n2 = without.length;
  const m1 = mean(withHabit);
  const m2 = mean(without);
  const v1 = variance(withHabit);
  const v2 = variance(without);

  const se = Math.sqrt(v1 / n1 + v2 / n2);
  let t: number;
  let df: number;
  if (se === 0) {
    // No variance in either group; treat any mean difference as decisive.
    t = m1 === m2 ? 0 : Infinity;
    df = n1 + n2 - 2;
  } else {
    t = (m1 - m2) / se;
    df =
      Math.pow(v1 / n1 + v2 / n2, 2) /
      (Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1));
  }
  const pValue = tDistTwoTailedP(t, df);

  // Pooled SD for Cohen's d.
  const pooledSd = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const cohensD = pooledSd === 0 ? 0 : (m1 - m2) / pooledSd;

  return {
    nWith: n1,
    nWithout: n2,
    meanWith: m1,
    meanWithout: m2,
    delta: m1 - m2,
    percentChange: m2 === 0 ? NaN : ((m1 - m2) / m2) * 100,
    t,
    df,
    pValue,
    cohensD,
    confidence: confidenceLabel(pValue),
  };
}

export interface Correlation {
  n: number;
  r: number;
  t: number;
  df: number;
  pValue: number;
  confidence: string;
}

/**
 * Pearson correlation between a numeric habit value and the recovery metric,
 * with a t-test on r for significance. `xs` and `ys` must be paired/same length.
 */
export function correlate(xs: number[], ys: number[]): Correlation | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null; // no variance to correlate
  const r = sxy / Math.sqrt(sxx * syy);
  const df = n - 2;
  const denom = 1 - r * r;
  const t = denom <= 0 ? Infinity : r * Math.sqrt(df / denom);
  const pValue = tDistTwoTailedP(t, df);
  return { n, r, t, df, pValue, confidence: confidenceLabel(pValue) };
}
