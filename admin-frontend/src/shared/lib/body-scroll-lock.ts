let lockCount = 0;
let previousOverflow = '';

export function lockBodyScroll() {
  if (typeof document === 'undefined') return;
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

export function unlockBodyScroll() {
  if (typeof document === 'undefined') return;
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = previousOverflow;
    previousOverflow = '';
  }
}

/** Recover from a stuck lock after nested modals / HMR */
export function resetBodyScrollLock() {
  if (typeof document === 'undefined') return;
  lockCount = 0;
  previousOverflow = '';
  document.body.style.overflow = '';
}
