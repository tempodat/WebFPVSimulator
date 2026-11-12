/*
 * headtrack.js: the pilot's webcam, read for where their head points.
 *
 * The page side of head tracking. It opens the camera, hands frames to the
 * face model (src/head/worker.js, or detect.js on the page when no module
 * worker can start), filters what comes back and answers one question a
 * frame: relative to straight ahead, where is the head pointing now? What
 * the camera on the quad does with that is src/head/gimbal.js's.
 *
 * RENDER ONLY. Nothing here reaches the plant, the trace, the replay files
 * or any determinism check: the answer moves the FPV camera and nothing
 * else, and the frame that composes it is src/main.js's flight camera.
 *
 * THE CAMERA is asked for at 640 by 480 and 30 frames a second, the user
 * facing one, or the one picked in Settings. It is held only while head
 * tracking is on, and stop() gives it back to the browser (the light goes
 * out). A refused permission is status 'denied', said in Settings.
 *
 * THE FRAME PUMP. Each new webcam frame (requestVideoFrameCallback, with a
 * check of the video's clock each animation frame where that is missing) is
 * copied into an ImageBitmap and transferred to the worker, one in flight at
 * a time. Frames are only sent while setActive(true): the page turns that on
 * in flight and while the Settings preview is open, so a pilot in a menu
 * pays nothing for a camera they are not using. The same path runs on
 * Firefox and Chromium; the Chromium only stream processor is not used.
 *
 * FROM POSE TO ANGLES. q from the model -> faceToView -> relative to the
 * neutral (recenter) -> pan, tilt, roll -> a one euro filter per axis,
 * stamped with the frame's capture time. sample() then carries each angle
 * forward to the moment it is asked, by the filter's own speed estimate,
 * capped at PREDICT_MAX_S: a webcam frame is 30 ms or more old when it
 * lands, and the head kept turning meanwhile.
 *
 * RECENTER makes the latest pose straight ahead. It happens on its own a
 * second after the face is first found, so turning tracking on in an odd
 * chair is not a crooked view, and again whenever asked (C in flight, a
 * radio switch, or Settings).
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
  createOneEuro, faceToView, oneEuro, PREDICT_MAX_S, relativeTo, smoothingToFilter, yawPitchRoll,
} from './gimbal.js';

/* A pose older than this is not a face: the worker stalled, or the tab
 * slept. Counted as lost, and the gimbal's hold and ease take over. */
const STALE_MS = 250;
/* The automatic recenter waits for this much steady tracking. */
const AUTO_RECENTER_MS = 1000;
/* On the page (no worker), detection is held to this rate so the flight
 * keeps its frame time. */
const PAGE_MIN_INTERVAL_MS = 66;

export function createHeadTracker() {
  let status = 'off';
  let message = '';
  let delegate = '';
  let stream = null;
  let video = null;
  let worker = null;
  let pageDetector = null;
  let inFlight = false;
  /* True once a detector answered ready: a frame sent before that would be
   * dropped by the worker with no reply, and inFlight would never clear. */
  let ready = false;
  let active = false;
  let lastSentMs = -1e9;
  let pumpHandle = 0;
  let lastVideoTime = -1;
  let generation = 0;
  const listeners = new Set();

  /* The latest pose in the view's frame, and the neutral it is read from. */
  const qView = { w: 1, x: 0, y: 0, z: 0 };
  const qNeutral = { w: 1, x: 0, y: 0, z: 0 };
  const qRel = { w: 1, x: 0, y: 0, z: 0 };
  const angles = { yaw: 0, pitch: 0, roll: 0 };
  const fYaw = createOneEuro();
  const fPitch = createOneEuro();
  const fRoll = createOneEuro();
  const filt = { minCutoff: 1.7, beta: 0.75 };
  let smoothing = 0.5;
  let poseMs = -1e9;
  let faceSince = -1;
  let autoDone = false;
  let lastMarks = null;
  let detectMs = 0;
  /* The calibration's measured reach: the largest head angle seen since
   * resetRange(), radians, before any sensitivity. */
  const range = { yaw: 0, pitch: 0 };

  function setStatus(s, msg = '') {
    if (s === status && msg === message) {
      return;
    }
    status = s;
    message = msg;
    for (const fn of listeners) {
      fn(status, message);
    }
  }

  function resetFilters() {
    fYaw.t = -1;
    fPitch.t = -1;
    fRoll.t = -1;
  }

  function onPose(t, ok, q, marks, ms) {
    inFlight = false;
    detectMs = ms || 0;
    if (!ok) {
      lastMarks = null;
      faceSince = -1;
      if (status === 'tracking' || status === 'loading') {
        setStatus('noface');
      }
      return;
    }
    qView.w = q[0];
    qView.x = q[1];
    qView.y = q[2];
    qView.z = q[3];
    faceToView(qView);
    lastMarks = marks.slice(0, 6);
    if (faceSince < 0) {
      faceSince = t;
      /* A face found again starts its filter fresh, so the first angles
       * after a loss are not blended with the ones before it. */
      resetFilters();
    }
    if (!autoDone && t - faceSince >= AUTO_RECENTER_MS) {
      autoDone = true;
      recenter();
    }
    relativeTo(qNeutral, qView, qRel);
    yawPitchRoll(qRel, angles);
    const ts = t / 1000;
    smoothingToFilter(smoothing, filt);
    oneEuro(fYaw, angles.yaw, ts, filt.minCutoff, filt.beta);
    oneEuro(fPitch, angles.pitch, ts, filt.minCutoff, filt.beta);
    oneEuro(fRoll, angles.roll, ts, filt.minCutoff, filt.beta);
    range.yaw = Math.max(range.yaw, Math.abs(fYaw.x));
    range.pitch = Math.max(range.pitch, Math.abs(fPitch.x));
    poseMs = t;
    if (status !== 'tracking') {
      setStatus('tracking');
    }
  }

  function onError(code, msg) {
    inFlight = false;
    if (code === 'unsupported') {
      setStatus('unsupported', msg);
    } else if (code === 'detect') {
      /* One bad frame is not the end of tracking; say so and go on. */
      console.warn(`head tracking: ${msg}`);
    } else {
      setStatus('error', msg);
    }
  }

  function send(nowMs) {
    if (!video || inFlight || !active || document.hidden || video.readyState < 2) {
      return;
    }
    if (pageDetector && nowMs - lastSentMs < PAGE_MIN_INTERVAL_MS) {
      return;
    }
    if (!ready) {
      return;
    }
    inFlight = true;
    lastSentMs = nowMs;
    const gen = generation;
    createImageBitmap(video).then((bitmap) => {
      if (gen !== generation) {
        bitmap.close();
        return;
      }
      if (worker) {
        worker.postMessage({ type: 'frame', bitmap, t: nowMs }, [bitmap]);
        return;
      }
      let r = null;
      const t0 = performance.now();
      try {
        r = pageDetector.detect(bitmap, nowMs);
      } catch (err) {
        bitmap.close();
        onError('detect', String(err && err.message || err));
        return;
      }
      bitmap.close();
      onPose(nowMs, Boolean(r), r && r.q, r && r.marks, performance.now() - t0);
    }, () => {
      inFlight = false;
    });
  }

  function pump() {
    const gen = generation;
    if (video.requestVideoFrameCallback) {
      const onFrame = (now, meta) => {
        if (gen !== generation) {
          return;
        }
        /* captureTime is when the sensor took it, on performance.now's
         * clock, where the browser knows it; else the frame's arrival. */
        send(meta && meta.captureTime ? meta.captureTime : now);
        pumpHandle = video.requestVideoFrameCallback(onFrame);
      };
      pumpHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      const onTick = (now) => {
        if (gen !== generation) {
          return;
        }
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          send(now);
        }
        pumpHandle = requestAnimationFrame(onTick);
      };
      pumpHandle = requestAnimationFrame(onTick);
    }
  }

  async function startDetection(gen) {
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
    if (worker) {
      const ok = await new Promise((resolve) => {
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'ready') {
            delegate = m.delegate;
            ready = true;
            resolve(true);
          } else if (m.type === 'error' && m.code !== 'detect' && status === 'loading') {
            if (m.code === 'unsupported') {
              onError(m.code, m.message);
              resolve(true);
            } else {
              resolve(false);
            }
          } else if (m.type === 'error') {
            onError(m.code, m.message);
          } else if (m.type === 'pose') {
            onPose(m.t, m.ok, m.q, m.marks, m.ms);
          }
        };
        worker.onerror = () => resolve(false);
        worker.postMessage({ type: 'init' });
      });
      if (gen !== generation) {
        return;
      }
      if (ok) {
        return;
      }
      worker.terminate();
      worker = null;
    }
    /* No worker: the same detector on the page, at a held down rate. */
    try {
      const { createDetector } = await import('./detect.js');
      const canvas = document.createElement('canvas');
      const d = await createDetector(canvas);
      if (gen !== generation) {
        d.close();
        return;
      }
      pageDetector = d;
      ready = true;
      delegate = `${d.delegate}, on the page`;
    } catch (err) {
      if (gen === generation) {
        onError(err.code || 'load', String(err && err.message || err));
      }
    }
  }

  async function start(deviceId = '') {
    stop();
    const gen = generation;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('unsupported', 'This browser does not offer the camera to pages.');
      return;
    }
    setStatus('loading');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        },
      });
    } catch (err) {
      if (gen !== generation) {
        return;
      }
      const name = err && err.name;
      setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error',
        name === 'NotFoundError' ? 'No camera was found.' : String(err && err.message || err));
      return;
    }
    if (gen !== generation) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      return;
    }
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* A muted, inline video is allowed to play; if it still does not,
       * readyState stays low and send() waits. */
    }
    pump();
    await startDetection(gen);
  }

  function stop() {
    generation += 1;
    if (pumpHandle && video) {
      if (video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(pumpHandle);
      }
      cancelAnimationFrame(pumpHandle);
    }
    pumpHandle = 0;
    if (worker) {
      worker.postMessage({ type: 'close' });
      worker.terminate();
      worker = null;
    }
    if (pageDetector) {
      pageDetector.close();
      pageDetector = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) {
      video.srcObject = null;
      video = null;
    }
    inFlight = false;
    ready = false;
    poseMs = -1e9;
    faceSince = -1;
    autoDone = false;
    lastMarks = null;
    delegate = '';
    resetFilters();
    setStatus('off');
  }

  function recenter() {
    qNeutral.w = qView.w;
    qNeutral.x = qView.x;
    qNeutral.y = qView.y;
    qNeutral.z = qView.z;
    /* The filters held angles from the old neutral. */
    resetFilters();
  }

  /*
   * Where the head points now, relative to neutral, in radians, written
   * into out {valid, yaw, pitch, roll}. nowMs on performance.now's clock.
   */
  function sample(nowMs, out) {
    const age = nowMs - poseMs;
    out.valid = status === 'tracking' && age < STALE_MS && fYaw.t >= 0;
    if (!out.valid) {
      return out;
    }
    const ahead = Math.max(0, Math.min(PREDICT_MAX_S, age / 1000));
    out.yaw = fYaw.x + fYaw.dx * ahead;
    out.pitch = fPitch.x + fPitch.dx * ahead;
    out.roll = fRoll.x + fRoll.dx * ahead;
    return out;
  }

  return {
    start,
    stop,
    recenter,
    sample,
    setActive(on) {
      active = Boolean(on);
    },
    setSmoothing(s) {
      smoothing = s;
    },
    resetRange() {
      range.yaw = 0;
      range.pitch = 0;
    },
    range,
    get status() {
      return status;
    },
    get message() {
      return message;
    },
    get delegate() {
      return delegate;
    },
    get detectMs() {
      return detectMs;
    },
    /* For the Settings preview: the live video element (null when off)
     * and the last nose and eye points, picture coordinates 0 to 1. */
    get video() {
      return video;
    },
    get marks() {
      return lastMarks;
    },
    /* The filtered angles, radians, unpredicted, for the preview's numbers. */
    get angles() {
      return { yaw: fYaw.x, pitch: fPitch.x, roll: fRoll.x };
    },
    onStatus(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async cameras() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    },
  };
}
