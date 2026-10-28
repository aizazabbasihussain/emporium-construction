-- P1-12 (CHANGES 2026-10-27, option 2): the cost code an inventory issue of this item is charged to
-- unless the issue names another. Nullable; the item service checks it is a live cost code.
alter table mst_items add column default_cost_code_id uuid references mst_cost_codes (id);
