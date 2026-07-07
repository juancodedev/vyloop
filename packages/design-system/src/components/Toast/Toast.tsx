import clsx from 'clsx';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import styles from './Toast.module.css';

// ── Types ──

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number; // ms, 0 = no auto-dismiss
}

export interface ToastOptions {
  /** Duration in ms (default: 4000, 0 = no auto-dismiss) */
  duration?: number;
}

interface ToastContextValue {
  addToast: (toast: ToastItem) => void;
  removeToast: (id: string) => void;
}

// ── Icons ──

const TOAST_ICONS: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 size={20} aria-hidden="true" />,
  error: <XCircle size={20} aria-hidden="true" />,
  warning: <AlertTriangle size={20} aria-hidden="true" />,
  info: <Info size={20} aria-hidden="true" />,
};

// ── Context ──

const MAX_VISIBLE = 5;

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

// ── Provider ──

export interface ToastProviderProps {
  children: ReactNode;
}

let toastCount = 0;

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [paused, setPaused] = useState(false);

  const addToast = useCallback((toast: ToastItem) => {
    setToasts((prev) => {
      const next = [...prev, toast];
      if (next.length > MAX_VISIBLE) {
        return next.slice(next.length - MAX_VISIBLE);
      }
      return next;
    });
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Register the global handler so imperative toast.success() works
  useEffect(() => {
    registerToastHandler((toast) => {
      addToast(toast);
    });
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <div
        className={styles.container}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        role="log"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <ToastItemComponent
            key={t.id}
            toast={t}
            onDismiss={() => removeToast(t.id)}
            paused={paused}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Individual Toast ──

interface ToastItemComponentProps {
  toast: ToastItem;
  onDismiss: () => void;
  paused: boolean;
}

function ToastItemComponent({ toast, onDismiss, paused }: ToastItemComponentProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exiting, setExiting] = useState(false);

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(onDismiss, 150);
  }, [onDismiss]);

  // Auto-dismiss timer
  useEffect(() => {
    if (toast.duration <= 0) return;

    if (!paused) {
      timerRef.current = setTimeout(dismiss, toast.duration);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [toast.duration, paused, dismiss]);

  return (
    <div
      className={clsx(styles.toast, styles[toast.type], exiting && styles.exiting)}
      role="alert"
    >
      {/* Icon */}
      <span className={styles.icon}>
        {TOAST_ICONS[toast.type]}
      </span>

      {/* Content */}
      <div className={styles.content}>
        <p className={styles.title}>{toast.title}</p>
        {toast.message && <p className={styles.message}>{toast.message}</p>}
      </div>

      {/* Close button */}
      <button
        className={styles.closeButton}
        onClick={dismiss}
        aria-label="Dismiss notification"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// ── Imperative API ──

let globalToastHandler: ((toast: ToastItem) => void) | null = null;

function registerToastHandler(handler: (toast: ToastItem) => void) {
  globalToastHandler = handler;
}

function emit(type: ToastType, title: string, message?: string, options?: ToastOptions) {
  const item: ToastItem = {
    id: `toast-${++toastCount}-${Date.now()}`,
    type,
    title,
    duration: options?.duration ?? 4000,
  };
  if (message) item.message = message;
  globalToastHandler?.(item);
}

export const toast = {
  success: (title: string, message?: string, options?: ToastOptions) => emit('success', title, message, options),
  error: (title: string, message?: string, options?: ToastOptions) => emit('error', title, message, options),
  warning: (title: string, message?: string, options?: ToastOptions) => emit('warning', title, message, options),
  info: (title: string, message?: string, options?: ToastOptions) => emit('info', title, message, options),
};
