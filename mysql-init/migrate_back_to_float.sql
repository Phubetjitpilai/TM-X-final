-- Run on an already migrated database to restore the original FLOAT types.
-- Back up the database and stop active measurements before running this file.

-- Block new Start requests while checking and altering the tables.
SELECT GET_LOCK('tmx_start_session', 5) INTO @float_start_lock;

-- Stop before either ALTER if a session is running or two tolerance rows
-- would become equal as FLOAT.
CREATE TEMPORARY TABLE float_conversion_check (ok TINYINT NOT NULL, CHECK (ok = 1));
INSERT INTO float_conversion_check (ok)
SELECT @float_start_lock = 1
  AND NOT EXISTS (SELECT 1 FROM sessions WHERE state = 'running')
  AND NOT EXISTS (
  SELECT 1
  FROM package_size_tolerance
  GROUP BY package_size_id,
           CAST(nominal_x AS FLOAT),
           CAST(nominal_y AS FLOAT),
           CAST(upper_tol AS FLOAT),
           CAST(lower_tol AS FLOAT),
           CAST(offset_tol AS FLOAT)
  HAVING COUNT(*) > 1
);
DROP TEMPORARY TABLE float_conversion_check;

ALTER TABLE package_size_tolerance
  MODIFY COLUMN nominal_x FLOAT NOT NULL,
  MODIFY COLUMN nominal_y FLOAT NOT NULL,
  MODIFY COLUMN upper_tol FLOAT NOT NULL,
  MODIFY COLUMN lower_tol FLOAT NOT NULL,
  MODIFY COLUMN offset_tol FLOAT NOT NULL;

ALTER TABLE measurements
  MODIFY COLUMN value_x FLOAT NOT NULL,
  MODIFY COLUMN value_y FLOAT NOT NULL,
  MODIFY COLUMN offset_opx FLOAT NOT NULL,
  MODIFY COLUMN offset_opy FLOAT NOT NULL;

DO RELEASE_LOCK('tmx_start_session');
