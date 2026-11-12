# Move head tracking's MediaPipe to a newer release

A prompt for one Claude Code session on WebFPVSimulator, or a checklist for a
person. Head tracking (`src/head/`) runs Google's MediaPipe Tasks Vision
FaceLandmarker from files committed in `vendor/mediapipe/`. This says how to
replace them with a newer release, and what to check before the commit.
Written 2026-11-12, when 1.2.0 was vendored.

## 0. Before you start

1. Read `CLAUDE.md` in full. Its rules bind: no em dashes or en dashes, a
   PROGRESS.md entry for the turn including what went wrong, a dependency
   change justified in PROGRESS.md first, and ask the owner which
   verification scale to run.
2. Read the PROGRESS.md entry "2026-11-12: head tracking for the FPV camera"
   for why this library, why it is committed rather than fetched, and why
   only the SIMD build.
3. Know the cost: every refresh adds about 19 MB to the repository's history
   for good. Do it for a reason (a fix that matters to tracking, a browser
   it now works on), not on a schedule.

## 1. Fetch

```
npm run vendor:mediapipe -- --latest
```

`--latest` takes the newest stable release that has been public for at least
14 days (`MIN_AGE_DAYS` in `scripts/vendor-mediapipe.js`). Add `--any-age` to
take a release younger than that, only on purpose. `--version X` takes exactly
X. With no flag the script refetches the pinned version (`PINNED`), which is
how to check the committed files still match their source.

The script stops without touching `vendor/mediapipe/` if the registry says the
licence is not Apache-2.0, if any file is missing or too small, or if the WASM
is not a WebAssembly module. Otherwise it replaces the folder, writes
`MANIFEST.json` (version, source URLs, sizes, SHA-256), and prints the NOTICE
block.

## 2. Check what changed upstream

1. The file layout. The script fetches `vision_bundle.mjs`,
   `wasm/vision_wasm_module_internal.js` and `.wasm`, and the model. If a
   release renames or drops the ES module loader (`_module_` in the name),
   the fetch fails: read the release's file list
   (`https://data.jsdelivr.com/v1/packages/npm/@mediapipe/tasks-vision@X?structure=flat`)
   and `FilesetResolver.forVisionTasks` in the bundle, and change `FILES` in
   the script and the loading in `src/head/detect.js` together.
2. The API `src/head/detect.js` uses: `FilesetResolver.forVisionTasks(base,
   true)`, `FaceLandmarker.createFromOptions` with
   `outputFacialTransformationMatrixes`, `runningMode: 'VIDEO'`, a `canvas`
   for the GPU delegate, `detectForVideo(image, timestampMs)`, and the result's
   `facialTransformationMatrixes[0].data` (column major 4x4) and
   `faceLandmarks[0]`. Grep `vision.d.ts` of the new release for each.
3. The model. The script pins the float16 bundle at version `1` in
   `MODEL_URL`. If Google publishes a newer model version, moving to it is a
   separate decision from moving the runtime: change `MODEL_URL` on its own
   commit.

## 3. Licences

1. The script has read the package's licence off the registry.
2. Read the three model cards on Google's own storage and confirm each still
   says Apache License, Version 2.0 (the URLs are in `MANIFEST.json`,
   `modelCards`; `pdftotext card.pdf - | grep -i -A2 licen`). If any says
   otherwise, stop and tell the owner: do not commit the model.
3. Replace the MediaPipe section of `NOTICE` with the block the script
   printed, keeping the paragraph below it.

## 4. Verify

1. `npm run head:selftest` (the arithmetic, including the matrix to
   quaternion conversion).
2. `npm run lint:boot` and `npm run lint:preload`. The vendored files are not
   in `src/fresh.js`'s preload list and must not become so: they load only
   when a pilot turns tracking on.
3. Fly it, in Firefox and in a Chromium: Settings, Head tracking, On. The
   status line should say Tracking (GPU); the preview's dots should sit on the
   nose and eye corners; turning the head left should pan left, looking up
   should tilt up. Cover the camera: HEAD LOST, a short hold, then the view
   eases home. Check the FPS readout with tracking on and off.

## 5. Commit

One commit, the vendored files with NOTICE and the PROGRESS.md entry, saying
the old and new versions and why the move was made.
