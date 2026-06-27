import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { DateTimePicker } from '../ui/DateTimePicker.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-I18N-01 / US-DS-01: the date popover weekday headers must come from the SAME
// planner.weekday.* locale keys the Planner uses, so de-CH never shows English
// Tu/We/Th while the planner above shows Di/Mi/Do. These tests open the popover
// and assert the header row is localized (no hardcoded English leak).
function renderPicker(locale) {
  return render(
    <I18nProvider locale={locale}>
      <DateTimePicker value={null} onChange={() => {}} />
    </I18nProvider>,
  );
}

describe('DateTimePicker weekday headers', () => {
  it('renders German weekday headers under de-CH (planner.weekday.* keys)', async () => {
    renderPicker('de-CH');
    await userEvent.click(screen.getByRole('button'));
    for (const day of ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']) {
      expect(screen.getByText(day)).toBeInTheDocument();
    }
    // The retired hardcoded English tokens must not leak through under de-CH.
    expect(screen.queryByText('Tu')).not.toBeInTheDocument();
    expect(screen.queryByText('We')).not.toBeInTheDocument();
    expect(screen.queryByText('Th')).not.toBeInTheDocument();
  });

  it('renders English weekday headers under en', async () => {
    renderPicker('en');
    await userEvent.click(screen.getByRole('button'));
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(screen.getByText(day)).toBeInTheDocument();
    }
  });
});
