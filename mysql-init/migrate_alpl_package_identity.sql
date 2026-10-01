-- Run once on a populated database, after insert_pkg_tolerance.sql and
-- add_part_tolerance_id.sql. Back up tmx_db and stop active sessions first.
-- Old ALPL-only measurements are attached to the unique Part that existed
-- before this migration. No historical row is matched by ALPL after it.

UPDATE parts_specifications p
LEFT JOIN part_number pn ON pn.part_number_id = p.part_number_id
SET p.package_size_id = pn.package_size_id
WHERE p.package_size_id IS NULL AND pn.package_size_id IS NOT NULL;

DELIMITER //
CREATE PROCEDURE migrate_alpl_package_identity()
BEGIN
  DECLARE old_fk VARCHAR(64);
  DECLARE old_unique VARCHAR(64);
  IF EXISTS (SELECT 1 FROM parts_specifications WHERE number_alpl IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Parts without ALPL: resolve these before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM parts_specifications WHERE package_size_id IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Parts without Package Size: resolve these before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM measurements m LEFT JOIN parts_specifications p
             ON p.number_alpl = m.number_alpl WHERE p.part_id IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Measurements without matching ALPL Part';
  END IF;
  ALTER TABLE measurements ADD COLUMN part_id INT NULL AFTER number_alpl;
  UPDATE measurements m JOIN parts_specifications p ON p.number_alpl = m.number_alpl
    SET m.part_id = p.part_id;
  ALTER TABLE measurements MODIFY part_id INT NOT NULL,
    ADD CONSTRAINT fk_measurements_part FOREIGN KEY (part_id) REFERENCES parts_specifications(part_id),
    ADD INDEX idx_meas_part_ts (part_id, timestamp, measurement_id);

  SELECT k.CONSTRAINT_NAME INTO old_fk
  FROM information_schema.KEY_COLUMN_USAGE k
  WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'measurements'
    AND k.COLUMN_NAME = 'number_alpl' AND k.REFERENCED_TABLE_NAME = 'parts_specifications'
  LIMIT 1;
  IF old_fk IS NOT NULL THEN
    SET @sql = CONCAT('ALTER TABLE measurements DROP FOREIGN KEY `', old_fk, '`');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;

  SELECT s.INDEX_NAME INTO old_unique
  FROM information_schema.STATISTICS s
  WHERE s.TABLE_SCHEMA = DATABASE() AND s.TABLE_NAME = 'parts_specifications'
    AND s.COLUMN_NAME = 'number_alpl' AND s.NON_UNIQUE = 0
    AND s.INDEX_NAME <> 'PRIMARY'
  GROUP BY s.INDEX_NAME HAVING COUNT(*) = 1 LIMIT 1;
  IF old_unique IS NOT NULL THEN
    SET @sql = CONCAT('ALTER TABLE parts_specifications DROP INDEX `', old_unique, '`');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
  ALTER TABLE parts_specifications MODIFY number_alpl INT NOT NULL,
    MODIFY package_size_id INT NOT NULL,
    ADD CONSTRAINT uq_parts_alpl_package UNIQUE (number_alpl, package_size_id);
END//
DELIMITER ;
CALL migrate_alpl_package_identity();
DROP PROCEDURE migrate_alpl_package_identity;
