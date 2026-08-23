import { useState, type FC, type ErrorInfo } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, RotateCcw, Home, ChevronDown, ChevronUp, Copy, Check } from "lucide-react"

export interface ErrorFallbackProps {
  error: Error | null
  errorInfo?: ErrorInfo | null
  resetErrorBoundary?: () => void
}

export const ErrorFallback: FC<ErrorFallbackProps> = ({
  error,
  errorInfo,
  resetErrorBoundary,
}) => {
  const { t } = useTranslation()
  const [showDetails, setShowDetails] = useState(false)
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle")

  const handleReload = () => {
    window.location.reload()
  }

  const handleGoHome = () => {
    window.location.href = "/"
  }

  const handleCopyError = async () => {
    const errorText = [
      `Error: ${error?.message || "Unknown error"}`,
      `Name: ${error?.name || "Error"}`,
      `Stack:\n${error?.stack || "No stack trace available"}`,
      errorInfo?.componentStack ? `Component Stack:\n${errorInfo.componentStack}` : "",
      `Time: ${new Date().toISOString()}`,
      `URL: ${typeof window !== "undefined" ? window.location.href : ""}`,
    ]
      .filter(Boolean)
      .join("\n\n")

    let success = false
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(errorText)
        success = true
      } catch {
        success = false
      }
    }

    // Fallback using temporary textarea if navigator.clipboard failed or is unavailable
    if (!success && typeof document !== "undefined") {
      try {
        const textArea = document.createElement("textarea")
        textArea.value = errorText
        textArea.style.position = "fixed"
        textArea.style.opacity = "0"
        textArea.style.left = "-9999px"
        document.body.appendChild(textArea)
        textArea.focus()
        textArea.select()
        success = document.execCommand("copy")
        document.body.removeChild(textArea)
      } catch {
        success = false
      }
    }

    if (success) {
      setCopyStatus("copied")
      setTimeout(() => setCopyStatus("idle"), 2000)
    } else {
      setCopyStatus("failed")
      setTimeout(() => setCopyStatus("idle"), 2000)
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 sm:p-6 bg-background text-foreground">
      <div className="max-w-lg w-full rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="flex flex-col items-center text-center space-y-3">
          <div className="p-3 rounded-full bg-destructive/10 text-destructive border border-destructive/20">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t('error.title')}
          </h1>
          <p className="text-sm text-muted-foreground max-w-sm">
            {t('error.description')}
          </p>
        </div>

        {error && (
          <div className="p-3.5 rounded-lg bg-muted/60 border border-border/60 text-xs font-mono text-muted-foreground break-words">
            <span className="font-semibold text-destructive">{error.name || t('error.title')}: </span>
            {error.message || t('error.description')}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <button
            type="button"
            onClick={handleReload}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <RotateCcw className="w-4 h-4" />
            {t('common.reload')}
          </button>

          {resetErrorBoundary && (
            <button
              type="button"
              onClick={resetErrorBoundary}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-secondary text-secondary-foreground font-medium text-sm hover:bg-secondary/80 border border-border transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {t('error.retry')}
            </button>
          )}

          <button
            type="button"
            onClick={handleGoHome}
            className="inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-muted text-muted-foreground font-medium text-sm hover:bg-muted/80 border border-border transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
            title={t('error.goHome')}
          >
            <Home className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setShowDetails(!showDetails)}
              className="w-full flex items-center justify-between text-xs text-muted-foreground hover:text-foreground font-medium transition-colors"
            >
              <span>{showDetails ? t('error.hideDetails') : t('error.showDetails')}</span>
              {showDetails ? (
                <ChevronUp className="w-4 h-4 ml-1" />
              ) : (
                <ChevronDown className="w-4 h-4 ml-1" />
              )}
            </button>

            {showDetails && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">{t('error.stackTrace')}</span>
                  <button
                    type="button"
                    onClick={handleCopyError}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {copyStatus === "copied" ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-emerald-500">{t('error.copied')}</span>
                      </>
                    ) : copyStatus === "failed" ? (
                      <>
                        <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                        <span className="text-destructive">{t('error.copyFailed')}</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>{t('error.copyTrace')}</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="max-h-48 overflow-auto p-3 rounded-lg bg-black/80 text-emerald-400 text-xs font-mono whitespace-pre-wrap select-all">
                  {error.stack || error.message}
                  {errorInfo?.componentStack ? `\n\nComponent Stack:${errorInfo.componentStack}` : ""}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
