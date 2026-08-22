import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
// Standalone dev entry, used only when running this remote in isolation (`npm run dev` in this
// package). Requires the host dev server (port 5173) to be running too, since the providers this
// remote depends on live there. When consumed as a remote from the actual host app, this file is
// never loaded — only CreateCommitmentWizard.tsx, exposed via vite.config.ts, is.
import { WalletProvider } from 'host/WalletContext'
import { queryClient } from 'host/queryClient'
import CreateCommitmentWizard from './CreateCommitmentWizard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <CreateCommitmentWizard onSubmit={(payload) => console.log('commitment payload', payload)} />
      </WalletProvider>
    </QueryClientProvider>
  </StrictMode>,
)
