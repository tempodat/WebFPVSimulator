/*
 * detect.js: one webcam frame in, the head's pose out, with MediaPipe's
 * FaceLandmarker from vendor/mediapipe/ (see NOTICE and PROGRESS.md,
 * 2026-11-12, head tracking).
 *
 * Shared by the two places detection can run: src/head/worker.js, where it
 * normally does, off the main thread that flies the quad, and the page
 * itself as a fallback when a module worker cannot be started there
 * (src/head/headtrack.js). Same code both ways, so the fallback is not a
 * second implementation to keep in step.
 *
 * WHERE THE FILES COME FROM. Only the sim's own origin: the ES module bundle
 * is imported from vendor/mediapipe/ and the fileset points the WASM loader
 * and the model at the same folder. useModule (the second argument of
 * forVisionTasks) picks the ES module loader, which a module worker can
 * import; the classic one needs importScripts, which module workers lack.
 * Only the SIMD build is carried, so a browser without WASM SIMD is told
 * head tracking is not supported rather than fetching a file that is not
 * there.
 *
 * WHAT COMES BACK. The facial transformation matrix's rotation as a unit
 * quaternion [w, x, y, z] in MediaPipe's camera frame (src/head/gimbal.js
 * says what that frame is and turns it into the view's), and three
 * landmarks (nose tip, the outer eye corners) in picture coordinates, 0 to
 * 1, for the preview in Settings. The matrix is column major: element (row
 * r, column c) is data[c * 4 + r].
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

const VENDOR = new URL('../../vendor/mediapipe/', import.meta.url);

/* Landmark indices in MediaPipe's 478 point face mesh. */
const NOSE_TIP = 1;
const EYE_RIGHT_OUTER = 33;
const EYE_LEFT_OUTER = 263;

function simdSupported() {
  /* The smallest module that uses a v128 instruction (i8x16.splat of a
   * constant, then drop): validate() is false where SIMD is missing. */
  return WebAssembly.validate(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7,
    0, 65, 0, 253, 15, 26, 11,
  ]));
}

/* The rotation part of a column major 4x4 as a unit quaternion. */
export function matrixToQuat(d, out) {
  const m00 = d[0]; const m10 = d[1]; const m20 = d[2];
  const m01 = d[4]; const m11 = d[5]; const m21 = d[6];
  const m02 = d[8]; const m12 = d[9]; const m22 = d[10];
  /* Divided by each column's length first: the face transform may carry
   * the face's scale, and a scaled matrix is not a rotation. */
  const sx = Math.hypot(m00, m10, m20) || 1;
  const sy = Math.hypot(m01, m11, m21) || 1;
  const sz = Math.hypot(m02, m12, m22) || 1;
  const a = m00 / sx; const b = m01 / sy; const c = m02 / sz;
  const e = m10 / sx; const f = m11 / sy; const g = m12 / sz;
  const h = m20 / sx; const i = m21 / sy; const j = m22 / sz;
  const tr = a + f + j;
  let w; let x; let y; let z;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (i - g) * s; y = (c - h) * s; z = (e - b) * s;
  } else if (a > f && a > j) {
    const s = 2 * Math.sqrt(1 + a - f - j);
    w = (i - g) / s; x = 0.25 * s; y = (b + e) / s; z = (c + h) / s;
  } else if (f > j) {
    const s = 2 * Math.sqrt(1 + f - a - j);
    w = (c - h) / s; x = (b + e) / s; y = 0.25 * s; z = (g + i) / s;
  } else {
    const s = 2 * Math.sqrt(1 + j - a - f);
    w = (e - b) / s; x = (c + h) / s; y = (g + i) / s; z = 0.25 * s;
  }
  const n = Math.hypot(w, x, y, z) || 1;
  out[0] = w / n; out[1] = x / n; out[2] = y / n; out[3] = z / n;
  return out;
}

/*
 * Resolves to {detect(image, tMs), delegate, close()}. canvas: an
 * OffscreenCanvas (in the worker) or a canvas (on the page) for the GPU
 * delegate; null to go straight to the CPU.
 */
export async function createDetector(canvas) {
  if (!simdSupported()) {
    const err = new Error('This browser has no WebAssembly SIMD, which the face tracker needs.');
    err.code = 'unsupported';
    throw err;
  }
  const { FilesetResolver, FaceLandmarker } = await import(new URL('vision_bundle.mjs', VENDOR).href);
  const fileset = await FilesetResolver.forVisionTasks(new URL('wasm', VENDOR).href.replace(/\/$/, ''), true);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: new URL('face_landmarker.task', VENDOR).href, delegate },
    ...(delegate === 'GPU' && canvas ? { canvas } : {}),
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  });
  let landmarker = null;
  let delegate = 'GPU';
  if (canvas) {
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      landmarker = null;
    }
  }
  if (!landmarker) {
    delegate = 'CPU';
    landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
  let lastT = -1;
  const q = [1, 0, 0, 0];
  const marks = [0, 0, 0, 0, 0, 0];
  return {
    delegate,
    /* Returns null when no face is found. The arrays are reused: copy
     * them before the next call (postMessage does). */
    detect(image, tMs) {
      /* VIDEO mode refuses a timestamp that does not move forward. */
      const t = tMs > lastT ? tMs : lastT + 1;
      lastT = t;
      const r = landmarker.detectForVideo(image, t);
      const m = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
      const lm = r.faceLandmarks && r.faceLandmarks[0];
      if (!m || !lm) {
        return null;
      }
      matrixToQuat(m.data, q);
      marks[0] = lm[NOSE_TIP].x; marks[1] = lm[NOSE_TIP].y;
      marks[2] = lm[EYE_RIGHT_OUTER].x; marks[3] = lm[EYE_RIGHT_OUTER].y;
      marks[4] = lm[EYE_LEFT_OUTER].x; marks[5] = lm[EYE_LEFT_OUTER].y;
      return { q, marks };
    },
    close() {
      landmarker.close();
    },
  };
}
