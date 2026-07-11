import { Navigate, useLocation } from 'react-router';

/** Redirect old /train/* URLs to /staff/trainer/* inside SystemLayout. */
export function LegacyTrainRedirect() {
  const location = useLocation();
  const suffix = location.pathname.replace(/^\/train\/?/, '');
  const target = suffix ? `/staff/trainer/${suffix}` : '/staff/trainer';
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
}
