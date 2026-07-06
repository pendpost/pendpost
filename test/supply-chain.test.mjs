#!/usr/bin/env node
// test/supply-chain.test.mjs - NFR-LIC-01 supply-chain hygiene as a gate.
//
// (a) the ROOT package.json declares ZERO runtime dependencies (no "dependencies"
//     key, or it is an empty object). The server core is node: built-ins only;
//     a single runtime dep added by accident must fail the build here.
// (b) the version string is IDENTICAL across the four places that carry it -
//     package.json, lib/util.mjs (VERSION), CITATION.cff, and the latest
//     released CHANGELOG.md heading - so a release can never half-bump.
//
// Zero-dep node:assert. This test reads files only (no PENDPOST_ROOT needed): it
// asserts repository invariants, not per-instance behaviour.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---- (a) zero runtime dependencies in the ROOT package.json ----------------
const pkg = JSON.parse(read('package.json'));
const deps = pkg.dependencies;
ok(
  deps == null || (typeof deps === 'object' && !Array.isArray(deps) && Object.keys(deps).length === 0),
  `root package.json has zero runtime dependencies (${deps ? Object.keys(deps).join(', ') || 'empty {}' : 'no dependencies key'})`,
);

// ---- (b) one version string, four sources of truth -------------------------
// package.json version is the canonical value the other three must equal.
const pkgVersion = pkg.version;
ok(typeof pkgVersion === 'string' && /^\d+\.\d+\.\d+/.test(pkgVersion), `package.json version is a semver string (${pkgVersion})`);

// lib/util.mjs: export const VERSION = '<x.y.z>';
const utilSrc = read('lib/util.mjs');
const utilMatch = utilSrc.match(/export\s+const\s+VERSION\s*=\s*'([^']+)'/);
ok(Boolean(utilMatch), 'lib/util.mjs exports a VERSION constant');
ok(utilMatch[1] === pkgVersion, `lib/util.mjs VERSION (${utilMatch[1]}) matches package.json (${pkgVersion})`);

// CITATION.cff: version: <x.y.z>  (a YAML scalar, optionally quoted).
const cffSrc = read('CITATION.cff');
const cffMatch = cffSrc.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m);
ok(Boolean(cffMatch), 'CITATION.cff carries a version field');
ok(cffMatch[1] === pkgVersion, `CITATION.cff version (${cffMatch[1]}) matches package.json (${pkgVersion})`);

// server.json (MCP registry manifest): both the top-level server version AND the
// npm package entry's version must equal package.json. The registry-publish
// workflow hard-fails on this mismatch AT PUBLISH TIME - catch it locally instead
// (the 1.2.1 release shipped with server.json still at 1.2.0 and only the workflow caught it).
const serverJson = JSON.parse(read('server.json'));
ok(serverJson.version === pkgVersion, `server.json version (${serverJson.version}) matches package.json (${pkgVersion})`);
const npmPkgEntry = (serverJson.packages || []).find((p) => p.registryType === 'npm');
ok(Boolean(npmPkgEntry), 'server.json declares an npm package entry');
ok(npmPkgEntry.version === pkgVersion, `server.json npm package version (${npmPkgEntry.version}) matches package.json (${pkgVersion})`);

// CHANGELOG.md: the latest RELEASED heading is the first "## [x.y.z]" that is
// not the "[Unreleased]" placeholder. That heading's version must match.
const changelog = read('CHANGELOG.md');
const headings = [...changelog.matchAll(/^##\s*\[([^\]]+)\]/gm)].map((m) => m[1]);
const latestReleased = headings.find((h) => h.toLowerCase() !== 'unreleased') || null;
ok(Boolean(latestReleased), `CHANGELOG.md has a released version heading (latest: ${latestReleased})`);
ok(latestReleased === pkgVersion, `latest released CHANGELOG.md heading (${latestReleased}) matches package.json (${pkgVersion})`);

// ---- (c) the published tarball allowlist stays tight -----------------------
// package.json `files` is an ALLOWLIST and npm does NOT apply .gitignore when it
// is present (and there is no .npmignore), so a bare "data/" / "app/" / "docs/"
// entry ships the owner's working data - including per-client .env credentials -
// plus the dashboard source and internal runbooks to the public registry. Lock
// the allowlist to the BUILT dashboard + the shipped contract, and forbid the
// over-broad entries. Guards the credential/private-data leak this caught.
const files = Array.isArray(pkg.files) ? pkg.files : [];
// Forbid the bare app//data//docs/ catch-alls AND any data/clients entry (the
// per-client subtree that holds the .env credentials + private working data).
const overBroad = files.filter((f) => /^(app|data|docs)\/?$/.test(f) || /^data\/clients(\/|$)/.test(f));
ok(overBroad.length === 0,
  `package.json files has no over-broad dir (offenders: ${overBroad.join(', ') || 'none'}) - ship app/dist/ + clean data/ example dirs, never bare app//data//docs/ or data/clients/`);
ok(files.includes('app/dist/'), 'package.json files ships the built dashboard (app/dist/)');
// app/dist/ is a BUILT artifact, not committed - so a lifecycle hook must
// rebuild it before npm packs the tarball, or the allowlist entry above ships an
// empty dir. Assert a prepack (or prepublishOnly) script runs the build, so the
// wiring that guarantees a bare `npm pack` rebuilds the dashboard can never
// silently disappear. Reads package.json only - does NOT require app/dist on disk.
const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
const buildHook = scripts.prepack ?? scripts.prepublishOnly;
ok(
  typeof buildHook === 'string' && /\bnpm run build\b/.test(buildHook),
  `package.json has a prepack/prepublishOnly hook that runs the build (${buildHook || 'none'}) - so app/dist/ is rebuilt before pack`,
);
ok(files.includes('AGENTS.md'), 'package.json files ships the AGENTS.md contract');
ok(!files.some((f) => /(^|\/)\.env$/.test(f)),
  'package.json files ships no raw .env (only .env.example is allowed)');

console.log(`[supply-chain] OK - zero runtime deps + version parity + tight publish allowlist across package.json, lib/util.mjs, CITATION.cff, CHANGELOG.md (${pass} assertions).`);
