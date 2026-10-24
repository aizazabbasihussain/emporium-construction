import { request } from '../admin/api';

export interface ScopeGrant {
  type: 'project' | 'team';
  id: string;
}

export interface Profile {
  id: string;
  email: string;
  fullName: string;
  locale: string;
  version: number;
  roles: string[];
  permissions: string[];
  scopes: ScopeGrant[];
}

export interface UserItem {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: 'active' | 'disabled';
  locale: string;
  lastLoginAt: string | null;
  version: number;
  roles: string[];
  scopes: ScopeGrant[];
}

export interface RoleItem {
  code: string;
  name: string;
  description: string;
  system: boolean;
  permissions: string[];
}

export const identityApi = {
  me: () => request<Profile>('GET', '/me'),
  setLocale: (locale: string, version: number) =>
    request<Profile>('PATCH', '/me', { locale, version }),
  users: () => request<{ items: UserItem[] }>('GET', '/admin/users'),
  createUser: (user: { email: string; fullName: string; phone?: string; roles: string[] }) =>
    request<UserItem>('POST', '/admin/users', user),
  setStatus: (id: string, status: 'active' | 'disabled', version: number) =>
    request<UserItem>('PATCH', `/admin/users/${id}`, { status, version }),
  setRoles: (id: string, roles: string[], version: number) =>
    request<UserItem>('PUT', `/admin/users/${id}/roles`, { roles, version }),
  setScopes: (id: string, scopes: ScopeGrant[], version: number) =>
    request<UserItem>('PUT', `/admin/users/${id}/scopes`, { scopes, version }),
  roles: () => request<{ items: RoleItem[]; permissions: string[] }>('GET', '/admin/roles'),
  setRolePermissions: (code: string, permissions: string[]) =>
    request<RoleItem>('PUT', `/admin/roles/${code}/permissions`, { permissions }),
};
