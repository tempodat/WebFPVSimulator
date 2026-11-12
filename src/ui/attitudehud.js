/*
 * attitudehud.js: the attitude indicator drawn over the FPV picture.
 *
 * WHAT IT IS. A head up display in the fighter sense rather than a box in
 * a corner: a horizon line, a pitch ladder every 10 degrees, a roll scale
 * with a sky pointer, a waterline mark where the craft's nose points and a
 * flight path marker where the craft is actually going. Off by default;
 * Settings, Attitude indicator is its room (each mark on or off, the
 * style, the ladder's step, size, colour and opacity), and H turns it on
 * and off in flight.
 *
 * CONFORMAL BY DEFAULT, which is the one decision worth writing down. The horizon and
 * the ladder are drawn from the camera's own orientation, the quaternion
 * the frame was rendered with, so the drawn horizon lies on the rendered
 * one at any camera tilt, and will keep doing so when the camera moves on
 * its own (a gimbal). A Betaflight OSD's horizon is craft referenced
 * instead and sits off the real one by the uptilt, which is right for a
 * box of characters that cannot know the lens and wrong for a picture that
 * does. What the craft is doing is still on screen: the waterline is the
 * nose, which on a tilted mount sits below the middle of the frame, and
 * the roll and pitch numbers are the craft's, from the plant quaternion
 * through attitudeAngles in src/ui/fc.js, the same reading the Setup tab's
 * horizon uses. The other style, Betaflight, draws everything as if the
 * lens looked along the nose, the way a Betaflight OSD's artificial
 * horizon does: level flight puts the horizon through the middle of the
 * frame whatever the tilt, and it sits off the rendered horizon by it.
 *
 * THE PROJECTION is the camera's: a world direction goes into the camera
 * frame through the inverse of its quaternion and through the pinhole of
 * its vertical field of view, then through the fisheye bend when that is
 * on (main.js hands in fisheyeNdc, so this file needs no three.js and the
 * bend has one owner). Exact at every point under the rectilinear lens.
 * Under the fisheye the horizon is still exact, because it is drawn as a
 * polyline of projected points; the ladder's rungs are straight segments
 * through exactly projected centres, which is close enough for a mark.
 *
 * WITH HEAD TRACKING (src/head/) the lens turns on the frame, and the
 * pilot picks how the indicator rides it, Settings, Attitude indicator,
 * With head tracking:
 *   Cockpit (the default): the indicator is a panel fixed to the quad, as
 *     a fighter's HUD glass is fixed to the airframe. It is drawn as it
 *     would be with the head centred, then every point is carried through
 *     the gimbal onto the picture, so looking left slides the whole panel
 *     right and out of view, roll scale and numbers with it, and looking
 *     back brings it home. The horizon, ladder and flight path marker stay
 *     on the world as before, inside the panel.
 *   Visor: the indicator rides the head, as a helmet sight does. The roll
 *     scale and numbers stay in the middle of the screen, the horizon and
 *     ladder stay on the world wherever the head looks, and the nose mark
 *     shows where the nose is.
 * In both, the nose mark waits on the nearest edge, with an arrow toward
 * the nose, once the nose has left the picture.
 *
 * Only the picture: nothing here is read back by the flight, and the frame
 * object main.js hands in is its own, written in place every frame, so the
 * draw allocates nothing (P8).
 *
 * This file is part of WebFPVSimulator.
 *
 * WebFPVSimulator is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVSimulator is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY, without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVSimulator. If not, see <https://www.gnu.org/licenses/>.
 */

const DEG = Math.PI / 180;
/* The OSD's own ink (index.html, --osd-ink): every mark is drawn over a
 * dark edge, so it reads over a bright sky and over grass alike. */
const INK = 'rgba(11, 17, 22, 0.8)';
const MINT = '#8dffb0';

/*
 * THE ROOM'S CHOICES, here so the settings screen and the drawing share
 * one list. This file imports nothing, so ui.js can take these without
 * three.js. Each list's first entry is the default.
 */
export const AHI_STYLES = ['camera', 'craft'];
export const AHI_STYLE_LABEL = { camera: 'True horizon', craft: 'Betaflight' };
export const AHI_STEPS = [10, 5, 15, 20];
export const AHI_SIZES = ['medium', 'small', 'large'];
export const AHI_SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large' };
const AHI_SIZE_SCALE = { small: 0.8, medium: 1, large: 1.3 };
/* The OSD's own inks: cream as the numbers are, amber as the lap clock,
 * mint as GO, sakura as the perf readout's line, and plain white. */
export const AHI_COLOURS = ['cream', 'amber', 'mint', 'sakura', 'white'];
export const AHI_COLOUR_LABEL = { cream: 'Cream', amber: 'Amber', mint: 'Mint', sakura: 'Sakura', white: 'White' };
const AHI_COLOUR_HEX = { cream: '#f3ead4', amber: '#ffd45c', mint: '#8dffb0', sakura: '#e8a8b8', white: '#ffffff' };
export const AHI_OPACITIES = [100, 75, 50];
/* How the indicator rides a head tracked camera: see WITH HEAD TRACKING. */
export const AHI_MOUNTS = ['quad', 'head'];
export const AHI_MOUNT_LABEL = { quad: 'Cockpit', head: 'Visor' };

/* The ladder's rungs for a step, degrees of elevation, built once per step
 * the pilot picks. The horizon itself is drawn apart, as a full line. */
const rungCache = new Map();
function rungsFor(step) {
  let r = rungCache.get(step);
  if (!r) {
    r = [];
    for (let e = step; e <= 85; e += step) {
      r.push(-e, e);
    }
    rungCache.set(step, r);
  }
  return r;
}
/* The roll scale's ticks, degrees, and which of them are long. */
const ROLL_TICKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
const ROLL_LONG = new Set([-60, -30, 0, 30, 60]);
/* The horizon's sweep either side of the heading, and its step. Past about
 * 85 degrees a rectilinear lens throws the point to infinity. */
const SWEEP_DEG = 85;
const SWEEP_STEP = 5;
/* Below this speed the flight path marker is noise: hovering, the velocity
 * points anywhere. Metres per second. */
const FPM_MIN_SPEED = 2;

/*
 * The frame main.js fills in place and hands to draw(). Field by field:
 *   w, h        the canvas's CSS size (the shell's cssSize).
 *   qx..qw      the camera's world quaternion, three.js frame.
 *   tanV        tan of half the vertical field of view.
 *   aspect      width over height.
 *   tilt        the camera's uptilt from the airframe, radians, for the
 *               waterline: the nose is that far below the lens axis.
 *   vx, vy, vz  the craft's velocity, three.js world frame, m/s.
 *   roll, pitch the craft's attitude, radians: roll right positive, nose up
 *               positive (attitudeAngles).
 *   hx..hw      the head tracking gimbal, as the rotation that takes the
 *               camera's mount (where the lens sits with the head centred)
 *               into the camera: main.js's qHeadInv. Identity when head
 *               tracking is off, so nothing changes then.
 *   mount       'quad' (Cockpit) or 'head' (Visor): AHI_MOUNTS.
 * And the pilot's choices, copied from the settings each frame:
 *   style       'camera' (true horizon) or 'craft' (Betaflight).
 *   ladder, rollScale, nose, path   each mark on or off.
 *   step        degrees between rungs.
 *   size, colour, opacity           as the lists above.
 */
export function hudFrame() {
  return {
    w: 0, h: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    tanV: 1, aspect: 1, tilt: 0,
    vx: 0, vy: 0, vz: 0,
    roll: 0, pitch: 0,
    hx: 0, hy: 0, hz: 0, hw: 1,
    mount: 'quad',
    style: 'camera',
    ladder: true, rollScale: true, nose: true, path: true,
    step: 10, size: 'medium', colour: 'cream', opacity: 100,
  };
}

/*
 * Build the overlay inside `parent` (the OSD layer, which is up exactly in
 * flight and paused) and return its controls. `bend` maps an NDC point
 * through the lens's bend in place, or is absent for a pinhole.
 */
export function createAttitudeHud(parent, bend) {
  const canvas = document.createElement('canvas');
  canvas.className = 'osd-ahi';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  /* First child: under the corners, the crosshairs and the target mark. */
  parent.prepend(canvas);
  const ctx = canvas.getContext('2d');
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let drawn = false;

  /* Scratch, written in place. */
  const ndc = { x: 0, y: 0, z: 0 };
  const pt = { x: 0, y: 0 };
  const cam = { r: [0, 0, 0], u: [0, 0, 0], f: [0, 0, 0] };
  const loc = [0, 0, 0];
  let F = null;
  /* The quaternion the marks are projected through: the camera's, or in
   * the Betaflight style the mount's with the tilt taken back out, which
   * is the lens looking along the nose. And this frame's ink. */
  const Q = { x: 0, y: 0, z: 0, w: 1 };
  /* The mount's world quaternion: the camera's times the gimbal's way back
   * to its mount. The camera's own when there is no gimbal. */
  const M = { x: 0, y: 0, z: 0, w: 1 };
  /* Where the nose points, in the frame Q looks from: below the lens axis
   * by the tilt, and swung by the gimbal when the head is turned. */
  const nose = [0, 0, -1];
  /* Cockpit with the head turned: the marks are laid out as for the
   * mount's lens (pinhole, unbent) and each point is then carried through
   * the gimbal, Hq, onto the picture by place(). Off, every point is
   * already the picture's. sp is place()'s answer, and pen whether the
   * path being drawn has a point to go on from. */
  let mapped = false;
  const Hq = { x: 0, y: 0, z: 0, w: 1 };
  const sp = { x: 0, y: 0 };
  const loc2 = [0, 0, 0];
  let pen = false;
  let CREAM = AHI_COLOUR_HEX.cream;

  /* Rotate (x, y, z) by the camera quaternion's conjugate: world into the
   * camera frame (x right, y up, looking down -z). */
  function toCamera(x, y, z) {
    const qx = -Q.x;
    const qy = -Q.y;
    const qz = -Q.z;
    const qw = Q.w;
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    loc[0] = x + qw * tx + (qy * tz - qz * ty);
    loc[1] = y + qw * ty + (qz * tx - qx * tz);
    loc[2] = z + qw * tz + (qx * ty - qy * tx);
  }

  /* Rotate (x, y, z) by the camera quaternion: camera frame into world. */
  function toWorld(x, y, z, out) {
    const qx = Q.x;
    const qy = Q.y;
    const qz = Q.z;
    const qw = Q.w;
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
  }

  /* Rotate (x, y, z) by the quaternion (qx, qy, qz, qw) into out. */
  function rotate(qx, qy, qz, qw, x, y, z, out) {
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
  }

  /* A camera frame direction to CSS pixels in pt. False when it is behind
   * the lens, where a projection reflects through the centre and lies. */
  function projectCam(x, y, z, bendIt) {
    if (z > -1e-4) {
      return false;
    }
    ndc.x = x / (-z * F.tanV * F.aspect);
    ndc.y = y / (-z * F.tanV);
    ndc.z = 0;
    if (bend && bendIt) {
      bend(ndc);
    }
    pt.x = (ndc.x + 1) * 0.5 * F.w;
    pt.y = (1 - ndc.y) * 0.5 * F.h;
    return true;
  }

  /* Into the frame the marks are laid out in: the picture's, or the
   * mount's unbent one when place() carries them on. */
  function projectLocal(x, y, z) {
    return projectCam(x, y, z, !mapped);
  }

  /* A layout point (x, y) onto the picture, in sp. Cockpit with the head
   * turned: the point is a direction from the mount's lens, turned through
   * the gimbal and projected through the real one, bend and all. False
   * when that lands behind the lens. */
  function place(x, y) {
    if (!mapped) {
      sp.x = x;
      sp.y = y;
      return true;
    }
    const nx = (x / F.w) * 2 - 1;
    const ny = 1 - (y / F.h) * 2;
    rotate(Hq.x, Hq.y, Hq.z, Hq.w, nx * F.tanV * F.aspect, ny * F.tanV, -1, loc2);
    if (!projectCam(loc2[0], loc2[1], loc2[2], true)) {
      return false;
    }
    sp.x = pt.x;
    sp.y = pt.y;
    return true;
  }

  /* moveTo and lineTo through place(), a path broken where a point is
   * behind the lens; an arc as short chords so it bends with the rest;
   * and a label at a placed point. */
  function mv(x, y) {
    pen = place(x, y);
    if (pen) {
      ctx.moveTo(sp.x, sp.y);
    }
  }
  function ln(x, y) {
    if (!place(x, y)) {
      pen = false;
      return;
    }
    if (pen) {
      ctx.lineTo(sp.x, sp.y);
    } else {
      ctx.moveTo(sp.x, sp.y);
    }
    pen = true;
  }
  function arcPoly(cx, cy, r, a0, a1, n) {
    for (let i = 0; i <= n; i += 1) {
      const a = a0 + ((a1 - a0) * i) / n;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) {
        mv(x, y);
      } else {
        ln(x, y);
      }
    }
  }
  function txt(text, x, y) {
    if (place(x, y)) {
      label(text, sp.x, sp.y);
    }
  }

  function projectWorld(x, y, z) {
    toCamera(x, y, z);
    return projectLocal(loc[0], loc[1], loc[2]);
  }

  /* Each mark is one path stroked twice: the ink edge wide, then the cream
   * narrow over it. */
  function strokeTwice(s, colour) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.6 * s;
    ctx.stroke();
    ctx.strokeStyle = colour || CREAM;
    ctx.lineWidth = 1.6 * s;
    ctx.stroke();
  }

  function label(text, x, y) {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  function size() {
    const d = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (F.w === cssW && F.h === cssH && d === dpr) {
      return;
    }
    cssW = F.w;
    cssH = F.h;
    dpr = d;
    /* Sizing a canvas clears it, so it happens only when the window did. */
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
  }

  function drawHorizonAndLadder(s, ladder) {
    const w = F.w;
    const h = F.h;
    const f = cam.f;
    /* The heading: the lens axis laid flat. Within about a degree of
     * straight up or down it has no direction worth drawing a ladder on. */
    const fh = Math.hypot(f[0], f[2]);
    if (fh < 0.02) {
      return;
    }
    const hx = f[0] / fh;
    const hz = f[2] / fh;
    /* Level right of the heading: h cross up. */
    const rx = -hz;
    const rz = hx;

    /* The horizon, as a polyline of projected points, broken wherever a
     * point is behind the lens. */
    ctx.beginPath();
    let on = false;
    for (let a = -SWEEP_DEG; a <= SWEEP_DEG; a += SWEEP_STEP) {
      const ca = Math.cos(a * DEG);
      const sa = Math.sin(a * DEG);
      if (projectWorld(ca * hx + sa * rx, 0, ca * hz + sa * rz)) {
        if (on) {
          ln(pt.x, pt.y);
        } else {
          mv(pt.x, pt.y);
        }
        on = true;
      } else {
        on = false;
      }
    }
    strokeTwice(s);
    if (!ladder) {
      return;
    }

    /* The sky's direction on screen, at the centre: world up seen through
     * the lens, (up.r, up.u) in camera coordinates, y flipped for the
     * canvas. Under a pinhole every rung is square to it. */
    const nl = Math.hypot(cam.r[1], cam.u[1]);
    if (nl < 1e-4) {
      return;
    }
    /* Screen vectors: n toward the sky, t along the rungs (rightward when
     * the craft is upright). */
    const nxs = cam.r[1] / nl;
    const nys = -cam.u[1] / nl;
    const tx = -nys;
    const ty = nxs;
    const half = 64 * s;
    const gap = 22 * s;
    const tick = 8 * s;
    const margin = 40 * s;
    ctx.font = `700 ${Math.round(13 * s)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const e of rungsFor(F.step)) {
      const ce = Math.cos(e * DEG);
      const se = Math.sin(e * DEG);
      if (!projectWorld(ce * hx, se, ce * hz)) {
        continue;
      }
      const cx = pt.x;
      const cy = pt.y;
      if (cx < -margin - half || cx > w + margin + half || cy < -margin || cy > h + margin) {
        continue;
      }
      /* The end ticks point at the horizon: down the sky vector above it,
       * up it below. */
      const toward = e > 0 ? -1 : 1;
      const kx = nxs * toward * tick;
      const ky = nys * toward * tick;
      ctx.beginPath();
      ctx.setLineDash(e < 0 ? [7 * s, 5 * s] : []);
      mv(cx - tx * half + kx, cy - ty * half + ky);
      ln(cx - tx * half, cy - ty * half);
      ln(cx - tx * gap, cy - ty * gap);
      mv(cx + tx * gap, cy + ty * gap);
      ln(cx + tx * half, cy + ty * half);
      ln(cx + tx * half + kx, cy + ty * half + ky);
      strokeTwice(s * 0.85);
      ctx.setLineDash([]);
      const lx = tx * (half + 16 * s);
      const ly = ty * (half + 16 * s);
      const text = String(e);
      ctx.lineWidth = 3 * s;
      ctx.strokeStyle = INK;
      ctx.fillStyle = CREAM;
      txt(text, cx - lx, cy - ly);
      txt(text, cx + lx, cy + ly);
    }
  }

  /* The W itself, centred on (x, y): wings out to 4a, or to 2a when it
   * sits on the edge and needs the room for its arrow. */
  function waterlineAt(x, y, a, wings, s) {
    ctx.beginPath();
    ctx.moveTo(x - wings * a, y);
    ctx.lineTo(x - 2 * a, y);
    ctx.lineTo(x - a, y + a);
    ctx.lineTo(x, y);
    ctx.lineTo(x + a, y + a);
    ctx.lineTo(x + 2 * a, y);
    ctx.lineTo(x + wings * a, y);
    ctx.lineJoin = 'miter';
    strokeTwice(s, MINT);
  }

  /*
   * The waterline: where the nose points. On a tilted mount the nose is
   * below the lens axis by the tilt; with the head turned the gimbal swings
   * it across the picture, and when it leaves the picture, or is behind
   * the lens, the W waits on the edge nearest it with an arrow pointing the
   * way to it, so a pilot looking sideways can always find the heading.
   */
  function drawWaterline(s) {
    const a = 9 * s;
    const cx = F.w / 2;
    const cy = F.h / 2;
    const m = 6 * a;
    let dx = 0;
    let dy = 0;
    if (projectCam(nose[0], nose[1], nose[2], true)) {
      if (pt.x >= m && pt.x <= F.w - m && pt.y >= m && pt.y <= F.h - m) {
        waterlineAt(pt.x, pt.y, a, 4, s);
        return;
      }
      dx = pt.x - cx;
      dy = pt.y - cy;
    } else {
      /* Behind the lens: its sideways and up parts still say which way to
       * turn. Straight behind says nothing, so point down. */
      dx = nose[0];
      dy = -nose[1];
    }
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) {
      dx = 0;
      dy = 1;
      d = 1;
    }
    const ux = dx / d;
    const uy = dy / d;
    const k = Math.min(
      Math.abs(ux) > 1e-6 ? (cx - m) / Math.abs(ux) : Infinity,
      Math.abs(uy) > 1e-6 ? (cy - m) / Math.abs(uy) : Infinity,
    );
    if (!(k > 0)) {
      return;
    }
    const x = cx + ux * k;
    const y = cy + uy * k;
    waterlineAt(x, y, a, 2, s);
    /* The arrow, beyond the W toward the nose. */
    const ax = x + ux * 3.4 * a;
    const ay = y + uy * 3.4 * a;
    const bx = -uy;
    const by = ux;
    ctx.beginPath();
    ctx.moveTo(ax + ux * a, ay + uy * a);
    ctx.lineTo(ax - ux * 0.4 * a + bx * a, ay - uy * 0.4 * a + by * a);
    ctx.lineTo(ax - ux * 0.4 * a - bx * a, ay - uy * 0.4 * a - by * a);
    ctx.closePath();
    strokeTwice(s, MINT);
  }

  /* The flight path marker: a ring with wings and a fin, where the
   * velocity points. Absent in a hover and when the craft is flying
   * backwards out of the picture. */
  function drawFlightPath(s) {
    const sp = Math.hypot(F.vx, F.vy, F.vz);
    if (!(sp > FPM_MIN_SPEED)) {
      return;
    }
    if (!projectWorld(F.vx / sp, F.vy / sp, F.vz / sp)) {
      return;
    }
    const x = pt.x;
    const y = pt.y;
    if (x < 0 || x > F.w || y < 0 || y > F.h) {
      return;
    }
    const r = 7 * s;
    ctx.beginPath();
    arcPoly(x, y, r, 0, Math.PI * 2, 16);
    mv(x - r, y);
    ln(x - r * 2.4, y);
    mv(x + r, y);
    ln(x + r * 2.4, y);
    mv(x, y - r);
    ln(x, y - r * 1.9);
    strokeTwice(s);
  }

  /* The roll scale: fixed ticks on an arc over the middle of the frame and
   * a sky pointer that turns with the craft's bank. Pinned at the scale's
   * end past 60 degrees, with the number saying how far. */
  function drawRollScale(s) {
    const cx = F.w / 2;
    const cy = F.h / 2;
    const R = Math.min(F.w, F.h) * 0.36;
    ctx.beginPath();
    arcPoly(cx, cy, R, (-90 - 60) * DEG, (-90 + 60) * DEG, 24);
    for (const t of ROLL_TICKS) {
      const a = (t - 90) * DEG;
      const len = (ROLL_LONG.has(t) ? 12 : 7) * s;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      mv(cx + c * R, cy + sn * R);
      ln(cx + c * (R + len), cy + sn * (R + len));
    }
    strokeTwice(s * 0.85);
    const rollDeg = F.roll / DEG;
    const shown = Math.max(-60, Math.min(60, rollDeg));
    /* Sky pointer: the horizon turns against a right bank, and so does
     * the pointer, which always points at the sky. */
    const a = (-shown - 90) * DEG;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const px = cx + c * (R - 2 * s);
    const py = cy + sn * (R - 2 * s);
    const bx = -sn;
    const by = c;
    const d = 11 * s;
    ctx.beginPath();
    mv(px, py);
    ln(px - c * d + bx * d * 0.6, py - sn * d + by * d * 0.6);
    ln(px - c * d - bx * d * 0.6, py - sn * d - by * d * 0.6);
    ln(px, py);
    ctx.lineJoin = 'miter';
    strokeTwice(s, Math.abs(rollDeg) > 60 ? MINT : CREAM);
    /* The craft's numbers, over the top of the scale. */
    ctx.font = `700 ${Math.round(14 * s)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 * s;
    ctx.strokeStyle = INK;
    ctx.fillStyle = CREAM;
    const r = Math.round(rollDeg);
    const p = Math.round(F.pitch / DEG);
    txt(`R ${r}  P ${p}`, cx, cy - R - 16 * s);
  }

  return {
    node: canvas,
    /* Draw one frame. `frame` is a hudFrame() the caller owns. */
    draw(frame) {
      F = frame;
      if (!ctx || !(F.w > 8 && F.h > 8)) {
        return;
      }
      if (canvas.hidden) {
        canvas.hidden = false;
      }
      size();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      drawn = true;
      /* M = camera * gimbal back to the mount, or the camera alone. */
      const hx = F.hx || 0;
      const hy = F.hy || 0;
      const hz = F.hz || 0;
      const hw = F.hw === undefined ? 1 : F.hw;
      M.x = F.qw * hx + F.qx * hw + F.qy * hz - F.qz * hy;
      M.y = F.qw * hy - F.qx * hz + F.qy * hw + F.qz * hx;
      M.z = F.qw * hz + F.qx * hy - F.qy * hx + F.qz * hw;
      M.w = F.qw * hw - F.qx * hx - F.qy * hy - F.qz * hz;
      /* Cockpit lays the marks out on the mount's lens and carries them
       * through the gimbal; with the head centred there is nothing to
       * carry, and the marks go straight onto the picture as always. */
      const cockpit = F.mount !== 'head';
      mapped = cockpit && !(hx === 0 && hy === 0 && hz === 0);
      Hq.x = hx;
      Hq.y = hy;
      Hq.z = hz;
      Hq.w = hw;
      const craft = F.style === 'craft';
      if (craft) {
        /* Q = mount * (rotation about its x by -tilt): the lens looking
         * along the nose, whatever the tilt, as a Betaflight OSD draws it
         * from the craft alone; the head never changes what is drawn,
         * only, in Cockpit, where. The nose is the middle of the layout. */
        const sh = Math.sin(-F.tilt / 2);
        const ch = Math.cos(-F.tilt / 2);
        Q.x = M.w * sh + M.x * ch;
        Q.y = M.y * ch + M.z * sh;
        Q.z = M.z * ch - M.y * sh;
        Q.w = M.w * ch - M.x * sh;
      } else if (cockpit) {
        /* True horizon on the mount's lens, carried on by place(): the
         * horizon and ladder still land on the picture's own. */
        Q.x = M.x;
        Q.y = M.y;
        Q.z = M.z;
        Q.w = M.w;
      } else {
        /* True horizon through the camera itself. */
        Q.x = F.qx;
        Q.y = F.qy;
        Q.z = F.qz;
        Q.w = F.qw;
      }
      /* The nose in the real camera's frame, for its mark: from the mount
       * (below its axis by the tilt, or its axis in Betaflight's layout)
       * through the gimbal, except Visor's Betaflight, which keeps it in
       * the middle of the screen with the rest of its layout. */
      const nyM = craft ? 0 : -Math.sin(F.tilt);
      const nzM = craft ? -1 : -Math.cos(F.tilt);
      if (craft && !cockpit) {
        nose[0] = 0;
        nose[1] = nyM;
        nose[2] = nzM;
      } else {
        rotate(hx, hy, hz, hw, 0, nyM, nzM, nose);
      }
      CREAM = AHI_COLOUR_HEX[F.colour] || AHI_COLOUR_HEX.cream;
      ctx.globalAlpha = (AHI_OPACITIES.includes(F.opacity) ? F.opacity : 100) / 100;
      /* The camera's axes in the world: right, up and forward. */
      toWorld(1, 0, 0, cam.r);
      toWorld(0, 1, 0, cam.u);
      toWorld(0, 0, -1, cam.f);
      /* One size for every mark, from the shorter side, so a phone and a
       * monitor read the same and nothing outgrows the frame. */
      const s = Math.max(0.6, Math.min(2, Math.min(F.w, F.h) / 720))
        * (AHI_SIZE_SCALE[F.size] || 1);
      ctx.lineCap = 'round';
      drawHorizonAndLadder(s, F.ladder !== false);
      if (F.rollScale !== false) {
        drawRollScale(s);
      }
      if (F.nose !== false) {
        drawWaterline(s);
      }
      if (F.path !== false) {
        drawFlightPath(s);
      }
    },
    /* Put it away: hidden, and cleared so a later show never flashes the
     * last flight's horizon. One test when already away. */
    clear() {
      if (canvas.hidden && !drawn) {
        return;
      }
      canvas.hidden = true;
      if (drawn && ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      drawn = false;
    },
  };
}
