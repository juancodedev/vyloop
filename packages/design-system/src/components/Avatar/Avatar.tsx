'use client';

import clsx from 'clsx';
import { useState, useCallback, type SyntheticEvent } from 'react';

import styles from './Avatar.module.css';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  /** Image URL */
  src?: string;
  /** Alt text (required for accessibility) */
  alt: string;
  /** Size preset */
  size?: AvatarSize;
  /** Fallback initials (shown when no src or image fails) */
  fallback?: string;
  className?: string;
}

export function Avatar({
  src,
  alt,
  size = 'md',
  fallback,
  className,
}: AvatarProps) {
  const [imgError, setImgError] = useState(false);

  const handleError = useCallback((_e: SyntheticEvent<HTMLImageElement>) => {
    setImgError(true);
  }, []);

  const showImage = !!src && !imgError;

  return (
    <div
      className={clsx(styles.base, styles[size], className)}
      role="img"
      aria-label={alt}
    >
      {showImage ? (
        <img
          src={src}
          alt={alt}
          className={styles.image}
          onError={handleError}
        />
      ) : fallback ? (
        <span aria-hidden="true">{fallback}</span>
      ) : (
        <svg
          className={styles.defaultIcon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      )}
    </div>
  );
}
