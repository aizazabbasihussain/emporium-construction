import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppProviders, AppRoutes } from './App';

describe('web shell', () => {
  it('renders the app title from the shared English keys', () => {
    render(
      <AppProviders>
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>,
    );
    expect(
      screen.getByRole('heading', { name: 'Emporium Construction Operations' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Construction operations system')).toBeInTheDocument();
  });
});
