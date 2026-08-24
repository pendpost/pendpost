// cli-prompt.mjs - interactive TTY prompts for the hand-run connect ceremonies.
//
// A missing credential used to hard-error ("Need --client-id and --client-secret").
// On an interactive terminal the ceremony now PROMPTS for the value instead, so the
// operator pastes what they just copied from the provider's console - no secret on
// the command line (which would leak into shell history), no hand-editing .env.
//
// The rule that keeps this safe for automation: on a NON-interactive stdin (CI, a
// piped or mock run, the launchd daemon) there is nothing to prompt, so isInteractive()
// is false, the caller skips the prompt, and a missing value still fails closed with
// the caller's own error rather than hanging forever on a read that never arrives.
//
// The streams are injectable so the behaviour is testable without a real TTY.
import readline from 'node:readline';

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// A visible line prompt, for PUBLIC values (OAuth client id, redirect uri, a handle).
// Returns the trimmed answer.
export function promptLine(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

// A HIDDEN prompt, for SECRETS (client secret, bot token, app password). The
// keystrokes are never echoed, so the pasted value never shows on screen, in a
// screen-share, or in the scrollback - and because it is typed at a prompt rather
// than passed as an argv flag, it never enters shell history. The value never
// passes through the agent either: it goes straight from the operator's paste into
// the process that writes .env.
export function promptSecret(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    let muted = false;
    // Swallow every echo AFTER the question line is printed, so typed characters
    // (and the pasted secret) leave no trace on the terminal.
    rl._writeToOutput = (str) => { if (!muted) output.write(str); };
    rl.question(question, (answer) => {
      rl.close();
      output.write('\n');
      resolve((answer || '').trim());
    });
    muted = true;
  });
}

// Resolve one credential: an explicit value (flag/env the caller already read) wins;
// otherwise, on an interactive terminal, prompt for it (hidden when `secret`). Returns
// '' when the value is absent and there is no TTY to ask on - the caller then fails
// closed with its own "set it in .env / pass the flag" error. `hint` is the prompt text.
export async function resolveCredential({ value, hint, secret = false, streams }) {
  const v = (value || '').trim();
  if (v) return v;
  if (!isInteractive()) return '';
  return secret ? promptSecret(hint, streams) : promptLine(hint, streams);
}
