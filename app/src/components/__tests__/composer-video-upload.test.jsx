// US-MEDIA-UP: the Composer VideoPicker uploads a fresh file in place (drag-drop or
// the popover's Upload control) instead of only selecting an already-uploaded one.
// A successful upload sets the field to the new asset's `${dir}/${file}` ref - the
// same shape a library pick emits - so the rest of the composer is unchanged.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

vi.mock('../../lib/api.js', async (orig) => {
  const actual = await orig();
  return { ...actual, uploadAssetFile: vi.fn(() => Promise.resolve({ ok: true, file: 'clip.mp4' })) };
});

import { VideoPicker } from '../Composer.jsx';
import { uploadAssetFile } from '../../lib/api.js';

const renderPicker = (onChange) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <VideoPicker assets={[]} assetsDir="data/media" value="" onChange={onChange} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
};

describe('Composer VideoPicker in-place upload', () => {
  it('offers an Upload control inside the picker popover', async () => {
    const user = userEvent.setup();
    renderPicker(() => {});
    await user.click(screen.getByRole('button', { name: /choose video/i }));
    expect(screen.getByRole('button', { name: /upload a file/i })).toBeInTheDocument();
  });

  it('uploads a chosen file and selects it as the media value', async () => {
    const onChange = vi.fn();
    renderPicker(onChange);
    const input = screen.getByLabelText('Upload a file');
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(uploadAssetFile).toHaveBeenCalledWith(file));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('data/media/clip.mp4'));
  });
});
