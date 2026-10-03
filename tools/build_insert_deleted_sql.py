"""Build sql-tools/Insert_deleted.sql from the current Deleted/*.json snapshot.

This only writes an SQL file. It never connects to MySQL or changes Deleted/.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DELETED = ROOT / "Deleted"
OUTPUT = ROOT / "sql-tools" / "Insert_deleted.sql"


def sql_string(value: str) -> str:
    if "\\" in value or "\x00" in value:
        raise ValueError(f"Unexpected character in SQL metadata: {value!r}")
    return "'" + value.replace("'", "''") + "'"


def main() -> None:
    files = sorted(DELETED.glob("*/*.json"), key=lambda p: p.relative_to(DELETED).as_posix())
    if not files:
        raise SystemExit("No Deleted/*.json files found; refusing to generate an empty import")

    inserts: list[str] = []
    ids: list[str] = []
    images = 0
    for path in files:
        raw = path.read_text(encoding="utf-8-sig")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError(f"Expected JSON object: {path}")

        trash_id = path.relative_to(DELETED).as_posix()
        kind = payload["kind"]
        source_table = payload["table"]
        deleted_at = datetime.fromisoformat(payload["deleted_at"]).strftime("%Y-%m-%d %H:%M:%S")
        image_file = payload.get("image_file")
        if not all(isinstance(v, str) and v for v in (kind, source_table)):
            raise ValueError(f"Invalid kind/table: {path}")
        if image_file is not None:
            if not isinstance(image_file, str) or Path(image_file).name != image_file or "/" in image_file or "\\" in image_file:
                raise ValueError(f"Invalid image filename: {path}")
            if not (path.parent / image_file).is_file():
                raise ValueError(f"Missing associated image: {path.parent / image_file}")
            images += 1

        # A hex literal preserves quotes, backslashes, Thai text and JSON exactly,
        # regardless of the MySQL client's SQL escaping mode or console encoding.
        payload_hex = raw.encode("utf-8").hex()
        id_sql = sql_string(trash_id)
        ids.append(id_sql)
        inserts.append(
            f"-- Deleted/{trash_id}\n"
            "INSERT INTO trash (trash_id, deleted_at, kind, source_table, payload, image_file)\n"
            f"SELECT {id_sql}, {sql_string(deleted_at)}, {sql_string(kind)}, "
            f"{sql_string(source_table)}, CONVERT(0x{payload_hex} USING utf8mb4), "
            f"{sql_string(image_file) if image_file else 'NULL'}\n"
            f"WHERE NOT EXISTS (SELECT 1 FROM trash WHERE trash_id = {id_sql});"
        )

    header = f"""-- Snapshot of Deleted/ at generation time: {len(files)} JSON files, {images} associated images.
-- Run manually against tmx_db. This does not delete or move the source files.
-- Example (cmd.exe): mysql --default-character-set=utf8mb4 -u root -p tmx_db < sql-tools\\Insert_deleted.sql
-- If Deleted/ changes before import, regenerate with: python tools/build_insert_deleted_sql.py
-- Existing trash_id values are preserved; rerunning skips records already imported.
-- This file only creates/imports trash data. The backend still reads Deleted/ until its endpoints are migrated.

USE tmx_db;

CREATE TABLE IF NOT EXISTS trash (
  trash_id      VARCHAR(255) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  deleted_at    DATETIME NOT NULL,
  kind          VARCHAR(48) NOT NULL,
  source_table  VARCHAR(64) NOT NULL,
  payload       JSON NOT NULL,
  image_file    VARCHAR(255) NULL,
  INDEX idx_trash_deleted_at (deleted_at),
  INDEX idx_trash_kind_deleted_at (kind, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

START TRANSACTION;
"""
    footer = (
        "\nCOMMIT;\n\n"
        "-- Expect this count to equal the snapshot count above.\n"
        "SELECT COUNT(*) AS imported_snapshot_rows FROM trash WHERE trash_id IN (\n  "
        + ",\n  ".join(ids)
        + "\n);\n"
    )
    OUTPUT.write_text(header + "\n\n".join(inserts) + footer, encoding="utf-8", newline="\n")
    print(f"Wrote {OUTPUT}: {len(files)} JSON records, {images} associated images")


if __name__ == "__main__":
    main()
