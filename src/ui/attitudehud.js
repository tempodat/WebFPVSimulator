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
   * the Betaflight style the camera's with the tilt taken back out, which
   * is the lens looking along the nose. And the tilt the waterline is
   * drawn at, zero in that style. And this frame's ink. */
  const Q = { x: 0, y: 0, z: 0, w: 1 };
  let tiltNow = 0;
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

  /* A camera frame direction to CSS pixels in pt. False when it is behind
   * the lens, where a projection reflects through the centre and lies. */
  function projectLocal(x, y, z) {
    if (z > -1e-4) {
      return false;
    }
    ndc.x = x / (-z * F.tanV * F.aspect);
    ndc.y = y / (-z * F.tanV);
    ndc.z = 0;
    if (bend) {
      bend(ndc);
    }
    pt.x = (ndc.x + 1) * 0.5 * F.w;
    pt.y = (1 - ndc.y) * 0.5 * F.h;
    return true;
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
    let pen = false;
    for (let a = -SWEEP_DEG; a <= SWEEP_DEG; a += SWEEP_STEP) {
      const ca = Math.cos(a * DEG);
      const sa = Math.sin(a * DEG);
      if (projectWorld(ca * hx + sa * rx, 0, ca * hz + sa * rz)) {
        if (pen) {
          ctx.lineTo(pt.x, pt.y);
        } else {
          ctx.moveTo(pt.x, pt.y);
          pen = true;
        }
      } else {
        pen = false;
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
      ctx.moveTo(cx - tx * half + kx, cy - ty * half + ky);
      ctx.lineTo(cx - tx * half, cy - ty * half);
      ctx.lineTo(cx - tx * gap, cy - ty * gap);
      ctx.moveTo(cx + tx * gap, cy + ty * gap);
      ctx.lineTo(cx + tx * half, cy + ty * half);
      ctx.lineTo(cx + tx * half + kx, cy + ty * half + ky);
      strokeTwice(s * 0.85);
      ctx.setLineDash([]);
      const lx = tx * (half + 16 * s);
      const ly = ty * (half + 16 * s);
      const text = String(e);
      ctx.lineWidth = 3 * s;
      ctx.strokeStyle = INK;
      ctx.fillStyle = CREAM;
      label(text, cx - lx, cy - ly);
      label(text, cx + lx, cy + ly);
    }
  }

  /* The waterline: where the nose points. On a tilted mount the nose is
   * below the lens axis by the tilt, straight down the picture in camera
   * terms whatever the craft is doing. */
  function drawWaterline(s) {
    if (!projectLocal(0, -Math.sin(tiltNow), -Math.cos(tiltNow))) {
      return;
    }
    const x = pt.x;
    const y = pt.y;
    const a = 9 * s;
    ctx.beginPath();
    ctx.moveTo(x - 4 * a, y);
    ctx.lineTo(x - 2 * a, y);
    ctx.lineTo(x - a, y + a);
    ctx.lineTo(x, y);
    ctx.lineTo(x + a, y + a);
    ctx.lineTo(x + 2 * a, y);
    ctx.lineTo(x + 4 * a, y);
    ctx.lineJoin = 'miter';
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
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.moveTo(x - r, y);
    ctx.lineTo(x - r * 2.4, y);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + r * 2.4, y);
    ctx.moveTo(x, y - r);
    ctx.lineTo(x, y - r * 1.9);
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
    ctx.arc(cx, cy, R, (-90 - 60) * DEG, (-90 + 60) * DEG);
    for (const t of ROLL_TICKS) {
      const a = (t - 90) * DEG;
      const len = (ROLL_LONG.has(t) ? 12 : 7) * s;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      ctx.moveTo(cx + c * R, cy + sn * R);
      ctx.lineTo(cx + c * (R + len), cy + sn * (R + len));
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
    ctx.moveTo(px, py);
    ctx.lineTo(px - c * d + bx * d * 0.6, py - sn * d + by * d * 0.6);
    ctx.lineTo(px - c * d - bx * d * 0.6, py - sn * d - by * d * 0.6);
    ctx.closePath();
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
    label(`R ${r}  P ${p}`, cx, cy - R - 16 * s);
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
      if (F.style === 'craft' && F.tilt !== 0) {
        /* Q = camera * (rotation about its x by -tilt). */
        const sh = Math.sin(-F.tilt / 2);
        const ch = Math.cos(-F.tilt / 2);
        Q.x = F.qw * sh + F.qx * ch;
        Q.y = F.qy * ch + F.qz * sh;
        Q.z = F.qz * ch - F.qy * sh;
        Q.w = F.qw * ch - F.qx * sh;
        tiltNow = 0;
      } else {
        Q.x = F.qx;
        Q.y = F.qy;
        Q.z = F.qz;
        Q.w = F.qw;
        tiltNow = F.tilt;
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
