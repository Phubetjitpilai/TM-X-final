"""Check that Excel exports keep editable cell types without changing report previews."""
from contextlib import nullcontext
from datetime import date, datetime, time
from io import BytesIO
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "Backend-server"))
from routers import export


class ExportCellTypesTests(unittest.IsolatedAsyncioTestCase):
    def test_offset_variants_use_each_axis_and_skip_ipm(self):
        columns = {c["key"]: c for c in export.list_export_columns("excel")}
        self.assertEqual(columns["offset_opx"]["values"], ["OK", "NG"])
        self.assertEqual(columns["offset_opy"]["values"], ["OK", "NG"])

        layout = {
            "nCols": 2, "nRows": 2, "dataRow": 1,
            "grid": [[{"v": "Offset X"}, {"v": "Offset Y"}], [
                {"f": "offset_opx", "variants": {"OK": {"bg": "green"}, "NG": {"bg": "red"}}},
                {"f": "offset_opy", "variants": {"OK": {"bg": "green"}, "NG": {"bg": "red"}}},
            ]],
        }
        row = {"measure_type": "New", "offset_opx": 0.02, "offset_opy": 0.04,
               "offset_tol": 0.03}
        data = export._render_report(layout, [row])["rows"][1]
        self.assertEqual([cell["s"]["bg"] for cell in data], ["green", "red"])

        data = export._render_report(layout, [{**row, "measure_type": "IPM"}])["rows"][1]
        self.assertEqual([cell["s"] for cell in data], [{}, {}])

    async def test_excel_numbers_and_date_formats_preserve_other_cells(self):
        fields = [
            {"f": "value_x"}, {"f": "value_y"}, {"f": "offset_opx"},
            {"f": "offset_opy"}, {"f": "offset"},
            {"f": "timestamp", "fmt": "date"},
            {"f": "timestamp", "fmt": "time"},
            {"f": "timestamp", "fmt": "datetime"},
            {"f": "recieve_date"},
            {"f": "item"},
            {"f": "result"},
        ]
        layout = {
            "nCols": len(fields), "nRows": 2, "dataRow": 1,
            "grid": [[{"v": f"Column {i}"} for i in range(len(fields))], fields],
        }
        row = {
            "value_x": 5.03775, "value_y": 5.0276,
            "offset_opx": 0.02, "offset_opy": 0.0, "offset_tol": 0.03,
            "timestamp": datetime(2026, 9, 28, 14, 23, 11),
            "recieve_date": date(2026, 9, 27), "result": "OK",
        }

        preview = export._render_report(layout, [row])
        self.assertEqual(preview["rows"][1][0]["v"], "5.038")
        self.assertNotIn("xlsx_value", preview["rows"][1][0])

        class FakeDB:
            def cursor(self):
                return nullcontext(None)

            def close(self):
                pass

        with patch.object(export, "get_db", return_value=FakeDB()), \
             patch.object(export, "_block_if_session_running"), \
             patch.object(export, "_load_report_layout", return_value={"name": "Test", "layout": layout}), \
             patch.object(export, "_export_filters", return_value=("", [])), \
             patch.object(export, "_fetch_export_raw", return_value=([row], 1)), \
             patch.object(export, "_guard_report_size"):
            response = export.export_xlsx(1, filters={})

        data = b"".join([chunk async for chunk in response.body_iterator])
        sheet = load_workbook(BytesIO(data)).active
        for cell in sheet[2][:5]:
            self.assertEqual(cell.data_type, "n")
            self.assertEqual(cell.number_format, "0.000")
        self.assertEqual(sheet["D2"].value, 0)
        self.assertIsInstance(sheet["F2"].value, (date, datetime))
        self.assertEqual(sheet["F2"]._style.numFmtId, 14)
        self.assertIsInstance(sheet["G2"].value, time)
        self.assertEqual(sheet["G2"]._style.numFmtId, 21)
        self.assertIsInstance(sheet["H2"].value, datetime)
        self.assertEqual(sheet["H2"].number_format, "dd/mm/yyyy hh:mm:ss")
        self.assertIsInstance(sheet["I2"].value, (date, datetime))
        self.assertEqual(sheet["I2"]._style.numFmtId, 14)
        self.assertEqual(sheet["J2"].value, 1)
        self.assertEqual(sheet["J2"].data_type, "n")
        self.assertEqual(sheet["J2"].number_format, "0")
        self.assertEqual(sheet["K2"].value, "OK")


if __name__ == "__main__":
    unittest.main()
