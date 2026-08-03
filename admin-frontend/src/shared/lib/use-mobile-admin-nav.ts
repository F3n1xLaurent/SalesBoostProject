import { useEffect, useState } from 'react';
import { ADMIN_MOBILE_NAV_MEDIA_QUERY } from './admin-layout-breakpoints';

export function useMobileAdminNav(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(ADMIN_MOBILE_NAV_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia(ADMIN_MOBILE_NAV_MEDIA_QUERY);
    const onChange = () => setIsMobile(mediaQuery.matches);
    onChange();
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
