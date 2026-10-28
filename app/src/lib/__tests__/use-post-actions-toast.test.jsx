import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePostActions } from '../usePostActions.js';
import AppToast from '../../components/AppToast.jsx';
import { ConfirmProvider } from '../../components/ui/confirm.jsx';
import { TooltipProvider } from '../../components/ui/Tooltip.jsx';
import { I18nProvider } from '../i18n.js';

// The overview row actions surface failures as the shared toast. The toast must say ONE plain
// sentence; an English server/engine line is never the visible text, only the "?" description
// (AppToast's { text, raw } shape, which keeps the "?" outside the announced alert).

const deletePostMock = vi.fn();
const approvePostMock = vi.fn();
const verifyPostMock = vi.fn();
const unschedulePostMock = vi.fn();
const resumeLaneMock = vi.fn();
const runPublishDueMock = vi.fn();

vi.mock('../api.js', () => ({
  approvePost: (...a) => approvePostMock(...a),
  rejectPost: vi.fn(),
  verifyPost: (...a) => verifyPostMock(...a),
  deletePost: (...a) => deletePostMock(...a),
  unschedulePost: (...a) => unschedulePostMock(...a),
  runPublishDue: (...a) => runPublishDueMock(...a),
  reschedulePost: vi.fn(),
  resumeLane: (...a) => resumeLaneMock(...a),
}));

function wrapper({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            {children}
            <AppToast />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const post = { id: 'p1', campaign: 'launch', approval: 'draft', executionMode: 'fully-scheduled', scheduledAt: '2026-06-01T10:00:00Z' };

async function runDelete() {
  const user = userEvent.setup();
  const { result } = renderHook(() => usePostActions(post), { wrapper });
  const del = result.current.items.find((i) => i.key === 'delete');
  let pending;
  act(() => { pending = del.run(); });
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
  await act(async () => { await pending; });
  return screen.findByRole('alert');
}

beforeEach(() => {
  [deletePostMock, approvePostMock, verifyPostMock, unschedulePostMock, resumeLaneMock, runPublishDueMock].forEach((m) => m.mockReset());
  try { localStorage.clear?.(); } catch { /* stubbed elsewhere */ }
});

describe('usePostActions delete: a failed row delete toasts a plain sentence', () => {
  it('an English server error is not the toast text; it rides the "?" only', async () => {
    deletePostMock.mockImplementation(() => Promise.reject(new Error('HTTP 500 internal')));
    const toast = await runDelete();
    expect(toast.textContent).toBe('Delete failed. The post is back in the plan.');
    expect(screen.queryByText(/HTTP 500/, { ignore: '.sr-only' })).toBeNull();
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('a message-less refusal still says the plain sentence, with no "?"', async () => {
    deletePostMock.mockImplementation(() => Promise.reject(new Error()));
    const toast = await runDelete();
    expect(toast.textContent).toBe('Delete failed. The post is back in the plan.');
    expect(screen.queryByRole('button', { name: /more about this/i })).toBeNull();
  });

  it('engine_failure says the cancel-failed sentence; the engine line rides the "?"', async () => {
    deletePostMock.mockImplementation(() => Promise.reject(Object.assign(new Error('native cancel failed on ghost: relay down'), { code: 'engine_failure' })));
    const toast = await runDelete();
    expect(toast.textContent).toMatch(/^Delete failed: the platform could not cancel the scheduled object/);
    expect(toast.textContent).not.toMatch(/relay down/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('native cancel failed on ghost: relay down');
  });
});

// The other row verbs (approve, park, verify, resume) toasted err.message verbatim. They now
// share the drawer's mapping: humanizeAction with the generic 'error.action' sentence.
const verbs = [
  ['approve', approvePostMock, { ...post, approval: 'pending' }],
  ['park', unschedulePostMock, { ...post, approval: 'approved' }],
  ['verify', verifyPostMock, { ...post, approval: 'approved', derivedState: 'fired-assumed' }],
  ['resume-lane', resumeLaneMock, { ...post, approval: 'approved', derivedState: 'publish-failed', lastFailure: { lane: 'x', halted: true } }],
];

describe.each(verbs)('usePostActions %s: a failure toasts a plain sentence', (key, mock, row) => {
  async function runVerb() {
    const { result } = renderHook(() => usePostActions(row), { wrapper });
    const item = result.current.items.find((i) => i.key === key);
    expect(item).toBeTruthy();
    await act(async () => { await item.run(); });
    return screen.findByRole('alert');
  }

  it('an English server error rides the "?" only', async () => {
    mock.mockImplementation(() => Promise.reject(new Error('HTTP 500 internal')));
    const toast = await runVerb();
    expect(toast.textContent).toBe('That did not work. Please try again.');
    expect(screen.queryByText(/HTTP 500/, { ignore: '.sr-only' })).toBeNull();
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('a message-less error says the plain sentence', async () => {
    mock.mockImplementation(() => Promise.reject(new Error()));
    const toast = await runVerb();
    expect(toast.textContent).toBe('That did not work. Please try again.');
    expect(screen.queryByRole('button', { name: /more about this/i })).toBeNull();
  });
});

// A lane that answered with its own (English) words: the row publish-now toast says the
// plain sentence (humanizeFailure, as PostDetail.onPublishNow does), the lane line rides the "?".
describe('usePostActions publish-now: a failed lane toasts a plain sentence', () => {
  it('the engine line is not the toast text', async () => {
    runPublishDueMock.mockImplementationOnce(() => Promise.resolve({ ran: [{ postId: 'p1', lane: 'x', ok: false, errorCode: 'publish_failed', errorMessage: 'HTTP 500 internal' }] }));
    const user = userEvent.setup();
    const { result } = renderHook(() => usePostActions({ ...post, approval: 'approved', derivedState: 'overdue' }), { wrapper });
    const pub = result.current.items.find((i) => i.key === 'publish-now');
    let pending;
    act(() => { pending = pub.run(); });
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /publish now/i }));
    await act(async () => { await pending; });
    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toMatch(/^Not published: /);
    expect(toast.textContent).not.toMatch(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });
});

// needs_confirm carries an English line for agents ("pass confirm: true"), never dialog copy.
// The row park confirm uses the Studio's own sentence, exactly like PostDetail.onPark.
describe('usePostActions park: the needs_confirm dialog says the Studio sentence', () => {
  it('the engine line is not the confirm body', async () => {
    unschedulePostMock.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('native object exists; pass confirm: true'), { code: 'needs_confirm' })));
    const { result } = renderHook(() => usePostActions({ ...post, approval: 'approved' }), { wrapper });
    const park = result.current.items.find((i) => i.key === 'park');
    act(() => { park.run(); });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This post is scheduled on the platform itself. Parking it deletes the scheduled copy there.');
    expect(dialog.textContent).not.toMatch(/pass confirm/);
  });
});

// #40: a row approve refused by the brand-lint gate toasts the sentence that names the platform
// and the fix (no "approve anyway"), the finding rides the "?".
describe('usePostActions approve: a lint_blocked refusal names the platform', () => {
  it('toasts the lint sentence', async () => {
    approvePostMock.mockImplementation(() => Promise.reject(Object.assign(new Error('caption fails brand lint on x'), {
      code: 'lint_blocked',
      findings: [{ platform: 'x', rule: 'banned-phrase', match: 'game-changer', hint: 'Say what it does instead.' }],
    })));
    const { result } = renderHook(() => usePostActions({ ...post, approval: 'pending' }), { wrapper });
    await act(async () => { await result.current.items.find((i) => i.key === 'approve').run(); });
    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toBe('The caption breaks a brand rule on X (Banned phrase). Edit the caption for X or remove X from the post.');
    expect(screen.queryByRole('button', { name: /more about this/i })).toBeNull();
  });
});

// An approve the engine accepted while the image is not online yet (mediaPending) says so in
// the same shared toast; a plain approve stays silent.
describe('usePostActions approve: the success notice', () => {
  it('says the image is not online yet', async () => {
    approvePostMock.mockResolvedValue({ ok: true, mediaPending: [{ platform: 'instagram', url: 'https://brand.example/a.jpg' }] });
    const { result } = renderHook(() => usePostActions({ ...post, approval: 'pending' }), { wrapper });
    await act(async () => { await result.current.items.find((i) => i.key === 'approve').run(); });
    expect(await screen.findByText("Approved. The image isn't online yet; pendpost checks it again right before posting.")).toBeInTheDocument();
  });

  it('a plain approve shows no toast', async () => {
    approvePostMock.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => usePostActions({ ...post, approval: 'pending' }), { wrapper });
    await act(async () => { await result.current.items.find((i) => i.key === 'approve').run(); });
    expect(screen.queryByText(/Approved\./)).toBeNull();
  });
});
