-- Pilot data fix: the Phase 1 pilot project PRJ-0007 was created before the tax
-- engine (P2-01) existed, so it has no location and its invoices cannot resolve a
-- tax authority. Add the Rawalpindi (Punjab) location and link it to that project.
-- Idempotent, and a no-op on a database that has no PRJ-0007.

insert into mst_locations (id, name, region, city)
select gen_random_uuid(), 'Rawalpindi', 'punjab', 'Rawalpindi'
where exists (select 1 from prj_projects where code = 'PRJ-0007')
  and not exists (
    select 1 from mst_locations
    where name = 'Rawalpindi' and region = 'punjab' and deleted_at is null
  );

update prj_projects
set location_id = (
      select id from mst_locations
      where name = 'Rawalpindi' and region = 'punjab' and deleted_at is null
      order by created_at
      limit 1
    ),
    updated_at = now(),
    version = version + 1
where code = 'PRJ-0007'
  and location_id is null;
