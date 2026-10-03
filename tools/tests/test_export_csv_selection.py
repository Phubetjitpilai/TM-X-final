"""CSV row selection must use the same measurement exclusions for preview and download."""
from contextlib import nullcontext
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "Backend-server"))
from routers import export


class FakeCursor:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params):
        self.calls.append((sql, list(params)))

    def fetchone(self):
        return {"n": 267, "width_sample_0": "0000000002OK",
                "width_sample_1": "00000000041000"}

    def fetchall(self):
        return [
            {"measurement_id": 12, "number_alpl": 1000, "value_x": 5.024,
             "value_y": 5.028, "result": "OK", "timestamp": "2026-10-03 07:14:04",
             "operator_name": "Boss"},
        ]


class FakeDB:
    def __init__(self, cursor):
        self.fake_cursor = cursor

    def cursor(self):
        return nullcontext(self.fake_cursor)

    def close(self):
        pass


class ExportCsvSelectionTests(unittest.TestCase):
    def test_selection_list_uses_filter_and_page_offset(self):
        cur = FakeCursor()
        with patch.object(export, "get_db", return_value=FakeDB(cur)), \
             patch.object(export, "_get_template", return_value={"kind": "csv", "columns_json": ["result", "number_alpl"]}), \
             patch.object(export, "_export_filters", return_value=("WHERE m.result = %s", ["OK"])):
            result = export.export_selection_rows(export_template_id=1, filters={}, limit=20, offset=40)

        self.assertEqual(result["total"], 267)
        self.assertEqual(result["items"][0]["measurement_id"], 12)
        self.assertEqual(result["columns"], ["Result", "ALPL"])
        self.assertEqual(result["max_texts"], ["OK", "1000"])
        self.assertEqual(result["items"][0]["values"], ["OK", 1000])
        self.assertEqual(cur.calls[1][1], ["OK", 20, 40])
        self.assertIn("MAX(CONCAT(LPAD(CHAR_LENGTH", cur.calls[0][0])
        self.assertIn("ORDER BY m.timestamp DESC, m.measurement_id DESC", cur.calls[1][0])

    def test_sort_only_accepts_columns_in_selected_template(self):
        self.assertEqual(
            export._csv_order_by(["number_alpl", "result"], "number_alpl", "asc"),
            "ORDER BY m.number_alpl ASC, m.measurement_id DESC",
        )
        with self.assertRaises(export.HTTPException):
            export._csv_order_by(["result"], "number_alpl", "asc")
        with self.assertRaises(export.HTTPException):
            export._csv_order_by(["number_alpl"], "number_alpl", "sideways")

    def test_report_tolerance_parts_sort_independently(self):
        cols = ["nominal_x", "nominal_y", "upper_tol", "lower_tol"]
        self.assertEqual(export._csv_order_by(cols, "upper_tol", "desc"),
                         "ORDER BY pst.upper_tol DESC, m.measurement_id DESC")
        with self.assertRaises(export.HTTPException):
            export._csv_order_by(cols, "tolerance_spec", "asc")

    def test_date_width_sql_escapes_percent_for_database_parameters(self):
        self.assertIn("%%d/%%m/%%Y", export._csv_display_sql("timestamp"))
        self.assertIn("%%d/%%m/%%Y", export._csv_display_sql("recieve_date"))

    def test_report_selection_uses_fields_from_layout(self):
        layout = {"grid": [
            [{"hdr": "item"}, {"hdr": "tolerance_spec"}, {"hdr": "result"}],
            [{"f": "item"}, {"spec": "tolerance_spec"}, {"f": "result"}],
            [{"f": "item"}, {"f": "value_x"}, {"f": "operator"}],
        ]}
        self.assertEqual(
            export._report_selection_columns(layout),
            ["item", "nominal_x", "nominal_y", "upper_tol", "lower_tol",
             "value_x", "result", "operator"],
        )

    def test_report_preview_excludes_selected_rows_and_keeps_sort(self):
        selection = export.CsvSelection(excluded_measurement_ids=[15])
        fetched = []

        def fetch_raw(where, params, limit=None, order_by=None):
            fetched.append((where, params, limit, order_by))
            return [], 2

        with patch.object(export, "get_db", return_value=FakeDB(FakeCursor())), \
             patch.object(export, "_load_report_layout", return_value={
                 "name": "Report", "layout": {"grid": [[{"f": "result"}]]}}), \
             patch.object(export, "_export_filters", return_value=("WHERE m.result = %s", ["OK"])), \
             patch.object(export, "_fetch_export_raw", side_effect=fetch_raw), \
             patch.object(export, "_render_report", return_value={"nCols": 1, "rows": []}):
            preview = export._report_preview(1, {}, 0, selection, "result", "desc")

        self.assertEqual(preview["total"], 2)
        self.assertIn("m.measurement_id NOT IN (%s)", fetched[0][0])
        self.assertEqual(fetched[0][1], ["OK", 15])
        self.assertEqual(fetched[0][3], "ORDER BY m.result DESC, m.measurement_id DESC")

    def test_preview_and_csv_apply_identical_exclusions(self):
        selection = export.CsvSelection(excluded_measurement_ids=[15, 8, 15])
        fetched = []

        def fetch_rows(cols, where, params, limit=None, sort_by=None, sort_dir="asc"):
            fetched.append((where, params, limit, sort_by, sort_dir))
            return [[1000]], 265

        with patch.object(export, "get_db", return_value=FakeDB(FakeCursor())), \
             patch.object(export, "_get_template", return_value={"name": "Test", "columns_json": ["number_alpl"]}), \
             patch.object(export, "_export_filters", return_value=("WHERE m.result = %s", ["OK"])), \
             patch.object(export, "_fetch_export_rows", side_effect=fetch_rows), \
             patch.object(export, "_block_if_session_running"):
            preview = export._csv_preview(1, {}, 100, selection, "number_alpl", "desc")
            download = export._csv_download(1, "test", {}, selection, "number_alpl", "desc")

        self.assertEqual(preview["total"], 265)
        self.assertEqual(download.headers["content-disposition"], "attachment; filename=test.csv")
        self.assertEqual(fetched[0][:2], fetched[1][:2])
        self.assertEqual(fetched[0][1], ["OK", 8, 15])
        self.assertIn("m.measurement_id NOT IN (%s,%s)", fetched[0][0])
        self.assertEqual([call[2] for call in fetched], [100, None])
        self.assertEqual([call[3:] for call in fetched], [("number_alpl", "desc")] * 2)

    def test_included_rows_limit_preview_and_download(self):
        selection = export.CsvSelection(included_measurement_ids=[12, 8, 12])
        fetched = []

        def fetch_rows(cols, where, params, limit=None, sort_by=None, sort_dir="asc"):
            fetched.append((where, params, limit))
            return [[1000]], 2

        with patch.object(export, "get_db", return_value=FakeDB(FakeCursor())), \
             patch.object(export, "_get_template", return_value={"name": "Test", "columns_json": ["number_alpl"]}), \
             patch.object(export, "_export_filters", return_value=("WHERE m.result = %s", ["OK"])), \
             patch.object(export, "_fetch_export_rows", side_effect=fetch_rows), \
             patch.object(export, "_block_if_session_running"):
            preview = export._csv_preview(1, {}, 100, selection, None, "asc")
            export._csv_download(1, "test", {}, selection, None, "asc")

        self.assertEqual(preview["total"], 2)
        self.assertEqual(fetched[0][:2], fetched[1][:2])
        self.assertIn("m.measurement_id IN (%s,%s)", fetched[0][0])
        self.assertEqual(fetched[0][1], ["OK", 8, 12])

    def test_clear_all_excludes_every_row(self):
        where, params = export._without_excluded(
            "WHERE m.result = %s", ["OK"], export.CsvSelection(included_measurement_ids=[]))
        self.assertEqual(where, "WHERE m.result = %s AND 1 = 0")
        self.assertEqual(params, ["OK"])


if __name__ == "__main__":
    unittest.main()
