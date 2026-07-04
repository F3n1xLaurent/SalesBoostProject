import React from 'react';

type Props = {
  title: string;
  className?: string;
  children: React.ReactNode;
};

/** Card with unified white surface — dashboard brutal theme */
export function BrutalCard({ title, className = '', children }: Props) {
  return (
    <div className={`sa-card sa-brutal-card ${className}`.trim()}>
      <div className="sa-brutal-card-header">
        <span className="sa-brutal-card-title">{title}</span>
      </div>
      <div className="sa-brutal-card-body">{children}</div>
    </div>
  );
}
