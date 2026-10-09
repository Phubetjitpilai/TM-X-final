# Import the Power BI workbook into an empty MySQL database

Copy `import_powerbi_excel.py` to the destination project's `Backend-server` folder.
The destination must already have the same table definitions and migrations.
Stop the destination Backend/Mock/Pi while importing so nothing writes concurrently.

## Install

```cmd
python -m pip install pymysql openpyxl python-dotenv
```

## Destination connection

The script uses the destination project root `.env`: `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD`. Existing environment variables take precedence.
Review the destination printed by the script. To override connection settings:

```cmd
python Backend-server\import_powerbi_excel.py "C:\Data\tmx_export.xlsx" --host 127.0.0.1 --port 3306 --database tmx_db --user pc_user
```

Use `--env-file "C:\Data\destination.env"` to choose another configuration file.
If `DB_PASSWORD` is not set, the script prompts without displaying the password.
Passwords are never supplied on the command line or printed.

## Validate first (no INSERT)

```cmd
python Backend-server\import_powerbi_excel.py "C:\Data\tmx_export.xlsx" --dry-run
```

This checks matching schema/columns, empty target tables, conversion of all cell
values, and the FK insertion order. FK values and uniqueness are checked by MySQL
during the actual import, not by the dry run.

## Import

```cmd
python Backend-server\import_powerbi_excel.py "C:\Data\tmx_export.xlsx"
```

Without a path argument, the script asks for the Excel path.
Success prints `COMMITTED` with table/row counts. All tables are inserted in one
transaction. A failure rolls back the entire import. The script never drops,
creates, deletes, upserts, or renumbers records, and never disables FK checks.
Only InnoDB tables are accepted. Keep the destination offline until completion.

## How workbook sheets are used

- Each sheet maps to its same-named table; `parts` maps to `parts_specifications`.
- Table names are truncated to 31 characters as in `power_bi_gateway.py`.
  Name collisions/unknown sheets fail rather than silently skipping data.
- `_meta` is export metadata and is not inserted into any database table.
- Source primary/foreign key IDs are preserved. Parent tables are inserted first.
- Blank cells become SQL NULL; literal strings such as `NA` remain strings.
- Valid JSON strings are kept as JSON. Python dict/list strings created by older
  exporter versions are safely converted with `ast.literal_eval`, never `eval`.
- Formula/error cells, truncated cells, schema mismatches, and numeric integer
  cells of 16+ digits are rejected rather than silently changing data.

## Limits of this export

This imports all rows in the FILE, not all historical source DB rows. The exporter
may filter sessions/measurements/edit history by `POWERBI_EXPORT_DAYS` (default
180), and may omit tables through `POWERBI_SKIP`. If an exported child refers to a
parent excluded by that filter, MySQL rejects it and the import rolls back. Export
a sufficiently complete set of records or use a MySQL dump for a full restore.

Images are not inside this workbook. `image_path` is restored, but copy the original
image folders separately to the destination server. Excel is not a lossless database
backup: empty strings vs NULL, already-rounded numeric values, stripped control
characters, and bytes decoded by the exporter cannot always be recovered. Invalid
JSON from truncated cells and binary columns are rejected. For an exact full
database backup use a MySQL dump instead of the Power BI workbook.
