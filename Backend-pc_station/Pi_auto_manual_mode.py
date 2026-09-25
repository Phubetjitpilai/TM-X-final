import os
import math
import re
import socket
import threading
import time

import httpx
from queue_review import QueueReview
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ── ตั้ง logging ─────────────────────────────────────────────────────────
# ทุกบรรทัดจะมี timestamp นำหน้า จำเป็นตอนรันเป็น service แบบไม่มีหน้าต่าง
# แล้วมาเปิดไฟล์ log อ่านทีหลัง — ไม่มีเวลากำกับจะไล่ลำดับเหตุการณ์ไม่ได้เลย
#
# ⚠ ป้าย [Pi] ไว้แยกจาก [Server] ของ Backend เวลาเอา log 2 เครื่องมาวางเทียบกัน
import logging

# new
########################
import glob
import serial

# ── Serial Config สำหรับเชื่อมต่อ Arduino Mega ──────────────────────────────
BAUD_RATE   = 115200
TIMEOUT_SEC = 1


logging.basicConfig(level=logging.INFO, format="%(asctime)s [Pi] %(message)s")
log = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)


load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__),  ".env"))
TMX_IP = os.getenv("TMX_HOST", "192.168.10.11")
TMX_PORT = int(os.getenv("TMX_PORT", 8600))
BUFFER_SIZE = 1024


def find_mega_port() -> str | None:
    """ค้นหาพอร์ต USB ที่เชื่อมต่อกับ Mega 2560 อัตโนมัติ"""
    ports = glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*")
    return ports[0] if ports else None

# ── เชื่อมต่อ Serial แบบ "เปิดเมื่อต้องใช้" (lazy) ─────────────────────────
# ⚠ ของเดิมเปิดพอร์ตที่ระดับโมดูลแล้ว `sys.exit(1)` ถ้าไม่เจอ Mega — ทำงานทันที
#   ตอน import ผลคือ **ไม่เสียบ Mega = สคริปต์ไม่สตาร์ทเลย** ซึ่งใช้ไม่ได้กับ
#   ไฟล์นี้ เพราะโหมด manual ต้องรันได้โดยไม่มีบอร์ด (นั่นคือเหตุผลที่มีโหมดนี้)
#
#   ตอนนี้จึงเลื่อนไปเปิดตอน `command_flow` เริ่ม และเฉพาะรอบที่ขอโหมด auto
#   เท่านั้น · เปิดครั้งเดียวแล้วใช้ซ้ำทุก session (ไม่ปิด-เปิดใหม่ทุกรอบ
#   เพราะ Mega รีเซ็ตตัวเองทุกครั้งที่เปิดพอร์ต = เสียเวลา 2 วิต่อรอบ)
mega_ser = None

def open_mega() -> bool:
    """เปิดพอร์ต Serial ถ้ายังไม่เปิด — คืน True เมื่อพร้อมใช้งาน

    ห้าม raise — ผู้เรียก (`command_flow`) ต้องเอาผลไปบอกผู้ใช้ผ่านหน้าเว็บ
    ไม่ใช่ปล่อยให้ตายกลางเธรดที่กำลังวัด
    """
    global mega_ser
    if mega_ser is not None:
        return True
    port = find_mega_port()
    if not port:
        log.error("❌ หา Arduino/Mega บน USB ไม่เจอ — โหมด auto ใช้ไม่ได้ "
                  "(ตรวจสาย USB หรือสั่ง Start ใหม่เป็นโหมด manual)")
        return False
    log.info("[INFO] Connecting to Mega on %s @ %s baud ...", port, BAUD_RATE)
    try:
        mega_ser = serial.Serial(port, BAUD_RATE, timeout=TIMEOUT_SEC)
    except Exception as exc:
        log.error("❌ เปิดพอร์ต %s ไม่สำเร็จ: %s", port, exc)
        mega_ser = None
        return False
    time.sleep(2)  # รอ Mega รีเซ็ตตัวเองหลังเชื่อมต่อ
    log.info("[INFO] Mega Serial Connected Successfully.")
    return True


def _drop_mega(where: str) -> None:
    global mega_ser
    if mega_ser is None:
        return
    try:
        mega_ser.close()
    except Exception:
        pass
    mega_ser = None
    log.warning("   ⚠️ ทิ้งการเชื่อมต่อ Mega แล้ว (พังตอน%s) "
                "— กด Start ใหม่บนหน้าเว็บเพื่อเปิดพอร์ตใหม่ ไม่ต้องรีสตาร์ทสคริปต์", where)
#########################

TRIGGER_COMMAND = "T1\r"

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
queue_review = QueueReview(BACKEND_URL)
AGENT_PORT = int(os.getenv("AGENT_PORT", 9998))

HB_INTERVAL     = float(os.getenv("HEARTBEAT_INTERVAL", 5))
HB_TIMEOUT_HINT = float(os.getenv("HEARTBEAT_TIMEOUT", 15))

MEASURE_TIMEOUT       = float(os.getenv("MEASURE_TIMEOUT", 15))    # รอค่าสูงสุดกี่วินาที
MEASURE_POLL_INTERVAL = float(os.getenv("MEASURE_POLL_INTERVAL", 0.4))

SOCKET_TIMEOUT   = float(os.getenv("SOCKET_TIMEOUT", 5))
# ── GM: ดึงค่าที่วัดได้จาก TM-X โดยตรง ──────────────────────────────────────
GM_POLL_INTERVAL = 0.02                                  # 20 ms
GM_MAX_WAIT      = float(os.getenv("GM_MAX_WAIT", 2))    # รอค่าสูงสุดต่อชิ้น
NO_VALUE_ABS     = 9999.0        # |ค่า| >= นี้ = TM-X ยังวัดไม่เสร็จ/วัดไม่ติด
# T1 ที่โดน ER,...,03 (READY ยังไม่กลับมาหลัง RESET ที่พ่วงมากับ PW) ยิงซ้ำได้

T1_RETRY = int(os.getenv("T1_RETRY", 3))
T1_RETRY_WAIT = float(os.getenv("T1_RETRY_WAIT", 0.3))

# รอกี่วินาทีหลังส่ง `PW` ก่อนจะเริ่มวัด — TM-X ต้องโหลดโปรแกรมจากการ์ด SD
# และ RESET ที่พ่วงมาทำให้ READY ดับชั่วคราว ยิง `T1` เร็วเกินไปจะได้ `ER,T1,03`
#
# ⚠ ตัวนี้ถูกใช้ **ทุกครั้งที่ข้ามรอยต่อกลุ่ม** ไม่ใช่แค่ตอนเริ่ม session แล้ว
#   ตั้งสูงไปจะช้าทุกกลุ่ม ตั้งต่ำไปชิ้นแรกของกลุ่มจะพังแล้วเด้งถามผู้ใช้
PW_LOAD_WAIT = float(os.getenv("PW_LOAD_WAIT", 1.0))

# รอคำตอบของ `PW` ได้นานกว่าคำสั่งอื่น — TM-X ต้องโหลดโปรแกรมจากการ์ด SD ก่อน
# ถึงจะตอบกลับ วัดจริงที่หน้างานได้ **2.7 วินาที** (log 8 ก.ย. 2569)
#
# ⚠ ห้ามใช้ `SOCKET_TIMEOUT` (5 วิ) เฉย ๆ — เฉียดเกินไป การ์ด SD ที่ช้ากว่านี้
#   หรือโปรแกรมวัดที่ใหญ่กว่าจะทำให้ session พังทั้งรอบตรงชิ้นแรกของกลุ่ม
PW_CMD_TIMEOUT = float(os.getenv("PW_CMD_TIMEOUT", 10))

MAX_ASK_USER_ROUNDS = int(os.getenv("MAX_ASK_USER_ROUNDS", 4))

_answer_event  = threading.Event()
_answer_action = None                  # "retry" | "stop" | None
_answer_lock   = threading.Lock()

# รอคำตอบจากคนได้นานสุดกี่วิ — ต้อง **มากกว่า** ตัวนับถอยหลังในหน้าเว็บ (60 วิ)
# เพราะคนกดหยุดเองหรือหน้าเว็บกดให้อัตโนมัติก็ตาม คำตอบจะวิ่งกลับมาทางเดียวกัน
# ตัวนี้เป็นแค่ตาข่ายกันค้างถาวรตอนหน้าเว็บไม่ได้เปิดอยู่เลย
ASK_USER_TIMEOUT = float(os.getenv("ASK_USER_TIMEOUT", 70))

# ถาดรับชิ้นงานจุได้กี่ชิ้น — วัดครบเท่านี้แล้วหยุดรอให้คนมาเคลียร์ถาด
# 0 = ปิดฟีเจอร์ (วัดรวดเดียวจนครบ target_count)
#
# ⚠ **ไม่มีคู่ TIMEOUT** ต่างจาก ASK_USER_TIMEOUT ข้างบนโดยตั้งใจ — ดู ask_tray_clear
#ถ้า tray = 0 คือปิดการทำงาน
TRAY_CAPACITY = 8

# คำสั่งล้างค่าเก่า — คู่มือหน้า 5-9 พิมพ์ 2 แบบไม่ตรงกันเอง ต้องลองเอง
CLEAR_CANDIDATES = ["MRS", "MSR"]
_clear_cmd = None    # None=ยังไม่ได้ลอง · "MRS"/"MSR"=ตัวที่ใช้ได้ · False=ไม่ผ่านทั้งคู่
MCU_TIMEOUT = float(os.getenv("MCU_TIMEOUT", 5))
def _idx(name, default):
    v = os.getenv(name, default)
    return None if v in ("", "none", "None", None) else int(v)

GM_IDX_X      = _idx("GM_IDX_X", "0")
GM_IDX_Y      = _idx("GM_IDX_Y", "1")
# ระยะ opening 4 ด้าน — จับเป็น 2 คู่แกน ไม่ใช่ 4 มุม
#
# ⚠⚠ ชื่อคีย์เปลี่ยนแล้ว (เดิม GM_IDX_TR/TL/BL/BR_OFFSET) — **ต้องแก้ `.env` บน
#     เครื่อง Pi จริงให้ตรงด้วย** ไม่งั้น `_idx()` จะหาคีย์ไม่เจอแล้ว **คืนค่า
#     default ให้เงียบๆ ไม่มี error** ถ้าเครื่องนั้นเคยตั้งช่องไว้ไม่ตรงกับ
#     default มันจะอ่านค่าจากช่องผิดตลอดทั้ง session โดยไม่มีอะไรเตือนเลย
GM_IDX_HORIZON_LEFT    = _idx("GM_IDX_HORIZON_LEFT", "2")
GM_IDX_HORIZON_RIGHT   = _idx("GM_IDX_HORIZON_RIGHT", "3")
GM_IDX_VERTICAL_TOP    = _idx("GM_IDX_VERTICAL_TOP", "4")
GM_IDX_VERTICAL_BOTTOM = _idx("GM_IDX_VERTICAL_BOTTOM", "5")
GM_IDX_OFFSET_X = _idx("GM_IDX_OFFSET_X", "6")    
GM_IDX_OFFSET_Y = _idx("GM_IDX_OFFSET_Y", "7") 

# ── สถานะระดับโมดูล ────────────────────────────────────────────────────────
# ทุกตัวต้องมีค่าตั้งต้นตรงนี้ ห้ามให้ไปเกิดครั้งแรกใน command_flow เท่านั้น
# เพราะ heartbeat_loop รันใน thread แยกตั้งแต่เปิดโปรแกรม = อ่านก่อนที่จะมีใคร
# กด Start → NameError
is_running = False          # ตอนนี้มี session กำลังวัดอยู่ไหม (ไม่ใช่ "สคริปต์รันอยู่ไหม")
current_session_id = None   # session ที่กำลังวัด (None = idle) heartbeat แนบไปด้วย
_hb_last_ok = time.time()   # เวลาที่ heartbeat ยิงออกสำเร็จครั้งล่าสุด

# "กระดิ่ง" ที่บอกว่าชิ้นงานเข้าที่พร้อมวัดแล้ว — ใช้เฉพาะโหมด manual
# (โหมด auto ไม่ผ่าน Event ตัวนี้ แต่อ่านจาก Serial ตรง ๆ ใน wait_for_trigger_serial)
_trigger = threading.Event()

# ตอนนี้อยู่ในช่วง "รอสัญญาณ" จริงหรือยัง — endpoint ใช้ตอบให้ตรงความจริงว่า
# สัญญาณที่ยิงมาจะถูกใช้หรือถูกทิ้ง ไม่งั้น curl แล้วเครื่องไม่ขยับจะนึกว่าพัง
# heartbeat แนบค่านี้ไปให้ backend เพื่อเปิด/ปิดปุ่ม ⚡ บนหน้าเว็บ
_waiting_for_trigger = False

# โหมด trigger ของ session ที่กำลังวัด — "manual" (ปุ่มบนเว็บ) | "auto" (MCU)
#
# ⚠ **ล็อกทั้ง session ห้ามสลับกลางคัน** — `send_package_size_to_mcu` ไม่ส่ง
#   <PKG:...> เลยเมื่ออยู่โหมด manual ถ้าสลับโหมดกลางรอบ MCU จะพลาด <PKG> ของ
#   ชิ้นที่ผ่านไปตอนอยู่โหมด manual แล้วตั้งฟิกซ์เจอร์ผิดขนาดโดยไม่มีใครรู้
#
# ค่าตั้งต้นเป็น "auto" เพราะเป็นโหมดใช้งานจริง · payload รุ่นเก่าที่ไม่ส่ง
# trigger_mode มาจะได้ auto แล้วยืนรอ Serial เงียบ ๆ จึงต้อง log ทุกรอบ
# ตอนเริ่ม session (ดู command_flow) ไม่งั้นจะหาสาเหตุไม่เจอ
_trigger_mode = "None"

http_app = FastAPI()

class Limits(BaseModel):
    x_lo: float; x_hi: float; y_lo: float; y_hi: float
    offset_max: float | None = None

class Group(BaseModel):
    template_name: str
    alpl: list[int]
    limits: Limits | None = None
    package_size: str | None = None      # เผื่อ backend รุ่นเก่าไม่ส่งมา
    handler: str

class CommandRequest(BaseModel):
    review_job: dict | None = None
    action: str
    session_id: int | None = None
    target_count: int | None = None
    # "manual" = รอปุ่ม ⚡ บนหน้าเว็บ · "auto" = รอ <TRIGGER_TMX> จาก MCU
    # default เป็น auto เพื่อให้ backend รุ่นที่ยังไม่ส่งฟิลด์นี้ทำงานเหมือนเดิม
    trigger_mode: str = "auto"
    tray_capacity: int | None = Field(default=None, ge=0, strict=True)
    groups: list[Group] | None = None

@http_app.post("/command")
async def command(req: CommandRequest):
    global is_running, _answer_action, TRAY_CAPACITY
    if req.action in ("pause_queue", "resume_queue", "remeasure"):
        if not is_running:
            raise HTTPException(409, "ไม่มี Session กำลังทำงาน")
        return queue_review.command(req.action, req.session_id, req.review_job)

    if req.action == "start":
        if is_running:
            raise HTTPException(409, "Pi กำลังทำงานอยู่")
        try:
            httpx.post(f"{BACKEND_URL}/api/heartbeat",
                json={"session_id": current_session_id},
                timeout=5)
        except Exception:
            pass
        log.info("\n ได้รับคำสั่ง Start จาก Backend")
        groups = req.groups
        if not groups:
            raise HTTPException(400, "payload ไม่มี `groups`")
        if any(not g.alpl for g in groups):
            raise HTTPException(400, "มีกลุ่มที่ `alpl` ว่างเปล่า")
        if any(g.limits is None for g in groups):
            raise HTTPException(400, "มีกลุ่มที่ไม่ได้ระบุ `limits`")

        all_alpl = [a for g in groups for a in g.alpl]
        if len(set(all_alpl)) != len(all_alpl):
            raise HTTPException(400, "มี ALPL ซ้ำข้ามกลุ่ม")
        if req.target_count != len(all_alpl):
            raise HTTPException(400, f"target_count ({req.target_count}) ไม่เท่ากับจำนวน ALPL รวมทุกกลุ่ม ({len(all_alpl)})")
        if any(not g.template_name for g in groups):
            raise HTTPException(400, "มีกลุ่มที่ไม่ได้ระบุ `template_name`")

        # ตรวจโหมดที่นี่ ไม่ใช่ปล่อยไปตกใน command_flow — ถ้าสะกดผิดต้องรู้
        # ตั้งแต่ตอนกด Start ไม่ใช่ไปเงียบ ๆ แล้วยืนรอ Serial ที่ไม่มีวันมา
        if req.trigger_mode not in ("manual", "auto"):
            raise HTTPException(
                400,
                f"trigger_mode '{req.trigger_mode}' ไม่ถูกต้อง — ต้องเป็น 'manual' หรือ 'auto'",
            )

        if req.trigger_mode == "auto" :
            global mega_ser
            mega_ser = None
            if not open_mega():
                raise HTTPException(
                    503,
                    "โหมด auto ต้องต่อ Arduino/Mega ผ่าน USB — หาพอร์ตไม่เจอ "
                    "(ตรวจสาย USB หรือเลือกโหมด manual แทน)",
                )
        

        with _answer_lock:
            _answer_action = None
            _answer_event.clear()

        queue_review.reset(req.session_id)
        TRAY_CAPACITY = 8 if req.tray_capacity is None else req.tray_capacity
        log.info("   Tray Capacity: %s", TRAY_CAPACITY)
        is_running = True
        threading.Thread(
            target=command_flow,
            args=(req.session_id, groups, req.target_count, req.trigger_mode),
            daemon=True,
        ).start()

    elif req.action == "retry":
        with _answer_lock:
            _answer_action = "retry"
        _answer_event.set()

    elif req.action == "accept":
        # ผู้ใช้กด "รับค่าจาก Pi (ไม่มีรูป)" — ใช้เฉพาะเคสที่ wait_for_measurement
        # หมดเวลา คือ **วัดสำเร็จแล้วแต่ค่าไม่ถึง DB** (Recieve ส่งไม่ถึง)
        #
        # ⚠ ไม่ใช่การวัดใหม่ — ชิ้นงานถูก MCU คัดแยกออกไปแล้ว ไม่มีอะไรให้วัด
        #   Pi แค่ POST ค่าที่อ่านจาก GM ไว้แล้วเข้า /api/measurements เอง
        #
        # ⚠ ห้ามแตะ is_running เหมือน retry — session ยังเดินต่อหลังบันทึกเสร็จ
        log.info("📥 ได้รับคำสั่ง Accept จาก Backend")
        with _answer_lock:
            _answer_action = "accept"
        _answer_event.set()

    elif req.action == "resume":
        # ผู้ใช้เคลียร์ถาดแล้วกด "วัดต่อ" — ปลดเธรดวัดที่บล็อกใน ask_tray_clear
        #
        # ⚠ ห้ามแตะ is_running เหมือน retry/accept — session ไม่เคยหยุด แค่ยืนรอ
        #   อยู่เฉย ๆ ถ้าเซ็ต is_running ใหม่ตรงนี้จะทับสถานะที่ Stop เพิ่งเปลี่ยนไป
        #   (เคสกด Stop กับ Resume ไล่หลังกันเสี้ยววินาที)
        log.info("▶ ได้รับคำสั่ง Resume จาก Backend — ผู้ใช้เคลียร์ถาดแล้ว")
        with _answer_lock:
            _answer_action = "resume"
        _answer_event.set()


    elif req.action == "trigger":
        # ปุ่ม ⚡ บนหน้าเว็บ — ใช้ได้เฉพาะโหมด manual
        # guard ชุดเดียวกับ /trigger เป๊ะ แต่ตอบเป็น HTTP error แทน {"ok": False}
        # เพราะเส้นนี้ backend เป็นคนเรียก ไม่ใช่คนยิง curl เอง
        if not is_running:
            raise HTTPException(400, "ไม่มี session กำลังวัดอยู่ — กด Start ที่หน้าเว็บก่อน")
        if not _waiting_for_trigger:
            raise HTTPException(
                409,
                "ยังไม่ถึงช่วงรอสัญญาณ — ระบบกำลังโหลดโปรแกรมวัด "
                "หรือกำลังรอผลของชิ้นก่อนหน้าอยู่",
            )
        _trigger.set()
        log.info("⚡ ได้รับสัญญาณ trigger (จากปุ่มบนหน้าเว็บ)")

    elif req.action == "stop":
        is_running = False
        # ⚠ ต้อง set ด้วย ไม่งั้นกด Stop ตอน modal เปิดอยู่
        #   ask_user() จะค้างรอต่ออีก 90 วิทั้งที่ session จบไปแล้ว
        with _answer_lock:
            _answer_action = "stop"
        _answer_event.set()
    else:
        raise HTTPException(
            400,
            f"ไม่รู้จัก action '{req.action}' — ตอนนี้รองรับแค่ "
            f"start/stop/retry/accept/trigger",
        )
    return {"status": "ok", "action": req.action}

@http_app.api_route("/trigger", methods=["GET", "POST"])
async def trigger():
    if not is_running:
        return {"ok": False, "reason": "ไม่มี session กำลังวัดอยู่ — กด Start ที่หน้าเว็บก่อน"}
    if not _waiting_for_trigger:
        return {"ok": False,
                "reason": "ยังไม่ถึงช่วงรอสัญญาณ — รอข้อความ 'รอสัญญาณ trigger ...' ก่อนแล้วยิงใหม่"}
    _trigger.set()
    log.info("⚡ ได้รับสัญญาณ trigger")
    return {"ok": True}

def heartbeat_loop():
    global is_running, _hb_last_ok
    while True:
        try:
            httpx.post(
                f"{BACKEND_URL}/api/heartbeat",
                json={
                    "session_id": current_session_id,
                    # 2 ตัวนี้เป็นตัวคุมปุ่ม ⚡ บนหน้าเว็บ
                    #   00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000                                                                                                                                                                                                                     → จะ "แสดงปุ่มไหม"
                    #   waiting_for_trigger → จะ "กดได้ไหม"
                    # backend เก็บไว้ใน memory แล้วแนบไปกับ /api/session/state
                    "waiting_for_trigger": _waiting_for_trigger,
                    "trigger_mode": _trigger_mode,
                },
                timeout=5,
            )
            _hb_last_ok = time.time()
        except Exception:
            pass  # backend ล่มชั่วคราวไม่เป็นไร รอบหน้าค่อยยิงใหม่
                  # (ไม่ต้องนับอะไร แค่ "ไม่อัปเดตเวลา" ก็พอ)

        # เช็คนอก try เสมอ — ต้องทำงานทุกรอบไม่ว่ารอบนี้จะยิงออกหรือไม่
        if is_running and time.time() - _hb_last_ok > HB_TIMEOUT_HINT:
            log.info(f"\n⏹ ติดต่อ Backend ไม่ได้เกิน {HB_TIMEOUT_HINT:g} วิ — หยุดวัด")
            log.info(f"   (backend น่าจะ mark session เป็น 'timeout' ไปแล้ว วัดต่อไปค่าก็ถูกทิ้ง)")
            is_running = False
        time.sleep(HB_INTERVAL)


def send_command(sock, command, timeout=SOCKET_TIMEOUT):
    """ส่ง 1 คำสั่งแล้ว `recv` ครั้งเดียว — ใช้กับ R0 / PW ที่คำตอบสั้นและมาทีเดียว

    ⚠⚠ **ต้อง `settimeout` เองทุกครั้ง ห้ามพึ่งค่าที่ติดมากับ socket** —
      `send_recv()` เปลี่ยนค่าบน socket ตัวเดียวกันแล้ว **ไม่คืนค่าเดิม** ถ้า
      ฟังก์ชันนี้ไม่ตั้งเอง มันจะรับมรดกค่าล่าสุดที่ใครก็ไม่รู้ตั้งทิ้งไว้

      เคยพังมาแล้วจริง (8 ก.ย. 2569): การวน `GM` ใช้ `timeout=2.0` พอจบลูป
      ค่านั้นค้างบน socket · ชิ้นแรกของกลุ่มที่ 2 ยิง `PW` แล้ว TM-X ตอบใน
      2.7 วิ (ต้องโหลดโปรแกรมจากการ์ด SD ก่อน) แต่ timeout เหลือ 2.0 →
      `TimeoutError` → session พังทั้งรอบ · `PW` ตัวแรกรอดเพราะตอนนั้น
      `send_recv` ยังไม่เคยรัน ค่ายังเป็น 5.0 ที่ตั้งไว้ตอน connect

    ⚠ `recv` ครั้งเดียวไม่ได้วนหา CR แบบ `send_recv` — ถ้าคำตอบยาวจนมาไม่ครบ
      ในทีเดียวจะได้มาครึ่งเดียวแล้วพาร์สเพี้ยนเงียบ ๆ · ใช้ได้เพราะ R0/PW
      ตอบสั้นมาก (2 ตัวอักษร) ถ้าจะเอามาใช้กับคำสั่งที่คืนค่ายาวให้ย้ายไปใช้
      `send_recv()` แทน
    """
    sock.settimeout(timeout)
    cmd_to_send = command + "\r"  # ต้องต่อท้ายด้วยตัวคั่น CR (\r) เสมอ
    sock.sendall(cmd_to_send.encode("ascii"))
    time.sleep(0.1)  # หน่วงเวลาให้กล้องประมวลผลเล็กน้อย
    response = sock.recv(BUFFER_SIZE).decode("ascii").strip()
    return response

def get_measured_count(session_id):
    try:
        data = httpx.get(f"{BACKEND_URL}/api/session/state", timeout=5).json()
    except Exception as exc:
        log.info(f"   ⚠️ อ่าน session state ไม่ได้: {exc}")
        return None
    if data.get("session_id") != session_id:
        return None
    return data.get("measured_count")

# ══════════════════════════════════════════════════════════════════════════
# รอสัญญาณ "ชิ้นงานเข้าที่แล้ว" — 2 ทาง เลือกด้วย _trigger_mode
# ══════════════════════════════════════════════════════════════════════════
# ทั้งคู่มีสัญญาเดียวกัน: คืน True = มีสัญญาณ · False = โดน Stop ระหว่างรอ
# ผู้เรียก (`command_flow`) จึงไม่ต้องรู้ว่ามาจากทางไหน

def wait_for_trigger_serial(session_id,piece,target_count):
    """โหมด auto — รอ `<TRIGGER_TMX>` จาก MCU ผ่าน Serial"""
    log.info("   ⏳ รอสัญญาณจาก MCU ... (กด Stop เพื่อยกเลิก)")
    while is_running:
        if queue_review.interrupt_wait():
            return False
        try:
            if mega_ser.in_waiting > 0:
                line = mega_ser.readline().decode("utf-8").strip()
                if line == "<TRIGGER_TMX>":
                    log.info("   📥 [RX ← Mega] ได้รับคำสั่ง <TRIGGER_TMX> แล้ว")
                    return True
        except UnicodeDecodeError:
            # ข้อมูลที่อ่านได้ไม่ใช่ UTF-8 ไม่ได้แปลว่าพอร์ตหลุด
            pass
        except Exception as exc:
            log.error("อ่านสัญญาณจาก Mega ไม่สำเร็จ (%s): %s", type(exc).__name__, exc)
            _drop_mega("รอสัญญาณ trigger")
            while is_running:
                if ask_for_mcu_connection(session_id,piece,target_count) != "retry":
                    return False
                if not is_running:
                    return False
                if open_mega():
                    break  # ออกจากลูปเชื่อมต่อ แล้วกลับไปรอ trigger ในลูปหลัก
        time.sleep(0.05)
    return False           # ออกจาก loop เพราะโดน Stop จาก Backend และ return False


def wait_for_trigger_web():
    """โหมด manual — รอปุ่ม ⚡ บนหน้าเว็บ (หรือ curl /trigger)"""
    global _waiting_for_trigger
    log.info("   ⏳ รอปุ่ม ⚡ Trigger บนหน้าเว็บ ... (กด Stop เพื่อยกเลิก)")
    _trigger.clear()
    _waiting_for_trigger = True
    # บอก Backend ทันทีว่าพร้อมรับ trigger — ไม่ต้องรอ heartbeat รอบถัดไป
    #
    # ⚠ timeout สั้นมากโดยตั้งใจ เพราะบรรทัดนี้อยู่ใน **เธรดที่กำลังวัดงาน**
    #   ถ้า Backend ช้าหรือค้าง Pi จะหยุดรอตรงนี้ก่อนเข้าลูปรอสัญญาณ ทำให้เกิด
    #   อาการ "กดปุ่มแล้วเครื่องไม่ขยับ" ซึ่งหาสาเหตุยากมาก
    #   ส่งไม่ทันก็ไม่เป็นไร — heartbeat รอบปกติจะตามมาใน HB_INTERVAL วิอยู่แล้ว
    try:
        httpx.post(f"{BACKEND_URL}/api/heartbeat",
            json={"session_id": current_session_id,
                  "waiting_for_trigger": _waiting_for_trigger,
                  "trigger_mode": _trigger_mode},
            timeout=0.5)
    except Exception:
        pass
    try:
        while is_running:
            if queue_review.interrupt_wait():
                return False
            if _trigger.wait(0.1):
                return True
        return False
    finally:
        _waiting_for_trigger = False
        # บอก Backend ทันทีว่าไม่รอแล้ว → ปุ่มดับเลย
        try:
            httpx.post(f"{BACKEND_URL}/api/heartbeat",
                json={"session_id": current_session_id,
                      "waiting_for_trigger": _waiting_for_trigger,
                      "trigger_mode": _trigger_mode},
                timeout=5)
        except Exception:
            pass


def wait_for_trigger(session_id,piece,target_count):
    """แยกทางตามโหมดของ session นี้ — ตัวเรียกไม่ต้องรู้ว่ามาจากไหน"""
    if _trigger_mode == "auto":
        print("Auto")
        return wait_for_trigger_serial(session_id,piece,target_count)
    return wait_for_trigger_web()

def send_recv(sock, command, timeout=SOCKET_TIMEOUT):
    """ส่ง 1 คำสั่ง แล้ว **วน recv จนเจอ CR** — คืน (response, ok)
    """
    sock.settimeout(timeout)
    deadline = time.time() + timeout
    sock.sendall((command + "\r").encode("ascii"))

    buf = b""
    while b"\r" not in buf:
        remain = deadline - time.time()
        if remain <= 0:
            return "<timeout>", False
        sock.settimeout(remain)
        try:
            chunk = sock.recv(BUFFER_SIZE)
        except socket.timeout:
            return "<timeout>", False
        if not chunk:                       # อีกฝั่งปิด connection
            return "<closed>", False
        buf += chunk

    resp = buf.decode("ascii", "replace").strip()
    return resp, not resp.upper().startswith("ER")


def parse_gm(resp):
    """แยก `GM,t,m,i,j,…` เป็น [(m, i, j), ...] — คืน None ถ้ารูปแบบไม่ตรง

        m = ค่าที่วัดได้
        i = สถานะ  0:ไม่ทำงาน 1:ค่าปกติ 2:แก้ตำแหน่งล้มเหลว 3:ข้อมูลไม่ถูกต้อง 4:รอตัดสิน
        j = ผลตัดสินของ TM-X เอง  0:OK  1:NG

    ไม่ยึดว่าต้องมีกี่เครื่องมือ — `t=0` แปลว่า "ทุกเครื่องมือ" TM-X บอกจำนวนจริงกลับมา
    """
    parts = [p.strip() for p in resp.split(",")]
    if len(parts) < 2 or parts[0].upper() != "GM":
        return None
    try:
        count = int(parts[1])
    except ValueError:
        return None
    body = parts[2:]
    if count == 0:
        count = len(body) // 3
    if count == 0 or len(body) < count * 3:
        return None

    def _int(s):
        try:    return int(s)
        except (ValueError, TypeError): return None

    tools = []
    for k in range(count):
        m_s, i_s, j_s = body[k * 3:k * 3 + 3]
        try:    m = float(m_s)
        except ValueError: m = None
        tools.append((m, _int(i_s), _int(j_s)))
    return tools


def has_real_value(tools):
    """ค่าครบ 8 ตัวและใช้ได้จริงทุกตัวหรือยัง"""
    return sum(1 for m, i, _ in tools or [] if m is not None and abs(m) < NO_VALUE_ABS and i == 1) >= 8


def clear_measurement(sock):
    """ล้างค่าเก่าใน TM-X ด้วย MRS — **ขั้นที่สำคัญที่สุดของทั้ง flow**

    GM ดึง "ค่าของภาพล่าสุด" และ **ไม่มีเลขลำดับกำกับ** จึงมองไม่ออกว่าค่าที่ได้
    เป็นของชิ้นที่เพิ่งวัดหรือของชิ้นก่อน ถ้า T1 รอบนี้วัดไม่ติด GM จะคืนค่าของ
    ชิ้นก่อนมาให้เฉยๆ ไม่มี error ไม่มีอะไรเตือน แล้วเราจะตัดสินชิ้นใหม่ด้วย
    ตัวเลขของชิ้นเก่า **แล้วสั่ง MCU ขยับของจริงตามนั้น**

    ข้อมูลหน้างาน 31/07: TM-X วัดไม่ติด 7 ครั้งจาก 8 — ไม่ใช่กรณีหายาก

    ⚠ คู่มือหน้า 5-9 พิมพ์ชื่อคำสั่งไม่ตรงกันเอง หัวข้อเขียน `MRS` แต่ช่องส่ง/รับ
      เขียน `MSR` จึงลองทีละตัวแล้วจำตัวที่ใช้ได้ไว้ (ไม่ต้องลองซ้ำทุกชิ้น)
    """
    global _clear_cmd
    if _clear_cmd is False:
        return False
    if _clear_cmd is not None:
        _, ok = send_recv(sock, _clear_cmd)
        return ok

    for cand in CLEAR_CANDIDATES:
        resp, ok = send_recv(sock, cand)
        if ok:
            _clear_cmd = cand
            log.info(f"   ℹ️ ใช้คำสั่งล้างค่า `{cand}` ได้ (จะใช้ตัวนี้ตลอดทั้ง session)")
            return True
    _clear_cmd = False
    log.info("   ⚠️ TM-X ไม่รู้จักทั้ง MRS และ MSR — GM อาจคืนค่าของชิ้นก่อนหน้า!")
    return False


def trigger_tmx(sock):
    """ล้างค่าเก่า → ยิง T1 สั่ง TM-X วัด 1 ครั้ง — คืน (ok, resp)

    **ส่งผ่าน sock หลัก ไม่เปิด connection ใหม่** — TM-X ให้มีอุปกรณ์ควบคุมได้
    ทีละตัวเดียว พอเปิดสายที่สองมันตัดสายแรกทิ้ง แล้ว GM ที่ต้องถามตามมาทันที
    จะยิงลงสายที่ตายไปแล้ว

    `ER,...,03` = READY ยังไม่กลับมาหลัง RESET ที่พ่วงมากับ PW — **ยิงซ้ำได้
    อย่างปลอดภัย** เพราะรหัส 03 แปลว่าทริกเกอร์ถูก *ละเว้น* ไม่ได้วัดเลย
    จึงไม่มีทางได้ measurement ซ้ำสองอัน
    """
    clear_measurement(sock)          # MRS ก่อนเสมอ ห้ามลืม
    for attempt in range(1, T1_RETRY + 1):
        resp, ok = send_recv(sock, "T1")
        log.info(resp)
        if ok:  
            log.info(f"📡 TM-X ตอบ T1: {resp}")
            log.info(f"ส่ง T1 สำเร็จหลังลอง {T1_RETRY} ครั้ง  {resp}")
            return True, resp
        if ",03" in resp:
            log.info(f"   ⏳ T1 โดนละเว้น ({resp}) — READY ยังไม่กลับมา "
                  f"ลองใหม่ครั้งที่ {attempt}/{T1_RETRY}")
            time.sleep(T1_RETRY_WAIT)
            continue
        log.info(f"❌ ส่ง T1 ไม่สำเร็จ: {resp}")
        return False, resp

    log.info(f"❌ ส่ง T1 ไม่สำเร็จหลังลอง {T1_RETRY} ครั้ง")
    return False, f"{resp} (ลองครบ {T1_RETRY} ครั้ง)"

def _f3(v):
    """จัดรูปตัวเลขเป็น 3 ตำแหน่งสำหรับ **แสดงผลเท่านั้น** — `None` คืน `"—"`

    ⚠ ห้ามเอาไปใช้ในเงื่อนไขเทียบค่า — ทั้งระบบตัดสิน OK/NG ที่ 3 ตำแหน่ง
      (`_DP = 3` ใน `shared.py`) แต่การเทียบต้องเทียบ float ตรง ๆ ตามที่
      docstring ของ `judge()` อธิบายไว้ ไม่ใช่เทียบสตริงที่ปัดมาแล้ว
    """
    return "—" if v is None else f"{v:.3f}"


def judge(x, y, offset_x, offset_y, limits):

    reasons = []
    if x is None:
        reasons.append("อ่านค่า Xไม่ได้ (ค่าเป็น None)")
    elif not (limits.x_lo <= x <= limits.x_hi):
        reasons.append(f"ค่า X ({x:.3f}) นอกช่วงเกณฑ์ ({limits.x_lo:.3f}–{limits.x_hi:.3f})")
    if y is None:
        reasons.append("อ่านค่า Y ไม่ได้ (ค่าเป็น None)")
    elif not (limits.y_lo <= y <= limits.y_hi):
        reasons.append(f"ค่า Y ({y:.3f}) นอกช่วงเกณฑ์ ({limits.y_lo:.3f}–{limits.y_hi:.3f})")
    if limits.offset_max is not None:
        if offset_x is None or abs(offset_x) > limits.offset_max:
            reasons.append(f"offset_x {_f3(offset_x)} เกิน {_f3(limits.offset_max)}")
        if offset_y is None or abs(offset_y) > limits.offset_max:
            reasons.append(f"offset_y {_f3(offset_y)} เกิน {_f3(limits.offset_max)}")
    return ("NG" if reasons else "OK"), reasons

def clean_tools(tools, package_size):
    """จัด GM เป็น X, Y, ค่าอื่น 4 ตัว, Offset X, Offset Y โดยไม่ใช้ค่าซ้ำ"""
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*",
                         str(package_size or ""), re.IGNORECASE)
    if not match:
        raise ValueError(f"Package Size ไม่อยู่ในรูปแบบ กว้างxสูง: {package_size!r}")
    nominal_x, nominal_y = map(float, match.groups())
    candidates = [(index, item) for index, item in enumerate(tools or [])
                  if item[0] is not None and math.isfinite(item[0])
                  and abs(item[0]) < NO_VALUE_ABS and item[1] == 1]
    if len(candidates) < 8:
        return []

    # เลือกคู่ X/Y ที่มีความคลาดเคลื่อนรวมจาก Package Size น้อยสุด
    # โดยบังคับให้เป็นคนละ Tool แม้ขนาดสองแกนจะเท่ากัน เช่น 4x4
    x_index, y_index = min(
        ((x[0], y[0]) for x in candidates for y in candidates if x[0] != y[0]),
        key=lambda pair: (abs(tools[pair[0]][0] - nominal_x)
                          + abs(tools[pair[1]][0] - nominal_y), pair),
    )
    remaining = [(index, item) for index, item in candidates
                 if index not in (x_index, y_index)]
    offset_indices = [index for index, _ in sorted(
        remaining, key=lambda entry: (abs(entry[1][0]), entry[0]))[:2]]
    middle = [item for index, item in remaining if index not in offset_indices][:4]
    log.info("GM จัดค่าจาก Package Size %s: X=#%s Y=#%s Offset X=#%s Offset Y=#%s",
             package_size, x_index + 1, y_index + 1,
             offset_indices[0] + 1, offset_indices[1] + 1)
    values = [tools[x_index], tools[y_index], *middle,
              tools[offset_indices[0]], tools[offset_indices[1]]]
    positions = [GM_IDX_X, GM_IDX_Y, GM_IDX_HORIZON_LEFT, GM_IDX_HORIZON_RIGHT,
                 GM_IDX_VERTICAL_TOP, GM_IDX_VERTICAL_BOTTOM,
                 GM_IDX_OFFSET_X, GM_IDX_OFFSET_Y]
    tools_new = [None] * (max((index for index in positions if index is not None), default=-1) + 1)
    for index, item in zip(positions, values):
        if index is not None:
            tools_new[index] = item
    return tools_new

            # ── ดึงค่าออกมาตาม index ที่ตั้งไว้ ────────────────────────────
def _val(idx,tools):
    if idx is None or idx >= len(tools):
        return None
    return None if tools[idx] is None else tools[idx][0]
            

def get_measurement_tmx(sock, limits, package_size, timeout=GM_MAX_WAIT):
    """วน GM จนได้ค่าใหม่ → ตัดสิน OK/NG → พิมพ์ผล

    คืน `(result, x, y, offset)` โดย result เป็น "OK" / "NG" / "UNKNOWN"

    **ทำไมต้องวน**: `T1` ตอบกลับตอน *รับทริกเกอร์* ไม่ใช่ตอนวัดเสร็จ (คู่มือหน้า
    5-4: "เวลาในการประมวลผลการวัดจะไม่ได้รับผลกระทบ") ยิง GM ตามติดจึงยังไม่มีค่า
    ให้ดึง ต้องถามซ้ำทุก ~20 ms จนกว่าจะได้ค่าที่ไม่ใช่ 9999.999

    **"UNKNOWN" เป็นสถานะที่สามที่ต้องมี** ไม่ใช่แค่ OK กับ NG — ครบเวลาแล้วยังไม่
    ได้ค่าแปลว่า TM-X วัดชิ้นนี้ไม่ติดจริง ต้องบอก MCU ว่า "ไม่รู้ผล" แล้วให้มัน
    ตัดสินใจเอง **ห้ามเดาเป็น NG** เพราะของอาจดีอยู่ แค่กล้องไม่เห็น
    """
    deadline = time.time() + timeout
    polls = 0
    t0 = time.time()

    while time.time() < deadline:
        if not is_running:                       # กด Stop ระหว่างรอ
            return "UNKNOWN", None, None, None, None, None, None, None, None

        resp, ok = send_recv(sock, "GM,3,0", timeout=2.0)
        polls += 1
        tools = parse_gm(resp) if ok else None
        log.info(tools)
        if tools and has_real_value(tools):
            tools_new = clean_tools(tools, package_size)
            log.info(tools_new)
        
            x, y, horizon_left, horizon_right, vertical_top, vertical_bottom, offset_x, offset_y = (
            _val(GM_IDX_X,tools_new),
            _val(GM_IDX_Y,tools_new),
            _val(GM_IDX_HORIZON_LEFT,tools_new),
            _val(GM_IDX_HORIZON_RIGHT,tools_new),
            _val(GM_IDX_VERTICAL_TOP,tools_new),
            _val(GM_IDX_VERTICAL_BOTTOM,tools_new),
            _val(GM_IDX_OFFSET_X,tools_new), 
            _val(GM_IDX_OFFSET_Y,tools_new)
             )
            result, reasons = judge(x, y, offset_x, offset_y, limits)

            log.info("   📥 ได้ค่าหลัง %.0f ms (ถาม GM %s ครั้ง · TM-X คืนมา %s เครื่องมือ)",
                     (time.time() - t0) * 1000, polls, len(tools))
            log.info("      X=%s · Y=%s · offset_x=%s · offset_y=%s",
                     _f3(x), _f3(y), _f3(offset_x), _f3(offset_y))
            log.info("   %s ผลตัดสิน: %s", "✅" if result == "OK" else "❌", result)
            for r in reasons:
                log.info("      • %s", r)

            # เทียบกับผลที่ TM-X ตัดสินมาเอง (j) — ได้ตัวเฝ้าระวัง config drift ฟรีๆ
            return result, x, y, horizon_left, horizon_right,vertical_top, vertical_bottom,offset_x, offset_y
        time.sleep(GM_POLL_INTERVAL)

    log.info("   ⚠️ รอ %.0f วิแล้ว GM ยังไม่คืนค่าใหม่ (ถาม %s ครั้ง) "
             "— TM-X วัดชิ้นนี้ไม่ติด", timeout, polls)
    return "UNKNOWN", None, None, None, None, None, None, None, None

#วนไปถามว่าพร้อมรับ result ยัง ให้ MCU set Flag เอา idle(ยังไม่มีชิ้นงาน) -> obj_is_ready(เมื่อวางชิ้นงานแล้ว) -> waiting_for_result(พร้อมรับ result) -> idle(เสร็จการวัด 1 ชิ้น)
def send_result_to_mcu(result,session_id,piece,target_count) -> bool:
    # ⚠ ต้องมี `global` — ข้างล่างมีการเขียน `mega_ser = None` ถ้าไม่ประกาศ
    #   Python จะถือว่าเป็นตัวแปรท้องถิ่นของฟังก์ชันนี้ โค้ดรันผ่านไม่มี error
    #   แต่ตัวแปรระดับโมดูลไม่ถูกแตะเลย = พฤติกรรมเหมือนไม่ได้แก้อะไร
    global mega_ser

    icon = {"OK": "✅", "NG": "❌", "UNKNOWN": "❓"}.get(result, "•")
    if _trigger_mode != "auto":
        log.info("   🔀 (manual) ไม่ได้ส่งผลให้ MCU: %s %s", icon, result)
        return True
    # กำหนด Token ที่จะส่งกลับหา Mega ตามผลลัพธ์
    if result == "OK":
        ack_msg = "<MEASURE_OK>\n"
    elif result == "NG":
        ack_msg = "<MEASURE_NG>\n"
    while is_running:
        try: 
            mega_ser.write(ack_msg.encode("utf-8"))
            log.info(f"   [TX → Mega] {ack_msg.strip()}")
            log.info("   🔀 → MCU: %s %s", icon, result)
            return True
        except Exception as exc:
            log.error("   ❌ ส่ง Result ให้ Mega ไม่สำเร็จ (%s): %s", type(exc).__name__, exc)
            report("MCU_WRITE_FAILED",
               f"ส่งผลการวัดให้ MCU ไม่สำเร็จ ({type(exc).__name__}) "
               f"— ตรวจสาย USB ของ Arduino แล้วกด Start ใหม่", show_toast=False)
            _drop_mega("ส่งผลการวัด")
            while is_running:
                if ask_for_mcu_connection(session_id,piece,target_count) != "retry":
                    return False
                if open_mega():
                    break  # กลับไปส่ง PKG ซ้ำ โดยยังจับข้อผิดพลาดได้
    return False

def send_package_size_to_mcu(package_size, number_alpl, handler, session_id, piece, target_count) -> bool:
    global mega_ser              # ⚠ เหตุผลเดียวกับ send_result_to_mcu ข้างบน

    if _trigger_mode != "auto":
        log.info("   🔀 (manual) ไม่ได้บอกขนาดชิ้นงานให้ MCU: %s", package_size)
        return True
    while is_running:
        try:
            ack_msg = f"<PKG:{package_size}:{number_alpl}:{handler}>\n"
            mega_ser.write(ack_msg.encode("utf-8"))
            log.info(f"   [TX → Mega] {ack_msg.strip()}")
            return True
        except Exception as exc:
            log.error("   ❌ ส่ง Package Size ให้ Mega ไม่สำเร็จ (%s): %s", type(exc).__name__, exc)
            report("MCU_WRITE_FAILED",
               f"ส่งค่า Package Size ให้ MCU ไม่สำเร็จ ({type(exc).__name__}) "
               f"— ตรวจสาย USB ของ Arduino แล้วกด Start ใหม่", show_toast=False)
            _drop_mega("ส่งขนาดชิ้นงาน")
            while is_running:
                if ask_for_mcu_connection(session_id,piece,target_count) != "retry":
                    return False
                if open_mega():
                    break  # กลับไปส่ง PKG ซ้ำ โดยยังจับข้อผิดพลาดได้
    return False

def send_measure_error_to_mcu( session_id,piece,target_count):
    global mega_ser              # ⚠ เหตุผลเดียวกับ send_result_to_mcu ข้างบน
    if _trigger_mode != "auto":
        log.info("   🔀 (manual) ไม่้องบอก Error ให้ MCU")
        return True
    while is_running:
        try:
            ack_msg = f"<MEASURE_ERROR>\n"
            mega_ser.write(ack_msg.encode("utf-8"))
            log.info(f"   [TX → Mega] {ack_msg.strip()}")
            return True
        except Exception as exc:
            log.error("   ❌ ส่ง MEASURE_ERROR ให้ Mega ไม่สำเร็จ (%s): %s", type(exc).__name__, exc)
            report("MCU_WRITE_FAILED",
               f"ส่งค่า MEASURE ให้ MCU ไม่สำเร็จ ({type(exc).__name__}) "
               f"— ตรวจสาย USB ของ Arduino แล้วกด Start ใหม่", show_toast=False)
            _drop_mega("ส่งขนาดชิ้นงาน")
            while is_running:
                if ask_for_mcu_connection(session_id,piece,target_count) != "retry":
                    return False
                if open_mega():
                    break  # กลับไปส่ง PKG ซ้ำ โดยยังจับข้อผิดพลาดได้
    return False


def wait_for_measurement(session_id, count_before, timeout=MEASURE_TIMEOUT):

    deadline = time.time() + timeout
    while time.time() < deadline:
        if not is_running: #ถ้า Stop
            return True
        if queue_review.capture_id:
            try:
                if queue_review.saved():
                    return True
            except Exception:
                pass
            time.sleep(MEASURE_POLL_INTERVAL)
            continue
        count_after = get_measured_count(session_id) 
        if count_after is not None and count_before is not None and count_after > count_before:
            return True
        time.sleep(MEASURE_POLL_INTERVAL)
    return False


def report(event: str, detail: str, *, persist: bool = True, show_toast: bool = True, type: str = "error"):
    """รายงานเหตุการณ์ โดยเลือกบันทึก last_event และแสดง toast แยกกันได้"""
    log.info("   📣 %s: %s", event, detail)
    try:
        resp = httpx.post(
            f"{BACKEND_URL}/api/session/event",
            json={"event": event, "detail": detail, "persist": persist, "show_toast": show_toast, "type": type},
            timeout=2,
        )
        if resp.status_code != 200:
            log.info("   ⚠️ Backend ไม่รับรายงาน (HTTP %s)", resp.status_code)
    except Exception as exc:
        log.info("   ⚠️ แจ้ง Backend ไม่สำเร็จ: %s", exc)

def ask_user(session_id, piece, target) -> str:
    global _answer_action
    with _answer_lock:
        _answer_action = None
        _answer_event.clear()

    try:
        resp = httpx.post(
            f"{BACKEND_URL}/api/measure-timeout",
            json={"session_id": session_id, "piece": piece, "target": target},
            timeout=5,
        )
        if resp.status_code != 200:
            log.info("   ⚠️ Backend ไม่รับคำถาม (HTTP %s) — ถือว่าหยุด", resp.status_code)
            return "stop"
    except Exception as exc:
        log.info("   ⚠️ ถามผู้ใช้ไม่ได้: %s — ถือว่าหยุด", exc)
        return "stop"

    log.info("   ⏳ รอผู้ใช้ตัดสินใจ (สูงสุด %.0f วิ) ...", ASK_USER_TIMEOUT)
    if not _answer_event.wait(ASK_USER_TIMEOUT):
        log.info("   ⏱ ไม่มีคำตอบใน %.0f วิ — ถือว่าหยุด", ASK_USER_TIMEOUT)
        return "stop"

    with _answer_lock:
        return _answer_action or "stop"


def ask_tray_clear(session_id, piece, target) -> str:
    """ถาดเต็ม — บอกผู้ใช้ให้มาเคลียร์ แล้วรอจนกว่าจะกด "วัดต่อ"

    คืน `"resume"` เมื่อผู้ใช้กดวัดต่อ · อย่างอื่นทั้งหมดถือว่าหยุด

    ⚠ **ไม่มี timeout โดยตั้งใจ** ต่างจาก `ask_user` ที่รอแค่ ASK_USER_TIMEOUT
      แล้วถือว่า stop — เคลียร์ถาดเป็นงานมือที่ใช้เวลาไม่แน่นอน (เดินไปหยิบถาด
      ใหม่ ยกของออก นับชิ้น อาจติดงานอื่นกลางทาง) ตั้งเพดานเวลาเมื่อไหร่ก็จะมี
      วันที่ session ตายกลางคันเพราะคนเดินช้าไป 10 วิ แล้วของที่วัดไปแล้วทั้งถาด
      ต้องมาเริ่มใหม่ · `ask_user` ต่างออกไปเพราะมันคือการวัดที่พังไปแล้ว
      ปล่อยค้างไม่ได้

    ⚠ ห้ามใช้ `_answer_event.wait()` แบบไม่มีพารามิเตอร์ — จะบล็อกจนกว่าจะมีคน
      ตอบเท่านั้น กด Stop บนหน้าเว็บแล้วเธรดนี้จะไม่มีวันตื่น จึงตื่นทุก 1 วิ
      มาเช็ค `is_running` ด้วย (Stop จาก backend เซ็ต flag นี้เป็น False)
    """
    global _answer_action
    with _answer_lock:
        _answer_action = None
        _answer_event.clear()

    try:
        resp = httpx.post(
            f"{BACKEND_URL}/api/tray-full",
            json={"session_id": session_id, "piece": piece, "target": target,
                  "capacity": TRAY_CAPACITY},
            timeout=5,
        )
        if resp.status_code != 200:
            log.info("   ⚠️ Backend ไม่รับคำถาม (HTTP %s) — ถือว่าหยุด", resp.status_code)
            return "stop"
    except Exception as exc:
        log.info("   ⚠️ ถามผู้ใช้ไม่ได้: %s — ถือว่าหยุด", exc)
        return "stop"

    log.info("   🧺 ถาดเต็มแล้ว (%s ชิ้น) — รอผู้ใช้เคลียร์ถาดแล้วกด 'วัดต่อ' "
             "(ไม่มีกำหนดเวลา)", TRAY_CAPACITY)
    while is_running:
        if _answer_event.wait(1.0):
            with _answer_lock:
                return _answer_action or "stop"
    log.info("   ⏹ ได้รับคำสั่ง Stop ระหว่างรอเคลียร์ถาด")
    return "stop"


def ask_for_mcu_connection(session_id: int, piece: int | None = None, target: int | None = None) -> str:
    """รอคำตอบเมื่อ MCU หลุด; ไม่จำเป็นต้องระบุชิ้นงาน แต่ต้องมี session_id"""
    if session_id is None:
        raise ValueError("session_id must not be None")
    global _answer_action
    with _answer_lock:
        _answer_action = None
        _answer_event.clear()

    payload = {"session_id": session_id}
    if piece is not None:
        payload["piece"] = piece
    if target is not None:
        payload["target"] = target
    try:
        resp = httpx.post(
            f"{BACKEND_URL}/api/mcu-disconnected",
            json=payload,
            timeout=5,
        )
        if resp.status_code != 200:
            log.info("   ⚠️ Backend ไม่รับคำถาม (HTTP %s) — ถือว่าหยุด", resp.status_code)
            return "stop"
    except Exception as exc:
        log.info("   ⚠️ ถามผู้ใช้ไม่ได้: %s — ถือว่าหยุด", exc)
        return "stop"

    log.info(" MCU Disconected — รอผู้ใช้กด 'เชื่อมต่อ ")
    while is_running:
        if _answer_event.wait(1.0):
            with _answer_lock:
                return _answer_action or "stop"
    log.info("   ⏹ ได้รับคำสั่ง Stop ระหว่างรอดารเชื่อมต่อจาก MCU")
    return "stop"

def handle_error(kind, session_id, piece, target_count,detail) -> bool:
    report(f"{kind}_FAILED",
           f"ชิ้นที่ {piece}/{target_count} ({detail})", show_toast=False)
    if not is_running:          # กด Stop จากเว็บระหว่างนี้
        return False
    if ask_user(session_id, piece, target_count) == "retry":
        # GM Retry ต้องให้ Mega กลับไปรอ Trigger; T1 Retry ใช้ Trigger เดิม
        if kind == "GM":
            if not send_measure_error_to_mcu(session_id,piece,target_count):
                return False
            try:
                queue_review.cancel_capture()
            except httpx.HTTPError as exc:
                report("CAPTURE_CANCEL_FAILED",
                       f"ชิ้นที่ {piece}/{target_count}: ยกเลิกรอบ GM ที่ล้มเหลวไม่สำเร็จ ({exc})",
                       show_toast=False)
                return False
        return True
    return False

def post_measurement_from_pi(session_id, piece, x, y, horizon_left, horizon_right, vertical_top, vertical_bottom,
                             offset_x, offset_y) -> bool:
    """POST ค่าที่ Pi อ่านจาก GM เข้า Backend แทน Recieve — คืน True ถ้าสำเร็จ

    ใช้เฉพาะตอน `wait_for_measurement` หมดเวลา = **วัดสำเร็จแล้วแต่ค่าไม่ถึง DB**
    (ชิ้นงานถูก MCU คัดแยกไปแล้ว ไม่มีอะไรให้วัดใหม่) สิ่งที่ขาดคือแถวใน DB
    ไม่ใช่การวัด — จึงเป็น "บันทึกค่าที่มี" ไม่ใช่ "retry"

    ⚠ ไม่มีการกันยิงซ้ำแล้ว — `client_uuid` ถูกถอดออกทั้งระบบ เพราะฟังก์ชันนี้
      ยิงครั้งเดียวจบ (พลาดแล้วตั้ง stop_reason แล้ว break ไม่มี retry loop)
      ถ้าวันหลังใส่ retry เข้ามา ต้องกลับมาคิดเรื่องกันซ้ำใหม่ด้วย

    ⚠ ต้อง PATCH image ต่อด้วย `upload_failed=True` — ไม่งั้น `image_path = NULL`
      จะแปลว่า "รูปยังไม่มา" ซึ่งปกติหมายถึงกำลังจะมาในไม่กี่วินาที แต่เคสนี้
      **ไม่มีวันมา** คนเปิดรายงานจะนั่งรอรูปที่ไม่มีอยู่จริง

    ไม่ส่ง `number_alpl` / `measure_type` / `operator_id` — backend เลือกเองจาก
    ตำแหน่งในคิวกับ queue_state เหมือนตอนที่ Recieve ส่ง (แหล่งความจริงเดียว)
    """
    body = {
        "session_id":  session_id,
        "capture_id": queue_review.capture_id,
        "value_x":     x,
        "value_y":     y,
        "horizon_left":       horizon_left,
        "horizon_right":       horizon_right,
        "vertical_top":       vertical_top,
        "vertical_bottom":       vertical_bottom,
        "offset_opx":  offset_x,
        "offset_opy":  offset_y,
        "note":        "ค่าจาก Pi (GM) — Recieve ส่งไม่ถึง ไม่มีรูป",
    }
    try:
        resp = httpx.post(f"{BACKEND_URL}/api/measurements", json=body, timeout=10)
    except Exception as exc:
        report("PI_POST_FAILED", f"ชิ้นที่ {piece}: ระบบรับค่าจาก Pi ไม่สำเร็จ จะทำการหยุดการวัด — {exc}")
        return False

    if resp.status_code != 200:
        detail = ""
        try:
            detail = resp.json().get("detail", "")
        except Exception:
            detail = resp.text[:200]
        report("PI_POST_FAILED",
               f"ชิ้นที่ {piece}: backend ปฏิเสธค่าจาก Pi จะทำการหยุดการวัด (HTTP {resp.status_code}): {detail}")
        return False

    mid = resp.json().get("measurement_id")
    log.info("   ✅ บันทึกค่าจาก Pi แล้ว (measurement_id=%s)", mid)

    try:
        httpx.patch(f"{BACKEND_URL}/api/measurements/{mid}/image",
                    json={"image_path": None, "upload_failed": True},
                    params={"capture_id": queue_review.capture_id}, timeout=5)
    except Exception as exc:
        pass
    return True

def pi_values_problem(x, y, hl, hr, vt, vb, ox, oy):
    """ค่าที่ Pi ถืออยู่ใช้ได้จริงไหม — คืนข้อความอธิบายปัญหา หรือ None ถ้าปกติ

    ⚠ ต้องเช็คแยกจาก `has_real_value()` ที่ใช้ตอนวน GM — ตัวนั้นใช้ `any()`
      แปลว่า "มีอย่างน้อย 1 เครื่องมือที่วัดติด" การวัดที่สำเร็จบางส่วนจึงผ่าน
      มาได้ แล้ว sentinel 9999.999 / None ติดมากับช่องที่วัดไม่ติด
    """
    names = ["X", "Y", "Horizon L", "Horizon R",
             "Vertical T", "Vertical B", "Offset X", "Offset Y"]
    bad = [n for n, v in zip(names, (x, y, hl, hr, vt, vb, ox, oy))
           if v is None or abs(v) >= NO_VALUE_ABS]
    return "ค่าไม่สมบูรณ์: " + ", ".join(bad) if bad else None

def command_flow(session_id, groups, target_count, trigger_mode="auto"):

    global current_session_id, is_running,_hb_last_ok, _trigger_mode
    _hb_last_ok = time.time()
    current_session_id = session_id  # heartbeat จะเริ่มแนบ session นี้ทันที
    # ⚠ ตั้ง **ก่อน** is_running = True — heartbeat_loop อ่านตัวนี้จากอีกเธรด
    #   ถ้าตั้งทีหลัง heartbeat รอบแรกของ session จะส่งโหมดของรอบก่อนไป
    #   แล้วปุ่มบนหน้าเว็บจะโผล่/ไม่โผล่ผิดอยู่ 1 จังหวะ
    _trigger_mode = trigger_mode
    is_running = True
    client_socket = None
    stop_reason = None

    try:
        log.info(f"\n{'='*60}")
        log.info(f"✅ ได้รับคำสั่ง Start จาก Backend")
        log.info(f"   session_id    : {session_id}")
        # ⚠ ต้อง log ทุกรอบ — payload รุ่นเก่าที่ไม่ส่ง trigger_mode จะได้ "auto"
        #   แล้วยืนรอ Serial เงียบ ๆ ทั้งที่ผู้ใช้กำลังหาปุ่มอยู่ บรรทัดนี้คือ
        #   สิ่งเดียวที่บอกได้ว่าทำไมเครื่องไม่ขยับ
        log.info(f"   โหมด trigger  : {trigger_mode}  "
                 f"({'รอ <TRIGGER_TMX> จาก MCU' if trigger_mode == 'auto' else 'รอปุ่ม ⚡ บนหน้าเว็บ'})")
        log.info(f"   target_count  : {target_count}  ← จำนวนชิ้นที่จะวัดรอบนี้")
        for gi, g in enumerate(groups, 1):
            log.info(f"   กลุ่มที่ {gi}      : template={g.template_name!r} "
                  f"ALPL={g.alpl}")
            if g.limits:
                L = g.limits
                log.info(f"                   X {L.x_lo:.3f}–{L.x_hi:.3f} · "
                      f"Y {L.y_lo:.3f}–{L.y_hi:.3f} · offset_max={_f3(L.offset_max)}")
        log.info(f"{'='*60}")

        # ── ชิ้นที่ i อยู่กลุ่มไหน ──────────────────────────────────────────
        # ทำได้ด้วยบรรทัดเดียวเพราะ **คิวไม่เคยสลับกลุ่ม** — `_flatten_groups`
        # ฝั่ง backend (routers/session.py) ต่อ ALPL ของกลุ่ม 0 ให้หมดก่อน
        # แล้วค่อยกลุ่ม 1 ดังนั้นแต่ละกลุ่มเป็นบล็อกติดกันเสมอ ลำดับที่ได้ตรงกับ
        # `queue` ที่ backend ใช้เลือก ALPL ให้ measurement เป๊ะ
        #
        # ⚠ ถ้าวันหลัง backend เปลี่ยนไปเรียงคิวแบบสลับกลุ่ม บรรทัดนี้พังทันที
        #   และจะพังแบบเงียบ ๆ (วัดด้วย template ผิดโดยไม่มี error) — ต้องให้
        #   backend ส่ง `group_of` มาตรง ๆ แทนการเดาจากลำดับ
        group_of = [gi for gi, g in enumerate(groups) for _ in g.alpl]
        if len(group_of) != target_count:
            log.info("⚠️ จำนวน ALPL รวม (%s) ไม่เท่า target_count (%s) — payload เพี้ยน",
                     len(group_of), target_count)

        try:
            client_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            client_socket.settimeout(5.0)
            client_socket.connect((TMX_IP, TMX_PORT))
        except Exception as exc:
            log.info("\n❌ ต่อ TM-X ที่ %s:%s ไม่ได้ — %s: %s", TMX_IP, TMX_PORT, type(exc).__name__, exc)
            log.info("   ตรวจ: สาย LAN ต่ออยู่ไหม · TM-X เปิดอยู่ไหม · TMX_HOST/TMX_PORT ใน .env ถูกไหม")
            log.info("   → กด Stop ที่หน้าเว็บเพื่อล้าง session นี้ แล้วลองใหม่")
            msg = (f"ต่อ TM-X ที่ {TMX_IP}:{TMX_PORT} ไม่ได้ ({type(exc).__name__}) "
                   f"— ตรวจสาย LAN · TM-X เปิดอยู่ไหม · TMX_HOST/TMX_PORT ใน .env")
            report("TMX_CONNECT_FAILED", msg, persist=False)
            stop_reason = msg
            return
        
        #ส่ง Start ให้ MCU
        if trigger_mode =="auto":
            global mega_ser
            start_msg ="<START>\n"
            while is_running:
                try:
                    mega_ser.write(start_msg.encode("utf-8"))
                    log.info(f" [TX -> Mega] {start_msg.strip()}")
                    break
                except Exception as exc:
                    log.error("ส่ง Start ให้ Mega ไม่สำเร็จ (%s): %s", type(exc).__name__, exc)
                    _drop_mega("ส่ง Start")
                    while is_running:
                        # ยังไม่ได้เริ่มวัด จึงไม่แนบข้อมูลชิ้นงาน
                        if ask_for_mcu_connection(session_id) != "retry":
                            stop_reason = "หยุดระหว่างรอเชื่อมต่อ MCU ก่อนเริ่มวัด"
                            return
                        if not is_running:
                            return
                        if open_mega():
                            break  # กลับไปส่ง START อีกครั้งด้วยพอร์ตใหม่
            if not is_running:
                return


        # Running (เข้าโหมดดำเนินงาน)
        log.info("→ R0 : %s", send_command(client_socket, "R0"))
        time.sleep(0.5)

        # `PW` ย้ายเข้าไปในลูปแล้ว (ดูข้างล่าง) เพราะแต่ละกลุ่มใช้ template คนละตัวได้
        current_tmpl = None      # template ที่โหลดค้างอยู่ใน TM-X ตอนนี้

        for piece in queue_review.pieces(target_count, lambda: is_running):
            if not is_running:
                log.info("⏹ ได้รับคำสั่ง Stop — หยุดการวัด")
                break

            # ── ⓪.1 ถาดเต็มหรือยัง — หยุดรอให้คนมาเคลียร์ก่อนวัดชิ้นถัดไป ────
            #
            # เช็ค **ก่อนเริ่มชิ้นถัดไป** ไม่ใช่หลังวัดชิ้นที่ 8 เสร็จ — ผลลัพธ์
            # เหมือนกันเป๊ะแต่มีจุดแทรกเดียว ถ้าไปวางท้ายลูปต้องแทรก 3 ที่
            # (`continue` ตอนบันทึกสำเร็จ · `continue` ตอนค่ามาถึงระหว่างรอคำตอบ ·
            # ทางที่ตกลงมาถึงท้ายลูป) แล้ววันหลังใครเพิ่ม `continue` อีกเส้น
            # ถาดจะถูกข้ามไปเงียบ ๆ
            #
            # `piece > 1` กันไม่ให้ถามตั้งแต่ชิ้นแรก และการเช็คที่หัวลูปทำให้
            # **ไม่มีทางถามหลังชิ้นสุดท้าย** โดยอัตโนมัติ (ไม่มีรอบถัดไปให้เช็ค)
            # เช่น TRAY_CAPACITY=8 · target=16 → ถามครั้งเดียวก่อนชิ้นที่ 9
            if trigger_mode == "auto":
                if not queue_review.job and TRAY_CAPACITY and piece > 1 and (piece - 1) % TRAY_CAPACITY == 0:
                    log.info("\n🧺 วัดครบ %s ชิ้นแล้ว (%s/%s) — ถาดเต็ม",
                            TRAY_CAPACITY, piece - 1, target_count)
                    if ask_tray_clear(session_id, piece - 1, target_count) != "resume":
                        stop_reason = (f"ผู้ใช้หยุดการวัดตอนเคลียร์ถาด "
                                    f"(วัดไปแล้ว {piece - 1}/{target_count} ชิ้น)")
                        break
                    log.info("   ▶ เคลียร์ถาดแล้ว — วัดต่อชิ้นที่ %s", piece)


            # ── ⓪ โหลดโปรแกรมวัดของกลุ่มนี้ ถ้ายังไม่ตรงกับที่ค้างอยู่ ──────
            #
            # ยิงก่อน `wait_for_trigger()` โดยตั้งใจ — ช่วงรอสัญญาณ
            # ไม่มีกำหนดเวลาอยู่แล้ว ปล่อยให้ TM-X โหลดโปรแกรมไปพร้อมกันเลย
            # ถ้าย้ายไปไว้หลัง trigger จะเพิ่มดีเลย์ ~1 วิให้ชิ้นแรกของทุกกลุ่ม
            #
            # ⚠ `PW` พ่วง RESET มาด้วย ทำให้ READY ดับชั่วคราว ยิง `T1` ตามติด
            #   จะได้ `ER,T1,03` · ที่รอดอยู่ทุกวันนี้เพราะ sleep 1 วิ + `T1_RETRY`
            #   ลองซ้ำให้อีก 3 ครั้ง (~0.9 วิ) รวมเผื่อไว้ ~1.9 วิ
            #   **ถ้าหน้างานพบว่าชิ้นแรกของกลุ่มพังบ่อย ให้เพิ่ม PW_LOAD_WAIT**
            #   ทางที่สะอาดกว่าคือใช้คำสั่ง `RM` อ่านโหมดยืนยันแทนการเดาเวลา
            tmpl = groups[group_of[piece - 1]].template_name
            if tmpl != current_tmpl:
                pw = f"PW,1,{str(tmpl).zfill(3)}"
                log.info("→ %s : %s  (กลุ่มที่ %s)", pw,
                         send_command(client_socket, pw, timeout=PW_CMD_TIMEOUT),
                         group_of[piece - 1] + 1)
                time.sleep(PW_LOAD_WAIT)
                current_tmpl = tmpl

            # ── ⓪.5 บอก MCU ว่าชิ้นนี้ขนาดไหน ────────────────────────────
            #
            # ส่ง **ทุกชิ้น** ไม่ใช่เฉพาะตอนเปลี่ยนกลุ่ม — เดิมมี `current_pkg`
            # จำไว้ว่าบอกไปแล้ว แต่ถอดออกโดยตั้งใจ เพราะถ้า Mega รีเซ็ตกลางคิว
            # (ไฟตก / USB re-enumerate) มันจะลืม <PKG> ของกลุ่มที่บอกไปแล้ว
            # แล้วตั้งฟิกซ์เจอร์ผิดขนาดต่อไปเงียบ ๆ จนจบกลุ่ม — ส่งซ้ำทุกชิ้น
            # ราคาถูกกว่ามาก (ข้อความเดียวต่อชิ้น) และกู้ตัวเองได้
            alpl_queue = [alpl for group in groups for alpl in group.alpl]
            number_alpl = alpl_queue[piece - 1]
            group = groups[group_of[piece - 1]]
            pkg = group.package_size
            handler = group.handler
            if not send_package_size_to_mcu(pkg, number_alpl, handler, session_id, piece, target_count):
                stop_reason = (f"ชิ้นที่ {piece}/{target_count}: "
                               f"บอกขนาดชิ้นงาน ({pkg}) ให้ MCU ไม่สำเร็จ "
                               f"— ตรวจสาย USB ของ Arduino แล้วกด Start ใหม่")
                break

            # ── รอ Trigger รอบแรก/GM Retry; T1 Retry ยิงซ้ำจาก Trigger เดิม ──────
            result = "UNKNOWN"          # ← ① ต้องมี กัน NameError รอบแรก
            need_trigger = True
            while is_running:
                if queue_review.interrupt_wait():
                    log.info("⏸ พักคิวก่อนวัดชิ้นที่ %s — กลับไปให้คิวจัดการ", piece)
                    break
                # ── ① รอสัญญาณว่าชิ้นงานเข้าที่แล้ว ──────────────────────────
                #    auto   → <TRIGGER_TMX> จาก MCU ผ่าน Serial
                #    manual → ปุ่ม ⚡ บนหน้าเว็บ (หรือ curl /trigger)
                if need_trigger:
                    log.info("\nชิ้นที่ %s/%s — รอสัญญาณ trigger ...", piece, target_count)
                    if not wait_for_trigger(session_id,piece,target_count):
                        if queue_review.interrupted:
                            log.info("⏸ พักคิวก่อนวัดชิ้นที่ %s — กลับไปให้คิวจัดการ", piece)
                        else:
                            log.info("⏹ ได้รับคำสั่ง Stop — หยุดการวัด")
                        break
                    if not is_running or queue_review.interrupt_wait():
                        break

                    # ผูก capture และอ่านตัวนับหลัง Trigger ของรอบนี้เสมอ
                    # GM Retry มี Trigger ใหม่ จึงใช้ token/ตัวนับใหม่ด้วย
                    queue_review.prepare(piece)
                    count_before = get_measured_count(session_id)
                if not is_running or queue_review.interrupt_wait():
                    break
                ok, t1_resp = trigger_tmx(client_socket)
                if ok:
                    result, x, y, horizon_left, horizon_right,vertical_top, vertical_bottom, offset_x, offset_y = get_measurement_tmx(client_socket, groups[group_of[piece - 1]].limits, pkg)
                    if result != "UNKNOWN":
                        break
                if not ok:
                    if not handle_error("T1", session_id, piece, target_count,
                    f"TM-X ปฏิเสธคำสั่ง T1 — {t1_resp}"):
                        stop_reason = (f"ชิ้นที่ {piece}/{target_count}: ยิง T1 ไม่สำเร็จ ({t1_resp})")
                        break
                    need_trigger = False
                    continue
                if result == "UNKNOWN":
                    if not handle_error("GM", session_id, piece, target_count,
                        f"รอ {GM_MAX_WAIT:.0f} วิแล้ว GM ไม่คืนค่าใหม่"):
                        stop_reason = f"ชิ้นที่ {piece}/{target_count}: TM-X วัดไม่ติด"
                        break
                    need_trigger = True

            # พักคิวต้องคืนการควบคุมให้ queue_review.pieces() เพื่อรอคำสั่ง
            # วัดซ้ำ/วัดต่อ โดยไม่ตีความ UNKNOWN ว่าเป็นความล้มเหลวของ TM-X
            if queue_review.interrupted:
                continue

            # ── ③ ยอมแพ้ทั้ง T1 และ GM แล้ว — ออกจากคิวเลย ────────────────
            #
            # ⚠ ห้ามปล่อยให้ไหลลงไป `send_result_to_mcu(result)` ข้างล่าง —
            #   ตัวนั้นคืน False สำหรับ UNKNOWN (ไม่มี token จะส่ง) แล้ว
            #   `stop_reason` ที่บอกสาเหตุจริง (ER,T1,03 / GM ไม่คืนค่า) ซึ่ง
            #   ตั้งไว้แล้วข้างบน จะถูกเขียนทับด้วย "ส่งผลให้ MCU ไม่สำเร็จ"
            #   ที่ชี้ไปหาสาย USB ทั้งที่สายปกติดี — คนหน้างานจะไล่ผิดทางทั้งวัน
            if result == "UNKNOWN":
                break

            # ── ④ ส่งผลให้ MCU ไปคัดแยก ───────────────────────────────────
            if not send_result_to_mcu(result,session_id,piece,target_count):
                stop_reason = (f"ชิ้นที่ {piece}/{target_count}: ส่งผลการวัด ({result}) "
                               f"ให้ MCU ไม่สำเร็จ — ตรวจสาย USB ของ Arduino")
                break
            # TODO: รอ MCU ตอบรับ (wait_mcu_ack) ก่อนไปชิ้นถัดไป — ยังไม่ทำ
            if not is_running:
                log.info("⏹ หยุดการวัด")
                break

            # ── รอยืนยันว่าค่าเข้า DB จริง ก่อนไปชิ้นถัดไป ────────────────── ถ้า wait_for_measurement return true 
            if wait_for_measurement(session_id, count_before):
                if is_running:
                    log.info("   ✅ ชิ้นที่ %s/%s บันทึกแล้ว", piece, target_count)
                continue

            # ── ค่าไม่ถึง DB — วัดสำเร็จแล้ว แต่ Recieve ส่งไม่ถึง ────────────
            # ⚠ ไม่มี retry ในเคสนี้ ชิ้นงานถูก MCU คัดแยกไปแล้ว ไม่มีอะไรให้วัดใหม่
            #   Pi ถือค่าอยู่ในมือครบ → ถามผู้ใช้ว่าจะรับค่านั้นโดยไม่มีรูปไหม

            report("NO_DB_ROW",
                   f"ชิ้นที่ {piece}/{target_count}: วัดได้แล้วแต่ค่าไม่ถึงฐานข้อมูลใน "
                   f"{MEASURE_TIMEOUT:.0f} วิ — ตรวจว่า Recieve_tm-x.py รันอยู่ไหม", show_toast=False)

            problem = pi_values_problem(x, y, horizon_left, horizon_right,
                                        vertical_top, vertical_bottom, offset_x, offset_y)
            preview = (f"X={_f3(x)} · Y={_f3(y)} · "
                       f"OffX={_f3(offset_x)} · OffY={_f3(offset_y)}")
            

            if problem:
                report("PI_VALUE_BAD",
                       f"ชิ้นที่ {piece}/{target_count}: ไม่ได้รับค่าจาก TM-X จะทำการหยุดการวัดและต้องแก้ไขระบบวัดหรือตรวจสอบการเชื่อมต่อของ TM-X"
                       f" ({problem}) — {preview}")
                stop_reason = (f"ชิ้นที่ {piece}/{target_count}: ค่าไม่ถึงฐานข้อมูล "
                               f"และค่าที่ Pi ถืออยู่ไม่สมบูรณ์ ({problem}) — วัดชิ้นนี้ใหม่")
                break

            if ask_user(session_id, piece, target_count) != "accept":
                stop_reason = (f"ชิ้นที่ {piece}/{target_count}: ค่าไม่ถึงฐานข้อมูล "
                               f"— ผู้ใช้เลือกหยุด")
                break

            if not post_measurement_from_pi(session_id, piece, x, y,
                                            horizon_left, horizon_right, vertical_top, vertical_bottom,
                                            offset_x, offset_y):
                stop_reason = f"ชิ้นที่ {piece}/{target_count}: บันทึกค่าจาก Pi ไม่สำเร็จ"
                break
    except Exception as exc:
        log.info("\n❌ session พังะหว่างวัด — %s: %s", type(exc).__name__, exc)
        report("SESSION_CRASHED", f"Session พังระหว่างวัด: {exc}")
        stop_reason = f"session พังะหว่างวัด — {type(exc).__name__}: {exc}" 
    finally:
        # บอก MCU ว่าจบรอบแล้ว — best effort เท่านั้น
        #
        # ⚠⚠ ห้ามเขียนแบบเปลือย ๆ (`mega_ser.write(...)`) เด็ดขาด — โค้ดใน
        #   `finally` ต้องไม่ raise ไม่ว่ากรณีใด ถ้ามันพังตรงนี้ exception เดิม
        #   ที่บอกสาเหตุจริงจะถูกกลบ แล้วบรรทัดที่เหลือ (ปิด socket · ตั้ง
        #   is_running=False · แจ้ง backend ปิด session) จะไม่ได้ทำงานเลย
        #   → session ค้างที่ 'running' จนกว่า heartbeat จะ timeout
        #
        #   `mega_ser` เป็น None ได้จริงใน 2 กรณี: โหมด manual (ไม่เคยเปิดพอร์ต)
        #   และหลัง `send_*_to_mcu` ล้าง handle ทิ้งเพราะสาย USB หลุด
        if trigger_mode == "auto" and mega_ser is not None:         
            try:
                mega_ser.write(b"<STOP>\n")
                log.info(" [TX → Mega] <STOP>")
            except Exception as exc:
                log.warning(" ⚠️ บอก <STOP> ให้ MCU ไม่สำเร็จ: %s", exc)
                _drop_mega("ส่ง Stop")
                report("MCU_STOP_FAILED", f"ส่ง <STOP> ให้ MCU ไม่สำเร็จกรุฯากดหยุดที่ตัวเครื่อง: {exc}",type="warning") 
                
        if client_socket is not None:
            try:
                client_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # อีกฝั่งตัดไปก่อนแล้ว หรือ socket ถูกปิดจาก stop handler
            try:
                client_socket.close()
            except Exception:
                pass
        is_running = False
        current_session_id = None  # heartbeat กลับไปยิงแบบ idle (ไม่แนบ session)
        log.info("\n✅ จบ session — ปิดการเชื่อมต่อ TM-X แล้ว")
        try:
            st = httpx.get(f"{BACKEND_URL}/api/session/state", timeout=5).json()
            if st.get("session_id") == session_id and st.get("state") == "running":
                measured = st.get("measured_count")

                # ⚠ ห้ามส่ง None — session.py:707 เช็ค `if req.reason:` ถ้าเป็น None
                #   จะไม่เขียนอะไรลง DB เลย หน้าเว็บขึ้น STOPPED เปล่า ๆ เหมือนเดิม
                #   ทางที่ยังไม่ได้ตั้ง reason ให้บอกตรง ๆ ว่าไม่ทราบ ดีกว่าเงียบ
                reason = stop_reason or (
                    f"session จบก่อนครบจำนวน (วัดได้ {measured}/{target_count}) "
                    f"— ไม่ทราบสาเหตุแน่ชัด ดู log บนเครื่อง Pi"
                )
                httpx.post(
                    f"{BACKEND_URL}/api/session/stop",
                    json={"session_id": session_id, "reason": reason},
                    timeout=10,
                )
                log.info("⏹ แจ้ง backend ปิด session แล้ว (วัดได้ %s/%s)", measured, target_count)
                log.info("   เหตุผล: %s", reason)

        except Exception as exc:
            log.info("   ⚠️ แจ้งปิด session ไม่ได้: %s — "
                     "backend จะปิดเองใน ~%g วิ (ขึ้นเป็น 'timeout')", exc, HB_TIMEOUT_HINT)
            # reason กำลังจะหายไปทั้งก้อน — เทอร์มินัลคือหลักฐานเดียวที่เหลือ
            if stop_reason:
                log.info("   เหตุผลที่จะหายไป: %s", stop_reason)



@http_app.get("/queue-review")
def get_queue_review():
    state = queue_review.status()
    if not is_running:
        state["phase"] = "stopped"
    return state


if __name__ == "__main__":
    # heartbeat ต้องเริ่ม "ก่อน" เปิด server และรันตลอดอายุโปรแกรมใน daemon thread
    threading.Thread(target=heartbeat_loop, daemon=True).start()

    log.info("─" * 66)
    log.info("Pi_auto_manual_mode.py — รอคำสั่ง Start จาก Backend")
    log.info(f"  ฟัง /command ที่    : 0.0.0.0:{AGENT_PORT}   (.env: AGENT_PORT)")
    log.info(f"  TM-X ที่            : {TMX_IP}:{TMX_PORT}    (.env: TMX_HOST/TMX_PORT)")
    log.info(f"  Backend ที่         : {BACKEND_URL}          (.env: BACKEND_URL)")
    log.info(f"  heartbeat ทุก       : {HB_INTERVAL:g} วิ · หยุดเองถ้าขาดติดต่อเกิน {HB_TIMEOUT_HINT:g} วิ")
    log.info(f"  รอค่าการวัดสูงสุด    : {MEASURE_TIMEOUT:g} วิ (poll ทุก {MEASURE_POLL_INTERVAL:g} วิ)")
    log.info( "  โหมด trigger        : เลือกรายรอบจาก payload ตอน Start")
    log.info( "                        auto   = รอ <TRIGGER_TMX> จาก MCU (ต้องเสียบ Mega)")
    log.info( "                        manual = รอปุ่ม ⚡ บนหน้าเว็บ (ไม่ต้องมี Mega)")
    log.info(f"  พอร์ต Serial        : เปิดตอนเริ่ม session โหมด auto เท่านั้น "
             f"({BAUD_RATE} baud)")
    # แยก 2 บรรทัดโดยตั้งใจ — เดิมพิมพ์ "curl -X POST http://..." ติดกันบรรทัดเดียว
    # แล้วมีคนก๊อปทั้งบรรทัดไปวางในช่อง address ของเบราว์เซอร์ ได้ URL เพี้ยนเป็น
    #   http://127.0.0.1:9998/curl%20-X%20POST%20http://...
    # (%20 = ช่องว่าง) · บรรทัดล่างจึงเป็น URL ล้วนที่ก๊อปแล้ววางได้ทันที
    log.info(f"  จำลองเซนเซอร์ (เบราว์เซอร์): http://127.0.0.1:{AGENT_PORT}/trigger")
    log.info(f"  จำลองเซนเซอร์ (เทอร์มินัล) : curl -X POST http://127.0.0.1:{AGENT_PORT}/trigger")
    log.info(f"     ⚠ ใช้ได้เฉพาะรอบที่เป็นโหมด manual · ยิงจากเครื่องอื่นให้เปลี่ยน 127.0.0.1 เป็น IP ของ Pi")
    log.info("─" * 66)

    # ── เตือนถ้า heartbeat ตั้งค่าไม่สัมพันธ์กัน ────────────────────────────
    # ต้อง INTERVAL × 2 ≤ TIMEOUT เป็นอย่างน้อย เพื่อให้ทนบีตหาย 1 ครั้งได้
    #
    # ถ้าตั้งเท่ากันเป๊ะ (เช่น 5/5) จะไม่มีระยะเผื่อเลยแม้แต่มิลลิวินาทีเดียว —
    # บีตต้องมาตรงเวลาพอดีทุกครั้งถึงจะรอด ซึ่งเป็นไปไม่ได้จริงเพราะมี network
    # latency + เวลาที่ MySQL เขียน UPDATE + GC ของ Python · ผลคือ backend
    # ฆ่า session ทิ้งเองกลางการวัด (ทิ้งคิวด้วย กู้ไม่ได้) โดยไม่มีสาเหตุจริง
    # แล้วหน้าเว็บขึ้นว่า 'timeout' ซึ่งชี้ไปที่ "Pi ตาย" ทั้งที่ Pi ปกติดี
    if HB_INTERVAL * 2 > HB_TIMEOUT_HINT:
        log.info(f"⚠️  HEARTBEAT_INTERVAL ({HB_INTERVAL:g}s) ถี่ไม่พอเมื่อเทียบกับ "
              f"HEARTBEAT_TIMEOUT ({HB_TIMEOUT_HINT:g}s)")
        log.info(f"    แนะนำให้ HEARTBEAT_INTERVAL ไม่เกิน {HB_TIMEOUT_HINT/2:g}s "
              f"— แก้ที่ .env\n")

    # port ต้องตรงกับ AGENT_PORT ที่ main.py ใช้ยิงมา
    uvicorn.run(http_app, host="0.0.0.0", port=AGENT_PORT,access_log =False)
