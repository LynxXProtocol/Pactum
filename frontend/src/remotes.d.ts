/// <reference types="vite/client" />

// Ambient declarations for modules resolved at runtime by Module Federation, which TypeScript
// cannot see through statically. Kept intentionally narrow (only what the host actually imports)
// rather than `declare module '*/*'`, so a typo or a real drift from a remote's exposed API
// surface still shows up as a type error here.
declare module 'dashboard/ReputationDashboard' {
  import type { ComponentType } from 'react'
  export interface ReputationDashboardProps {
    initialAddress?: string
    onNavigateAddress?: (address: string) => void
    onLaunchCreate?: () => void
  }
  const ReputationDashboard: ComponentType<ReputationDashboardProps>
  export default ReputationDashboard
}

declare module 'wizard/CreateCommitmentWizard' {
  import type { ComponentType } from 'react'
  export interface CreateCommitmentPayload {
    counterparty: string
    termsHash: string
    dueAt: number
  }
  export interface CreateCommitmentResult {
    hash: string
    commitmentId?: number | bigint
    status: 'SUCCESS'
  }
  export interface CreateCommitmentWizardProps {
    onSubmit?: (payload: CreateCommitmentPayload) => void
    onSuccess?: (result: CreateCommitmentResult) => void
  }
  const CreateCommitmentWizard: ComponentType<CreateCommitmentWizardProps>
  export default CreateCommitmentWizard
}
