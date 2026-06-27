#!/usr/bin/env node
// mcpb entry_point shim (required by the mcpb 0.3 manifest). The real launch is
// mcp_config.command in manifest.json (npx -y pendpost --stdio); this shim does the
// same if a host execs the entry_point directly.
import { spawn } from 'node:child_process';
const child = spawn('npx', ['-y', 'pendpost', '--stdio'], { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
