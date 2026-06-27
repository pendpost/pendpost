#!/usr/bin/env node
// test/cloud-error-codes.test.mjs - regression guard for the cloud error-code registry.
// The managed-cloud routes throw CloudError codes (no_api_key, not_configured, ...) that
// cloudRoute (lib/api.mjs) formats via errorBody() (lib/util.mjs). errorBody() THROWS on
// any code missing from ERROR_CODES. The cloud codes lived in CLOUD_ERROR_STATUS but not
// ERROR_CODES, so a real "no api key" condition surfaced to the UI as the garbled
// "unknown error code: no_api_key" at HTTP 500 instead of a clean { code, message } at
// 400. This pins the fix: errorBody() must RETURN for the cloud code, not throw.
import assert from 'node:assert';
import { errorBody } from '../lib/util.mjs';

assert.deepStrictEqual(errorBody('no_api_key', 'x'), { code: 'no_api_key', message: 'x' });
console.log('ok - errorBody returns a body for the cloud no_api_key code (does not throw)');
