"""Regression tests; no hardware or real database connections.

Run with the project's Python dependencies: python -m unittest discover -s tools/tests -p test_queue_review.py
"""
import asyncio
import ast
import copy
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "Backend-pc_station"), str(ROOT / "Backend-server")]
from fastapi import HTTPException, Request
from pydantic import BaseModel, Field
from queue_review import QueueReview
from routers import review, measurements, session
from shared import MeasurementCreate


def until(predicate):
    deadline = time.monotonic() + 3
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("worker did not reach the expected state")
        time.sleep(0.005)


class WorkerTests(unittest.TestCase):
    def test_pause_remeasure_resume_preserves_next_piece(self):
        controller = QueueReview("http://unused")
        controller.reset(42)
        worker = controller.pieces(3, lambda: True)
        self.assertEqual(next(worker), 1)
        controller.command("pause_queue", 42)
        output = []
        thread = threading.Thread(target=lambda: output.append(next(worker)), daemon=True)
        thread.start()
        until(lambda: controller.phase == "paused")
        controller.command("remeasure", 42, {"piece": 1, "measurement_id": 101})
        thread.join(3)
        self.assertEqual(output, [1])
        with self.assertRaises(HTTPException):
            controller.command("remeasure", 42, {"piece": 1, "measurement_id": 101})
        with self.assertRaises(HTTPException):
            controller.command("resume_queue", 42)
        output.clear()
        thread = threading.Thread(target=lambda: output.append(next(worker)), daemon=True)
        thread.start()
        until(lambda: controller.phase == "paused")
        controller.command("resume_queue", 42)
        thread.join(3)
        self.assertEqual(output, [2])
        self.assertEqual(next(worker), 3)
        worker.close()

    def test_pause_during_trigger_wait_retries_same_normal_piece(self):
        c = QueueReview("http://unused")
        c.reset(42)
        worker = c.pieces(2, lambda: True)
        self.assertEqual(next(worker), 1)
        c.command("pause_queue", 42)
        self.assertTrue(c.interrupt_wait())
        c.command("resume_queue", 42)
        self.assertEqual(next(worker), 1)
        self.assertEqual(next(worker), 2)
        worker.close()

    def test_stop_while_paused_exits_without_another_measurement(self):
        c = QueueReview("http://unused")
        c.reset(42)
        running = threading.Event()
        running.set()
        worker = c.pieces(3, running.is_set)
        next(worker)
        c.command("pause_queue", 42)
        result = []
        thread = threading.Thread(target=lambda: result.append(next(worker, None)), daemon=True)
        thread.start()
        until(lambda: c.phase == "paused")
        running.clear()
        thread.join(3)
        self.assertEqual(result, [None])

    def test_stale_session_rejected(self):
        c = QueueReview("http://unused")
        c.reset(43)
        with self.assertRaises(HTTPException):
            c.command("pause_queue", 42)


class FakeDB:
    def __init__(self):
        self.statements = []
        self.session = {"state": "running", "measured_count": 2, "target_count": 5}
        self.row = {"measurement_id": 101, "session_id": 42, "number_alpl": 10,
                    "value_x": 8.03, "value_y": 8.03, "offset_opx": 0.01, "offset_opy": 0.01,
                    "offset_pos_op": "Center", "result": "OK", "measure_type": "IPM",
                    "image_path": "old.jpg"}
        self.queue = {"queue": [10, 20, 30, 40, 50], "position": 2,
                      "group_of": [0, 0, 0, 0, 0], "groups": [{"number_alpl": [10,20,30,40,50], "package_size": "8x8"}],
                      "operator": "Test", "entry_mode": "IPM", "measure_mode": "IPM", "trigger_mode": "manual"}
    def cursor(self): return self
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def close(self): pass
    def begin(self): self.snapshot = copy.deepcopy((self.row, self.session))
    def commit(self): self.snapshot = None
    def rollback(self):
        if getattr(self, "snapshot", None):
            self.row, self.session = self.snapshot
            self.snapshot = None
    def execute(self, sql, args=()):
        self.statements.append((sql, args))
        if sql.startswith("UPDATE measurements SET value_x"):
            self.row.update(zip(("value_x", "value_y", "offset_opx", "offset_opy", "offset_pos_op", "result"), args))
            self.row["image_path"] = None
        if sql.startswith("UPDATE sessions SET measured_count=1"):
            self.session.update(state="stopped", measured_count=1, queue_state=args[0])
    def fetchone(self):
        sql = self.statements[-1][0]
        if "JOIN sessions" in sql:
            return {"number_alpl": 10, "session_id": 42, "queue_state": json.dumps(self.queue)}
        if "FROM sessions" in sql: return copy.deepcopy(self.session)
        return copy.deepcopy(self.row)


class BackendTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        review.captures.clear()
        review.active.clear()
        review.latest_image_capture.clear()
        self.db = FakeDB()
        self.request = MeasurementCreate(session_id=42, capture_id="ticket-1", value_x=8.2, value_y=8.03,
                                         offset_opx=.01, offset_opy=.01, horizon_left=4, horizon_right=4,
                                         vertical_top=4, vertical_bottom=4)
        review.captures["ticket-1"] = dict(session_id=42, piece=1, measurement_id=101, saved=False, image_done=False)
        review.active[42] = "ticket-1"

    async def test_remeasure_updates_only_selected_row_and_is_idempotent(self):
        events = AsyncMock()
        criteria = {"nominal_x": 8.035, "nominal_y": 8.035, "upper_tol": .015, "lower_tol": .015, "offset_tol": None}
        with patch.object(measurements, "get_db", return_value=self.db), \
             patch.object(measurements, "_load_criteria", return_value=criteria), \
             patch.object(measurements, "push_event", events), patch.object(measurements, "log_edit") as history:
            result = await measurements.create_measurement(self.request)
            self.assertEqual(result["measurement_id"], 101)
            self.assertEqual(result["status"], "remeasured")
            self.assertEqual(result["measured"], 2)
            self.assertEqual(result["result"], "NG")
            self.assertEqual(await measurements.create_measurement(self.request), result)
        writes = [sql for sql, _ in self.db.statements if sql.startswith(("UPDATE", "INSERT"))]
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0].endswith("WHERE measurement_id=%s"))
        history.assert_called_once()
        self.assertEqual(history.call_args.kwargs["before"]["image_path"], "old.jpg")
        events.assert_awaited_once()
        self.assertEqual(events.call_args.args[0], "measurement_replaced")
        self.assertTrue(review.check_image(101, "ticket-1"))

    async def test_stopped_session_does_not_overwrite(self):
        self.db.session["state"] = "stopped"
        with patch.object(measurements, "get_db", return_value=self.db):
            with self.assertRaises(HTTPException):
                await measurements.create_measurement(self.request)
        self.assertFalse(any(sql.startswith("UPDATE") for sql, _ in self.db.statements))

    async def test_old_capture_missing_token_and_old_image_rejected(self):
        review.active[42] = "new-ticket"
        with self.assertRaises(HTTPException): review.resolve_capture(self.request)
        with self.assertRaises(HTTPException): review.resolve_capture(self.request.model_copy(update={"capture_id": None}))
        review.latest_image_capture[101] = "new-ticket"
        with self.assertRaises(HTTPException): review.check_image(101, "ticket-1")

    async def test_finished_session_restarts_exactly_one_alpl_with_original_mode(self):
        async def start(request):
            body = await request.json()
            self.assertEqual(body["groups"][0]["number_alpl"], [10])
            self.assertEqual(body["Trigger_Mode"], "manual")
            self.assertEqual(body["Operator"], "Test")
            self.assertEqual(body["Measure_Type"], "IPM")
            self.assertEqual(body["Tray_Capacity"], 0)
            self.assertEqual(request.state.review_source, {"measurement_id": 101, "session_id": 42, "number_alpl": 10, "update_existing": True})
            return {"session_id": 43, "target_count": 1}
        with patch.object(review.s, "get_db", return_value=self.db), patch.object(session, "start_session", side_effect=start):
            self.assertEqual(await review.start_single(101), {"session_id": 43, "target_count": 1})

    async def test_capture_cannot_advance_until_previous_image_finishes(self):
        with patch.dict(review.s.session_queues, {42: self.db.queue}), patch.object(review.s, "get_db", return_value=self.db):
            with self.assertRaises(HTTPException):
                await review.prepare(review.CaptureRequest(session_id=42, piece=3, capture_id="new-ticket"))
            review.captures["ticket-1"]["image_done"] = True
            await review.prepare(review.CaptureRequest(session_id=42, piece=3, capture_id="new-ticket"))
            self.assertEqual(review.active[42], "new-ticket")

    async def test_standalone_review_updates_original_and_finishes_new_session_once(self):
        self.db.session.update(measured_count=0, target_count=1)
        self.db.row["measure_type"] = "New"
        source = {"measurement_id": 101, "session_id": 42, "number_alpl": 10, "update_existing": True}
        queue = {"queue": [10], "position": 0, "review_source": source}
        request = self.request.model_copy(update={"session_id": 43, "capture_id": "single"})
        criteria = {"nominal_x": 8.035, "nominal_y": 8.035, "upper_tol": .015, "lower_tol": .015, "offset_tol": .1}
        events = AsyncMock()
        with patch.dict(review.s.session_queues, {43: queue}), \
             patch.object(review.s, "get_db", return_value=self.db), \
             patch.object(measurements, "get_db", return_value=self.db), \
             patch.object(measurements, "_load_criteria", return_value=criteria), \
             patch.object(measurements, "push_event", events), patch.object(measurements, "log_edit"):
            # Both Pi and Mockup send measurement_id=None for a freshly started run.
            await review.prepare(review.CaptureRequest(session_id=43, piece=1, capture_id="single"))
            capture = review.captures["single"]
            self.assertEqual(capture["measurement_id"], 101)
            self.assertEqual(capture["measurement_session_id"], 42)
            response = await measurements.create_measurement(request)
            self.assertEqual(response["measurement_id"], 101)
            self.assertEqual(response["status"], "complete")
            self.assertEqual(response["measured"], 1)
            self.assertEqual(await measurements.create_measurement(request), response)
        self.assertEqual(self.db.row["session_id"], 42)
        self.assertEqual(self.db.row["measure_type"], "New")
        self.assertEqual(self.db.session["state"], "stopped")
        self.assertEqual(json.loads(self.db.session["queue_state"])["position"], 1)
        writes = [sql for sql, _ in self.db.statements if sql.startswith(("INSERT", "UPDATE"))]
        self.assertEqual(len(writes), 2)  # one original measurement + one execution session
        self.assertFalse(any("parts_specifications" in sql or sql.startswith("INSERT") for sql in writes))
        self.assertEqual([call.args[0] for call in events.call_args_list], ["measurement_replaced", "session_complete"])
        self.assertEqual(events.call_args_list[0].args[1]["measurement_session_id"], 42)
        self.assertTrue(review.check_image(101, "single"))  # image arrives after completion

    async def test_standalone_review_without_capture_cannot_insert(self):
        q = {"review_source": {"update_existing": True}}
        with patch.dict(review.s.session_queues, {43: q}):
            with self.assertRaises(HTTPException):
                await measurements.create_measurement(self.request.model_copy(update={"session_id": 43, "capture_id": None}))
        self.assertFalse(self.db.statements)

    async def test_standalone_review_rejects_different_measurement(self):
        q = {"queue": [10], "position": 0, "review_source": {
            "measurement_id": 101, "session_id": 42, "update_existing": True}}
        with patch.dict(review.s.session_queues, {43: q}):
            with self.assertRaises(HTTPException):
                await review.prepare(review.CaptureRequest(session_id=43, piece=1, capture_id="wrong", measurement_id=999))
        self.assertNotIn("wrong", review.captures)

    def test_new_existing_and_rework_missing_are_allowed(self):
        class Cursor:
            def execute(self, *args): pass
            def fetchone(self): return {"template_name": "021"}
            def fetchall(self): return [{"number_alpl": 10}]
        group = {"package_size": "8x8", "part_number": "PN"}
        self.assertEqual(session._validate_group(Cursor(), 0, group, "New", [10]), "021")
        self.assertEqual(session._validate_group(Cursor(), 0, group, "Rework", [20]), "021")
        with self.assertRaises(HTTPException):
            session._validate_group(Cursor(), 0, group, "Rework", [20], remeasure=True)
        self.assertEqual(session._validate_group(Cursor(), 0, group, "New", [10], remeasure=True), "021")

    async def test_new_remeasure_start_uses_real_start_validation_and_original_limits(self):
        class StartDB(FakeDB):
            lastrowid = 43
            def fetchone(self):
                sql = self.statements[-1][0]
                if "GET_LOCK" in sql: return {"got": 1}
                if "SELECT session_id FROM sessions WHERE state" in sql: return None
                if "SELECT t.template_name" in sql: return {"template_name": "021"}
                return super().fetchone()
            def fetchall(self): return [{"number_alpl": 10}]
        db = StartDB()
        db.queue.update(entry_mode="New", measure_mode="New")
        db.queue["groups"][0]["part_number"] = "PN"
        crit = {"nominal_x": 8.035, "nominal_y": 8.035, "upper_tol": .015, "lower_tol": .015, "offset_tol": .1}
        notify = AsyncMock()
        with patch.dict(review.s.session_queues, {}, clear=True), \
             patch.object(review.s, "get_db", return_value=db), patch.object(session, "get_db", return_value=db), \
             patch.object(session, "ALLOW_MANUAL_TRIGGER", True), \
             patch.object(session, "_criteria_from_config", return_value=crit), \
             patch.object(session, "_load_criteria", return_value=crit), \
             patch.object(session, "_notify_agent_start", notify), patch.object(session, "push_event", AsyncMock()):
            response = await review.start_single(101, review.SingleReviewStartRequest(trigger_mode="auto"))
            self.assertEqual(response["target_count"], 1)
            self.assertEqual(response["queue_state"]["measure_mode"], "New")
            self.assertTrue(response["queue_state"]["review_source"]["update_existing"])
            self.assertEqual(response["queue_state"]["trigger_mode"], "auto")
            self.assertEqual(notify.call_args.args[3], "auto")
            self.assertEqual(notify.call_args.args[4], 0)
            self.assertEqual(response["queue_state"]["tray_capacity"], 0)
            sent_groups = notify.call_args.args[2]
            self.assertEqual(sent_groups[0]["alpl"], [10])
            self.assertEqual(sent_groups[0]["template_name"], "021")
            self.assertEqual(sent_groups[0]["limits"]["offset_max"], .1)
            for capacity in (None, 12, 0):
                body = {"Measure_Type": "IPM", "Operator": "Test", "Trigger_Mode": "auto",
                        "Tray_Capacity": capacity, "groups": [{"number_alpl": [10], "package_size": "8x8"}]}
                async def receive():
                    return {"type": "http.request", "body": json.dumps(body).encode(), "more_body": False}
                normal = await session.start_session(Request({"type": "http", "method": "POST", "headers": []}, receive))
                self.assertEqual(notify.call_args.args[4], capacity)
                self.assertEqual(normal["queue_state"]["tray_capacity"], capacity)
        writes = [sql for sql, _ in db.statements if sql.startswith(("INSERT", "UPDATE"))]
        self.assertTrue(writes)
        self.assertTrue(all("sessions" in sql for sql in writes))

    async def test_standalone_start_forwards_selected_mode_over_saved_mode(self):
        for mode in ("auto", "manual"):
            self.db.queue["trigger_mode"] = "manual" if mode == "auto" else "auto"
            async def start(request):
                body = await request.json()
                self.assertEqual(body["Trigger_Mode"], mode)
                return {"session_id": 43, "target_count": 1}
            with patch.object(review.s, "get_db", return_value=self.db), patch.object(session, "start_session", side_effect=start):
                await review.start_single(101, review.SingleReviewStartRequest(trigger_mode=mode))

    def test_invalid_standalone_trigger_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            review.SingleReviewStartRequest(trigger_mode="invalid")

    async def test_start_rejects_invalid_tray_capacity_before_database_access(self):
        for capacity in (-1, 1.5, True, "8"):
            async def receive():
                return {"type": "http.request", "body": json.dumps({"Measure_Type": "IPM", "Tray_Capacity": capacity}).encode()}
            with self.assertRaises(HTTPException) as caught:
                await session.start_session(Request({"type": "http", "headers": []}, receive))
            self.assertEqual(caught.exception.status_code, 400)

    async def test_agent_json_preserves_null_zero_and_explicit_capacity(self):
        client = AsyncMock()
        client.post.return_value = Mock(status_code=200, is_success=True)
        context = AsyncMock()
        context.__aenter__.return_value = client
        with patch.object(session.httpx, "AsyncClient", return_value=context):
            for capacity in (None, 0, 12):
                await session._notify_agent_start(43, 1, [], "auto", capacity)
                payload = client.post.call_args.kwargs["json"]
                self.assertIn("tray_capacity", payload)
                self.assertEqual(payload["tray_capacity"], capacity)

    async def test_standalone_update_rolls_back_if_session_completion_fails(self):
        self.db.session.update(measured_count=0, target_count=1)
        queue = {"queue": [10], "position": 0, "review_source": {
            "measurement_id": 101, "session_id": 42, "update_existing": True}}
        request = self.request.model_copy(update={"session_id": 43, "capture_id": "single"})
        criteria = {"nominal_x": 8.035, "nominal_y": 8.035, "upper_tol": .015, "lower_tol": .015, "offset_tol": .1}
        execute = self.db.execute
        def fail_completion(sql, args=()):
            if sql.startswith("UPDATE sessions SET measured_count=1"):
                raise RuntimeError("simulated DB failure")
            execute(sql, args)
        with patch.dict(review.s.session_queues, {43: queue}), \
             patch.object(review.s, "get_db", return_value=self.db), \
             patch.object(measurements, "get_db", return_value=self.db), \
             patch.object(measurements, "_load_criteria", return_value=criteria):
            await review.prepare(review.CaptureRequest(session_id=43, piece=1, capture_id="single"))
            with patch.object(self.db, "execute", side_effect=fail_completion):
                with self.assertRaises(RuntimeError):
                    await measurements.create_measurement(request)
        self.assertEqual(self.db.row["value_x"], 8.03)
        self.assertEqual(self.db.row["image_path"], "old.jpg")
        self.assertEqual(self.db.session["measured_count"], 0)
        self.assertFalse(review.captures["single"]["saved"])


class AgentTrayTests(unittest.IsolatedAsyncioTestCase):
    async def test_pi_and_mock_apply_capacity_per_start_without_hardware(self):
        # Load only request models and the command handler: importing either
        # full agent would start background services and hardware discovery.
        for filename in ("Pi_auto_manual_mode.py", "mockup.py"):
            tree = ast.parse((ROOT / "Backend-pc_station" / filename).read_text(encoding="utf-8-sig"))
            nodes = []
            for node in tree.body:
                if isinstance(node, ast.ClassDef) and node.name in {"Limits", "Group", "GroupLimits", "EntryGroup", "CommandRequest"}:
                    nodes.append(node)
                elif isinstance(node, ast.AsyncFunctionDef) and node.name == "command":
                    node.decorator_list = []
                    nodes.append(node)
            env = dict(BaseModel=BaseModel, Field=Field, HTTPException=HTTPException,
                       is_running=False, _answer_lock=threading.Lock(), _answer_event=threading.Event(),
                       queue_review=Mock(), threading=Mock(), httpx=Mock(), log=Mock(), print=Mock(),
                       BACKEND_URL="http://test", current_session_id=None, open_mega=Mock(return_value=True),
                       command_flow=Mock(), measurement_flow=Mock())
            exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, "exec"), env)
            for capacity, expected in [(None, 8), (12, 12), (0, 0), (None, 8)]:
                env["is_running"] = False
                req = env["CommandRequest"](action="start", session_id=43, target_count=1,
                    tray_capacity=capacity, groups=[{"template_name": "021", "alpl": [10],
                    "limits": {"x_lo": 8, "x_hi": 9, "y_lo": 8, "y_hi": 9}}])
                await env["command"](req)
                self.assertEqual(env["TRAY_CAPACITY"], expected, filename)
            for invalid in (-1, 1.5, True):
                with self.assertRaises(ValueError):
                    env["CommandRequest"](action="start", tray_capacity=invalid)


if __name__ == "__main__":
    unittest.main()
