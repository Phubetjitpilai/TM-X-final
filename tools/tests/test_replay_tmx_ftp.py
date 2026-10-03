"""Offline checks for the TM-X FTP replay; no FTP server or DB required."""

import ast
import importlib.util
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "replay_tmx_ftp.py"
spec = importlib.util.spec_from_file_location("replay_tmx_ftp", SCRIPT)
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


class FTPReplayTests(unittest.TestCase):
    def test_receiver_rejects_txt_at_ftp_start_without_running_session(self):
        receiver_path = SCRIPT.parents[1] / "Backend-server" / "Data-receiver.py"
        module = ast.parse(receiver_path.read_text(encoding="utf-8-sig"))
        handler = next(node for node in module.body if isinstance(node, ast.ClassDef)
                       and node.name == "ReceiverFTPHandler")

        class FakeFTPHandler:
            def ftp_STOR(self, file, mode="w"):
                self.accepted = file

            def respond(self, response):
                self.response = response

        namespace = {"FTPHandler": FakeFTPHandler, "FORWARD_TO_BACKEND": True,
                     "_IMAGE_EXTS": {".bmp"}, "_IMAGE_DIR_NAME": "head-a",
                     "get_current_session": lambda: None, "os": os,
                     "log": SimpleNamespace(warning=lambda *_: None)}
        exec(compile(ast.Module(body=[handler], type_ignores=[]), str(receiver_path), "exec"),
             namespace)
        instance = namespace["ReceiverFTPHandler"]()
        instance.ftp_STOR("tm-x/result/SD1_023/261002_120000.txt")
        self.assertTrue(instance.response.startswith("451"))
        self.assertFalse(hasattr(instance, "accepted"))

    def test_line_has_same_24_column_shape_as_tmx_sample(self):
        fields = replay.measurement_line(5.011, 5.012).strip().split(",")
        self.assertEqual(len(fields), 24)
        self.assertEqual(fields[:8], ["-9999.999"] * 6 + ["-999999.999"] * 2)
        self.assertEqual(fields[8:16], fields[:8])
        self.assertEqual([float(value) for value in fields[16:18]], [5.011, 5.012])

    def test_receiver_can_consume_old_txt_before_new_txt_arrives(self):
        # Execute the actual parser/cursor functions without importing the
        # Receiver's FTP/OpenCV dependencies or contacting a live service.
        receiver_path = SCRIPT.parents[1] / "Backend-server" / "Data-receiver.py"
        module = ast.parse(receiver_path.read_text(encoding="utf-8-sig"))
        names = {"_parse_measurement_line", "_read_lines", "_find_measurement_for_image"}
        functions = [node for node in module.body
                     if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual({node.name for node in functions}, names)
        for function in functions:
            function.args.defaults = []  # Supply timeout explicitly.
        namespace = {
            "IDX_X": 0, "IDX_Y": 1, "IDX_HORIZON_LEFT": 2,
            "IDX_HORIZON_RIGHT": 3, "IDX_VERTICAL_TOP": 4,
            "IDX_VERTICAL_BOTTOM": 5, "IDX_OFFSET_X": 6,
            "IDX_OFFSET_Y": 7, "_MIN_FIELDS": 8,
            "_txt_lock": threading.Lock(), "count_lock": threading.Lock(),
            "_txt_paths": [], "_txt_cursor_path": None, "_txt_cursor_rows": 0,
            "time": time,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(receiver_path), "exec"),
             namespace)
        with tempfile.TemporaryDirectory() as tmp:
            txt = Path(tmp) / "result.txt"
            txt.write_text(replay.measurement_line(5.011, 5.012), encoding="ascii")
            namespace["_txt_paths"].append(str(txt))
            pair = namespace["_find_measurement_for_image"](timeout=0)
            self.assertEqual(pair[:2], (5.011, 5.012))
            txt.write_text(replay.measurement_line(5.011, 5.012) +
                           replay.measurement_line(5.031, 5.032), encoding="ascii")
            self.assertEqual(namespace["_txt_cursor_rows"], 1)

    def test_image_first_phase_uploads_image_before_new_txt(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            manifest = {
                "text_rel": "tm-x/result/SD1_023/261002_120000.txt",
                "new_image_rel": "261002/HEAD-A/new.bmp",
                "other_image_rel": "261002/other.bmp",
                "old_x": 5.011, "old_y": 5.012,
                "new_x": 5.031, "new_y": 5.032,
            }
            for key in ("text_rel", "new_image_rel", "other_image_rel"):
                path = directory / manifest[key]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"bmp" if key != "text_rel" else
                                 replay.measurement_line(5.011, 5.012).encode("ascii"))
            sent = []

            class FakeFTP:
                def __enter__(self):
                    return self

                def __exit__(self, *_):
                    return False

            def fake_api(_base, path, params=None):
                if path == "/api/session/state":
                    return {"state": "running", "session_id": 42}
                if path == "/api/review/capture":
                    return {"capture_id": "test-capture"}
                if path == "/api/review/capture/test-capture":
                    return {"saved": False}
                raise AssertionError(path)

            args = SimpleNamespace(write_live_db=True, backend="http://unused",
                                   order="image-first", txt_delay=1, host="unused",
                                   port=21, user="user", password="pass")
            with patch.object(replay, "api_get", side_effect=fake_api), \
                 patch.object(replay, "connect_ftp", return_value=FakeFTP()), \
                 patch.object(replay, "upload", side_effect=lambda _ftp, rel, _path: sent.append(rel)), \
                 patch.object(replay.time, "sleep"), patch("builtins.print"):
                replay.phase_inside(args, directory, manifest, {})
            self.assertEqual(sent, [manifest["new_image_rel"], manifest["text_rel"],
                                    manifest["other_image_rel"]])
            lines = (directory / manifest["text_rel"]).read_text().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(float(lines[0].split(",")[16]), 5.011)
            self.assertEqual(float(lines[1].split(",")[16]), 5.031)


if __name__ == "__main__":
    unittest.main()
