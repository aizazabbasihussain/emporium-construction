import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from './App';
import { createSupabaseAuthClient } from './auth/client';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

const auth = createSupabaseAuthClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
);

createRoot(container).render(
  <StrictMode>
    <AppProviders auth={auth}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  </StrictMode>,
);
