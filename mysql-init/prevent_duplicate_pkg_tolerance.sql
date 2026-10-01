-- Run once on an existing database after checking the duplicate list below.
USE tmx_db;

SELECT package_size_id, nominal_x, nominal_y, upper_tol, lower_tol, offset_tol,
       COUNT(*) AS duplicate_count,
       GROUP_CONCAT(tolerance_id ORDER BY tolerance_id) AS tolerance_ids
FROM package_size_tolerance
GROUP BY package_size_id, nominal_x, nominal_y, upper_tol, lower_tol, offset_tol
HAVING COUNT(*) > 1;

-- This fails with duplicate-key error if the SELECT above finds any rows.
-- Resolve references in parts_specifications and measurements before removing
-- a duplicate; do not delete a tolerance_id that is already in use.
ALTER TABLE package_size_tolerance
  ADD UNIQUE KEY uq_pkg_tolerance_spec
    (package_size_id, nominal_x, nominal_y, upper_tol, lower_tol, offset_tol);
