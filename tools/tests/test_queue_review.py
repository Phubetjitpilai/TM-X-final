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

    def test_continue_remaining_and_replay_all_use_original_positions(self):
        c = QueueReview("http://unused")
        c.reset(42, run_pieces=[3, 4, 5])
        self.assertEqual(list(c.pieces(5, lambda: True)), [3, 4, 5])
        c.reset(42, run_pieces=[1, 2, 3, 4, 5], existing_measurements={1: 101, 2: 102})
        worker = c.pieces(5, lambda: True)
        self.assertEqual(next(worker), 1)
        self.assertEqual(c.job["measurement_id"], 101)
        self.assertEqual(next(worker), 2)
        self.assertEqual(c.job["measurement_id"], 102)
        self.assertEqual(next(worker), 3)
        self.assertIsNone(c.job)
        self.assertEqual(list(worker), [4, 5])

    def test_single_piece_plan_keeps_same_session_identity(self):
        c = QueueReview("http://unused")
        c.reset(42, run_pieces=[2], existing_measurements={2: 102})
        worker = c.pieces(5, lambda: True)
        self.assertEqual(next(worker), 2)
        self.assertEqual(c.session_id, 42)
        self.assertEqual(c.job["measurement_id"], 102)
        self.assertEqual(list(worker), [])


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
        if sql.startswith("UPDATE sessions SET state='stopped'"):
            self.session.update(state="stopped", queue_state=args[0])
        if sql.startswith("UPDATE sessions SET target_count="):
            self.session.update(target_count=args[0], queue_state=args[1])
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

    async def test_replay_all_advances_display_piece_without_changing_measure_count(self):
        q = {**self.db.queue, "run_mode": "all", "run_pieces": [1, 2, 3, 4, 5], "active_piece": 1}
        criteria = {"nominal_x": 8.035, "nominal_y": 8.035,
                    "upper_tol": .015, "lower_tol": .015, "offset_tol": None}
        events = AsyncMock()
        with patch.dict(review.s.session_queues, {42: q}, clear=True), \
             patch.object(measurements, "get_db", return_value=self.db), \
             patch.object(measurements, "_load_criteria", return_value=criteria), \
             patch.object(measurements, "push_event", events), patch.object(measurements, "log_edit"):
            result = await measurements.create_measurement(self.request)
        self.assertEqual(result["measured"], 2)
        self.assertEqual(q["active_piece"], 2)
        writes = [args for sql, args in self.db.statements if sql.startswith("UPDATE sessions SET queue_state=")]
        self.assertEqual(json.loads(writes[-1][0])["active_piece"], 2)
        self.assertEqual(events.call_args.args[1]["active_piece"], 2)

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
        restart = AsyncMock(return_value={"session_id": 42, "target_count": 5})
        with patch.object(review.s, "get_db", return_value=self.db), patch.object(session, "restart_existing_session", restart):
            self.assertEqual(await review.start_single(101), {"session_id": 42, "target_count": 5})
        restart.assert_awaited_once_with(42, "single", None, 101)

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

    async def test_stopped_remeasure_replaces_row_in_same_session_without_advancing_queue(self):
        q = {**self.db.queue, "run_mode": "single", "run_pieces": [1]}
        criteria = {"nominal_x": 8.035, "nominal_y": 8.035, "upper_tol": .015, "lower_tol": .015, "offset_tol": None}
        events = AsyncMock()
        with patch.dict(review.s.session_queues, {42: q}, clear=True), \
             patch.object(measurements, "get_db", return_value=self.db), \
             patch.object(measurements, "_load_criteria", return_value=criteria), \
             patch.object(measurements, "push_event", events), patch.object(measurements, "log_edit"):
            result = await measurements.create_measurement(self.request)
        self.assertEqual(result["measurement_id"], 101)
        self.assertEqual(result["measured"], 2)
        self.assertEqual(result["target"], 5)
        self.assertEqual(self.db.session["state"], "stopped")
        self.assertEqual(self.db.session["measured_count"], 2)
        self.assertEqual(json.loads(self.db.session["queue_state"])["position"], 2)
        self.assertEqual([call.args[0] for call in events.call_args_list], ["measurement_replaced", "session_complete"])
        self.assertFalse(any(sql.startswith("INSERT") for sql, _ in self.db.statements))

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
        # The restart endpoint must keep the original ID and schedule only
        # unmeasured positions, while replay-all includes measured positions.
        class RestartDB(FakeDB):
            def __init__(self):
                super().__init__()
                self.session["state"] = "stopped"
                self.queue.update(start_confirmed=True, group_templates=["021"], tray_capacity=8)
            def fetchone(self):
                sql = self.statements[-1][0]
                if "GET_LOCK" in sql: return {"got": 1}
                if "WHERE state='running'" in sql: return None
                if "ORDER BY session_id DESC" in sql: return {"session_id": 42}
                if "FROM sessions WHERE session_id" in sql:
                    return {**self.session, "queue_state": json.dumps(self.queue)}
                return super().fetchone()
            def fetchall(self):
                return [{"measurement_id": 101, "number_alpl": 10},
                        {"measurement_id": 102, "number_alpl": 20}]
        db = RestartDB()
        client = AsyncMock()
        client.post.return_value = Mock(status_code=200)
        client.post.return_value.raise_for_status = Mock()
        context = AsyncMock()
        context.__aenter__.return_value = client
        with patch.dict(review.s.session_queues, {}, clear=True), \
             patch.object(session, "get_db", return_value=db), \
             patch.object(session, "_build_groups", return_value=[{"template_name": "021", "alpl": db.queue["queue"], "handler": "H"}]), \
             patch.object(session.httpx, "AsyncClient", return_value=context), \
             patch.object(session, "push_event", AsyncMock()):
            for mode, pieces in (("remaining", [3, 4, 5]), ("all", [1, 2, 3, 4, 5]), ("single", [1])):
                result = await session.restart_existing_session(42, mode, measurement_id=101 if mode == "single" else None)
                payload = client.post.call_args.kwargs["json"]
                self.assertEqual(result["session_id"], 42)
                self.assertEqual(result["measured_count"], 2)
                self.assertEqual(payload["run_pieces"], pieces)
                self.assertEqual(result["queue_state"]["active_piece"], pieces[0])
                self.assertEqual(payload["existing_measurements"],
                                 {1: 101, 2: 102} if mode == "all" else {1: 101} if mode == "single" else {})
                self.assertEqual(payload["target_count"], 5)
                self.assertEqual(payload["tray_capacity"], 0 if mode == "single" else 8)
            db.queue.update(queue=[10, 20], group_of=[0, 0], position=2,
                            groups=[{**db.queue["groups"][0], "number_alpl": [10, 20]}],
                            work_closed=True)
            db.session["target_count"] = 2
            closed = await session.restart_existing_session(42, "single", measurement_id=101)
            self.assertEqual(closed["target_count"], 2)
            self.assertEqual(client.post.call_args.kwargs["json"]["run_pieces"], [1])

    async def test_timeout_restart_requires_pi_and_restores_timeout_after_rejected_start(self):
        class RestartDB(FakeDB):
            def fetchone(self):
                sql = self.statements[-1][0]
                if "GET_LOCK" in sql: return {"got": 1}
                if "WHERE state='running'" in sql: return None
                if "ORDER BY session_id DESC" in sql: return {"session_id": 42}
                if "FROM sessions WHERE session_id" in sql:
                    return {**self.session, "queue_state": json.dumps(self.queue)}
                return super().fetchone()
            def fetchall(self):
                return [{"measurement_id": 101, "number_alpl": 10},
                        {"measurement_id": 102, "number_alpl": 20}]

        db = RestartDB()
        db.session.update(state="timeout", last_seen="old-heartbeat", ended_at="interrupted-at")
        db.queue.update(start_confirmed=True, group_templates=["021"], tray_capacity=8)
        original_queue = copy.deepcopy(db.queue)
        client = AsyncMock()
        client.post.return_value = Mock()
        context = AsyncMock()
        context.__aenter__.return_value = client
        events = AsyncMock()
        with patch.dict(session.session_queues, {}, clear=True), \
             patch.object(session, "get_db", return_value=db), \
             patch.object(session, "read_pi_status", return_value=False) as pi_status, \
             patch.object(session, "_build_groups", return_value=[{"template_name": "021", "alpl": db.queue["queue"]}]), \
             patch.object(session.httpx, "AsyncClient", return_value=context), \
             patch.object(session, "push_event", events):
            with self.assertRaises(HTTPException) as offline:
                await session.restart_existing_session(42, "single", measurement_id=101)
            self.assertEqual(offline.exception.status_code, 503)
            self.assertFalse(any(sql.startswith("UPDATE sessions SET state='running'") for sql, _ in db.statements))
            client.post.assert_not_awaited()

            pi_status.return_value = True
            client.post.return_value.raise_for_status.side_effect = session.httpx.HTTPStatusError(
                "Pi is busy", request=session.httpx.Request("POST", "http://pi/command"),
                response=session.httpx.Response(409))
            with self.assertRaises(HTTPException) as rejected:
                await session.restart_existing_session(42, "single", measurement_id=101)
            self.assertEqual(rejected.exception.status_code, 502)
            rollback = [(sql, args) for sql, args in db.statements
                        if sql.startswith("UPDATE sessions SET state=%s")][-1]
            self.assertEqual(rollback[1][:3], ("timeout", "interrupted-at", "old-heartbeat"))
            self.assertEqual(json.loads(rollback[1][3]), original_queue)
            self.assertNotIn(42, session.session_queues)
            events.assert_not_awaited()

            client.post.side_effect = session.httpx.ConnectError("Pi disconnected")
            with self.assertRaises(HTTPException) as disconnected:
                await session.restart_existing_session(42, "remaining")
            self.assertEqual(disconnected.exception.status_code, 502)
            rollback = [(sql, args) for sql, args in db.statements
                        if sql.startswith("UPDATE sessions SET state=%s")][-1]
            self.assertEqual(rollback[1][0], "timeout")
            client.post.side_effect = None
            client.post.return_value.raise_for_status.side_effect = None
            result = await session.restart_existing_session(42, "single", measurement_id=101)
            self.assertEqual(result["session_id"], 42)
            self.assertEqual(result["state"], "running")
            self.assertEqual(client.post.call_args.kwargs["json"]["run_pieces"], [1])
            self.assertEqual(client.post.call_args.kwargs["json"]["existing_measurements"], {1: 101})
            events.assert_awaited_once()
            continued = await session.restart_existing_session(42, "remaining")
            self.assertEqual(continued["session_id"], 42)
            self.assertEqual(client.post.call_args.kwargs["json"]["run_pieces"], [3, 4, 5])
            self.assertEqual(client.post.call_args.kwargs["json"]["existing_measurements"], {})

    async def test_standalone_start_forwards_selected_mode_over_saved_mode(self):
        for mode in ("auto", "manual"):
            self.db.queue["trigger_mode"] = "manual" if mode == "auto" else "auto"
            restart = AsyncMock(return_value={"session_id": 42})
            with patch.object(review.s, "get_db", return_value=self.db), patch.object(session, "restart_existing_session", restart):
                await review.start_single(101, review.SingleReviewStartRequest(trigger_mode=mode))
            restart.assert_awaited_once_with(42, "single", mode, 101)

    async def test_end_work_closes_only_pending_queue_and_preserves_measurements(self):
        class EndDB(FakeDB):
            def fetchone(self):
                sql = self.statements[-1][0]
                if "GET_LOCK" in sql: return {"got": 1}
                if "ORDER BY session_id DESC" in sql: return {"session_id": 42}
                if "FROM sessions WHERE session_id" in sql:
                    return {**self.session, "queue_state": json.dumps(self.queue)}
                return super().fetchone()
        db = EndDB()
        db.session["state"] = "stopped"
        db.queue["group_templates"] = ["021"]
        events = AsyncMock()
        with patch.object(session, "get_db", return_value=db), patch.object(session, "push_event", events):
            result = await session.end_work(session.StopSessionRequest(session_id=42))
        self.assertTrue(result["queue_state"]["work_closed"])
        self.assertEqual(result["queue_state"]["queue"], [10, 20])
        self.assertEqual(result["queue_state"]["original_plan"]["queue"], [10, 20, 30, 40, 50])
        self.assertEqual(db.session["measured_count"], 2)
        self.assertEqual(db.session["target_count"], 2)
        self.assertFalse(any(sql.startswith("DELETE") for sql, _ in db.statements))
        events.assert_awaited_once()

    async def test_timeout_end_work_requires_online_idle_pi(self):
        class EndDB(FakeDB):
            def fetchone(self):
                sql = self.statements[-1][0]
                if "GET_LOCK" in sql: return {"got": 1}
                if "ORDER BY session_id DESC" in sql: return {"session_id": 42}
                if "FROM sessions WHERE session_id" in sql:
                    return {**self.session, "queue_state": json.dumps(self.queue)}
                return super().fetchone()

        db = EndDB()
        db.session["state"] = "timeout"
        db.queue.update(start_confirmed=True, group_templates=["021"])
        client = AsyncMock()
        client.get.return_value = Mock()
        client.get.return_value.json.return_value = {"phase": "running"}
        context = AsyncMock()
        context.__aenter__.return_value = client
        events = AsyncMock()
        with patch.object(session, "get_db", return_value=db), \
             patch.object(session, "read_pi_status", return_value=False) as pi_status, \
             patch.object(session.httpx, "AsyncClient", return_value=context), \
             patch.object(session, "push_event", events):
            with self.assertRaises(HTTPException) as offline:
                await session.end_work(session.StopSessionRequest(session_id=42))
            self.assertEqual(offline.exception.status_code, 503)
            client.get.assert_not_awaited()
            pi_status.return_value = True
            with self.assertRaises(HTTPException) as busy:
                await session.end_work(session.StopSessionRequest(session_id=42))
            self.assertEqual(busy.exception.status_code, 409)
            self.assertFalse(any(sql.startswith("UPDATE sessions SET target_count") for sql, _ in db.statements))
            client.get.return_value.json.return_value = {"phase": "stopped"}
            result = await session.end_work(session.StopSessionRequest(session_id=42))
            self.assertTrue(result["queue_state"]["work_closed"])
            self.assertEqual(result["queue_state"]["queue"], [10, 20])
            events.assert_awaited_once()

    async def test_normal_start_is_blocked_while_latest_queue_has_pending_pieces(self):
        class GuardDB(FakeDB):
            def fetchone(self):
                sql = self.statements[-1][0]
                if "GET_LOCK" in sql: return {"got": 1}
                if "WHERE state = 'running'" in sql: return None
                if "ORDER BY session_id DESC" in sql:
                    return {"state": self.pending_state, "measured_count": 2, "target_count": 5,
                            "queue_state": json.dumps({"start_confirmed": True, "work_closed": False})}
                return super().fetchone()
        body = {"Measure_Type": "IPM", "Operator": "Test", "groups": [{"number_alpl": [11]}]}
        for state in ("stopped", "timeout"):
            db = GuardDB()
            db.pending_state = state
            async def receive():
                return {"type": "http.request", "body": json.dumps(body).encode(), "more_body": False}
            request = Request({"type": "http", "method": "POST", "headers": []}, receive)
            with patch.object(session, "get_db", return_value=db), \
                 patch.object(session, "_parse_entry_groups", return_value=body["groups"]), \
                 patch.object(session, "_flatten_groups", return_value=([11], [0])):
                with self.assertRaises(HTTPException) as caught:
                    await session.start_session(request)
            self.assertEqual(caught.exception.status_code, 409)
            self.assertFalse(any(sql.startswith("INSERT") for sql, _ in db.statements))

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
                env["_worker_thread"] = None
                req = env["CommandRequest"](action="start", session_id=43, target_count=1,
                    tray_capacity=capacity, groups=[{"template_name": "021", "alpl": [10],
                    "handler": "H", "limits": {"x_lo": 8, "x_hi": 9, "y_lo": 8, "y_hi": 9}}])
                await env["command"](req)
                self.assertEqual(env["TRAY_CAPACITY"], expected, filename)
            for invalid in (-1, 1.5, True):
                with self.assertRaises(ValueError):
                    env["CommandRequest"](action="start", tray_capacity=invalid)


if __name__ == "__main__":
    unittest.main()
