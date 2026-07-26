import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer, { TelegramCtaFields, DiscordEmbedFields } from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Spec 14: rich link/CTA - Telegram inline CTA buttons + link-preview/format
// control (TelegramCtaFields), and a Discord rich embed card (DiscordEmbedFields).
// Mirrors interactive-fields.test.jsx: direct sub-component tests + a Composer-
// level gating test (rel.tgCta / rel.dcEmbed).

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function renderTgCta(props = {}) {
  const onChange = vi.fn();
  const utils = render(
    <TooltipProvider>
      <TelegramCtaFields cta={{ buttons: [], linkPreview: true, format: 'plain' }} onChange={onChange} {...props} />
    </TooltipProvider>,
  );
  return { ...utils, onChange };
}

describe('TelegramCtaFields (spec 14 authoring)', () => {
  it('shows the empty-state prompt with no buttons yet', () => {
    renderTgCta();
    expect(screen.getByText(/no buttons yet/i)).toBeInTheDocument();
  });

  it('adds a button via the Add button control', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTgCta();
    await user.click(screen.getByRole('button', { name: /add button/i }));
    expect(onChange).toHaveBeenCalledWith({ buttons: [{ label: '', url: '' }], linkPreview: true, format: 'plain' });
  });

  it('shows label + url inputs for an existing button and edits the label', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTgCta({ cta: { buttons: [{ label: 'Read more', url: 'https://example.com' }], linkPreview: true, format: 'plain' } });
    expect(screen.getByLabelText('Button label')).toHaveValue('Read more');
    expect(screen.getByLabelText('Button URL')).toHaveValue('https://example.com');
    await user.type(screen.getByLabelText('Button label'), '!');
    expect(onChange).toHaveBeenCalledWith({
      buttons: [{ label: 'Read more!', url: 'https://example.com' }],
      linkPreview: true,
      format: 'plain',
    });
  });

  it('removes a button via the remove control', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTgCta({ cta: { buttons: [{ label: 'Go', url: 'https://example.com' }], linkPreview: true, format: 'plain' } });
    await user.click(screen.getByRole('button', { name: /remove button/i }));
    expect(onChange).toHaveBeenCalledWith({ buttons: [], linkPreview: true, format: 'plain' });
  });

  it('hides the Add button control once 4 buttons are present (cap)', () => {
    const buttons = Array.from({ length: 4 }, (_, i) => ({ label: `B${i}`, url: 'https://example.com' }));
    renderTgCta({ cta: { buttons, linkPreview: true, format: 'plain' } });
    expect(screen.queryByRole('button', { name: /add button/i })).not.toBeInTheDocument();
  });

  it('toggles the link-preview checkbox', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTgCta();
    await user.click(screen.getByRole('checkbox', { name: /show link preview/i }));
    expect(onChange).toHaveBeenCalledWith({ buttons: [], linkPreview: false, format: 'plain' });
  });

  it('switches the format select to HTML', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTgCta();
    await user.selectOptions(screen.getByLabelText('Format'), 'html');
    expect(onChange).toHaveBeenCalledWith({ buttons: [], linkPreview: true, format: 'html' });
  });

  it('has no axe violations', async () => {
    const { container } = renderTgCta({ cta: { buttons: [{ label: 'Go', url: 'https://example.com' }], linkPreview: false, format: 'html' } });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

function renderDcEmbed(props = {}) {
  const onChange = vi.fn();
  const utils = render(
    <DiscordEmbedFields embed={{ title: '', description: '', url: '', color: '' }} onChange={onChange} {...props} />,
  );
  return { ...utils, onChange };
}

describe('DiscordEmbedFields (spec 14 authoring)', () => {
  it('renders the honest buttons-gated hint', () => {
    renderDcEmbed();
    expect(screen.getByText(/buttons need an app-owned webhook/i)).toBeInTheDocument();
  });

  it('shows the seeded values for an existing embed', () => {
    renderDcEmbed({ embed: { title: 'Launch', description: 'It shipped', url: 'https://example.com', color: '#5865F2' } });
    expect(screen.getByLabelText('Embed title')).toHaveValue('Launch');
    expect(screen.getByLabelText('Embed description')).toHaveValue('It shipped');
    expect(screen.getByLabelText('Embed URL')).toHaveValue('https://example.com');
    expect(screen.getByLabelText('Embed color')).toHaveValue('#5865F2');
  });

  it('edits the title field', async () => {
    const user = userEvent.setup();
    const { onChange } = renderDcEmbed();
    await user.type(screen.getByLabelText('Embed title'), 'X');
    expect(onChange).toHaveBeenCalledWith({ title: 'X', description: '', url: '', color: '' });
  });

  it('has no axe violations', async () => {
    const { container } = renderDcEmbed({ embed: { title: 'Launch', description: 'It shipped', url: 'https://example.com', color: '#5865F2' } });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Composer gates the sections on rel.tgCta / rel.dcEmbed', () => {
  function renderComposer(props = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="create"
              post={null}
              campaigns={[{ id: 'launch', active: true, posts: [] }]}
              onClose={vi.fn()}
              onSaved={vi.fn()}
              {...props}
            />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('shows the Telegram CTA section only when telegram is targeted', async () => {
    const user = userEvent.setup();
    renderComposer();
    expect(screen.queryByText('Telegram CTA')).not.toBeInTheDocument();
    expect(screen.queryByText('Discord embed')).not.toBeInTheDocument();
    // Default create-mode selection is Instagram only; add Telegram + Discord.
    await user.click(screen.getByRole('button', { name: /telegram/i }));
    expect(screen.getByText('Telegram CTA')).toBeInTheDocument();
    expect(screen.queryByText('Discord embed')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /discord/i }));
    expect(screen.getByText('Discord embed')).toBeInTheDocument();
  });

  // Fix #1: a persisted dcEmbed with null string members (validateFieldValues
  // accepts them; the tool prose teaches "set a field to null to remove it")
  // must NOT white-screen the editor - dcEmbedFormState coerces null -> ''
  // before the controlled inputs read them. Without the coerce, dcEmbedPayload's
  // `dcEmbed.title.trim()` threw TypeError and the post was uneditable.
  it('renders the editor without throwing for a dcEmbed with null string members', () => {
    const post = {
      campaign: 'launch',
      id: 'd1',
      rev: 'r1',
      type: 'text',
      platforms: ['discord'],
      caption: 'Hello',
      dcEmbed: { title: null, description: null, url: 'https://example.com', color: 5793266 },
    };
    renderComposer({ mode: 'edit', post });
    // The Discord embed section renders; the url that WAS set shows through, and
    // the null members resolve to empty controlled inputs (no crash).
    expect(screen.getByText('Discord embed')).toBeInTheDocument();
    expect(screen.getByLabelText('Embed URL')).toHaveValue('https://example.com');
    expect(screen.getByLabelText('Embed title')).toHaveValue('');
    expect(screen.getByLabelText('Embed description')).toHaveValue('');
    expect(screen.getByLabelText('Embed color')).toHaveValue('#5865F2');
  });
});
