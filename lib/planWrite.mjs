// planWrite.mjs - pendpost's plan-file writer. Same mkdir-lockfile protocol
// as the engine siblings (scripts/*-social.mjs): every writer takes
// `<plan>.lock.d` before touching the file, so an engine field-merge save and
// a pendpost caption/cover edit can never lose each other's update (WP-1).
//
// pendpost owns owner-editable fields (caption, schedule, approval,
// cover, ...); engines own ONLY their publish-result fields - see the
// ENGINE_OWNED_FIELDS list in scripts/meta-social.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './util.mjs';
import { activeRoot } from './context.mjs';

const LOCK_RETRIES = 5;
const LOCK_RETRY_MS = 200;
const LOCK_STALE_MS = 15 * 60 * 1000;

// Relative plan paths anchor at the active client root (activeRoot()), so a
// plan resolves inside the active/override client's subtree.
export function resolvePlanPath(relOrAbs) {
  return path.resolve(activeRoot(), relOrAbs);
}

// mkdir lockfile next to the plan: retry, steal when stale. Unlike the engine
// copies (sync critical sections), fn may be async - the lock is held until
// it settles.
export async function withPlanLock(absPlanPath, fn) {
  const lockDir = `${absPlanPath}.lock.d`;
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { continue; }
      if (ageMs > LOCK_STALE_MS) {
        try { fs.rmdirSync(lockDir); } catch { /* racing steal */ }
        continue;
      }
      if (i >= LOCK_RETRIES) throw new Error(`plan lock busy: ${lockDir}`);
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* already released */ }
  }
}

// Read-mutate-write under the lock. The mutator receives the freshly-read
// plan object and may return a value, which is passed through.
export async function mutatePlan(absPlanPath, mutator) {
  return withPlanLock(absPlanPath, () => {
    const plan = JSON.parse(fs.readFileSync(absPlanPath, 'utf8'));
    const result = mutator(plan);
    atomicWriteJson(absPlanPath, plan);
    return result;
  });
}
