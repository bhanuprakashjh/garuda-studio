/* zcml.ts — offline ZC-position estimator (small MLP) for sensorless 6-step.
 *
 * Faithful TypeScript port of the pure-numpy module
 *   tools/garuda_debug/garuda_gui/zcml.py
 *
 * Idea (after Energies 2023 16(10):4027): instead of thresholding a single ZC
 * edge, regress the rotor position within each floating 60deg sector from the
 * conditioned phase-voltage trajectory. Trained on burst-scope captures (the
 * un-aliased 24 kHz waveform) with the TRUE ZC extracted offline as the label
 * -> learns the falling crossing the live comparator can't cleanly threshold.
 *
 * Pipeline:
 *   BurstScopePanel captures -> raw "windows" (bemf/zcthr/sector + erpm/duty)
 *   extractExamples()  -> per floating-sector trajectory (resampled) + true ZC
 *   MLP                -> predict ZC fraction in [0,1]  (x60deg = elec position)
 *   evaluate()         -> MAE in elec degrees vs eRPM band, rising vs falling
 *
 * Pure TypeScript, ZERO external deps. All numpy ops are replaced by plain
 * number[] / number[][] helpers + Math.*. Because JS has no seeded numpy RNG,
 * weight init uses a small deterministic seeded PRNG so results are repeatable.
 */

// ── constants (Python: SEG_LEN, MIN_RUN) ──────────────────────────────────
/** Python: SEG_LEN — resample each sector trajectory to this many points. */
export const SEG_LEN = 16;
/** Python: MIN_RUN — min samples in a sector-run to use it. */
export const MIN_RUN = 5;

/** Feature dimension produced by extractExamples: SEG_LEN traj + [duty, pol]. */
export const N_FEATURES = SEG_LEN + 2;

// ── raw capture / example types ───────────────────────────────────────────
/** A raw burst-scope capture window (Python: a `capture` dict). */
export interface ZcWindow {
  /** floating-phase BEMF samples (ADC counts). */
  bemf: number[];
  /** per-sample comparator ZC threshold (ADC counts). */
  zcthr: number[];
  /** per-sample active sector index (0..5). */
  sector: number[];
  /** electrical RPM at capture. */
  erpm?: number;
  /** PWM duty in percent (0..100). */
  duty?: number;
}

/** One training example (Python: a row of X with paired y + meta). */
export interface ZcExample {
  /** Python: feat — SEG_LEN normalized (bemf-zcthr) samples + [duty_frac, pol]. */
  features: number[];
  /** Python: y — true ZC fraction within the sector (0..1). */
  target: number;
  /** Python: meta[0] — electrical RPM. */
  erpm: number;
  /** Python: meta[1] — polarity (+1 rising / -1 falling). */
  pol: number;
}

// ── small numeric helpers (replace numpy) ─────────────────────────────────

/** Deterministic seeded PRNG (mulberry32) — stands in for np.random RNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box-Muller from a uniform PRNG. */
function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** np.zeros(n). */
function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

/** Build (rows x cols) matrix filled by fn(i, j). */
function matrix(rows: number, cols: number, fn: () => number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const row = new Array<number>(cols);
    for (let j = 0; j < cols; j++) row[j] = fn();
    m.push(row);
  }
  return m;
}

/** Matrix product A(n x k) @ B(k x m) -> (n x m). */
function matmul(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const k = B.length;
  const m = k > 0 ? B[0].length : 0;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ai = A[i];
    const row = new Array<number>(m).fill(0);
    for (let p = 0; p < k; p++) {
      const aip = ai[p];
      if (aip === 0) continue;
      const bp = B[p];
      for (let j = 0; j < m; j++) row[j] += aip * bp[j];
    }
    out.push(row);
  }
  return out;
}

/** Transpose. */
function transpose(A: number[][]): number[][] {
  const n = A.length;
  const m = n > 0 ? A[0].length : 0;
  const out: number[][] = [];
  for (let j = 0; j < m; j++) {
    const row = new Array<number>(n);
    for (let i = 0; i < n; i++) row[i] = A[i][j];
    out.push(row);
  }
  return out;
}

/** Add a row-vector b (length cols) to every row of M (broadcast). */
function addRowVec(M: number[][], b: number[]): number[][] {
  return M.map((row) => row.map((v, j) => v + b[j]));
}

/** Elementwise binary op over two equal-shape matrices. */
function ewise(A: number[][], B: number[][], fn: (a: number, b: number) => number): number[][] {
  return A.map((row, i) => row.map((v, j) => fn(v, B[i][j])));
}

/** Elementwise map over a matrix. */
function mmap(A: number[][], fn: (a: number) => number): number[][] {
  return A.map((row) => row.map(fn));
}

/** Column means -> length-cols vector (np.mean(M, 0)). */
function colMean(M: number[][]): number[] {
  const n = M.length;
  const m = n > 0 ? M[0].length : 0;
  const out = zeros(m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out[j] += M[i][j];
  for (let j = 0; j < m; j++) out[j] /= n || 1;
  return out;
}

/** Column std (population, ddof=0) -> length-cols vector (np.std(M, 0)). */
function colStd(M: number[][]): number[] {
  const n = M.length;
  const m = n > 0 ? M[0].length : 0;
  const mu = colMean(M);
  const out = zeros(m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const d = M[i][j] - mu[j];
    out[j] += d * d;
  }
  for (let j = 0; j < m; j++) out[j] = Math.sqrt(out[j] / (n || 1));
  return out;
}

// ── dataset extraction ────────────────────────────────────────────────────

/** Python: _resample — linear-interp `arr` onto `n` evenly spaced points. */
function resample(arr: number[], n: number): number[] {
  const size = arr.length;
  if (size === n) return arr.slice();
  if (size === 0) return zeros(n);
  if (size === 1) return new Array<number>(n).fill(arr[0]);
  // xp = linspace(0,1,size); query x = linspace(0,1,n); np.interp.
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1);
    const pos = x * (size - 1); // index in source space
    const lo = Math.floor(pos);
    if (lo >= size - 1) {
      out[i] = arr[size - 1];
    } else {
      const frac = pos - lo;
      out[i] = arr[lo] * (1 - frac) + arr[lo + 1] * frac;
    }
  }
  return out;
}

/**
 * Python: _find_zc — robust ZC = the polarity-correct, SUSTAINED crossing of
 * (bemf - zcthr). pol_sign +1 (rising) wants a -> + transition; -1 (falling)
 * wants + -> -. Requires the run to actually be on the expected side before and
 * after, so a lone PWM-ON spike that briefly crosses isn't mistaken for the ZC.
 * Returns the fraction (0..1) of the crossing within the run, or null.
 */
function findZc(run: number[], polSign: number): number | null {
  const n = run.length;
  const pre = Math.max(1, Math.floor(n / 4));
  for (let k = 1; k < n; k++) {
    let cross: boolean;
    if (polSign > 0) cross = run[k - 1] <= 0 && 0 < run[k];
    else cross = run[k - 1] >= 0 && 0 > run[k];
    if (!cross) continue;
    // sustained: the samples after the crossing must stay on the new side
    const tailEnd = Math.min(n, k + pre);
    let tailSum = 0;
    let tailCnt = 0;
    for (let t = k; t < tailEnd; t++) {
      tailSum += run[t];
      tailCnt++;
    }
    const tailMean = tailCnt > 0 ? tailSum / tailCnt : 0;
    if (polSign > 0 && tailMean <= 0) continue;
    if (polSign < 0 && tailMean >= 0) continue;
    const f = run[k - 1] / (run[k - 1] - run[k] + 1e-9);
    return (k - 1 + f) / (n - 1);
  }
  return null;
}

/**
 * Python: extract_examples — each capture -> per floating-sector trajectory.
 *   features : [SEG_LEN normalized (bemf-zcthr) samples, duty_frac, polarity]
 *   target   : true ZC fraction within the sector (0..1)
 *   erpm/pol : meta per example (polarity +1 rising / -1 falling)
 */
export function extractExamples(windows: ZcWindow[]): ZcExample[] {
  const out: ZcExample[] = [];
  for (const c of windows) {
    const bemf = c.bemf.map(Number);
    const zcthr = c.zcthr.map(Number);
    const sector = c.sector.map((s) => Math.trunc(Number(s)));
    const erpm = Number(c.erpm ?? 0);
    const duty = Number(c.duty ?? 0) / 100.0;
    const n = sector.length;
    const d: number[] = new Array<number>(n);
    for (let t = 0; t < n; t++) d[t] = bemf[t] - zcthr[t]; // BEMF relative to threshold
    // split into runs of constant sector
    let i = 0;
    while (i < n) {
      let j = i;
      while (j < n && sector[j] === sector[i]) j++;
      const run = d.slice(i, j);
      if (j - i >= MIN_RUN) {
        const polSign = sector[i] % 2 === 0 ? +1 : -1;
        const zcFrac = findZc(run, polSign);
        if (zcFrac !== null) {
          const pol = sector[i] % 2 === 0 ? +1.0 : -1.0; // even=rising
          const traj = resample(run, SEG_LEN);
          let maxAbs = 0;
          for (const v of traj) maxAbs = Math.max(maxAbs, Math.abs(v));
          const sc = maxAbs + 1e-6;
          const features = traj.map((v) => v / sc);
          features.push(duty, pol);
          out.push({ features, target: zcFrac, erpm, pol });
        }
      }
      i = j;
    }
  }
  return out;
}

// ── tiny MLP (pure TS port of the numpy MLP) ──────────────────────────────

/** Options for MLP.train (Python: fit(epochs=800, lr=0.08)). */
export interface TrainOpts {
  epochs?: number;
  lr?: number;
}

/** Serialisable weight bundle (toJSON/fromJSON) for localStorage / download. */
export interface MLPWeights {
  nIn: number;
  nHid: number;
  W1: number[][];
  b1: number[];
  W2: number[][];
  b2: number[];
  mu: number[] | null;
  sd: number[] | null;
}

/** Python: class MLP — single tanh hidden layer, linear output, SGD full-batch. */
export class MLP {
  nIn: number;
  nHid: number;
  W1: number[][]; // (nIn x nHid)
  b1: number[]; // (nHid)
  W2: number[][]; // (nHid x 1)
  b2: number[]; // (1)
  mu: number[] | null = null;
  sd: number[] | null = null;

  /** Python: __init__(n_in, n_hid=24, seed=0). */
  constructor(nIn: number, nHid = 24, seed = 0) {
    this.nIn = nIn;
    this.nHid = nHid;
    const rng = mulberry32(seed);
    const s1 = 1 / Math.sqrt(nIn);
    const s2 = 1 / Math.sqrt(nHid);
    this.W1 = matrix(nIn, nHid, () => randn(rng) * s1);
    this.b1 = zeros(nHid);
    this.W2 = matrix(nHid, 1, () => randn(rng) * s2);
    this.b2 = zeros(1);
  }

  /** Python: _norm — (X - mu) / sd, broadcast over rows. */
  private norm(X: number[][]): number[][] {
    const mu = this.mu!;
    const sd = this.sd!;
    return X.map((row) => row.map((v, j) => (v - mu[j]) / sd[j]));
  }

  /**
   * Python: predict (forward pass) for a single feature vector.
   * forward(x) -> predicted ZC fraction (scalar).
   */
  forward(x: number[]): number {
    return this.predict([x])[0];
  }

  /** Python: predict — batch forward, returns one scalar per row. */
  predict(X: number[][]): number[] {
    if (X.length === 0) return [];
    const Xn = this.norm(X);
    const z1 = addRowVec(matmul(Xn, this.W1), this.b1);
    const a1 = mmap(z1, Math.tanh);
    const out = addRowVec(matmul(a1, this.W2), this.b2);
    return out.map((row) => row[0]);
  }

  /**
   * Python: fit — full-batch gradient descent, MSE loss, tanh hidden layer.
   * Mirrors the numpy update exactly (same lr, epochs, normalization).
   */
  train(examples: ZcExample[], opts: TrainOpts = {}): this {
    const epochs = opts.epochs ?? 800;
    const lr = opts.lr ?? 0.08;
    const X = examples.map((e) => e.features);
    const y = examples.map((e) => e.target);
    const n = X.length;
    if (n === 0) return this;

    this.mu = colMean(X);
    this.sd = colStd(X).map((v) => v + 1e-6);
    const Xn = this.norm(X);
    const XnT = transpose(Xn);
    const yy = y.map((v) => [v]); // (n x 1)

    for (let e = 0; e < epochs; e++) {
      // forward
      const z1 = addRowVec(matmul(Xn, this.W1), this.b1); // (n x nHid)
      const a1 = mmap(z1, Math.tanh);
      const pred = addRowVec(matmul(a1, this.W2), this.b2); // (n x 1)
      const err = ewise(pred, yy, (a, b) => a - b); // (n x 1)

      // dW2 = a1.T @ err / n ; db2 = err.mean(0)
      const dW2raw = matmul(transpose(a1), err); // (nHid x 1)
      const dW2 = mmap(dW2raw, (v) => v / n);
      const db2 = colMean(err); // (1)

      // da1 = (err @ W2.T) * (1 - a1^2)
      const errW2T = matmul(err, transpose(this.W2)); // (n x nHid)
      const da1 = ewise(errW2T, a1, (g, a) => g * (1 - a * a)); // (n x nHid)

      // dW1 = Xn.T @ da1 / n ; db1 = da1.mean(0)
      const dW1raw = matmul(XnT, da1); // (nIn x nHid)
      const dW1 = mmap(dW1raw, (v) => v / n);
      const db1 = colMean(da1); // (nHid)

      // SGD step
      this.W2 = ewise(this.W2, dW2, (w, g) => w - lr * g);
      this.b2 = this.b2.map((v, j) => v - lr * db2[j]);
      this.W1 = ewise(this.W1, dW1, (w, g) => w - lr * g);
      this.b1 = this.b1.map((v, j) => v - lr * db1[j]);
    }
    return this;
  }

  /** Serialise weights (for localStorage / download). */
  toJSON(): MLPWeights {
    return {
      nIn: this.nIn,
      nHid: this.nHid,
      W1: this.W1.map((r) => r.slice()),
      b1: this.b1.slice(),
      W2: this.W2.map((r) => r.slice()),
      b2: this.b2.slice(),
      mu: this.mu ? this.mu.slice() : null,
      sd: this.sd ? this.sd.slice() : null,
    };
  }

  /** Rebuild an MLP from serialised weights. */
  static fromJSON(w: MLPWeights): MLP {
    const m = new MLP(w.nIn, w.nHid);
    m.W1 = w.W1.map((r) => r.slice());
    m.b1 = w.b1.slice();
    m.W2 = w.W2.map((r) => r.slice());
    m.b2 = w.b2.slice();
    m.mu = w.mu ? w.mu.slice() : null;
    m.sd = w.sd ? w.sd.slice() : null;
    return m;
  }
}

// ── evaluation ────────────────────────────────────────────────────────────

/** Per eRPM-band / polarity evaluation cell. */
export interface EvalCell {
  /** number of examples in this band/polarity (NaN-free count). */
  n: number;
  /** MLP MAE in electrical degrees. */
  mae: number;
  /** best-constant-guess MAE (Python 'floor'); no constant can beat it. */
  floor: number;
  /** floor - mae; >0 means the MLP predicts each crossing, not just the mean. */
  win: number;
}

/** One eRPM band row of the evaluation table. */
export interface EvalBand {
  /** band label, e.g. "0-50k" or ">130k". */
  label: string;
  lo: number;
  hi: number;
  /** total examples in band (Python: m.sum()). */
  n: number;
  /** polarity +1 (rising) cell, or null if empty. */
  rise: EvalCell | null;
  /** polarity -1 (falling) cell, or null if empty. */
  fall: EvalCell | null;
}

/** Result of evaluate(): per-example errors + the banded breakdown. */
export interface EvalResult {
  /** Python return value: |pred - y| * 60 per example (elec deg). */
  errDeg: number[];
  /** the printed table, as structured rows. */
  bands: EvalBand[];
}

/**
 * Python: evaluate(model, X, y, meta) — predict, then report MAE in electrical
 * degrees (sector = 60 elec deg) broken down by eRPM band and polarity. The
 * 'floor' is the best possible CONSTANT guess (always predict the subset mean
 * ZC fraction); 'win' = floor - mae. win>0 means the MLP learned each crossing,
 * win~0 means it only memorised the mean.
 */
export function evaluate(model: MLP, examples: ZcExample[]): EvalResult {
  const X = examples.map((e) => e.features);
  const y = examples.map((e) => e.target);
  const erpm = examples.map((e) => e.erpm);
  const pol = examples.map((e) => e.pol);
  const pred = model.predict(X);
  const errDeg = pred.map((p, i) => Math.abs(p - y[i]) * 60.0); // sector = 60 elec deg

  const bandDefs: Array<[number, number]> = [
    [0, 50000],
    [50000, 90000],
    [90000, 130000],
    [130000, 999999],
  ];

  const cellFor = (idx: number[]): EvalCell | null => {
    if (idx.length === 0) return null;
    let maeSum = 0;
    let meanY = 0;
    for (const i of idx) meanY += y[i];
    meanY /= idx.length;
    let floorSum = 0;
    for (const i of idx) {
      maeSum += errDeg[i];
      floorSum += Math.abs(y[i] - meanY) * 60.0;
    }
    const mae = maeSum / idx.length;
    const floor = floorSum / idx.length;
    return { n: idx.length, mae, floor, win: floor - mae };
  };

  const bands: EvalBand[] = [];
  for (const [lo, hi] of bandDefs) {
    const inBand: number[] = [];
    for (let i = 0; i < y.length; i++) if (erpm[i] >= lo && erpm[i] < hi) inBand.push(i);
    if (inBand.length === 0) continue;
    const label = hi < 999999 ? `${Math.floor(lo / 1000)}-${Math.floor(hi / 1000)}k` : `>${Math.floor(lo / 1000)}k`;
    const rise = cellFor(inBand.filter((i) => pol[i] === +1));
    const fall = cellFor(inBand.filter((i) => pol[i] === -1));
    bands.push({ label, lo, hi, n: inBand.length, rise, fall });
  }

  return { errDeg, bands };
}
