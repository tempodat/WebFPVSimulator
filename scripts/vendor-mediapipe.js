/*
 * vendor-mediapipe.js: fetch the head tracker's runtime and model into
 * vendor/mediapipe/, the one way they get into the repository.
 *
 * WHY THEY ARE COMMITTED. Head tracking (src/head/) must work from a plain
 * checkout and in the Steam edition, which reaches nothing off the machine,
 * so nothing is fetched from a CDN or from Google when a pilot turns it on.
 * The files are carried in git instead, about 19 MB a version, and every
 * refresh adds another copy to the history for good. So a refresh is a
 * deliberate act: run this, read what it printed, commit. See
 * prompts/vendor-mediapipe.md for the whole procedure and PROGRESS.md
 * (2026-11-12, head tracking) for why this library at all.
 *
 * WHAT IT FETCHES, all checked before anything in vendor/ is touched:
 *   vision_bundle.mjs                        the Tasks Vision ES module
 *   wasm/vision_wasm_module_internal.js      the ES module WASM loader, the
 *                                            one a module worker can import
 *   wasm/vision_wasm_module_internal.wasm    its SIMD build (no non SIMD
 *                                            build: see PROGRESS.md)
 *   face_landmarker.task                     the face model bundle
 *   LICENSE                                  Apache-2.0, from MediaPipe's
 *                                            repository: the npm package
 *                                            ships none
 * and writes MANIFEST.json: the version, where each file came from, its
 * size and its SHA-256. The licence of the package is read off the npm
 * registry and the run stops if it is not Apache-2.0.
 *
 * WHICH VERSION:
 *   node scripts/vendor-mediapipe.js               the PINNED version below
 *   node scripts/vendor-mediapipe.js --version X   exactly X
 *   node scripts/vendor-mediapipe.js --latest      the newest stable release
 *                                                  at least MIN_AGE_DAYS old
 *   add --any-age to --latest to take the newest whatever its age
 * The age floor is a supply chain habit: a release that has been public for
 * two weeks has been installed by many people who would have noticed it
 * doing something it should not. Pass --any-age only on purpose.
 *
 * Downloads land in a fresh temporary directory first and are moved into
 * vendor/mediapipe/ only when every one arrived and checks out, so a failed
 * run leaves the committed copy as it was.
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

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED = '1.2.0';
const MIN_AGE_DAYS = 14;
const PKG = '@mediapipe/tasks-vision';
const REGISTRY = `https://registry.npmjs.org/${PKG}`;
const CDN = (v) => `https://cdn.jsdelivr.net/npm/${PKG}@${v}`;
/* The model is versioned on its own, outside npm. "1" is the published
 * float16 bundle; Google also serves it as "latest", which is not used so
 * that a rerun of the same version fetches the same bytes. */
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const LICENSE_URL = 'https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE';
const MODEL_CARDS = [
  'https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf',
  'https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf',
  'https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf',
];

/* Each file, where it comes from, and the least it can weigh: a CDN error
 * page or a truncated body is caught here and not committed. */
const FILES = (v) => [
  { path: 'vision_bundle.mjs', url: `${CDN(v)}/vision_bundle.mjs`, min: 50e3 },
  { path: 'wasm/vision_wasm_module_internal.js', url: `${CDN(v)}/wasm/vision_wasm_module_internal.js`, min: 100e3 },
  { path: 'wasm/vision_wasm_module_internal.wasm', url: `${CDN(v)}/wasm/vision_wasm_module_internal.wasm`, min: 5e6, wasm: true },
  { path: 'face_landmarker.task', url: MODEL_URL, min: 1e6 },
  { path: 'LICENSE', url: LICENSE_URL, min: 5e3, text: 'Apache License' },
];

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'vendor', 'mediapipe');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`${url}: HTTP ${r.status}`);
  }
  return r.json();
}

async function pickVersion(meta) {
  if (arg('--version')) {
    return arg('--version');
  }
  if (!process.argv.includes('--latest')) {
    return PINNED;
  }
  const anyAge = process.argv.includes('--any-age');
  const floor = Date.now() - MIN_AGE_DAYS * 86400e3;
  const stable = Object.keys(meta.versions)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => anyAge || Date.parse(meta.time[v]) <= floor)
    .sort((a, b) => Date.parse(meta.time[a]) - Date.parse(meta.time[b]));
  if (!stable.length) {
    throw new Error('no stable release matches');
  }
  return stable[stable.length - 1];
}

async function main() {
  const meta = await getJson(REGISTRY);
  const version = await pickVersion(meta);
  const info = meta.versions[version];
  if (!info) {
    throw new Error(`${PKG}@${version} is not on the registry`);
  }
  if (info.license !== 'Apache-2.0') {
    throw new Error(`${PKG}@${version} says its licence is ${info.license}, not Apache-2.0: stop and read it`);
  }
  console.log(`${PKG}@${version}, published ${meta.time[version]}, ${info.license}`);

  const tmp = await mkdtemp(join(tmpdir(), 'vendor-mediapipe-'));
  const manifest = {
    package: PKG,
    version,
    published: meta.time[version],
    license: info.license,
    modelCards: MODEL_CARDS,
    fetched: new Date().toISOString(),
    files: [],
  };
  try {
    for (const f of FILES(version)) {
      const r = await fetch(f.url);
      if (!r.ok) {
        throw new Error(`${f.url}: HTTP ${r.status}`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < f.min) {
        throw new Error(`${f.path}: ${buf.length} bytes, expected at least ${f.min}`);
      }
      if (f.wasm && !(buf[0] === 0 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d)) {
        throw new Error(`${f.path}: not a WebAssembly module`);
      }
      if (f.text && !buf.toString('utf8').includes(f.text)) {
        throw new Error(`${f.path}: does not read as "${f.text}"`);
      }
      const sha256 = createHash('sha256').update(buf).digest('hex');
      await mkdir(dirname(join(tmp, f.path)), { recursive: true });
      await writeFile(join(tmp, f.path), buf);
      manifest.files.push({ path: f.path, url: f.url, bytes: buf.length, sha256 });
      console.log(`  ${f.path}  ${(buf.length / 1e6).toFixed(2)} MB  ${sha256.slice(0, 16)}`);
    }
    await writeFile(join(tmp, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    /* Every file arrived and checked out: replace the committed copy. */
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    for (const name of await readdir(tmp)) {
      await cp(join(tmp, name), join(dest, name), { recursive: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
  console.log(`\nwrote vendor/mediapipe/ (${(total / 1e6).toFixed(1)} MB). For NOTICE:\n`);
  console.log(`## MediaPipe Tasks Vision

    Upstream    https://github.com/google-ai-edge/mediapipe (npm ${PKG})
    Version     ${version}, published ${meta.time[version].slice(0, 10)}
    Licence     Apache-2.0 (package and the three models in face_landmarker.task)
    Vendored at vendor/mediapipe/
    Files       listed with their sources and SHA-256 in vendor/mediapipe/MANIFEST.json
    Licence text travels with them at vendor/mediapipe/LICENSE
`);
}

main().catch((e) => {
  console.error(`vendor-mediapipe: ${e.message}`);
  process.exit(1);
});
