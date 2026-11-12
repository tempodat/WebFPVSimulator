/*
 * head-selftest.js: the head tracker's arithmetic (src/head/gimbal.js), in
 * plain Node, against the facts it must keep.
 *
 * Each check is one way head tracking could be quietly wrong: the view
 * turning the opposite way to the head on some axis, recenter not taking
 * the offset out, the multiplier or a limit applied wrong, a still head
 * that still moves the picture, a servo that moves faster than it is
 * allowed, or a lost face that snaps or overshoots on its way home. Written
 * at the stop, not in a band, like the other selftests.
 *
 * Usage:
 *   npm run head:selftest
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

import {
  createGimbal, createOneEuro, faceToView, GIMBAL_DEFAULTS, HOLD_S, LOOK_LIMITS,
  oneEuro, relativeTo, resetGimbal, stepGimbal, yawPitchRoll,
} from '../src/head/gimbal.js';
import { matrixToQuat } from '../src/head/detect.js';

let passed = 0;
let failed = 0;

function check(what, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  pass  ${what}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${what}${detail ? `, ${detail}` : ''}`);
  }
}

const DEG = Math.PI / 180;
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const deg = (r) => (r / DEG).toFixed(3);

function axisAngle(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return { w: Math.cos(angle / 2), x: ax * s, y: ay * s, z: az * s };
}
function mul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
function rotate(q, v) {
  const p = mul(mul(q, { w: 0, ...v }), { w: q.w, x: -q.x, y: -q.y, z: -q.z });
  return { x: p.x, y: p.y, z: p.z };
}
const ypr = (q) => yawPitchRoll(q, {});

console.log('the head\'s frame to the view\'s');
{
  /* A head turned to the pilot's left: in the webcam's frame the nose, +Z
   * toward the lens, swings to +X, the picture's right. */
  const head = axisAngle(0, 1, 0, 30 * DEG);
  const nose = rotate(head, { x: 0, y: 0, z: 1 });
  check('turning left moves the nose to the webcam\'s +X', nose.x > 0.49);
  const v = faceToView({ ...head });
  const a = ypr(v);
  check('turning left 30 is a pan of +30 (three.js: +Y turns the view left)', near(a.yaw, 30 * DEG), deg(a.yaw));
  const fwd = rotate(v, { x: 0, y: 0, z: -1 });
  check('and the view\'s forward goes left', fwd.x < -0.49);

  /* Looking up: the nose goes to +Y, a negative turn about the webcam's X. */
  const up = axisAngle(1, 0, 0, -20 * DEG);
  check('looking up lifts the nose', rotate(up, { x: 0, y: 0, z: 1 }).y > 0.3);
  const b = ypr(faceToView({ ...up }));
  check('looking up 20 is a tilt of +20 (view looks up)', near(b.pitch, 20 * DEG), deg(b.pitch));
  check('and only a tilt', near(b.yaw, 0) && near(b.roll, 0));

  /* Leaning to the left shoulder: the top of the head goes to the
   * webcam's +X, a negative turn about its Z. */
  const lean = axisAngle(0, 0, 1, -15 * DEG);
  check('leaning left moves the crown to the webcam\'s +X', rotate(lean, { x: 0, y: 1, z: 0 }).x > 0.2);
  const c = ypr(faceToView({ ...lean }));
  check('leaning left 15 is a roll of +15 (view up goes left)', near(c.roll, 15 * DEG), deg(c.roll));
  const viewUp = rotate(faceToView({ ...lean }), { x: 0, y: 1, z: 0 });
  check('and the view\'s up goes left', viewUp.x < -0.2);
}

console.log('the model\'s matrix to a quaternion');
{
  /* A column major 4x4 (MediaPipe's layout) built from a known rotation,
   * with the face's scale and a translation folded in as the model may. */
  const cases = [
    mul(axisAngle(0, 1, 0, 35 * DEG), axisAngle(1, 0, 0, -12 * DEG)),
    axisAngle(0, 0, 1, 170 * DEG),
    axisAngle(0.6, 0, 0.8, -150 * DEG),
  ];
  let worst = 0;
  for (const q of cases) {
    const cols = [rotate(q, { x: 1, y: 0, z: 0 }), rotate(q, { x: 0, y: 1, z: 0 }), rotate(q, { x: 0, y: 0, z: 1 })];
    const k = 1.07;
    const d = [
      cols[0].x * k, cols[0].y * k, cols[0].z * k, 0,
      cols[1].x * k, cols[1].y * k, cols[1].z * k, 0,
      cols[2].x * k, cols[2].y * k, cols[2].z * k, 0,
      3, -2, -40, 1,
    ];
    const out = matrixToQuat(d, [0, 0, 0, 0]);
    /* q and -q are the same rotation. */
    const dot = Math.abs(out[0] * q.w + out[1] * q.x + out[2] * q.y + out[3] * q.z);
    worst = Math.max(worst, 1 - dot);
  }
  check('three rotations, scaled and moved, come back as themselves (all four trace branches near)', worst < 1e-12, worst.toExponential(2));
}

console.log('angles taken apart in pan, tilt, roll order');
{
  const q = mul(mul(axisAngle(0, 1, 0, 40 * DEG), axisAngle(1, 0, 0, -25 * DEG)), axisAngle(0, 0, 1, 10 * DEG));
  const a = ypr(q);
  check('a composed pan 40, tilt -25, roll 10 comes back as itself',
    near(a.yaw, 40 * DEG) && near(a.pitch, -25 * DEG) && near(a.roll, 10 * DEG),
    `${deg(a.yaw)} ${deg(a.pitch)} ${deg(a.roll)}`);
  const s = ypr(axisAngle(1, 0, 0, Math.PI / 2));
  check('straight up gives numbers, not NaN', Number.isFinite(s.yaw) && Number.isFinite(s.pitch) && Number.isFinite(s.roll));
}

console.log('recenter');
{
  /* A webcam above the screen sees "straight ahead" as looking down a bit
   * and a little to one side. Recenter takes that out. */
  const neutral = mul(axisAngle(0, 1, 0, 10 * DEG), axisAngle(1, 0, 0, -8 * DEG));
  const head = mul(neutral, axisAngle(0, 1, 0, 30 * DEG));
  const rel = ypr(relativeTo(neutral, head, {}));
  check('a 30 degree turn from an offset neutral reads 30', near(rel.yaw, 30 * DEG, 1e-12) && near(rel.pitch, 0, 1e-12), deg(rel.yaw));
  const same = ypr(relativeTo(neutral, neutral, {}));
  check('the neutral itself reads zero', near(same.yaw, 0) && near(same.pitch, 0) && near(same.roll, 0));
}

function run(g, head, cfg, seconds, dt = 1 / 60, each = null) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i += 1) {
    stepGimbal(g, head, cfg, dt);
    if (each) {
      each(g.out, i);
    }
  }
  return g.out;
}

console.log('look style');
{
  const cfg = { ...GIMBAL_DEFAULTS, deadzone: 0, sensYaw: 2 };
  const g = createGimbal();
  const out = run(g, { valid: true, yaw: 30 * DEG, pitch: 0, roll: 0 }, cfg, 0.5);
  check('sensitivity 2 turns a 30 degree head turn into 60', near(out.yaw, 60 * DEG, 1e-9), deg(out.yaw));
  run(g, { valid: true, yaw: 100 * DEG, pitch: 0, roll: 0 }, cfg, 1);
  check(`and stops at the look limit, ${LOOK_LIMITS.yaw}`, near(g.out.yaw, LOOK_LIMITS.yaw * DEG, 1e-9), deg(g.out.yaw));
  const h = createGimbal();
  run(h, { valid: true, yaw: 0, pitch: 0, roll: 20 * DEG }, { ...cfg }, 0.5);
  check('roll off: a leaning head does not roll the view', g.out.roll === 0 && h.out.roll === 0);
  run(h, { valid: true, yaw: 0, pitch: 0, roll: 20 * DEG }, { ...cfg, roll: true }, 0.5);
  check('roll on: it does', near(h.out.roll, 20 * DEG, 1e-9), deg(h.out.roll));
  const k = createGimbal();
  run(k, { valid: true, yaw: 1.5 * DEG, pitch: -1.9 * DEG, roll: 0 }, { ...GIMBAL_DEFAULTS, deadzone: 2 }, 0.5);
  check('a head inside the 2 degree dead zone leaves the view still', k.out.yaw === 0 && k.out.pitch === 0);
  run(k, { valid: true, yaw: 12 * DEG, pitch: 0, roll: 0 }, { ...GIMBAL_DEFAULTS, deadzone: 2 }, 0.5);
  check('and past it the view moves by the excess, with no step at the edge', near(k.out.yaw, 10 * DEG, 1e-9), deg(k.out.yaw));
  const m = createGimbal();
  run(m, { valid: true, yaw: 20 * DEG, pitch: 10 * DEG, roll: 0 }, { ...cfg, sensYaw: 1, invertYaw: true, invertPitch: true }, 0.5);
  check('invert turns each axis round', near(m.out.yaw, -20 * DEG, 1e-9) && near(m.out.pitch, -10 * DEG, 1e-9));
  const e = createGimbal();
  run(e, { valid: true, yaw: 15 * DEG, pitch: 0, roll: 0 }, { ...cfg, sensYaw: 1, expo: 0.5 }, 0.5);
  check('expo softens the middle of the travel', e.out.yaw > 0 && e.out.yaw < 15 * DEG, deg(e.out.yaw));
}

console.log('servo style');
{
  const cfg = { ...GIMBAL_DEFAULTS, style: 'servo', deadzone: 0, sensYaw: 3, servoYaw: 90, servoSpeed: 400 };
  const g = createGimbal();
  let fastest = 0;
  let prev = 0;
  run(g, { valid: true, yaw: 60 * DEG, pitch: 0, roll: 0 }, cfg, 1.5, 1 / 120, (o) => {
    fastest = Math.max(fastest, Math.abs(o.yaw - prev) * 120);
    prev = o.yaw;
  });
  check('a 3x, 60 degree head turn stops at the 90 degree travel', near(g.out.yaw, 90 * DEG, 1e-6), deg(g.out.yaw));
  check('and never moves faster than the 400 deg/s servo', fastest <= 400 * DEG + 1e-9, `${(fastest / DEG).toFixed(1)} deg/s`);
  const h = createGimbal();
  run(h, { valid: true, yaw: 30 * DEG, pitch: 0, roll: 0 }, { ...cfg, sensYaw: 1 }, 0.02, 1 / 120);
  check('the servo lags a step: 20 ms in, short of the target', h.out.yaw < 30 * DEG * 0.6, deg(h.out.yaw));
}

console.log('face lost');
{
  const cfg = { ...GIMBAL_DEFAULTS, deadzone: 0, sensYaw: 2 };
  const g = createGimbal();
  run(g, { valid: true, yaw: 30 * DEG, pitch: 15 * DEG, roll: 0 }, cfg, 0.5);
  const held = g.out.yaw;
  const lost = { valid: false, yaw: 0, pitch: 0, roll: 0 };
  let moved = false;
  run(g, lost, cfg, HOLD_S - 0.02, 1 / 60, (o) => { moved = moved || o.yaw !== held; });
  check(`the view holds for ${HOLD_S} s after the face is lost`, !moved && g.out.yaw === held);
  let crossed = false;
  run(g, lost, cfg, 1.2, 1 / 60, (o) => { crossed = crossed || o.yaw < 0 || o.pitch < 0; });
  check('then goes home: within 2 percent after a second', Math.abs(g.out.yaw) < 0.02 * held, deg(g.out.yaw));
  check('without overshooting', !crossed);
  let jump = 0;
  let prev = g.out.yaw;
  run(g, { valid: true, yaw: 40 * DEG, pitch: 0, roll: 0 }, cfg, 0.3, 1 / 60, (o) => {
    jump = Math.max(jump, Math.abs(o.yaw - prev));
    prev = o.yaw;
  });
  check('a face found again is followed, not cut to (no frame moves over 13 degrees)', jump <= 12.01 * DEG, deg(jump));
  /* The engage switch off: home at once, with the face still seen. */
  const turned = { valid: true, yaw: 30 * DEG, pitch: 15 * DEG, roll: 0 };
  run(g, turned, cfg, 0.5);
  const before = g.out.yaw;
  stepGimbal(g, turned, cfg, 1 / 60, true);
  check('the engage switch off starts the view home on its first frame, with no hold', g.out.yaw < before, deg(g.out.yaw));
  let offCrossed = false;
  for (let i = 0; i < 60; i += 1) {
    stepGimbal(g, turned, cfg, 1 / 60, true);
    offCrossed = offCrossed || g.out.yaw < 0 || g.out.pitch < 0;
  }
  check('and is home within 2 percent a second later, without overshooting', Math.abs(g.out.yaw) < 0.02 * before && !offCrossed, deg(g.out.yaw));
  let offJump = 0;
  let offPrev = g.out.yaw;
  run(g, turned, cfg, 0.3, 1 / 60, (o) => {
    offJump = Math.max(offJump, Math.abs(o.yaw - offPrev));
    offPrev = o.yaw;
  });
  check('switched back on, the head is followed again, not cut to', offJump <= 12.01 * DEG && near(g.out.yaw, 60 * DEG, 1e-6), deg(offJump));
  resetGimbal(g);
  check('reset puts it straight ahead', g.out.yaw === 0 && g.out.pitch === 0 && g.out.roll === 0);
}

console.log('the one euro filter');
{
  /* Still head with landmark jitter: a fixed seed so the run is the same. */
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const f = createOneEuro();
  let inSq = 0;
  let outSq = 0;
  const n = 300;
  for (let i = 0; i < n; i += 1) {
    const noise = rnd() * 0.02;
    const y = oneEuro(f, noise, i / 30, 1.7, 0.75);
    if (i > 30) {
      inSq += noise * noise;
      outSq += y * y;
    }
  }
  check('a still head\'s jitter comes out at under half its size', Math.sqrt(outSq) < 0.5 * Math.sqrt(inSq),
    `${(Math.sqrt(outSq / inSq) * 100).toFixed(0)} percent`);
  const s = createOneEuro();
  let t = 0;
  oneEuro(s, 0, t, 1.7, 0.75);
  let y = 0;
  for (let i = 1; i <= 12; i += 1) {
    t = i / 30;
    y = oneEuro(s, 1, t, 1.7, 0.75);
  }
  check('a quick turn is through in 0.4 s (95 percent)', y > 0.95, y.toFixed(3));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
