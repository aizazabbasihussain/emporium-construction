-- The admin role is described as seeing everything, but each module granted its permissions only to
-- the operational roles. Give admin every permission the other roles hold. One-time copy: a later
-- module that adds permissions must grant them to admin in its own migration.

insert into sys_role_permissions (role_code, permission_code)
select distinct 'admin', permission_code
  from sys_role_permissions
 where role_code <> 'admin'
on conflict do nothing;
