'use client';

import * as Dialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { forwardRef, type ForwardedRef } from 'react';

import styles from './Modal.module.css';

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  /** Controls visibility */
  open: boolean;
  /** Called when the modal should close */
  onClose: () => void;
  /** Modal title (rendered in header) */
  title: string;
  /** Optional description rendered below the title */
  description?: string;
  /** Width preset */
  size?: ModalSize;
  /** Modal body content */
  children?: React.ReactNode;
  /** Custom footer actions (default: none) */
  footer?: React.ReactNode;
}

const sizeClasses: Record<ModalSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

function ModalInner(
  {
    open,
    onClose,
    title,
    description,
    size = 'md',
    children,
    footer,
  }: ModalProps,
  _ref: ForwardedRef<HTMLDivElement>,
) {
  return (
    <Dialog.Root open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={clsx(styles.content, sizeClasses[size])}
        >
          {/* Header */}
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            {description && (
              <Dialog.Description className={styles.description}>
                {description}
              </Dialog.Description>
            )}
          </div>

          {/* Close button */}
          <Dialog.Close asChild>
            <button className={styles.closeButton} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </Dialog.Close>

          {/* Body */}
          {children && <div className={styles.body}>{children}</div>}

          {/* Footer */}
          {footer && <div className={styles.footer}>{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const Modal = forwardRef<HTMLDivElement, ModalProps>(ModalInner);
