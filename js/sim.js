// Mode simulation (ordinateur sans gyroscope) et tests : un faux décor 360,
// des vues "photo" rendues depuis ce décor, et une orientation pilotée à la souris.
import { apply, DEG, camLookingAt } from './math.js';

// Décor équirectangulaire procédural (seed fixe pour des tests reproductibles).
export function makeSyntheticPano(W = 4096) {
  const H = W / 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#2a5d9e'); sky.addColorStop(1, '#a9cbe8');
  g.fillStyle = sky; g.fillRect(0, 0, W, H / 2);
  const ground = g.createLinearGradient(0, H / 2, 0, H);
  ground.addColorStop(0, '#b89b6b'); ground.addColorStop(1, '#5d4a30');
  g.fillStyle = ground; g.fillRect(0, H / 2, W, H / 2);

  const wrapDraw = (x, fn) => { for (const dx of [-W, 0, W]) { g.save(); g.translate(x + dx, 0); fn(); g.restore(); } };

  // Nuages
  for (let i = 0; i < 40; i++) {
    const x = rnd() * W, y = rnd() * H * 0.35, r = 20 + rnd() * 70;
    wrapDraw(x, () => { g.fillStyle = `rgba(255,255,255,${0.4 + rnd() * 0.4})`; g.beginPath(); g.ellipse(0, y, r * 2, r, 0, 0, 7); g.fill(); });
  }
  // Bâtiments avec fenêtres
  for (let i = 0; i < 55; i++) {
    const w = 60 + rnd() * 220, h = 80 + rnd() * 380, x = rnd() * W, base = H / 2 + 30 + rnd() * 60;
    const hue = Math.floor(rnd() * 50), light = 55 + rnd() * 30;
    wrapDraw(x, () => {
      g.fillStyle = `hsl(${hue},35%,${light}%)`; g.fillRect(0, base - h, w, h);
      g.fillStyle = 'rgba(40,40,60,0.85)';
      for (let yy = base - h + 12; yy < base - 20; yy += 26)
        for (let xx = 10; xx < w - 14; xx += 22) if (rnd() > 0.25) g.fillRect(xx, yy, 10, 14);
    });
  }
  // Repères numérotés, pavés au sol, détails : beaucoup de texture pour l'alignement
  g.font = 'bold 54px sans-serif'; g.textAlign = 'center';
  for (let i = 0; i < 36; i++) {
    const x = (i / 36) * W;
    wrapDraw(x, () => {
      g.fillStyle = i % 2 ? '#d9443a' : '#1f8a4c'; g.fillRect(-40, H / 2 - 30, 80, 60);
      g.fillStyle = '#fff'; g.fillText(String(i * 10), 0, H / 2 + 18);
    });
  }
  for (let i = 0; i < 900; i++) {
    const x = rnd() * W, y = H / 2 + 80 + rnd() * (H / 2 - 80), s = 6 + rnd() * 30;
    wrapDraw(x, () => { g.fillStyle = `hsl(${30 + rnd() * 20},${20 + rnd() * 30}%,${25 + rnd() * 45}%)`; g.fillRect(0, y, s * 2, s); });
  }
  for (let i = 0; i < 160; i++) {
    const x = rnd() * W, y = rnd() * H * 0.45, s = 4 + rnd() * 10;
    wrapDraw(x, () => { g.fillStyle = `rgba(255,255,255,${0.5 + rnd() * 0.5})`; g.fillRect(0, y, s, s); });
  }
  return g.getImageData(0, 0, W, H);
}

// Rend une vue perspective (caméra Rcw, focale f en pixels) depuis un équirectangulaire.
export function renderView(pano, Rcw, w, h, f, out) {
  const W = pano.width, H = pano.height, src = pano.data;
  const dst = out || new ImageData(w, h);
  const d = dst.data, cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = apply(Rcw, [(x + 0.5 - cx) / f, (y + 0.5 - cy) / f, 1]);
      const lon = Math.atan2(v[0], v[1]);
      const lat = Math.atan2(v[2], Math.hypot(v[0], v[1]));
      let u = (lon / (2 * Math.PI) + 0.5) * W, t = (0.5 - lat / Math.PI) * H;
      // bilinéaire avec bouclage horizontal
      u -= 0.5; t -= 0.5;
      const x0 = Math.floor(u), y0 = Math.max(0, Math.min(H - 2, Math.floor(t)));
      const fx = u - x0, fy = Math.max(0, Math.min(1, t - y0));
      const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
      const i00 = (y0 * W + xa) * 4, i10 = (y0 * W + xb) * 4, i01 = ((y0 + 1) * W + xa) * 4, i11 = ((y0 + 1) * W + xb) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++)
        d[o + k] = (src[i00 + k] * (1 - fx) + src[i10 + k] * fx) * (1 - fy) + (src[i01 + k] * (1 - fx) + src[i11 + k] * fx) * fy;
      d[o + 3] = 255;
    }
  }
  return dst;
}

// Contrôle de l'orientation à la souris / au clavier pour tester l'écran de capture.
export class SimOrientation {
  constructor(el) {
    this.yaw = 0; this.pitch = 0; this.listeners = [];
    let drag = null;
    this._down = (e) => { drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; };
    this.attach(el);
    window.addEventListener('pointerup', () => { drag = null; });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw = drag.yaw - (e.clientX - drag.x) * 0.25 * DEG;
      this.pitch = Math.max(-89.9 * DEG, Math.min(89.9 * DEG, drag.pitch + (e.clientY - drag.y) * 0.25 * DEG));
      this.emit();
    });
    window.addEventListener('keydown', (e) => {
      const s = 2 * DEG;
      if (e.key === 'ArrowLeft') this.yaw -= s;
      else if (e.key === 'ArrowRight') this.yaw += s;
      else if (e.key === 'ArrowUp') this.pitch = Math.min(89.9 * DEG, this.pitch + s);
      else if (e.key === 'ArrowDown') this.pitch = Math.max(-89.9 * DEG, this.pitch - s);
      else return;
      this.emit();
    });
  }
  // Rebranche la souris sur un nouvel écran (reprise ciblée)
  attach(el) { if (this._el) this._el.removeEventListener('pointerdown', this._down); this._el = el; el.addEventListener('pointerdown', this._down); }
  set(yaw, pitch) { this.yaw = yaw; this.pitch = pitch; this.emit(); }
  trueRcw() { return camLookingAt(this.yaw, this.pitch); }
  emit() { for (const l of this.listeners) l(); }
}
