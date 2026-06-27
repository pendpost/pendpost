// context.mjs - per-client root resolution (Phase 1a multi-client foundation).
//
// Every path helper that used to anchor at WORKSPACE_ROOT now anchors at
// activeRoot(): the per-request client root when one is bound (withClient), else
// a backward-compatible fallback. The fallback keeps the single-workspace world
// working unchanged: when no clients.json exists yet, activeRoot() IS the legacy
// WORKSPACE_ROOT, so an un-migrated checkout (and every existing test that sets
// PENDPOST_ROOT before importing lib/) resolves exactly the same files as before.
//
// Zero-dep: node:async_hooks AsyncLocalStorage carries the bound root through the
// async call tree (a publish run, an API request) without threading it by hand.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WORKSPACE_ROOT, DATA_ROOT } from './util.mjs';

const als = new AsyncLocalStorage();

// data/clients.json read is cached: activeRoot() is on the hot path of every
// path helper. The cache is invalidated whenever the registry is written
// (multi-client.mjs calls invalidateRegistryCache) so a freshly-migrated or
// re-pointed active client is seen immediately. DATA_ROOT is read INSIDE the
// function (not at module top level) so the util.mjs <-> context.mjs import
// cycle resolves cleanly - the binding is live by the time activeRoot() runs.
let registryCache; // undefined = not yet read; null = file absent; object = parsed

function readRegistry() {
  if (registryCache !== undefined) return registryCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'clients.json'), 'utf8'));
    registryCache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    // Missing (ENOENT) or unparseable -> behave as un-migrated (legacy fallback).
    registryCache = null;
  }
  return registryCache;
}

// Called by multi-client.mjs after any registry write so the next activeRoot()
// re-reads clients.json (new active client, or the registry now existing at all).
export function invalidateRegistryCache() {
  registryCache = undefined;
}

// Run fn with clientRootAbs bound as the active root for the whole async subtree.
// The caller resolves the slug to an absolute path via multi-client.clientRoot().
export function withClient(clientRootAbs, fn) {
  return als.run(clientRootAbs, fn);
}

// The currently-bound client root, or null when none is in context.
export function boundRoot() {
  return als.getStore() || null;
}

// The active root for path resolution:
//  1. an explicit withClient() binding, if any;
//  2. else, if data/clients.json exists, DATA_ROOT/clients/<activeClientId>;
//  3. else the legacy WORKSPACE_ROOT (un-migrated / single-workspace fallback).
export function activeRoot() {
  const bound = als.getStore();
  if (bound) return bound;
  const registry = readRegistry();
  if (registry) {
    const id = typeof registry.activeClientId === 'string' && registry.activeClientId ? registry.activeClientId : 'default';
    return path.join(DATA_ROOT, 'clients', id);
  }
  return WORKSPACE_ROOT;
}
