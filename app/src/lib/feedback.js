// feedback.js - pure deep-link builder for the in-app "Help & feedback" dialog.
//
// pendpost is local-first with a hard no-telemetry rule: the app never stores or
// transmits feedback itself. Instead this builds a URL the user explicitly opens,
// handing off to a channel that already exists:
//   - bug / feature  -> a PRE-FILLED GitHub issue, keyed on the field `id`s in
//                       .github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml
//                       (GitHub reads ?field-id=value query params on issues/new).
//   - feedback        -> a PRE-FILLED mailto: to the maintainer inbox.
// No React, no DOM - just string building, so it is trivially unit-testable and
// the single source of truth for the dialog (which stays a thin consumer).
//
// NOTE: the GitHub links 404 for anyone without repo access until the repo is
// public. That is acceptable - the email path always works, and the repo goes
// public at launch.

export const FEEDBACK_REPO = 'https://github.com/pendpost/pendpost';
export const FEEDBACK_EMAIL = 'hello@pendpost.com';
export const FEEDBACK_TYPES = ['feedback', 'bug', 'feature'];

// A one-line title from the first line of the message, capped so the GitHub issue
// title (and mail subject) stay readable. Collapses whitespace; appends an ellipsis
// when truncated.
function titleSlug(message, max = 60) {
  const oneLine = String(message || '').trim().replace(/\s+/g, ' ');
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

// Build a query string, encoding every key and value and dropping empties so an
// absent diagnostic never leaves a spurious `&version=` in the URL.
function queryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// buildFeedbackTarget({ type, message, diagnostics }) -> { kind, url }
//   kind: 'github' (open in a new tab) | 'mailto' (open the mail client)
// `diagnostics` is { version, os, node, mode } sourced from /api/health; only the
// bug path uses it (version/os/node prefilled, mode mapped to the dropdown option).
export function buildFeedbackTarget({ type, message = '', diagnostics = {} } = {}) {
  const msg = String(message || '');
  const slug = titleSlug(msg);

  if (type === 'bug') {
    const url = `${FEEDBACK_REPO}/issues/new?${queryString({
      template: 'bug_report.yml',
      title: `[bug] ${slug}`,
      'what-happened': msg,
      version: diagnostics.version,
      mode: diagnostics.mode,
      node: diagnostics.node,
      os: diagnostics.os,
    })}`;
    return { kind: 'github', url };
  }

  if (type === 'feature') {
    const url = `${FEEDBACK_REPO}/issues/new?${queryString({
      template: 'feature_request.yml',
      title: `[feature] ${slug}`,
      problem: msg,
    })}`;
    return { kind: 'github', url };
  }

  // General feedback -> email. mailto query params follow the same encoding rules.
  const url = `mailto:${FEEDBACK_EMAIL}?${queryString({
    subject: `[pendpost] ${slug || 'feedback'}`,
    body: msg,
  })}`;
  return { kind: 'mailto', url };
}
