/*
 * gimbal.js: from a head pose to the angles the FPV camera turns by.
 *
 * The pilot's webcam sees their head (src/head/headtrack.js and its worker
 * do that), and this file decides what the camera on the quad does about
 * it: which way is which, how far, how fast, and what happens when the face
 * is lost. Pure arithmetic on plain objects, the way src/render/predict.js
 * is, so scripts/head-selftest.js runs every case in Node and the page and
 * the test run the same code. Nothing here allocates after creation: the
 * page calls it once a frame (rule P8).
 *
 * THE FRAMES. MediaPipe's facial transformation matrix is the head's pose in
 * its camera's space: right handed, Y up, the camera at the origin looking
 * down -Z, and the face's own +Z out of the nose, so a face looking into the
 * lens has its nose pointing back at it. The FPV camera in three.js looks
 * down -Z with Y up too, but it looks AWAY from the pilot. A head turned to
 * the pilot's left (nose toward the webcam's +X, the picture's right) is a
 * positive turn about +Y, and so is a three.js camera turning left; looking
 * up and tilting the head are the other way round in the two frames. All
 * three facts are one conjugation by a half turn about Y, which leaves y and
 * w alone and negates x and z: faceToView. After it, a head that turns left,
 * looks up or leans left turns, tilts or rolls the view the same way.
 *
 * THE ANGLES. qRel = qNeutral^-1 q, the head relative to where the pilot
 * last said "straight ahead" (recenter), taken apart in Y then X then Z
 * order (pan, then tilt, then roll) because that is how a pan and tilt
 * gimbal is built: the pan turns about the frame's up, the tilt about the
 * panned camera's right. Head angles are radians throughout.
 *
 * WHAT THE PILOT SETS (cfg, from Settings, see src/ui/ui.js headtrack rows):
 *   sens       head to camera multiplier per axis, 0.5 to 4: at 2 a 30 degree
 *              head turn looks 60 degrees, so the eyes stay on the screen
 *   deadzone   degrees of head movement that do nothing, so a still head
 *              gives a still picture
 *   expo       0 to 1, softens the middle of the travel and keeps the ends
 *   roll       whether head roll moves the camera at all (off by default)
 *   style      'look': the camera goes where the head says, smoothed by the
 *              filter only, inside wide limits. 'servo': a pan and tilt
 *              gimbal on the quad, with hard travel stops, a first order
 *              lag and a slew limit, the way an analogue servo follows.
 *
 * FACE LOST. The camera holds where it was for HOLD_S (a blink of the
 * tracker should not move the picture), then eases back to straight ahead,
 * critically damped so it neither snaps nor overshoots. When the face comes
 * back the slew limit carries the camera to it rather than cutting.
 *
 * This file is part of WebFPVSimulator.
 *
 * WebFPVSimulator is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVSimulator is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const DEG = Math.PI / 180;

/* Face lost: hold this long, then ease home with this natural frequency
 * (rad/s). Critically damped at 8 rad/s is within 2 percent of home in
 * about 0.7 s and most of the way in 0.4 s. */
export const HOLD_S = 0.3;
const HOME_OMEGA = 8;

/* Look style's limits, degrees. Wide, because the point of a multiplier is
 * to see behind the shoulder; past these a view turns into a mirror. */
export const LOOK_LIMITS = { yaw: 150, pitch: 80, roll: 45 };
/* Look style still has a slew limit, high enough never to be felt in a
 * head turn, so a face found again after a loss does not cut the picture. */
const LOOK_SLEW = 720;

/* Prediction past the last sample is capped: the webcam runs at about 30
 * Hz and a sample older than this is a stall, not latency to hide. */
export const PREDICT_MAX_S = 0.06;

/* The defaults a fresh setting starts from. Sensitivity 1 is the honest
 * mapping; the pilot turns it up. */
export const GIMBAL_DEFAULTS = Object.freeze({
  style: 'look',
  sensYaw: 1,
  sensPitch: 1,
  sensRoll: 1,
  roll: false,
  deadzone: 2,
  expo: 0,
  smoothing: 0.5,
  invertYaw: false,
  invertPitch: false,
  servoYaw: 90,
  servoPitch: 45,
  servoSpeed: 400,
});

/* What each Settings row may hold. loadSettings holds a stored value to its
 * list, so an old or hand edited value falls back to the default. */
export const HEAD_STYLES = ['look', 'servo'];
export const HEAD_SENS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
export const HEAD_DEADZONES = [0, 1, 2, 3, 5];
export const HEAD_SMOOTHING = [0, 0.25, 0.5, 0.75, 1];
export const HEAD_EXPOS = [0, 0.25, 0.5, 0.75];
export const HEAD_PANS = [45, 60, 90, 120, 150];
export const HEAD_TILTS = [30, 45, 60, 80];
export const HEAD_SPEEDS = [200, 300, 400, 600, 900];

/* The setting's name for each knob: headStyle, headSensYaw and so on. */
export function headSettingKey(k) {
  return `head${k[0].toUpperCase()}${k.slice(1)}`;
}

/*
 * Calibration's answer: the multiplier that makes the head's comfortable
 * reach (radians, measured) turn the camera targetDeg, as the nearest step
 * on HEAD_SENS. null when the reach is too small to mean anything (the
 * pilot did not turn), so a bad measurement changes nothing.
 */
export function suggestSensitivity(reachRad, targetDeg) {
  const reach = reachRad / DEG;
  if (!(reach >= 5)) {
    return null;
  }
  const want = targetDeg / reach;
  let best = HEAD_SENS[0];
  for (const v of HEAD_SENS) {
    if (Math.abs(v - want) < Math.abs(best - want)) {
      best = v;
    }
  }
  return best;
}

/* q = [w, x, y, z] in place: a rotation in the face's camera frame becomes
 * the same motion of the FPV view (see THE FRAMES above). */
export function faceToView(q) {
  q.x = -q.x;
  q.z = -q.z;
  return q;
}

/* out = conj(a) b, both unit quaternions as {w, x, y, z}. */
export function relativeTo(a, b, out) {
  const aw = a.w;
  const ax = -a.x;
  const ay = -a.y;
  const az = -a.z;
  const w = aw * b.w - ax * b.x - ay * b.y - az * b.z;
  const x = aw * b.x + ax * b.w + ay * b.z - az * b.y;
  const y = aw * b.y - ax * b.z + ay * b.w + az * b.x;
  const z = aw * b.z + ax * b.y - ay * b.x + az * b.w;
  out.w = w;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/* A unit quaternion as pan (about Y), then tilt (about the panned X), then
 * roll (about the result's Z): the YXZ order three.js uses for a camera. */
export function yawPitchRoll(q, out) {
  const { w, x, y, z } = q;
  const m13 = 2 * (x * z + w * y);
  const m23 = 2 * (y * z - w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const m21 = 2 * (x * y + w * z);
  const m22 = 1 - 2 * (x * x + z * z);
  const s = Math.max(-1, Math.min(1, -m23));
  out.pitch = Math.asin(s);
  if (Math.abs(m23) < 0.9999999) {
    out.yaw = Math.atan2(m13, m33);
    out.roll = Math.atan2(m21, m22);
  } else {
    /* Looking straight up or down: pan and roll are one axis, so it is
     * all called pan. A head cannot get there; the guard is for NaN. */
    out.yaw = Math.atan2(-2 * (x * z - w * y), 1 - 2 * (y * y + z * z));
    out.roll = 0;
  }
  return out;
}

/*
 * THE ONE EURO FILTER (Casiez, Roussel and Vogel, CHI 2012), one per axis.
 * A low pass whose cutoff rises with speed: a still head is smoothed hard,
 * so landmark jitter does not shake the picture, and a quick turn is let
 * through with little lag. minCutoff (Hz) is the stillness smoothing, beta
 * how fast the cutoff opens with speed. It also keeps the speed it measured,
 * which is what the prediction to the frame's time runs on.
 */
export function createOneEuro() {
  return { t: -1, x: 0, dx: 0 };
}

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export function oneEuro(f, value, t, minCutoff, beta, dCutoff = 1) {
  if (f.t < 0 || t <= f.t) {
    if (f.t < 0) {
      f.x = value;
      f.dx = 0;
    }
    f.t = t;
    return f.x;
  }
  const dt = t - f.t;
  f.t = t;
  const rawDx = (value - f.x) / dt;
  f.dx += alpha(dCutoff, dt) * (rawDx - f.dx);
  const cutoff = minCutoff + beta * Math.abs(f.dx);
  f.x += alpha(cutoff, dt) * (value - f.x);
  return f.x;
}

/* The Smoothing setting, 0 to 1, as the filter's two numbers. 0 is the
 * least the jitter of a webcam landmark allows; 1 is a heavy, calm view. */
export function smoothingToFilter(smoothing, out) {
  const s = Math.max(0, Math.min(1, smoothing));
  out.minCutoff = 3 - 2.6 * s;
  out.beta = 1.2 - 0.9 * s;
  return out;
}

function shape(a, invert, deadzoneRad, sens, expo, limit) {
  let v = invert ? -a : a;
  const m = Math.abs(v) - deadzoneRad;
  v = m > 0 ? Math.sign(v) * m : 0;
  v *= sens;
  let u = v / limit;
  u = u > 1 ? 1 : u < -1 ? -1 : u;
  if (expo > 0) {
    u = u * (1 - expo) + u * u * u * expo;
  }
  return u * limit;
}

/* One axis's moving parts. */
function axis() {
  return { out: 0, cmd: 0, v: 0 };
}

export function createGimbal() {
  return {
    yaw: axis(),
    pitch: axis(),
    roll: axis(),
    lost: 0,
    /* What the frame reads: radians, pan, tilt and roll of the camera
     * relative to its mount. */
    out: { yaw: 0, pitch: 0, roll: 0 },
  };
}

/* Puts the camera straight ahead at once, for a restart or a switch off. */
export function resetGimbal(g) {
  for (const a of [g.yaw, g.pitch, g.roll]) {
    a.out = 0;
    a.cmd = 0;
    a.v = 0;
  }
  g.lost = 0;
  g.out.yaw = 0;
  g.out.pitch = 0;
  g.out.roll = 0;
}

function home(a, dt) {
  /* Critically damped spring toward zero, integrated exactly over dt. */
  const w = HOME_OMEGA;
  const e = Math.exp(-w * dt);
  const x0 = a.out;
  const v0 = a.v;
  const c = v0 + w * x0;
  a.out = (x0 + c * dt) * e;
  a.v = (c - w * (x0 + c * dt)) * e;
  a.cmd = a.out;
}

function follow(a, target, dt, servo, tau, slew) {
  const prev = a.out;
  let goal = target;
  if (servo) {
    /* First order lag toward the target, then the slew limit. */
    a.cmd += (target - a.cmd) * (1 - Math.exp(-dt / tau));
    goal = a.cmd;
  } else {
    a.cmd = target;
  }
  const step = slew * dt;
  const d = goal - a.out;
  a.out += d > step ? step : d < -step ? -step : d;
  a.v = dt > 0 ? (a.out - prev) / dt : 0;
}

/*
 * One frame. head: {valid, yaw, pitch, roll} in radians relative to
 * neutral, already filtered and predicted. cfg: GIMBAL_DEFAULTS' shape.
 * dt: seconds since the last call. off: the pilot's engage switch is off,
 * so the head is ignored and the view goes home at once, with no hold: the
 * hold is for a face the webcam missed, and this is the pilot's own word.
 * Writes g.out and returns it.
 */
export function stepGimbal(g, head, cfg, dt, off = false) {
  const d = dt > 0 ? Math.min(dt, 0.1) : 0;
  const servo = cfg.style === 'servo';
  if (off || !head.valid) {
    g.lost = (off ? Math.max(g.lost, HOLD_S) : g.lost) + d;
    if (g.lost > HOLD_S) {
      home(g.yaw, d);
      home(g.pitch, d);
      home(g.roll, d);
    }
  } else {
    g.lost = 0;
    const dz = cfg.deadzone * DEG;
    const ly = (servo ? cfg.servoYaw : LOOK_LIMITS.yaw) * DEG;
    const lp = (servo ? cfg.servoPitch : LOOK_LIMITS.pitch) * DEG;
    const lr = LOOK_LIMITS.roll * DEG;
    const ty = shape(head.yaw, cfg.invertYaw, dz, cfg.sensYaw, cfg.expo, ly);
    const tp = shape(head.pitch, cfg.invertPitch, dz, cfg.sensPitch, cfg.expo, lp);
    const tr = cfg.roll ? shape(head.roll, false, dz, cfg.sensRoll, cfg.expo, lr) : 0;
    const slew = (servo ? cfg.servoSpeed : LOOK_SLEW) * DEG;
    /* An analogue servo's lag, about 40 ms to two thirds of a step. */
    const tau = 0.04;
    follow(g.yaw, ty, d, servo, tau, slew);
    follow(g.pitch, tp, d, servo, tau, slew);
    follow(g.roll, tr, d, servo, tau, slew);
  }
  g.out.yaw = g.yaw.out;
  g.out.pitch = g.pitch.out;
  g.out.roll = g.roll.out;
  return g.out;
}
