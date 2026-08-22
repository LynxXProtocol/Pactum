import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { Buffer } from 'buffer';
import './index.css';

if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
}
import App from './App.tsx';
import { queryClient } from './lib/queryClient';
import { WalletProvider } from './context/WalletContext';
import { ThemeProvider } from './context/ThemeContext';

// WalletProvider and QueryClientProvider wrap the whole tree here, in the host, exactly once —
// not per-remote — since the host owns the single WalletContext and QueryClient instances that
// dashboard/wizard remotes consume over Module Federation (see vite.config.ts `exposes` and
// docs/module-federation.md). A remote wrapping itself in its own instance of either provider
// would defeat the singleton sharing this architecture depends on.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </WalletProvider>
    </QueryClientProvider>
  </StrictMode>,
);
