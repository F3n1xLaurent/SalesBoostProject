import React from 'react';
import { useDevMode } from '../../../entities/session/model/useDevMode';

/** Stored provider errors are diagnostic text, not user-facing messages. */
export function CallError({ message, detailsOnly = false, className, style }: {
  message?: string | null;
  detailsOnly?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { devMode } = useDevMode();
  if (!message || (detailsOnly && !devMode)) return null;
  return <div className={className} style={style}>{devMode ? message : 'Ошибка'}</div>;
}
