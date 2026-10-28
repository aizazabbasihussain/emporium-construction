import { Spin } from 'antd';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ForbiddenPage } from './ErrorPages';

/** Sends signed-out visitors to the login page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <Spin fullscreen />;
  if (status === 'signedOut') return <Navigate to="/login" replace />;
  return children;
}

/** Like `RequirePermission`, for a page that any one of several permissions opens. */
export function RequireAnyPermission({
  permissions,
  children,
}: {
  permissions: readonly string[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!permissions.some((permission) => can(permission))) return <ForbiddenPage />;
  return children;
}

/** Shows the 403 page when the user lacks the permission, even on a direct URL (BR-10). */
export function RequirePermission({
  permission,
  children,
}: {
  permission?: string | undefined;
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (permission !== undefined && !can(permission)) return <ForbiddenPage />;
  return children;
}
