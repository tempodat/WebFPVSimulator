/*
 * worker.js: the face tracker's own thread.
 *
 * The page's main thread flies the quad: Betaflight's WebAssembly at 1 kHz,
 * the renderer and the input poll all share it, and a face model costs
 * milliseconds a frame. So detection runs here, in a module worker, with
 * MediaPipe in its own WebAssembly instance and its own memory, and the
 * page only hands it frames and reads back a pose. Nothing in here can
 * touch the flight model or its determinism.
 *
 * THE MESSAGES (src/head/headtrack.js is the other end):
 *   in   {type: 'init'}                      load the runtime and model
 *   out  {type: 'ready', delegate}           'GPU' or 'CPU'
 *   out  {type: 'error', code, message}      code 'unsupported' or 'load'
 *   in   {type: 'frame', bitmap, t}          an ImageBitmap, transferred,
 *                                            and its capture time in ms
 *   out  {type: 'pose', t, ok, q, marks, ms} q [w, x, y, z] and marks as in
 *                                            src/head/detect.js; ok false
 *                                            when no face; ms the detect cost
 * One frame at a time: the page sends the next only after the answer, so a
 * slow detect drops webcam frames instead of queueing them.
 *
 * The GPU delegate draws into an OffscreenCanvas made here (WebGL2 in a
 * worker: Firefox 105 on, Chromium); where that fails detect.js falls back
 * to the CPU.
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

import { createDetector } from './detect.js';

let detector = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : null;
      detector = await createDetector(canvas);
      self.postMessage({ type: 'ready', delegate: detector.delegate });
    } catch (err) {
      self.postMessage({ type: 'error', code: err.code || 'load', message: String(err && err.message || err) });
    }
    return;
  }
  if (m.type === 'frame') {
    const bitmap = m.bitmap;
    if (!detector) {
      bitmap.close();
      return;
    }
    const t0 = performance.now();
    let r = null;
    try {
      r = detector.detect(bitmap, m.t);
    } catch (err) {
      bitmap.close();
      self.postMessage({ type: 'error', code: 'detect', message: String(err && err.message || err) });
      return;
    }
    bitmap.close();
    const ms = performance.now() - t0;
    self.postMessage(r
      ? { type: 'pose', t: m.t, ok: true, q: r.q, marks: r.marks, ms }
      : { type: 'pose', t: m.t, ok: false, ms });
    return;
  }
  if (m.type === 'close' && detector) {
    detector.close();
    detector = null;
  }
};
