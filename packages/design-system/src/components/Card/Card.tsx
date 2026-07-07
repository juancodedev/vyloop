import clsx from 'clsx';
import { forwardRef, type ForwardedRef, useId } from 'react';

import styles from './Card.module.css';

export type CardVariant = 'default' | 'elevated' | 'outlined';
export type CardPadding = 'sm' | 'md' | 'lg';

export interface CardProps {
  /** Visual variant */
  variant?: CardVariant;
  /** Padding density */
  padding?: CardPadding;
  className?: string;
  children?: React.ReactNode;
}

function CardInner(
  {
    variant = 'default',
    padding = 'md',
    className,
    children,
    ...rest
  }: CardProps & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>,
  ref: ForwardedRef<HTMLDivElement>,
) {
  const paddingClass = padding === 'sm' ? styles.paddingSm : padding === 'lg' ? styles.paddingLg : null;

  return (
    <div
      ref={ref}
      className={clsx(
        styles.card,
        styles[variant],
        paddingClass,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

// ── Card.Header ──

export interface CardHeaderProps {
  title: React.ReactNode;
  /** Optional action element (button, menu, etc.) rendered on the right */
  action?: React.ReactNode;
  className?: string;
}

export function CardHeader({ title, action, className }: CardHeaderProps) {
  const headerId = useId();

  return (
    <div className={clsx(styles.header, className)}>
      <h3 id={headerId} className={styles.headerTitle}>
        {title}
      </h3>
      {action && <div className={styles.headerAction}>{action}</div>}
    </div>
  );
}

// ── Card.Body ──

export interface CardBodyProps {
  children?: React.ReactNode;
  className?: string;
}

export function CardBody({ children, className }: CardBodyProps) {
  return <div className={clsx(styles.body, className)}>{children}</div>;
}

// ── Card.Footer ──

export interface CardFooterProps {
  children?: React.ReactNode;
  className?: string;
}

export function CardFooter({ children, className }: CardFooterProps) {
  return <div className={clsx(styles.footer, className)}>{children}</div>;
}

// ── Compound component ──

const Card = Object.assign(
  forwardRef<HTMLDivElement, CardProps & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>>(CardInner),
  {
    Header: CardHeader,
    Body: CardBody,
    Footer: CardFooter,
  },
);

export { Card };
