
CREATE TABLE package_size_tolerance (
  tolerance_id    INT AUTO_INCREMENT PRIMARY KEY,
  package_size_id INT NOT NULL,
  nominal_x       FLOAT NOT NULL,
  nominal_y       FLOAT NOT NULL,
  upper_tol       FLOAT NOT NULL,
  lower_tol       FLOAT NOT NULL,
  offset_tol      FLOAT NOT NULL,
  UNIQUE KEY uq_pkg_tolerance_spec
    (package_size_id, nominal_x, nominal_y, upper_tol, lower_tol, offset_tol),
  FOREIGN KEY (package_size_id) REFERENCES package_size(package_size_id)
);

INSERT INTO package_size_tolerance (
    package_size_id,
    nominal_x, nominal_y,
    upper_tol, lower_tol, offset_tol
)
SELECT
    package_size_id,
    nominal_x, nominal_y,
    upper_tol, lower_tol, offset_tol
FROM package_size;

ALTER TABLE package_size
    DROP COLUMN nominal_x,
    DROP COLUMN nominal_y,
    DROP COLUMN upper_tol,
    DROP COLUMN lower_tol,
    DROP COLUMN offset_tol;
-- One-time migration for an OLD database that still stores nominal/tolerance
-- and template_id in package_size. Do not rerun on an already migrated database.
-- For a fresh empty database use init.sql then insert.sql.

-- Migrate the old Package Size -> Handler relation and its Template.
-- This file converts an OLD database once; fresh installs use init.sql + insert.sql.
CREATE TABLE package_size_handler_template (
  package_size_id INT NOT NULL,
  handler_id      INT NOT NULL,
  template_id     INT NOT NULL,
  PRIMARY KEY (package_size_id, handler_id),
  FOREIGN KEY (package_size_id) REFERENCES package_size(package_size_id),
  FOREIGN KEY (handler_id) REFERENCES handler(handler_id),
  FOREIGN KEY (template_id) REFERENCES template(template_id)
);

INSERT INTO package_size_handler_template (package_size_id, handler_id, template_id)
SELECT psh.package_size_id, psh.handler_id, ps.template_id
FROM package_size_handler psh
JOIN package_size ps ON ps.package_size_id = psh.package_size_id;

SELECT (SELECT COUNT(*) FROM package_size_handler) AS old_pairs,
       (SELECT COUNT(*) FROM package_size_handler_template) AS new_pairs;

CREATE TEMPORARY TABLE mapping_copy_check (ok TINYINT NOT NULL, CHECK (ok = 1));
INSERT INTO mapping_copy_check (ok)
SELECT (SELECT COUNT(*) FROM package_size_handler) =
       (SELECT COUNT(*) FROM package_size_handler_template);
DROP TEMPORARY TABLE mapping_copy_check;

DROP TABLE package_size_handler;
SET @old_template_fk = (
  SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'package_size'
    AND COLUMN_NAME = 'template_id' AND REFERENCED_TABLE_NAME = 'template'
  LIMIT 1
);
SET @drop_template_fk = IF(@old_template_fk IS NULL, 'SELECT 1',
  CONCAT('ALTER TABLE package_size DROP FOREIGN KEY `', REPLACE(@old_template_fk, '`', '``'), '`'));
PREPARE drop_fk_stmt FROM @drop_template_fk;
EXECUTE drop_fk_stmt;
DEALLOCATE PREPARE drop_fk_stmt;
ALTER TABLE package_size DROP COLUMN template_id;


-- ALPL + Package Size migration for this populated database.
-- Back up tmx_db and stop active sessions first.
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
