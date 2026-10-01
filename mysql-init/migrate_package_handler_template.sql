-- Run once on an existing tmx_db after taking a backup.
-- Every existing Package Size / Handler pair inherits its current Template.
USE tmx_db;

CREATE TABLE package_size_handler_template (
  package_size_id INT NOT NULL,
  handler_id      INT NOT NULL,
  template_id     INT NOT NULL,
  PRIMARY KEY (package_size_id, handler_id),
  FOREIGN KEY (package_size_id) REFERENCES package_size(package_size_id),
  FOREIGN KEY (handler_id) REFERENCES handler(handler_id),
  FOREIGN KEY (template_id) REFERENCES template(template_id)
);

-- The INSERT must fail if a mapped Package Size has no Template; do not discard
-- such mappings silently. Fix package_size.template_id, then rerun this script
-- from the INSERT statement (the CREATE TABLE has already succeeded).
INSERT INTO package_size_handler_template (package_size_id, handler_id, template_id)
SELECT psh.package_size_id, psh.handler_id, ps.template_id
FROM package_size_handler psh
JOIN package_size ps ON ps.package_size_id = psh.package_size_id;

-- Verify the copy before dropping the old relation.
SELECT (SELECT COUNT(*) FROM package_size_handler) AS old_pairs,
       (SELECT COUNT(*) FROM package_size_handler_template) AS new_pairs;

-- Stop before dropping the old table if any pair failed to copy.
CREATE TEMPORARY TABLE mapping_copy_check (ok TINYINT NOT NULL, CHECK (ok = 1));
INSERT INTO mapping_copy_check (ok)
SELECT (SELECT COUNT(*) FROM package_size_handler) =
       (SELECT COUNT(*) FROM package_size_handler_template);
DROP TEMPORARY TABLE mapping_copy_check;

DROP TABLE package_size_handler;

-- The old FK name depends on how MySQL created the original table.
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
