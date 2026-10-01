-- Run once after insert_pkg_tolerance.sql on an existing database.
USE tmx_db;

ALTER TABLE parts_specifications
  ADD COLUMN tolerance_id INT NULL,
  ADD CONSTRAINT fk_parts_tolerance
    FOREIGN KEY (tolerance_id) REFERENCES package_size_tolerance(tolerance_id);

-- Existing ALPLs can be assigned automatically only when their package has
-- exactly one tolerance. Leave ambiguous ALPLs empty for explicit selection.
UPDATE parts_specifications p
LEFT JOIN part_number pn ON pn.part_number_id = p.part_number_id
JOIN (
  SELECT package_size_id, MIN(tolerance_id) AS tolerance_id
  FROM package_size_tolerance
  GROUP BY package_size_id
  HAVING COUNT(*) = 1
) t ON t.package_size_id = COALESCE(p.package_size_id, pn.package_size_id)
SET p.tolerance_id = t.tolerance_id
WHERE p.tolerance_id IS NULL;

ALTER TABLE measurements
  ADD COLUMN tolerance_id INT NULL,
  ADD CONSTRAINT fk_measurements_tolerance
    FOREIGN KEY (tolerance_id) REFERENCES package_size_tolerance(tolerance_id);

-- Preserve the best-known tolerance for existing measurements. Rows still
-- unassigned need manual review in Edit > Parts before further measurement.
UPDATE measurements m
JOIN parts_specifications p ON p.part_id = m.part_id
SET m.tolerance_id = p.tolerance_id
WHERE m.tolerance_id IS NULL AND p.tolerance_id IS NOT NULL;

SELECT m.measurement_id, m.number_alpl, m.session_id
FROM measurements m
WHERE m.tolerance_id IS NULL;

SELECT p.number_alpl, ps.package_size
FROM parts_specifications p
LEFT JOIN part_number pn ON pn.part_number_id = p.part_number_id
LEFT JOIN package_size ps ON ps.package_size_id = COALESCE(p.package_size_id, pn.package_size_id)
WHERE p.tolerance_id IS NULL;
