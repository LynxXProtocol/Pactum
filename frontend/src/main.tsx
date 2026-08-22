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
import { IndexerModeProvider } from './context/IndexerModeContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <ThemeProvider>
          <IndexerModeProvider>
            <App />
          </IndexerModeProvider>
        </ThemeProvider>
      </WalletProvider>
    </QueryClientProvider>
  </StrictMode>,
);
