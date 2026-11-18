// Assemblage 360 sur l'appareil, entièrement hors ligne.
// 1. Pose initiale de chaque photo = gyroscope.
// 2. Recherche de points communs entre photos voisines (corrélation de motifs, grossier puis fin).
// 3. Optimisation des rotations + de la focale (Levenberg-Marquardt, robuste).
// 4. Égalisation des expositions (gains).
// 5. Projection équirectangulaire avec fondu entre les photos, bouchage des trous (zénith / nadir).
import { mul, transpose, apply, expMap, normalize, forwardOf, yawPitchOf, solve, DEG } from './math.js';

const post = (type, data, transfer) => self.postMessage({ type, ...data }, transfer || []);
const progress = (stage, p) => post('progress', { stage, p });

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd !== 'stitch') return;
  try {
    const result = stitch(msg);
    post('done', result, [result.rgba.buffer]);
  } catch (err) {
    post('error', { message: String(err && err.stack || err) });
  }
};

// ---------- Outils image ----------

function downsample4(src, w, h) {
  const W = Math.floor(w / 4), H = Math.floor(h / 4), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = 0; dy < 4; dy++) {
        const row = (y * 4 + dy) * w + x * 4;
        s += src[row] + src[row + 1] + src[row + 2] + src[row + 3];
      }
      out[y * W + x] = s / 16;
    }
  return { data: out, w: W, h: H };
}

function bilinear(img, x, y) {
  const { data, w, h } = img;
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
}

// Points bien texturés (critère de Shi-Tomasi), au plus un par case d'une grille.
function detectFeatures(img) {
  const { data, w, h } = img;
  const COLS = 8, ROWS = 10, R = 4, STEP = 3, margin = 12;
  const feats = [];
  const cw = (w - 2 * margin) / COLS, ch = (h - 2 * margin) / ROWS;
  for (let cy = 0; cy < ROWS; cy++)
    for (let cx = 0; cx < COLS; cx++) {
      let best = null;
      const x0 = Math.floor(margin + cx * cw), x1 = Math.floor(margin + (cx + 1) * cw);
      const y0 = Math.floor(margin + cy * ch), y1 = Math.floor(margin + (cy + 1) * ch);
      for (let y = y0; y < y1; y += STEP)
        for (let x = x0; x < x1; x += STEP) {
          let sxx = 0, syy = 0, sxy = 0;
          for (let dy = -R; dy <= R; dy += 2)
            for (let dx = -R; dx <= R; dx += 2) {
              const i = (y + dy) * w + (x + dx);
              const gx = data[i + 1] - data[i - 1], gy = data[i + w] - data[i - w];
              sxx += gx * gx; syy += gy * gy; sxy += gx * gy;
            }
          const n = 25;
          sxx /= n; syy /= n; sxy /= n;
          const tr = sxx + syy, det = sxx * syy - sxy * sxy;
          const lmin = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
          if (!best || lmin > best.score) best = { x, y, score: lmin };
        }
      if (best && best.score > 40) feats.push(best);
    }
  feats.sort((a, b) => b.score - a.score);
  return feats;
}

// Corrélation croisée normalisée entre un gabarit (tableau) et des échantillons.
function nccAt(tpl, tplMean, tplStd, img, qs, dx, dy) {
  let s = 0, ss = 0, sc = 0;
  const n = tpl.length;
  for (let k = 0; k < n; k++) {
    const v = bilinear(img, qs[2 * k] + dx, qs[2 * k + 1] + dy);
    if (v < 0) return -2;
    s += v; ss += v * v; sc += v * tpl[k];
  }
  const mean = s / n, varr = ss / n - mean * mean;
  if (varr < 4) return -2;
  return (sc / n - mean * tplMean) / (Math.sqrt(varr) * tplStd);
}

function makeTemplate(img, x, y, half, step) {
  const vals = [];
  for (let dy = -half; dy <= half; dy++)
    for (let dx = -half; dx <= half; dx++) vals.push(bilinear(img, x + dx * step, y + dy * step));
  if (vals.some((v) => v < 0)) return null;
  let s = 0, ss = 0;
  for (const v of vals) { s += v; ss += v * v; }
  const mean = s / vals.length, std = Math.sqrt(Math.max(0, ss / vals.length - mean * mean));
  if (std < 3) return null;
  return { vals: Float32Array.from(vals), mean, std };
}

// ---------- Géométrie caméra ----------

function project(M, f, cx, cy, x, y) {
  // M = Rj^T Ri : point de l'image i -> point de l'image j
  const v = apply(M, [(x - cx) / f, (y - cy) / f, 1]);
  if (v[2] <= 0.05) return null;
  return [f * v[0] / v[2] + cx, f * v[1] / v[2] + cy];
}

// ---------- Mise en correspondance ----------

function matchPair(i, j, imgs, L0, L1, R, f, cx, cy) {
  const M = mul(transpose(R[j]), R[i]);
  const A = L0[i], B = L0[j], A1 = L1[i], B1 = L1[j];
  const out = [];
  const COARSE_HALF = 3, COARSE_R = 10, FINE_HALF = 5, FINE_R = 3;
  const margin = 4 * (COARSE_HALF + COARSE_R) + 4;
  let tried = 0;
  for (const p of imgs[i].feats) {
    if (tried >= 30) break;
    const q0 = project(M, f, cx, cy, p.x, p.y);
    if (!q0 || q0[0] < margin || q0[1] < margin || q0[0] > B.w - margin || q0[1] > B.h - margin) continue;
    tried++;

    // Niveau grossier (1/4)
    const tc = makeTemplate(A1, p.x / 4, p.y / 4, COARSE_HALF, 1);
    if (!tc) continue;
    const qs = new Float32Array(tc.vals.length * 2);
    let k = 0, ok = true;
    for (let dy = -COARSE_HALF; dy <= COARSE_HALF && ok; dy++)
      for (let dx = -COARSE_HALF; dx <= COARSE_HALF; dx++) {
        const q = project(M, f, cx, cy, p.x + dx * 4, p.y + dy * 4);
        if (!q) { ok = false; break; }
        qs[2 * k] = q[0] / 4; qs[2 * k + 1] = q[1] / 4; k++;
      }
    if (!ok) continue;
    let best = -2, bx = 0, by = 0;
    const scores = new Float32Array((2 * COARSE_R + 1) ** 2);
    for (let dy = -COARSE_R; dy <= COARSE_R; dy++)
      for (let dx = -COARSE_R; dx <= COARSE_R; dx++) {
        const s = nccAt(tc.vals, tc.mean, tc.std, B1, qs, dx, dy);
        scores[(dy + COARSE_R) * (2 * COARSE_R + 1) + dx + COARSE_R] = s;
        if (s > best) { best = s; bx = dx; by = dy; }
      }
    if (best < 0.7) continue;
    let second = -2;
    for (let dy = -COARSE_R; dy <= COARSE_R; dy++)
      for (let dx = -COARSE_R; dx <= COARSE_R; dx++)
        if (Math.abs(dx - bx) > 2 || Math.abs(dy - by) > 2)
          second = Math.max(second, scores[(dy + COARSE_R) * (2 * COARSE_R + 1) + dx + COARSE_R]);
    if (best - second < 0.04) continue;

    // Niveau fin (pleine résolution d'alignement)
    const tf = makeTemplate(A, p.x, p.y, FINE_HALF, 1);
    if (!tf) continue;
    const qf = new Float32Array(tf.vals.length * 2);
    k = 0; ok = true;
    for (let dy = -FINE_HALF; dy <= FINE_HALF && ok; dy++)
      for (let dx = -FINE_HALF; dx <= FINE_HALF; dx++) {
        const q = project(M, f, cx, cy, p.x + dx, p.y + dy);
        if (!q) { ok = false; break; }
        qf[2 * k] = q[0]; qf[2 * k + 1] = q[1]; k++;
      }
    if (!ok) continue;
    const S = 2 * FINE_R + 1, fs = new Float32Array(S * S);
    let fb = -2, fx = 0, fy = 0;
    for (let dy = -FINE_R; dy <= FINE_R; dy++)
      for (let dx = -FINE_R; dx <= FINE_R; dx++) {
        const s = nccAt(tf.vals, tf.mean, tf.std, B, qf, bx * 4 + dx, by * 4 + dy);
        fs[(dy + FINE_R) * S + dx + FINE_R] = s;
        if (s > fb) { fb = s; fx = dx; fy = dy; }
      }
    if (fb < 0.85) continue;
    // Sous-pixel par parabole
    let sx = 0, sy = 0;
    if (Math.abs(fx) < FINE_R && Math.abs(fy) < FINE_R) {
      const c = fs[(fy + FINE_R) * S + fx + FINE_R];
      const l = fs[(fy + FINE_R) * S + fx + FINE_R - 1], r = fs[(fy + FINE_R) * S + fx + FINE_R + 1];
      const u = fs[(fy + FINE_R - 1) * S + fx + FINE_R], d = fs[(fy + FINE_R + 1) * S + fx + FINE_R];
      const denx = l - 2 * c + r, deny = u - 2 * c + d;
      if (denx < 0) sx = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / denx));
      if (deny < 0) sy = Math.max(-0.5, Math.min(0.5, 0.5 * (u - d) / deny));
    }
    const qx = q0[0] + bx * 4 + fx + sx, qy = q0[1] + by * 4 + fy + sy;
    out.push({ i, j, px: p.x, py: p.y, qx, qy, dx: qx - q0[0], dy: qy - q0[1], score: fb });
  }
  // Cohérence : dans une paire, les décalages doivent être proches les uns des autres.
  if (out.length >= 3) {
    const mx = median(out.map((m) => m.dx)), my = median(out.map((m) => m.dy));
    return out.filter((m) => Math.hypot(m.dx - mx, m.dy - my) < 14);
  }
  return out.length >= 2 ? out : [];
}

function median(a) { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }

// ---------- Optimisation ----------

function optimize(N, R0, matches, f0, cx, cy, iters = 20) {
  const P = 3 * (N - 1) + 1;
  const SIGMA_R = 4 * DEG, SIGMA_S = 0.2, HUBER = 3;
  let x = new Float64Array(P);

  const rot = (xv, i) => (i === 0 ? R0[0] : mul(expMap([xv[3 * (i - 1)], xv[3 * (i - 1) + 1], xv[3 * (i - 1) + 2]]), R0[i]));
  const ray = (Ri, f, px, py) => normalize(apply(Ri, [(px - cx) / f, (py - cy) / f, 1]));
  const resid = (xv, m) => {
    const f = f0 * Math.exp(xv[P - 1]);
    const a = ray(rot(xv, m.i), f, m.px, m.py), b = ray(rot(xv, m.j), f, m.qx, m.qy);
    return [f0 * (a[0] - b[0]), f0 * (a[1] - b[1]), f0 * (a[2] - b[2])];
  };
  const huberW = (e) => { const n = Math.hypot(e[0], e[1], e[2]); return n <= HUBER ? 1 : HUBER / n; };
  const cost = (xv) => {
    let c = 0;
    for (const m of matches) {
      const e = resid(xv, m), n = Math.hypot(e[0], e[1], e[2]);
      c += n <= HUBER ? n * n : 2 * HUBER * n - HUBER * HUBER;
    }
    for (let k = 0; k < P - 1; k++) c += (xv[k] / SIGMA_R) ** 2;
    c += (xv[P - 1] / SIGMA_S) ** 2;
    return c;
  };

  let lambda = 1e-3, c0 = cost(x);
  for (let it = 0; it < iters; it++) {
    const A = new Float64Array(P * P), g = new Float64Array(P);
    for (const m of matches) {
      const e = resid(x, m), w = huberW(e);
      const idx = [];
      if (m.i > 0) idx.push(3 * (m.i - 1), 3 * (m.i - 1) + 1, 3 * (m.i - 1) + 2);
      if (m.j > 0) idx.push(3 * (m.j - 1), 3 * (m.j - 1) + 1, 3 * (m.j - 1) + 2);
      idx.push(P - 1);
      const J = idx.map((p) => {
        const h = 1e-6, xp = x.slice();
        xp[p] += h;
        const e2 = resid(xp, m);
        return [(e2[0] - e[0]) / h, (e2[1] - e[1]) / h, (e2[2] - e[2]) / h];
      });
      for (let a = 0; a < idx.length; a++) {
        const Ja = J[a];
        g[idx[a]] += w * (Ja[0] * e[0] + Ja[1] * e[1] + Ja[2] * e[2]);
        for (let b = 0; b < idx.length; b++) {
          const Jb = J[b];
          A[idx[a] * P + idx[b]] += w * (Ja[0] * Jb[0] + Ja[1] * Jb[1] + Ja[2] * Jb[2]);
        }
      }
    }
    for (let k = 0; k < P - 1; k++) { A[k * P + k] += 1 / SIGMA_R ** 2; g[k] += x[k] / SIGMA_R ** 2; }
    A[(P - 1) * P + P - 1] += 1 / SIGMA_S ** 2; g[P - 1] += x[P - 1] / SIGMA_S ** 2;

    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const Ad = Array.from(A);
      for (let k = 0; k < P; k++) Ad[k * P + k] *= 1 + lambda;
      const dx = solve(Ad, Array.from(g, (v) => -v), P);
      const xn = x.map((v, k) => v + dx[k]);
      const c1 = cost(xn);
      if (c1 < c0) { x = xn; c0 = c1; lambda = Math.max(1e-7, lambda / 3); improved = true; }
      else lambda *= 5;
    }
    if (!improved) break;
  }
  const f = f0 * Math.exp(x[P - 1]);
  const R = Array.from({ length: N }, (_, i) => rot(x, i));
  const errs = matches.map((m) => { const e = resid(x, m); return Math.hypot(e[0], e[1], e[2]); });
  return { R, f, errs };
}

// L'optimisation fixe la photo 0 : son erreur d'inclinaison pencherait tout l'horizon.
// On cherche la rotation globale G qui rapproche au mieux G·Ri de TOUTES les mesures du gyroscope
// (décomposition polaire de somme(R0i · Riᵀ)), ce qui moyenne les erreurs.
function levelWithSensors(R, R0) {
  let M = new Array(9).fill(0);
  for (let i = 0; i < R.length; i++) {
    const P = mul(R0[i], transpose(R[i]));
    for (let k = 0; k < 9; k++) M[k] += P[k];
  }
  let G = M.map((v) => v / R.length);
  for (let it = 0; it < 30; it++) {
    const inv = inverse3(G);
    if (!inv) return R;
    const invT = transpose(inv);
    G = G.map((v, k) => 0.5 * (v + invT[k]));
  }
  return R.map((Ri) => mul(G, Ri));
}

function inverse3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

// ---------- Gains d'exposition ----------

function computeGains(N, matches, L0) {
  const SIGMA_N = 10, SIGMA_G = 0.1;
  const pairs = new Map();
  for (const m of matches) {
    const a = patchMean(L0[m.i], m.px, m.py), b = patchMean(L0[m.j], m.qx, m.qy);
    if (a < 0 || b < 0) continue;
    const key = m.i * 1000 + m.j;
    const p = pairs.get(key) || { i: m.i, j: m.j, n: 0, a: 0, b: 0 };
    p.n++; p.a += a; p.b += b; pairs.set(key, p);
  }
  const A = new Array(N * N).fill(0), b = new Array(N).fill(0);
  for (const p of pairs.values()) {
    const Ia = p.a / p.n, Ib = p.b / p.n, n = p.n;
    A[p.i * N + p.i] += n * Ia * Ia / SIGMA_N ** 2;
    A[p.j * N + p.j] += n * Ib * Ib / SIGMA_N ** 2;
    A[p.i * N + p.j] -= n * Ia * Ib / SIGMA_N ** 2;
    A[p.j * N + p.i] -= n * Ia * Ib / SIGMA_N ** 2;
    for (const k of [p.i, p.j]) { A[k * N + k] += n / SIGMA_G ** 2; b[k] += n / SIGMA_G ** 2; }
  }
  for (let k = 0; k < N; k++) if (A[k * N + k] === 0) { A[k * N + k] = 1; b[k] = 1; }
  return solve(A, b, N).map((g) => Math.max(0.6, Math.min(1.6, g || 1)));
}

function patchMean(img, x, y) {
  let s = 0, n = 0;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) { const v = bilinear(img, x + dx, y + dy); if (v < 0) return -1; s += v; n++; }
  return s / n;
}

// ---------- Rendu équirectangulaire ----------

function render(images, R, focalNorm, gains, W, yaw0) {
  const H = W / 2, out = new Uint8ClampedArray(W * H * 4), covered = new Uint8Array(W * H);
  const cams = images.map((im, i) => {
    const w = im.cw, h = im.ch, f = focalNorm * Math.max(w, h);
    const halfDiag = Math.atan(Math.hypot(w, h) / 2 / f);
    return { Rt: transpose(R[i]), fwd: forwardOf(R[i]), cosLim: Math.cos(halfDiag + 1 * DEG), f, w, h, cx: w / 2, cy: h / 2, data: im.color, gain: gains[i] };
  });
  const sinY = new Float32Array(W), cosY = new Float32Array(W);
  for (let x = 0; x < W; x++) { const yaw = yaw0 + ((x + 0.5) / W - 0.5) * 2 * Math.PI; sinY[x] = Math.sin(yaw); cosY[x] = Math.cos(yaw); }
  const acc = new Float32Array(4);
  for (let y = 0; y < H; y++) {
    if (y % 64 === 0) progress('render', y / H);
    const pitch = (0.5 - (y + 0.5) / H) * Math.PI, cp = Math.cos(pitch), sp = Math.sin(pitch);
    for (let x = 0; x < W; x++) {
      const dx = cp * sinY[x], dy = cp * cosY[x], dz = sp;
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      for (let c = 0; c < cams.length; c++) {
        const cam = cams[c], F = cam.fwd;
        if (dx * F[0] + dy * F[1] + dz * F[2] < cam.cosLim) continue;
        const t = cam.Rt;
        const vx = t[0] * dx + t[1] * dy + t[2] * dz, vy = t[3] * dx + t[4] * dy + t[5] * dz, vz = t[6] * dx + t[7] * dy + t[8] * dz;
        if (vz <= 0) continue;
        const u = cam.f * vx / vz + cam.cx - 0.5, v = cam.f * vy / vz + cam.cy - 0.5;
        if (u < 0 || v < 0 || u >= cam.w - 1 || v >= cam.h - 1) continue;
        const wx = 1 - Math.abs(2 * (u + 0.5) / cam.w - 1), wy = 1 - Math.abs(2 * (v + 0.5) / cam.h - 1);
        let wgt = wx * wy; wgt = wgt * wgt * wgt + 1e-6;
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i = (y0 * cam.w + x0) * 4, row = cam.w * 4, d = cam.data;
        const k = wgt * cam.gain;
        for (let ch = 0; ch < 3; ch++) {
          const val = (d[i + ch] * (1 - fx) + d[i + 4 + ch] * fx) * (1 - fy) + (d[i + row + ch] * (1 - fx) + d[i + row + 4 + ch] * fx) * fy;
          acc[ch] += val * k;
        }
        acc[3] += wgt;
      }
      const o = (y * W + x) * 4;
      if (acc[3] > 0) {
        out[o] = acc[0] / acc[3]; out[o + 1] = acc[1] / acc[3]; out[o + 2] = acc[2] / acc[3]; out[o + 3] = 255;
        covered[y * W + x] = 1;
      }
    }
  }
  const holes = fillHoles(out, covered, W, H);
  return { rgba: out, holes };
}

// Bouche les zones non photographiées (souvent le ciel au zénith et le sol au nadir)
// par prolongement vertical puis flou horizontal.
function fillHoles(out, covered, W, H) {
  let holes = 0;
  for (let x = 0; x < W; x++) {
    let prev = -1;
    for (let y = 0; y <= H; y++) {
      if (y < H && !covered[y * W + x]) continue;
      // trou entre prev et y
      if (y - prev > 1) {
        for (let yy = prev + 1; yy < y; yy++) {
          holes++;
          const o = (yy * W + x) * 4;
          const a = prev >= 0 ? (prev * W + x) * 4 : -1, b = y < H ? (y * W + x) * 4 : -1;
          for (let c = 0; c < 3; c++) {
            let v;
            if (a >= 0 && b >= 0) { const t = (yy - prev) / (y - prev); v = out[a + c] * (1 - t) + out[b + c] * t; }
            else v = out[(a >= 0 ? a : b) + c];
            out[o + c] = a < 0 && b < 0 ? 60 : v;
          }
          out[o + 3] = 255;
        }
      }
      prev = y;
    }
  }
  if (!holes) return 0;
  const r = Math.max(4, Math.round(W / 50)), rowSum = new Float64Array((W + 1) * 3);
  for (let y = 0; y < H; y++) {
    let any = false;
    for (let x = 0; x < W; x++) if (!covered[y * W + x]) { any = true; break; }
    if (!any) continue;
    for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) rowSum[(x + 1) * 3 + c] = rowSum[x * 3 + c] + out[(y * W + x) * 4 + c];
    const total = [rowSum[W * 3], rowSum[W * 3 + 1], rowSum[W * 3 + 2]];
    // Plus on s'approche du pôle, plus le flou est large (les pixels y sont très étirés).
    const lat = Math.abs(0.5 - (y + 0.5) / H) * 2, rr = Math.min(W / 2 - 1, Math.round(r / Math.max(0.05, Math.cos(lat * Math.PI / 2))));
    for (let x = 0; x < W; x++) {
      if (covered[y * W + x]) continue;
      const a = x - rr, b = x + rr + 1;
      for (let c = 0; c < 3; c++) {
        let s;
        if (a >= 0 && b <= W) s = rowSum[b * 3 + c] - rowSum[a * 3 + c];
        else if (a < 0) s = rowSum[b * 3 + c] + (total[c] - rowSum[(W + a) * 3 + c]);
        else s = (total[c] - rowSum[a * 3 + c]) + rowSum[(b - W) * 3 + c];
        out[(y * W + x) * 4 + c] = s / (2 * rr + 1);
      }
    }
  }
  return holes / (W * H);
}

// ---------- Pipeline ----------

function stitch({ images, focalNorm, outW, refine = true }) {
  const N = images.length;
  const mw = images[0].mw, mh = images[0].mh;
  const f0 = focalNorm * Math.max(mw, mh), cx = mw / 2, cy = mh / 2;
  const R0 = images.map((im) => im.R);

  progress('features', 0);
  const L0 = images.map((im) => ({ data: Float32Array.from(im.gray), w: im.mw, h: im.mh }));
  const L1 = L0.map((l) => downsample4(l.data, l.w, l.h));
  images.forEach((im, i) => { im.feats = detectFeatures(L0[i]); });

  let R = R0, f = f0, stats = { pairs: 0, matches: 0, rms: null, aligned: 0, refined: false };
  let perImage = null;
  if (refine && N > 1) {
    const fwd = R0.map(forwardOf);
    const pairList = [];
    for (let i = 0; i < N; i++)
      for (let j = i + 1; j < N; j++) {
        const ang = Math.acos(Math.max(-1, Math.min(1, fwd[i][0] * fwd[j][0] + fwd[i][1] * fwd[j][1] + fwd[i][2] * fwd[j][2])));
        if (ang < 62 * DEG) pairList.push([i, j]);
      }
    let matches = [];
    pairList.forEach(([i, j], k) => {
      if (k % 4 === 0) progress('match', k / pairList.length);
      const m1 = matchPair(i, j, images, L0, L1, R0, f0, cx, cy);
      const m2 = matchPair(j, i, images, L0, L1, R0, f0, cx, cy);
      if (m1.length + m2.length >= 4) matches = matches.concat(m1, m2);
    });
    progress('optimize', 0);
    if (matches.length >= 8) {
      let res = optimize(N, R0, matches, f0, cx, cy);
      const keep = matches.filter((m, k) => res.errs[k] < 4);
      progress('optimize', 0.5);
      if (keep.length >= 8) res = optimize(N, R0, keep, f0, cx, cy);
      const errs = res.errs, rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
      const seen = new Set(); keep.forEach((m) => { seen.add(m.i); seen.add(m.j); });
      // Qualité par photo : nombre de points communs avec les voisines et erreur moyenne de raccord.
      const per = Array.from({ length: N }, () => ({ n: 0, err: 0 }));
      keep.forEach((m, k) => {
        for (const i of [m.i, m.j]) { per[i].n++; per[i].err += errs[k] || 0; }
      });
      perImage = per.map((p, i) => ({ n: p.n, err: p.n ? Math.round((p.err / p.n) * 100) / 100 : null, feats: images[i].feats.length }));
      const fRatio = res.f / f0;
      // Garde-fou : on n'accepte la correction que si elle est raisonnable.
      if (rms < 3 && fRatio > 0.75 && fRatio < 1.33) {
        R = levelWithSensors(res.R, R0); f = res.f;
        stats = { pairs: pairList.length, matches: keep.length, rms, aligned: seen.size, refined: true };
      } else {
        stats = { pairs: pairList.length, matches: keep.length, rms, aligned: seen.size, refined: false };
      }
      matches = keep;
    }
    var gains = stats.refined ? computeGains(N, matches, L0) : new Array(N).fill(1);
  } else {
    var gains = new Array(N).fill(1);
  }
  if (!perImage) perImage = images.map((im) => ({ n: 0, err: null, feats: im.feats.length }));
  const newFocalNorm = f / Math.max(mw, mh);
  const yaw0 = yawPitchOf(forwardOf(R[0])).yaw;
  progress('render', 0);
  const { rgba, holes } = render(images, R, newFocalNorm, gains, outW, yaw0);
  progress('render', 1);
  return { rgba, w: outW, h: outW / 2, focalNorm: newFocalNorm, rotations: R, gains, perImage, stats: { ...stats, holes } };
}
