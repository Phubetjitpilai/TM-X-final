import { useEffect, useRef, useState } from "react";
import { apiGet, apiGetRetry, apiPost, ApiError } from "../api/client";
import { useSSE } from "../hooks/useSSE";
import { useSessionState, sessionStateLabel } from "../hooks/useSessionState";
import { useToast } from "../components/Toast";
import { useDialog } from "../components/Dialog";
import AlplIcon from "../components/AlplIcon";
// DP_OFF ถูกถอดออกตอนย้ายคอลัมน์ Offset Tol ไปตาราง Parts — ที่เหลือในไฟล์นี้
// ใช้แค่ DP_MM · ตัวจัดรูปของ offset อยู่ใน offsetValue() ซึ่งเรียก DP_OFF เองข้างใน
import { axisValue, offsetValue, xyPair, DP_MM } from "../components/measurementCells";
import { ReportAxis } from "../components/dashboard/ReportAxis";
import OffsetMap from "../components/dashboard/OffsetMap";
import IpmSummaryModal, { type IpmSummaryRow } from "../components/dashboard/IpmSummaryModal";
import PartEntryModal, { type EntryQueue, type TriggerMode } from "../components/dashboard/PartEntryModal";
import RemeasureStartOptions from "../components/dashboard/RemeasureStartOptions";
import { formatAlplRanges } from "../utils/formatAlplRanges";

// DashboardPage — พอร์ตจาก Frontend/index.html (TM-X Dashboard) แบบยึด
// โครงสร้าง/ข้อความ/พฤติกรรมตามต้นฉบับเป๊ะๆ (ไม่ใช่ดีไซน์ใหม่ของตัวเอง) —
// เขียนรวมไว้ไฟล์เดียวขนาดใหญ่โดยตั้งใจ (แทนที่จะแยก component ย่อยเยอะๆ)
// เพราะ state ของหน้านี้พันกันหมดทุกส่วน (session/queue/telemetry/parts
// cache) เหมือนต้นฉบับที่เป็น script เดียวในไฟล์เดียวเช่นกัน

const PART_ENTRY_STORAGE_KEY = "tmx_part_entry_state_v1";
const MEAS_PAGE_SIZE = 10;

interface SessionState {
  state: "idle" | "running" | "stopped" | "timeout";
  session_id: number | null;
  measured_count: number;
  target_count: number;
  queue_state?: any;
}

interface Part {
  number_alpl: number;
  part_number: string | null;
  description: string | null;
  po_number: number | null;
  recieve_date: string | null;
  handler: string | null;
  vendor: string | null;
  owner: string | null;
  package_size: string | null;
  nominal_x: number | null;
  nominal_y: number | null;
  upper_tol: number | null;
  lower_tol: number | null;
  template_name: string | null;
}

interface Measurement {
  measurement_id: number;
  session_id: number | null;
  number_alpl: number;
  value_x: number | null;
  value_y: number | null;
  result: string | null;
  note: string | null;
  timestamp: string | null;
  operator_name?: string | null;
  image_path?: string | null;
  image_upload_failed?: boolean;
  /** เกณฑ์ที่ใช้ตัดสินการวัดครั้งนั้น — backend เลือกแหล่งให้ตามโหมดแล้ว
   *  (IPM → package_size · New/Rework → part_number) ดู MEASUREMENTS_SELECT
   *  ⚠ offset_tol เป็น null ได้ = โหมด IPM ที่ไม่เอา offset มาตัดสิน */
  nominal_x?: number | null;
  nominal_y?: number | null;
  upper_tol?: number | null;
  lower_tol?: number | null;
  // ⚠ ไม่มี `offset` ตัวเดียวแล้ว — แยกเป็น 2 แกนตั้งแต่ถอดฝั่ง GH ออก
  //   `offset_pos_op` เป็นรหัส 9 ค่าจาก `_get_min_position_label` ฝั่ง backend
  //   (TOP / BOTTOM / LEFT / RIGHT / TOP LEFT / … / CENTER) — บอก "ทิศ"
  //   ส่วน offset_opx/opy เป็น "ขนาด" ไม่มีเครื่องหมาย
  offset_opx?: number | null;
  offset_opy?: number | null;
  offset_pos_op?: string | null;
  offset_tol?: number | null;
  measure_type?: string | null;
  /** ผลตัดสินรายแกนที่ backend คำนวณให้ (`_ok_flags` ใน shared.py)
   *
   *  ⚠ **ต้องใช้ค่าพวกนี้ระบายสี ห้ามคำนวณ `nominal ± tol` เองในหน้าเว็บ** —
   *    backend ปัดทศนิยมด้วย `_DP` ก่อนเทียบ ถ้าที่นี่คำนวณเองแบบไม่ปัด
   *    ชิ้นที่ตกขอบพอดีจะขึ้นสีแดงทั้งที่คอลัมน์ Result บอก OK (เคยเกิดจริง)
   *
   *  `null` = ตัดสินไม่ได้ (ยังไม่ผูก package_size / โหมด IPM ที่ไม่ตรวจ offset)
   *  ต่างจาก `false` ที่แปลว่าตรวจแล้วไม่ผ่าน — null ต้องไม่ระบายสี */
  ok_x?: boolean | null;
  ok_y?: boolean | null;
  /** แยกรายแกน — ใช้ระบายสีช่องตัวเลข Offset X / Y */
  ok_opx?: boolean | null;
  ok_opy?: boolean | null;
  /** ⚠ **ผลรวมของทั้ง opx และ opy** — ใช้กับผัง OffsetMap / ป้าย OK-NG ของทั้ง
   *  การ์ดเท่านั้น **ห้ามเอาไประบายสีช่องรายแกน** (เคยพลาด: opx หลุดแล้วช่อง
   *  opy ที่ผ่านอยู่โดนแดงไปด้วย) — ช่องรายแกนต้องใช้ `ok_opx` / `ok_opy` */
  ok_offset?: boolean | null;
}

interface Telemetry {
  number_alpl?: number;
  value_x: number;
  value_y: number;
  /** เกณฑ์ + ผลรายแกนที่ backend ส่งมากับ event — ใช้ ok_* ก่อนเสมอ (แม่นที่สุด)
   *  ค่อยคำนวณเองจาก nominal/tol ถ้า event เก่าไม่มี */
  nominal_x?: number | null;
  nominal_y?: number | null;
  upper_tol?: number | null;
  lower_tol?: number | null;
  offset_tol?: number | null;
  ok_x?: boolean | null;
  ok_y?: boolean | null;
  ok_offset?: boolean | null;
  /** ธงจาก backend ว่า offset ถูกนับเป็นเกณฑ์ไหม — false = โหมด IPM */
  offset_counts?: boolean;
  measure_type?: string | null;
  // ⚠ ไม่มี offset_ghx / offset_ghy / offset_pos_gh แล้ว — เลิกใช้เครื่องมือฝั่ง GH
  //   (ถอดออกจาก MeasurementCreate และตาราง measurements ไปแล้ว) backend
  //   ไม่ได้ส่งมาใน SSE `measurement` อีกต่อไป
  offset_opx?: number | null;
  offset_opy?: number | null;
  offset_pos_op?: string | null;
  result: string;
  measurement_id?: number;
}

/** ป้าย OK/NG รายแกน + ข้อความช่วงที่รับได้
 *
 *  บอกว่า "พังที่แกนไหน" ไม่ใช่รู้แค่ Result รวม — ตอนวัดไม่ผ่านจะได้รู้ทันที
 *  ว่าต้องไปแก้อะไร · ใช้ ok ที่ backend ส่งมาก่อนเสมอ (แม่นที่สุด เพราะเกณฑ์
 *  มาจากคนละตารางตามโหมด) ค่อยคำนวณเองถ้า event เก่าไม่มีค่านั้น
 */
function axisInfo(
  value?: number | null, nominal?: number | null,
  upper?: number | null, lower?: number | null, okFromEvent?: boolean | null,
): { ok: boolean | null; range: string } {
  const ok = okFromEvent != null ? okFromEvent
    : value != null && nominal != null && upper != null && lower != null
      ? value >= nominal - lower && value <= nominal + upper
      : null;
  const range = nominal != null && upper != null && lower != null
    ? `รับได้ ${(nominal - lower).toFixed(DP_MM)} – ${(nominal + upper).toFixed(DP_MM)}`
    : "";
  return { ok, range };
}

/* ── หน้าตา modal "ไม่ได้รับค่าการวัด" แยกตามสาเหตุ ───────────────────────
 *
 * เลือกจาก `event` (รหัส) ที่ backend แนบมากับ SSE `measure_timeout`
 * **ห้ามเดาจากข้อความใน `detail`** เพราะข้อความเปลี่ยนได้ตลอดโดยไม่มีใครรู้ว่า
 * มีโค้ดฝั่งนี้พึ่งพาอยู่
 *
 * แยกเป็น 2 พฤติกรรม เพราะ "ของยังอยู่ในเครื่องไหม" ต่างกันสิ้นเชิง:
 *
 *   T1_FAILED / GM_NO_VALUE → ยังไม่ได้ค่า **ชิ้นงานยังอยู่ในเครื่อง**
 *                             → "ลองใหม่" = สั่งวัดชิ้นเดิมซ้ำ ปลอดภัย
 *
 *   NO_DB_ROW               → วัดแล้ว ตัดสินแล้ว **MCU คัดแยกออกไปแล้ว**
 *                             → ไม่มีอะไรให้วัดใหม่ · Pi ถือค่าจาก GM อยู่
 *                             → "รับค่าจาก Pi" = ให้ Pi POST ค่านั้นแทน (ไม่มีรูป)
 *                             ⚠ ถ้าเผลอขึ้นปุ่ม "ลองใหม่" ในเคสนี้ จะกลายเป็นวัด
 *                               ชิ้นถัดไปที่เพิ่งไหลเข้ามาแล้วบันทึกเป็นชิ้นนี้
 *
 * event ที่ไม่รู้จัก / เป็น null (Recieve ไม่เคยรายงาน เช่นไม่ได้รันอยู่เลย)
 * → ตกมาที่ค่าเริ่มต้น "ลองใหม่" ซึ่งเป็นตัวเลือกที่ปลอดภัยกว่า
 */
type MtAction = "retry" | "accept";
interface MtView {
  title: string; body: string; question: string; hint: React.ReactNode;
  action: MtAction; actionLabel: string;
}

const MT_RETRY: MtView = {
  title: "⚠ ไม่ได้รับค่าการวัด",
  body: "ไม่ได้รับค่าการวัดกลับมาภายในเวลาที่กำหนด",
  question: "ต้องการให้ลองวัดชิ้นเดิมอีกครั้งหรือไม่?",
  hint: <>สาเหตุที่พบบ่อย — TM-X วัดไม่ติด (ชิ้นงานวางไม่เข้าที่ / เลนส์สกปรก)
        หรือ TM-X ยังไม่พร้อมรับคำสั่งวัด</>,
  action: "retry",
  actionLabel: "ลองใหม่",
};

const MT_ACCEPT: MtView = {
  title: "⚠ ค่าไม่ถึงฐานข้อมูล",
  body: "วัดสำเร็จแล้ว แต่ค่าไม่ถูกบันทึกลงฐานข้อมูลภายในเวลาที่กำหนด",
  question: "ต้องการรับค่าที่ Pi อ่านไว้แทนหรือไม่? (จะไม่มีรูปของชิ้นนี้)",
  hint: <>ชิ้นงานถูกวัดและคัดแยกไปแล้ว จึงวัดใหม่ไม่ได้ — Pi ยังถือค่าไว้ครบ
        <br />สาเหตุที่พบบ่อย — <strong>Recieve_tm-x.py</strong> ไม่ได้รันอยู่
        หรือ TM-X ส่งไฟล์มาไม่ถึงเครื่อง PC</>,
  action: "accept",
  actionLabel: "รับค่าจาก Pi",
};

const mtView = (event?: string | null): MtView =>
  event === "NO_DB_ROW" ? MT_ACCEPT : MT_RETRY;


export default function DashboardPage() {
  // ── Session ────────────────────────────────────────────────────────
  const [session, setSession] = useState<SessionState>({ state: "idle", session_id: null, measured_count: 0, target_count: 1 });
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // ── Telemetry / Camera preview ───────────────────────────────────────
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  /** ค่า telemetry ล่าสุด "ณ ตอนนี้จริง ๆ" — savePartEntryState() ต้องอ่านจากตัวนี้
   *
   *  ⚠ ห้ามให้ savePartEntryState() อ่านตัวแปร `telemetry` ตรง ๆ เด็ดขาด
   *    setTelemetry() ไม่ได้อัปเดตทันที ค่าใน closure ยังเป็นของ render เดิมอยู่
   *    พอ resetTelemetry() เรียก setTelemetry(null) แล้วเรียก save ต่อทันที
   *    สิ่งที่ถูกเขียนลง localStorage คือค่า "ก่อนล้าง" → จอล้างจริงตอนกด แต่
   *    พอ refresh ค่าเดิมโผล่กลับมา เหมือนปุ่ม Clear ไม่ทำงาน (อาการที่เจอจริง) */
  const telemetryRef = useRef<Telemetry | null>(null);
  const latestTelemetryRef = useRef<Telemetry | null>(null);
  const [selectedQueueIndex, setSelectedQueueIndex] = useState<number | null>(null);
  const selectedQueueRef = useRef<number | null>(null);
  const telemetryRequestRef = useRef(0);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [reviewPhase, setReviewPhase] = useState("running");
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewBusyRef = useRef(false);

  async function resumeLatestTelemetry() {
    if (reviewBusyRef.current) return;
    reviewBusyRef.current = true;
    setReviewBusy(true);
    try {
      if (sessionRef.current.state === "running") {
        await apiPost("/api/review/command", { action: "resume_queue", session_id: sessionRef.current.session_id });
      }
      setReviewPhase("running");
      followLatestTelemetry();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "สั่งวัดต่อไม่สำเร็จ");
    } finally {
      reviewBusyRef.current = false;
      setReviewBusy(false);
    }
  }

  async function remeasureSelected() {
    const selected = telemetryRef.current;
    const sid = sessionRef.current.session_id;
    if (reviewBusyRef.current || !selected?.measurement_id) return;
    reviewBusyRef.current = true;
    setReviewBusy(true);
    const previousReview = reviewDisplayRef.current;
    try {
      const running = sessionRef.current.state === "running";
      let triggerMode: TriggerMode = parsedQueue?.trigger_mode === "manual" ? "manual" : "auto";
      if (!await dialog.confirm(
        running
          ? `วางชิ้นงาน ALPL ${selected.number_alpl} ให้พร้อม แล้วเริ่มวัดใหม่ ผลและรูปใหม่จะแทนที่รายการเดิม`
          : <RemeasureStartOptions alpl={selected.number_alpl} initialMode={triggerMode}
              onModeChange={mode => { triggerMode = mode; }} />,
        { title: "วัดชิ้นงานใหม่", okLabel: running ? "เริ่มวัดใหม่" : "▶ Start" },
      )) return;
      if (sid !== sessionRef.current.session_id || running !== (sessionRef.current.state === "running")) {
        showToast("สถานะ Session เปลี่ยนแล้ว กรุณาเลือกชิ้นงานอีกครั้ง", undefined, "warning");
        return;
      }
      if (running) {
        await apiPost("/api/review/command", { action: "remeasure", session_id: sid, measurement_id: selected.measurement_id });
        setReviewPhase("remeasuring");
      } else {
        const originIndex = selectedQueueIndex;
        if (originIndex == null) {
          showToast("กรุณาเลือก Queue ที่ต้องการวัดซ้ำก่อน", undefined, "warning");
          return;
        }
        reviewDisplayRef.current = {
          sessionId: null,
          originSessionId: sid,
          queueIndex: originIndex,
          measurementId: selected.measurement_id,
          pendingStart: true,
          completed: false,
        };
        const data = await apiPost<SessionState>(`/api/review/start/${selected.measurement_id}`, { trigger_mode: triggerMode });
        onSessionStarted(data);
        savePartEntryState();
      }
    } catch (err) {
      // Failed Start must leave the previous queue and its session associations intact.
      if (reviewDisplayRef.current?.pendingStart) reviewDisplayRef.current = previousReview;
      savePartEntryState();
      showToast(err instanceof ApiError ? err.message : "เริ่มวัดใหม่ไม่สำเร็จ");
    } finally {
      reviewBusyRef.current = false;
      setReviewBusy(false);
    }
  }

  function followLatestTelemetry() {
    telemetryRequestRef.current += 1;
    selectedQueueRef.current = null;
    setSelectedQueueIndex(null);
    setTelemetryLoading(false);
    applyTelemetry(latestTelemetryRef.current);
  }

  async function selectQueueTelemetry(index: number, alpl: number) {
    const sid = sessionRef.current.session_id;
    if (sid == null) return;
    const request = ++telemetryRequestRef.current;
    selectedQueueRef.current = index;
    setSelectedQueueIndex(index);
    setTelemetryLoading(true);
    applyTelemetry(null);
    try {
      if (sessionRef.current.state === "running" && !reviewDisplayRef.current) {
        setReviewPhase("pausing");
        const status = await apiPost<{ phase: string }>("/api/review/command", { action: "pause_queue", session_id: sid });
        if (request !== telemetryRequestRef.current) return;
        setReviewPhase(status.phase);
      }
      const params = { number_alpl: alpl, limit: 1,
        session_id: displayQueueRef.current[index]?.sessionId ?? sid };
      const data = await apiGet<{ items: Telemetry[] }>("/api/measurements", params);
      if (request !== telemetryRequestRef.current || sessionRef.current.session_id !== sid) return;
      if (!data.items[0]) {
        showToast("ยังไม่พบผลวัดของชิ้นนี้", undefined, "warning");
        followLatestTelemetry();
        return;
      }
      applyTelemetry(data.items[0]);
    } catch (err) {
      if (request !== telemetryRequestRef.current) return;
      showToast(err instanceof ApiError ? err.message : "โหลดผลวัดไม่สำเร็จ");
      followLatestTelemetry();
    } finally {
      if (request === telemetryRequestRef.current) setTelemetryLoading(false);
    }
  }
  /** ตั้งค่า telemetry — ใช้ตัวนี้แทน setTelemetry() ทุกที่ เพื่อให้ ref ตรงกับ state เสมอ */
  const applyTelemetry = (v: Telemetry | null) => {
    telemetryRef.current = v;
    setTelemetry(v);
    // รูปต้องเป็นของผลวัดที่กำลังแสดงเสมอ รวมถึงตอนเปลี่ยนคิว/กลับไปค่าล่าสุด
    cameraRequestRef.current += 1;
    setCameraImgUrl(null);
    applyLastImageId(null);
    if (v?.measurement_id != null) void updateCameraPreview(v.measurement_id);
  };
  const [lastImageMeasurementId, setLastImageMeasurementId] = useState<number | null>(null);
  /** เหตุผลเดียวกับ telemetryRef — รูปที่ค้างใน Camera Preview ก็ถูกเซฟกลับด้วย
   *  ค่าเก่าเหมือนกัน กด Clear แล้ว refresh รูปเดิมจึงโผล่กลับมา */
  const lastImageIdRef = useRef<number | null>(null);
  const applyLastImageId = (v: number | null) => { lastImageIdRef.current = v; setLastImageMeasurementId(v); };
  const [cameraImgUrl, setCameraImgUrl] = useState<string | null>(null);
  const cameraRequestRef = useRef(0);
  /** รูปที่กำลังเปิดดูเต็มจอ — null = ไม่ได้เปิด
   *  แยกจาก cameraImgUrl เพราะรูปใน Camera Preview เปลี่ยนเองทุกครั้งที่วัดชิ้นใหม่
   *  ถ้าผูกกันไว้ รูปที่กำลังซูมดูอยู่จะโดนสลับกลางคันตอนชิ้นถัดไปมาถึง */
  const [zoomImgUrl, setZoomImgUrl] = useState<string | null>(null);

  // ── Stats ─────────────────────────────────────────────────────────────
  const [stats, setStats] = useState({ total: 0, ok: 0, ng: 0 });
  /** ผล OK/NG รายชิ้นเรียงตามลำดับในคิว — ใช้ระบายสีชิปในแถบคิว
   *  เก็บเป็น ref เพราะ syncQueueStrip อ่านตอนถูกเรียกจาก async ไม่ผ่าน render
   *
   *  ⚠ ถูกเซฟลง localStorage ด้วย (savePartEntryState) — ref เปล่าทุกครั้งที่
   *    component เกิดใหม่ (refresh · HMR ตอน dev) ถ้าไม่เซฟไว้ แถบคิวจะลืมผล
   *    ที่วัดไปแล้วทั้งหมด */
  const resultsRef = useRef<string[]>([]);

  /** ชิ้นที่ i ควรเป็นชิปสีอะไร — **ทางเดียว** ที่ควรใช้ตัดสิน
   *
   *  ⚠ ห้ามเขียน `results[i] === "NG" ? "ng" : "ok"` อีก — `undefined` (ยังไม่รู้ผล)
   *    จะตกไปเป็น "ok" เขียวติ๊กถูก ทั้งที่ของจริงอาจ NG ทุกชิ้น เคยเกิดจริงมาแล้ว
   *    ตอนรีเฟรชหน้ากลาง session แล้วชิปขึ้นเขียวหมดสวนทางกับ Progress ที่ขึ้น NG
   *
   *  ระบบตรวจคุณภาพ "ไม่รู้" ต้องไม่แปลว่า "ผ่าน" เด็ดขาด — คืน `done` (เทา เส้นประ)
   *  ให้เห็นชัดว่าวัดไปแล้วแต่หน้านี้ตอบผลไม่ได้
   */
  function chipStateFor(i: number): "ok" | "ng" | "done" {
    const r = resultsRef.current[i];
    return r === "NG" ? "ng" : r === "OK" ? "ok" : "done";
  }

  /** จอ Live Telemetry ถูกสั่งล้างไว้สำหรับ session ไหน
   *
   *  ⚠ จำเป็นเพราะการล้าง state เฉย ๆ **ไม่พอ** — พอผล poll ของ useSessionState()
   *    เปลี่ยน effect จะเรียก syncQueueStrip()/updateStats() ซึ่งไปดึงคิวกับสถิติ
   *    ของ session นั้นกลับมาเติมใหม่ ผู้ใช้จะเห็นของที่เพิ่งล้างโผล่กลับมาเอง
   *
   *  ผูกกับ session_id ไม่ใช่ boolean เฉย ๆ — พอขึ้น session ใหม่ธงจะหมดผลเอง
   *  โดยไม่ต้องล้างให้ (คนละ session แล้ว ไม่มีเหตุผลที่จะซ่อนของใหม่)
   *
   *  null = ไม่ได้ล้างอะไรไว้ · ตัวเลข = session นั้นถูกสั่งล้างจอไว้
   */
  const [ipmSummary, setIpmSummary] = useState<IpmSummaryRow[] | null>(null);
  const clearedSidRef = useRef<number | null>(null);
  const isTelemetryCleared = () =>
    clearedSidRef.current != null && clearedSidRef.current === sessionRef.current.session_id;

  /** modal ตอน Pi ยิง T1 แล้วไม่ได้รับค่ากลับมาภายในเวลาที่กำหนด
   *
   *  ⚠ **Pi ค้างรอคำตอบอยู่จริง ๆ** ไม่ใช่แค่แจ้งเตือน — จึงตั้งใจไม่มีปุ่มปิด (✕)
   *    และคลิกพื้นหลังปิดไม่ได้ ถ้าปิดทิ้งเฉย ๆ session จะค้างโดยไม่มีใครรู้
   *  มีนับถอยหลัง — ไม่ตอบภายในเวลาจะหยุดให้อัตโนมัติ ดีกว่าปล่อยเครื่องค้าง
   *  ข้ามคืนเพราะคนเดินออกจากหน้าจอไปแล้ว
   */
  // เวลาที่ให้คนตัดสินใจก่อนหยุดให้อัตโนมัติ (วินาที) — ปรับตรงนี้ที่เดียว
  //
  // ⚠ ต้อง **น้อยกว่า** `ASK_USER_TIMEOUT` ของ Pi/mockup (ตั้งไว้ 90 วิใน .env)
  //   เพราะฝั่งนั้นคือตาข่ายกันค้างตอนไม่มีใครเปิดหน้าเว็บอยู่เลย ถ้าตัวนี้ยาว
  //   กว่า Pi จะยอมแพ้ไปก่อนแล้วปุ่มในโมดัลจะกดไม่ติด (backend ตอบ 404
  //   "ไม่พบคำถามค้าง") ทั้งที่หน้าจอยังนับถอยหลังอยู่
  const MT_ANSWER_TIMEOUT = 60;
  const [mtModal, setMtModal] = useState<
    { session_id: number; piece?: number; target?: number; number_alpl?: number; detail?: string; event?: string} | null
  >(null);
  const [mtLeft, setMtLeft] = useState(MT_ANSWER_TIMEOUT);
  const mtTimerRef = useRef<number | null>(null);

  /** modal "ถาดเต็ม" — Pi หยุดรอให้คนมาเคลียร์ถาดก่อนวัดชิ้นถัดไป
   *  (ทำงานเมื่อ `TRAY_CAPACITY` ใน .env > 0 · ค่าปัจจุบัน 8 ชิ้น)
   *
   *  ⚠⚠ **ห้ามใส่ตัวนับถอยหลังให้ตัวนี้** ต่างจาก `mtModal` ข้างบนโดยตั้งใจ —
   *    `mtModal` นับถอยหลัง 60 วิแล้วหยุด session เองเพราะมันคือการวัดที่พัง
   *    ไปแล้ว ปล่อยค้างไม่ได้ · ส่วนถาดเต็มเป็น **จุดพักตามแผน** คนต้องเดินไป
   *    ยกของออกจากถาดจริง ๆ ใช้เวลาไม่แน่นอน ตั้งเพดานเวลาเมื่อไหร่ก็จะมีวันที่
   *    session ตายกลางคันเพราะคนเดินช้าไป 10 วิ แล้วของทั้งถาดต้องวัดใหม่
   *    (ฝั่ง Pi ก็รอไม่จำกัดเวลาเหมือนกัน — ดู `ask_tray_clear`)
   */
  const [trayModal, setTrayModal] = useState<
    { session_id: number; piece?: number; target?: number; capacity?: number } | null
  >(null);


  const [mcuModal, setMcuModal] = useState<
    { session_id: number; piece?: number | null; target?: number | null } | null
  >(null);
  const mcuFailRef = useRef(0);
  
  /** นับว่าส่งคำตอบใน modal ไปที่ Pi ไม่สำเร็จติดกันกี่ครั้ง
   *
   *  ใช้ `useRef` ไม่ใช่ `useState` เพราะเป็นค่าที่ใช้ **ตัดสินใจภายใน** อย่างเดียว
   *  ไม่ได้เอาไปวาดบนจอ — ถ้าใช้ state จะ re-render ทั้งหน้าโดยเปล่าประโยชน์
   *  และค่าที่อ่านได้ใน closure ของ catch อาจเป็นค่าเก่า
   */
  const mtFailRef = useRef(0);
  /** แถบคิว ALPL — ok/ng = วัดแล้วรู้ผล · done = วัดแล้วแต่หน้านี้ไม่รู้ผล ·
   *  now = กำลังวัด · wait = ยังไม่ถึงคิว
   *  ซ่อนทั้งแถบเมื่อคิวมีตัวเดียว (เช่น IPM ชิ้นเดียว) เพราะไม่มีอะไรให้ดู
   *
   *  ⚠ `done` มีไว้เพื่อ **ห้ามเดาผลเป็นเขียว** — ดู chipStateFor() ข้างล่าง */
  type QueueItem = { alpl: number; state: "ok" | "ng" | "done" | "now" | "wait"; sessionId: number };
  const [queueStrip, setQueueStripState] = useState<QueueItem[]>([]);
  const displayQueueRef = useRef<QueueItem[]>([]);
  const displaySessionIdRef = useRef<number | null>(null);
  const statsRequestRef = useRef(0);
  function setQueueStrip(value: QueueItem[] | ((prev: QueueItem[]) => QueueItem[])) {
    const next = typeof value === "function" ? value(displayQueueRef.current) : value;
    displayQueueRef.current = next;
    setQueueStripState(next);
  }
  type ReviewDisplay = {
    sessionId: number | null;
    originSessionId: number | null;
    queueIndex: number;
    measurementId: number;
    pendingStart: boolean;
    completed: boolean;
    updateExisting?: boolean;
  };
  // Session วัดซ้ำแบบชิ้นเดียวต้องไม่เอา queue_state ของมันมาแทน Queue เดิม
  const reviewDisplayRef = useRef<ReviewDisplay | null>(null);
  const queueStripRef = useRef<HTMLDivElement>(null);
  const queueNowIndex = queueStrip.findIndex((item) => item.state === "now");
  const queueFollowIndex = queueNowIndex >= 0 ? queueNowIndex
    : queueStrip.reduce((last, item, index) =>
      item.state === "ok" || item.state === "ng" || item.state === "done" ? index : last, -1);
  const queueFollowAlpl = queueStrip[queueFollowIndex]?.alpl;

  useEffect(() => {
    if (selectedQueueIndex !== null) return;
    const strip = queueStripRef.current;
    const chip = strip?.children[queueFollowIndex] as HTMLElement | undefined;
    if (!strip || !chip) return;
    const stripRect = strip.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    // Scroll only this strip; keep the latest result and next piece nearby.
    strip.scrollTo({
      left: strip.scrollLeft + chipRect.left - stripRect.left - (strip.clientWidth - chipRect.width) / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [queueFollowIndex, queueFollowAlpl, selectedQueueIndex]);

  // ── Parts cache (ใช้ validate ALPL + report modal — ไม่มีตารางแสดงในหน้านี้) ──
  const partsRef = useRef<Part[]>([]);

  // ── Dropdown lookups (Operator/Owner/Vendor/Handler/Package Size) ────
  // โหลดครั้งเดียวตอนเปิดหน้าจาก endpoint ของแต่ละตัวจริงๆ (เหมือน index.html
  // ต้นฉบับ) ไม่ใช่ derive จาก parts cache (เดิมทำผิดไป — ทำให้ Operator ไม่มี
  // ตัวเลือกเลยเพราะ parts ไม่มี field operator, และ Handler/Vendor/Owner/
  // Package Size ก็โชว์ไม่ครบเพราะเห็นแค่ค่าที่เคยผูกกับ part ที่โหลดมาแล้ว)
  const [operatorOptions, setOperatorOptions] = useState<string[]>([]);
  const [ownerOptions, setOwnerOptions] = useState<string[]>([]);
  const [vendorOptions, setVendorOptions] = useState<string[]>([]);
  const [packageSizeOptions, setPackageSizeOptions] = useState<string[]>([]);
  /** แถวเต็มของ package_size — ต้องเก็บทั้งก้อนเพราะช่อง Handler ในฟอร์ม
   *  ต้องใช้ `handlers` ที่แนบมาด้วย ถ้าเก็บแค่ชื่อเหมือนเดิมจะต้องยิง API
   *  เพิ่มทุกครั้งที่เปลี่ยน Package Size */
  const [packageSizeCatalog, setPackageSizeCatalog] =
    useState<{ package_size: string; handlers: string[] }[]>([]);
  const [partNumberCatalog, setPartNumberCatalog] =
    useState<{ part_number_name: string; package_size: string; handler: string }[]>([]);

  // ── Part Entry queues ────────────────────────────────────────────────
  /** คิวเดียวใช้ทั้ง 3 โหมด — โครง groups[] เหมือนกันหมด ต่างแค่ field ในกลุ่ม
   *
   *  ⚠ เดิมแยกเป็น ipmQueue/newQueue/reworkQueue คนละก้อน ทำให้ทุกจุดที่ใช้ต้อง
   *    เขียน 3 สาขาเสมอ (เช็คว่าอันไหนไม่ null → หยิบตัวนั้น) พอเพิ่มโหมดหรือแก้
   *    ตรรกะทีก็ต้องไล่แก้ 3 ที่ทุกครั้ง
   */
  const [entryQueue, setEntryQueue] = useState<EntryQueue | null>(null);
  const entryQueueRef = useRef<EntryQueue | null>(null);
  entryQueueRef.current = entryQueue;


  // ── Part Entry modal / toggle ────────────────────────────────────────
  const [peModalOpen, setPeModalOpen] = useState(false);
  /** มีเส้นไหนของ loadDropdownData() โหลดไม่สำเร็จไหม — ใช้ขึ้นแถบเตือน
   *  ไม่ให้อาการ "ช่องเลือกว่าง" เงียบอีกต่อไป (ดู loadDropdownData) */
  const [dropdownFailed, setDropdownFailed] = useState(false);
  const [peSummaryOpen, setPeSummaryOpen] = useState(false);





  // ── Confirm modal (Promise-based, ใช้ตอน IPM เจอ ALPL ที่ยังไม่เคยลงทะเบียน) ──
  const [confirmModal, setConfirmModal] = useState<{ message: string } | null>(null);
  const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);
  function resolveConfirmModal(result: boolean) {
    setConfirmModal(null);
    confirmResolveRef.current?.(result);
    confirmResolveRef.current = null;
  }

  // ── Measurements table (server-side pagination + filter) ─────────────
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [measTotal, setMeasTotal] = useState(0);
  const [measPage, setMeasPage] = useState(1);
  const [measFilterAlplInput, setMeasFilterAlplInput] = useState("");
  const measFilterAlplRef = useRef("");
  const [measFilterDate, setMeasFilterDate] = useState("");
  const measSearchTimer = useRef<number | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // ── Report modal ───────────────────────────────────────────────────────
  const [reportModal, setReportModal] = useState<{ measurement: Measurement; part: Part | null; imageUrl: string | null; imageState: "loading" | "ok" | "none" } | null>(null);

  const { show: showToast } = useToast();
  const dialog = useDialog();

  const stationStatus = useSSE({
    session_started: (d) => onSessionStarted(d),
    measurement: (d) => onNewMeasurement(d),
    measurement_replaced: (d) => onMeasurementReplaced(d),
    session_stopped: (d) => onSessionStopped(d),
    session_complete: (d) => onSessionComplete(d),
    session_timeout: () => onSessionTimeout(),
    image_updated: (d) => onImageUpdated(d),
    measure_timeout: (d) => onMeasureTimeout(d),
    tray_full: (d) => setTrayModal(d),
    mcu_disconnected: (d) => onMcuDisconnected(d),
    station_event: (d) => onStationEvent(d),
  });
  const stationStatusRef = useRef(stationStatus);
  stationStatusRef.current = stationStatus;

  // ── สถานะ Pi + DB ────────────────────────────────────────────────────────
  // มาจาก /api/session/state ที่ poll อยู่แล้วทุก 4 วิ — ไม่ได้เพิ่ม request ใหม่
  // (useSessionState dedupe ให้ตาม queryKey แม้ Layout จะเรียกซ้ำอีกที)
  const { data: polledSession, piStatus, dbOffline: dbDown, triggerReady, manualTrigger } = useSessionState();
  const piOnline = piStatus === true;
  const dbOffline = !!dbDown;
  useEffect(() => {
    if (session.state !== "running") { setReviewPhase("running"); return; }
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const status = await apiGet<{ session_id: number; phase: string }>("/api/review/state");
        if (!cancelled && status.session_id === session.session_id) setReviewPhase(status.phase);
      } catch {
        if (!cancelled) setReviewPhase("unknown");
      }
      if (!cancelled) timer = window.setTimeout(poll, 1000);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [session.state, session.session_id]);

  /** ลายเซ็นของ "สิ่งที่หน้านี้สนใจจริง ๆ" ในผล poll
   *
   *  ⚠ ต้องมีตัวนี้ ห้ามใช้ `[polledSession]` ตรง ๆ เป็น dependency — TanStack
   *    คืน **object ใหม่ทุกครั้งที่ refetch** แม้ข้อมูลจะเหมือนเดิมเป๊ะ effect
   *    จึงทำงานทุกวินาทีตอน running แล้ว updateStats() จะยิง /api/measurements
   *    3 คำขอทุกวินาที (ของเดิมยิงทุก 5 วิ = แย่ลง 5 เท่า)
   *
   *  ⚠ **ห้ามใส่ `last_seen`** — heartbeat ขยับทุก 5 วิ ใส่แล้วเท่ากับไม่ได้กรอง
   *    อะไรเลย (และไม่มีใครในหน้านี้อ่านค่านั้น)
   *
   *  `measured_count` ครอบเรื่อง queue_state ให้แล้ว เพราะ position ใน
   *  queue_state ขยับพร้อมกับตัวนับนี้เสมอ (ดู create_measurement)
   */
  const sessionSig = polledSession
    ? `${polledSession.session_id}|${polledSession.state}|${polledSession.measured_count}|${polledSession.target_count}`
    : "";

  /* ── ปุ่มจำลองสัญญาณทริกเกอร์ — ใช้ระหว่างที่ยังไม่ได้ต่อ MCU ──────────────
     ยิงไปที่ Backend ไม่ใช่ที่ Pi โดยตรง (ดูเหตุผลใน manual_trigger ฝั่ง backend)

     ⚠ ปุ่มยังกดพลาดจังหวะได้ถึงแม้จะสว่างอยู่ — heartbeat มาทุก 2 วิ แล้วหน้าเว็บ
       poll ทุก 4 วิ ค่าที่เห็นจึงเก่าได้ถึง ~6 วินาที จังหวะอาจเปลี่ยนไปแล้ว
       ตอนที่กด **จึงต้องมี toast บอกเหตุผลเสมอ** ห้ามให้ปุ่มเงียบ ไม่งั้น
       operator จะกดรัวแล้วคิดว่าระบบพัง                                      */
  async function sendManualTrigger() {
    try {
      await apiPost("/api/session/trigger", { session_id: session?.session_id });
      showToast("⚡ ส่งสัญญาณแล้ว", undefined, "success");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "ส่งสัญญาณไม่สำเร็จ");
    }
  }

  // ── localStorage persistence (ipmQueue/newQueue/reworkQueue/telemetry) ──
  function savePartEntryState() {
    try {
      localStorage.setItem(
        PART_ENTRY_STORAGE_KEY,
        JSON.stringify({
          entryQueue: entryQueueRef.current,
          lastTelemetry: latestTelemetryRef.current,
          lastImageMeasurementId: latestTelemetryRef.current?.measurement_id ?? null,
          // ผล OK/NG รายชิ้น — ต้องรอดการ refresh เหมือน lastTelemetry ไม่งั้น
          // แถบคิวจะลืมผลทั้งแถวแล้วชิปกลายเป็น "ไม่รู้ผล" ทั้งที่เพิ่งวัดไปเอง
          results: resultsRef.current,
          // "ล้างจอ" ต้องรอดการ refresh — ไม่งั้น poll รอบแรกหลังโหลดหน้าจะดึงคิว
          // กับตัวเลขของ session เดิมกลับมาทันที เหมือนไม่เคยกดล้าง
          // เก็บเป็น session_id ไม่ใช่ boolean จะได้ปลดตัวเองเมื่อขึ้น session ใหม่
          clearedSid: clearedSidRef.current,
          displayQueue: displayQueueRef.current,
          displaySessionId: displaySessionIdRef.current,
          reviewDisplay: reviewDisplayRef.current?.pendingStart ? null : reviewDisplayRef.current,
        }),
      );
    } catch {
      /* localStorage อาจใช้ไม่ได้ — ไม่ critical ปล่อยผ่าน */
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Data loaders
  // ══════════════════════════════════════════════════════════════════
  /** โหลด Part ทั้งหมดแบบวนทีละหน้า
   *
   *  ⚠ ของเดิมยิง `/api/parts?limit=100000` ทีเดียว ซึ่ง **พังตั้งแต่ request แรก**
   *    เพราะ backend ตั้งเพดานไว้ `Query(10, ge=1, le=1000)` — เกินเพดานได้
   *    **422 Unprocessable Entity** ทุกครั้ง ตาราง Parts จึงว่างตลอดโดยไม่มีใคร
   *    สังเกต (catch กลืน error ไว้แล้ว log อย่างเดียว)
   *
   *  วนทีละ PARTS_PAGE เหมือน fetchAllParts() ของ vanilla — ต้องไม่เกินเพดาน
   */
  async function refreshParts(): Promise<Part[]> {
    const PARTS_PAGE = 1000; // ต้องไม่เกินเพดานของ /api/parts (le=1000)
    try {
      const out: Part[] = [];
      for (let offset = 0, total = Infinity; offset < total; offset += PARTS_PAGE) {
        const d = await apiGet<{ items: Part[]; total: number }>("/api/parts", {
          limit: PARTS_PAGE,
          offset,
        });
        out.push(...(d.items ?? []));
        total = d.total ?? out.length;
        if (!d.items?.length) break; // กันวนไม่รู้จบถ้า backend คืน total เพี้ยน
      }
      partsRef.current = out;
      return out;
    } catch (e) {
      console.warn("refreshParts:", e);
      return partsRef.current;
    }
  }


  async function loadMeasurementsPage(page = measPage, alpl = measFilterAlplRef.current, date = measFilterDate) {
    const params: Record<string, string | number> = { limit: MEAS_PAGE_SIZE, offset: (page - 1) * MEAS_PAGE_SIZE };
    if (alpl) params.number_alpl = alpl;
    if (date) {
      params.date_from = `${date} 00:00:00`;
      params.date_to = `${date} 23:59:59`;
    }
    try {
      const d = await apiGet<{ items: Measurement[]; total: number }>("/api/measurements", params);
      setMeasurements(d.items ?? []);
      setMeasTotal(d.total ?? 0);
    } catch (e) {
      console.warn("loadMeasurementsPage:", e);
    }
  }

  async function updateStats(sid: number | null) {
    const request = ++statsRequestRef.current;
    if (isTelemetryCleared()) { setStats({ total: 0, ok: 0, ng: 0 }); return; }
    if (sid == null) {
      setStats({ total: 0, ok: 0, ng: 0 });
      return;
    }
    try {
      const review = reviewDisplayRef.current;
      if (review) {
        const queue = displayQueueRef.current;
        const sessionIds = [...new Set([...queue.map(q => q.sessionId), review.sessionId].filter((id): id is number => id != null))];
        const rows = await Promise.all(sessionIds.map(async sessionId => ({ sessionId,
          items: (await apiGet<{ items: Telemetry[] }>("/api/measurements", { session_id: sessionId, limit: 1000 })).items,
        })));
        if (request !== statsRequestRef.current || reviewDisplayRef.current !== review || isTelemetryCleared()) return;
        // Every chip is scoped to its own session; never use a global ALPL search.
        setQueueStrip(queue.map((q, index) => {
          const replacement = index !== review.queueIndex ? undefined : review.updateExisting
            ? (review.completed || sessionRef.current.measured_count >= 1
                ? rows.find(r => r.sessionId === review.originSessionId)?.items.find(m => m.measurement_id === review.measurementId)
                : undefined)
            : rows.find(r => r.sessionId === review.sessionId)?.items.find(m => m.number_alpl === q.alpl);
          const measurement = replacement ?? rows.find(r => r.sessionId === q.sessionId)?.items.find(m => m.number_alpl === q.alpl);
          if (!measurement) return q;
          resultsRef.current[index] = measurement.result;
          if (replacement && JSON.stringify(latestTelemetryRef.current) !== JSON.stringify(replacement)) {
            latestTelemetryRef.current = replacement;
            if (selectedQueueRef.current === null || selectedQueueRef.current === index) applyTelemetry(replacement);
          }
          return { ...q, sessionId: replacement && !review.updateExisting ? review.sessionId! : q.sessionId, state: chipStateFor(index) };
        }));
        const items = displayQueueRef.current;
        setStats({ total: items.filter(q => ["ok", "ng", "done"].includes(q.state)).length,
          ok: items.filter(q => q.state === "ok").length, ng: items.filter(q => q.state === "ng").length });
        savePartEntryState();
        return;
      }
      const [totalD, okD, ngD] = await Promise.all([
        apiGet<{ total: number }>("/api/measurements", { session_id: sid, limit: 1 }).catch(() => ({ total: 0 })),
        apiGet<{ total: number }>("/api/measurements", { session_id: sid, result: "OK", limit: 1 }).catch(() => ({ total: 0 })),
        apiGet<{ total: number }>("/api/measurements", { session_id: sid, result: "NG", limit: 1 }).catch(() => ({ total: 0 })),
      ]);
      // เช็คธงอีกรอบ "หลัง await" — ผู้ใช้อาจกด Clear ระหว่างที่ fetch ยังค้างอยู่
      // ถ้าไม่เช็ค response ที่มาถึงทีหลังจะเขียนทับของที่เพิ่งล้าง
      if (request !== statsRequestRef.current) return;
      if (isTelemetryCleared()) { setStats({ total: 0, ok: 0, ng: 0 }); return; }
      setStats({ total: totalD.total ?? 0, ok: okD.total ?? 0, ng: ngD.total ?? 0 });
    } catch (e) {
      console.warn("updateStats:", e);
    }
  }

  /** โหลดข้อมูลตั้งต้นของ dropdown ทั้งหมด — เรียกครั้งเดียวตอน mount
   *
   *  ⚠ เดิมทุกเส้นเป็น `apiGet(...).catch(() => [])` ซึ่งมีปัญหา 2 ข้อ
   *
   *    1. **ไม่ลองใหม่เลย** ยิงครั้งเดียวจบ · ถ้ารีสตาร์ททั้งระบบแล้วเปิดเว็บ
   *       ก่อน MySQL บูตเสร็จ จะได้ 503 แล้วจบเลย dropdown ว่างค้างจนกว่า
   *       ผู้ใช้จะกด F5 เอง (และไม่มีอะไรบอกว่าต้องกด)
   *
   *    2. **`[]` ทำให้ "โหลดไม่ได้" หน้าตาเหมือน "ตารางว่างจริง" เป๊ะ**
   *       ผู้ใช้เห็น Operator ว่างแล้วเข้าใจว่ายังไม่มีใครลงทะเบียน ทั้งที่มี
   *       อยู่ใน DB ครบ · และ autofill ALPL จะบอกว่า Handler "ไม่มีในระบบ"
   *       ซึ่งชี้ไปผิดที่ทั้งหมด
   *
   *  `apiGetRetry` แก้ทั้งสองข้อ — **ลองใหม่ไปเรื่อย ๆ จนกว่าจะได้** (หน่วง
   *  1→2→4→8→8... วิ) และรายงานผ่าน `setDropdownFailed` ทันทีที่พลาดครั้งแรก
   *  เพื่อให้ผู้ใช้รู้ตัวระหว่างที่ระบบยังพยายามอยู่เบื้องหลัง
   *
   *  ⚠ ไม่จำกัดจำนวนครั้ง จึง **ต้องส่ง `signal` เสมอ** — effect ที่เรียก
   *    ฟังก์ชันนี้ abort ให้ตอน unmount (ดู useEffect ท้ายไฟล์) ไม่งั้นลูปจะ
   *    เดินต่อหลังสลับไปหน้า Edit แล้วค้างอยู่ตลอดอายุแท็บ
   */
  async function loadDropdownData(signal?: AbortSignal) {
    // พลาดครั้งไหนก็ขึ้นเตือนทันที ไม่ต้องรอให้ครบทุกเส้น — ระหว่างนั้นระบบ
    // ยังลองต่ออยู่เบื้องหลัง พอได้ครบธงจะถูกล้างเองด้านล่าง
    const onFail = () => setDropdownFailed(true);
    const [operators, owners, vendors, packageSizes, partNumbers] = await Promise.all([
      apiGetRetry<{ operator_name: string }>("/api/operators", { signal, onFail }),
      apiGetRetry<{ owner_name: string }>("/api/owners", { signal, onFail }),
      apiGetRetry<{ vendor_name: string }>("/api/vendors", { signal, onFail }),
      apiGetRetry<{ package_size: string; handlers: string[] }>("/api/package-sizes", { signal, onFail }),
      // catalog part number พร้อม package size — ใช้กรอง Part Number ตามขนาด
      // ที่เลือกในกลุ่มนั้น (cascade) ดู partNumbersFor ที่ส่งให้ PartEntryModal
      apiGetRetry<{ part_number_name: string; package_size: string; handler: string }>(
        "/api/part-numbers/all", { signal, onFail }),
    ]);

    // ถูก abort (ผู้ใช้สลับหน้าไปแล้ว) — อย่าแตะ state ของ component ที่ตายแล้ว
    if (signal?.aborted) return;

    // มาถึงบรรทัดนี้โดยไม่ถูก abort = ทุกเส้นสำเร็จ (ไม่งั้นมันยังวนอยู่)
    // → ล้างธงให้กล่องเตือนหายไปเอง ผู้ใช้ไม่ต้องกดรีเฟรช
    setDropdownFailed(false);

    setOperatorOptions((operators ?? []).map((o) => o.operator_name));
    setOwnerOptions((owners ?? []).map((o) => o.owner_name));
    setVendorOptions((vendors ?? []).map((v) => v.vendor_name));
    setPackageSizeOptions((packageSizes ?? []).map((p) => p.package_size));
    setPackageSizeCatalog(packageSizes ?? []);
    setPartNumberCatalog(partNumbers ?? []);
  }

  /* ── ผล poll เปลี่ยน → อัปเดตหน้าจอ ──────────────────────────────────────
     เดิมหน้านี้ตั้ง `setInterval(loadSessionState, 5000)` ยิง /api/session/state
     เองอีกเส้น **ทั้งที่ useSessionState() ยิงเส้นเดียวกันอยู่แล้ว** และเพราะมัน
     เป็น apiGet ดิบ TanStack จึง dedupe ให้ไม่ได้ ผลคือ

       · ตอน running ยิงซ้ำสองทาง (1 วิ + 5 วิ) โดยไม่รู้จักกัน
       · หน้านี้ถือ session อยู่ 2 ชุดที่มาถึงคนละเวลา — มีจังหวะที่ป้ายบนแถบ
         กับแถบคิวข้างล่างพูดไม่ตรงกัน

     ตอนนี้เหลือทางเดียว และดีกว่าเดิมตรงที่ **ทำงานเมื่อข้อมูลเปลี่ยนจริงเท่านั้น**
     ไม่ใช่ทำตามนาฬิกา (ดู sessionSig ว่าอะไรนับว่า "เปลี่ยน")                */
  // updateSession: merge ค่าใหม่เข้ากับ session เดิม + เช็คว่าคิว Part Entry
  // ที่ค้างอยู่ "หมดอายุ" ไปแล้วหรือยัง (ผูกกับ session_id ที่จบไปแล้ว) —
  // เทียบ session_id ตรงๆ แทนการเช็คแค่ transition สด เพื่อครอบคลุมเคส
  // เปิดหน้า/refresh หลัง session จบไปแล้ว (ดู comment เดิมใน index.html)
  function updateSession(data: Partial<SessionState>) {
    const merged = { ...sessionRef.current, ...data } as SessionState;
    setSession(merged);
    sessionRef.current = merged;

    const queue = entryQueueRef.current;
    const queueIsStale = !!queue && queue.session_id != null && !(merged.state === "running" && merged.session_id === queue.session_id);
    if (queueIsStale) {
      clearAllQueuesAndForms();
    }
    updateStats(merged.session_id);
  }

  function clearAllQueuesAndForms() {
    // ฟอร์มถูกล้างเองตอนปิด modal (state อยู่ใน PartEntryModal) — ตรงนี้เหลือแค่
    // ล้างคิวที่ค้างอยู่ ต่างจากเดิมที่ต้องรีเซ็ต state ของ 3 ฟอร์มทีละตัว
    setEntryQueue(null);
    entryQueueRef.current = null;
    savePartEntryState();
    // เดิมมี setEntryMode(null) ตรงนี้ — ลบทิ้งแล้วเพราะ state ตัวนั้นถูกเขียน
    // อย่างเดียว ไม่มีใครอ่านเลย (ซากจากตอนที่ยังแยกฟอร์มเป็น 3 โหมด)
  }

  function resetTelemetry() {
    latestTelemetryRef.current = null;
    followLatestTelemetry();
    applyTelemetry(null);
    setCameraImgUrl(null);
    applyLastImageId(null);
    savePartEntryState();
  }

  /** ปุ่ม 🧹 Clear ของ Live Telemetry — ล้างเฉพาะสิ่งที่แสดงบนจอ
   *
   *  ไม่แตะฐานข้อมูลเลย ผลวัดที่บันทึกไปแล้วยังอยู่ครบในตาราง Measurements
   *  ด้านล่าง · ล้างแถบคิวกับตัวนับด้วยเพื่อให้ทั้งการ์ดกลับไปเป็นสภาพว่าง
   *  พร้อมกัน ไม่ใช่ล้างครึ่งเดียวแล้วเหลือของค้างดูสับสน
   */
  function clearTelemetry() {
    reviewDisplayRef.current = null;
    displaySessionIdRef.current = sessionRef.current.session_id;
    statsRequestRef.current += 1;
    resetTelemetry();
    resultsRef.current = [];
    setQueueStrip([]);
    setStats({ total: 0, ok: 0, ng: 0 });
    // ตั้งธงไว้ ไม่งั้น poll รอบถัดไปเติมคิว/สถิติกลับมาภายใน 5 วิ
    clearedSidRef.current = sessionRef.current.session_id ?? null;
    savePartEntryState();
  }

  /** ปุ่ม 🧹 Clear ของ Part Entry — ล้างคิวที่กรอกไว้ทั้ง 3 โหมด
   *
   *  ล้าง localStorage ด้วย ไม่งั้นรีเฟรชหน้าแล้วคิวเก่าจะกลับมาเอง —
   *  ผู้ใช้กด Clear แล้วเห็นของหาย พอ refresh กลับมาใหม่จะงงหนัก
   */
  /* Part Entry ถามยืนยันก่อนล้าง — กรอกใหม่เสียเวลากว่ามาก โดยเฉพาะตอนมีหลาย
     กลุ่ม (ต่างจาก Clear ของ Live Telemetry ที่ไม่ถาม เพราะกดดูย้อนหลังได้
     ทันทีจากตาราง Measurements ด้านล่าง ไม่มีอะไรหายจริง) */
  async function clearPartEntry() {
    if (!await dialog.confirm(
      <>
        คิวที่กรอกไว้จะถูกล้างทิ้ง ต้องกรอกใหม่ก่อนกด Start
        <br />
        <span style={{ color: "var(--muted)" }}>ไม่กระทบข้อมูลที่บันทึกลงฐานข้อมูลแล้ว</span>
      </>,
      { title: "ล้างข้อมูล Part Entry", okLabel: "🧹 ล้างข้อมูล", danger: true },
    )) return;
    setEntryQueue(null);
    entryQueueRef.current = null;
    savePartEntryState();
  }

  // ── SSE handlers ───────────────────────────────────────────────────
  /** สร้าง/อัปเดตแถบคิวจาก queue_state ที่ backend แนบมากับ session/state
   *
   *  ⚠ ตำแหน่งปัจจุบันใช้ measured_count เป็นตัวชี้ ไม่ได้ถาม Pi — เพราะ Pi
   *    ไม่รู้ด้วยซ้ำว่ากำลังวัด ALPL ตัวไหน (backend เป็นคนจับคู่จากตำแหน่งใน
   *    คิวของตัวเอง ดู session_queues ใน main.py)
   */
  function syncQueueStrip(st: any) {
    // Session วัดซ้ำแบบชิ้นเดียวใช้ Queue เดิมของหน้าจอเป็นหลัก
    if (reviewDisplayRef.current) return;
    // ผู้ใช้กด 🧹 Clear ไว้ — ต้องค้างว่างไว้ ไม่ใช่โหลดกลับมาใหม่
    if (isTelemetryCleared()) { setQueueStrip([]); return; }

    // Keep measured entries after completion, Stop, or timeout. Only a new
    // normal Start (or explicit Clear) replaces the display queue.
    const raw = st?.queue_state;
    if (!raw) { setQueueStrip([]); return; }
    let q: any = null;
    try { q = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
    const list: number[] = q?.queue ?? q?.alpl ?? (q?.groups ?? []).flatMap((g: any) => g.alpl ?? []);
    if (!Array.isArray(list) || list.length === 0) { setQueueStrip([]); return; }
    const done = st?.measured_count ?? 0;
    setQueueStrip(
      list.map((alpl, i) => ({
        alpl,
        sessionId: st.session_id,
        // ผลของชิ้นที่วัดไปแล้วมาจาก resultsRef ที่สะสมจาก SSE (+ กู้จาก
        // localStorage ตอน mount) — ถ้ายังไม่รู้ผลจริงๆ chipStateFor คืน "done"
        state: i < done ? chipStateFor(i)
             : i === done && st?.state === "running" ? "now"
             : "wait",
      })),
    );
    savePartEntryState();
  }

  function prepareDisplaySession(st: any) {
    if (st.session_id == null) return;
    let q = st.queue_state;
    try { if (typeof q === "string") q = JSON.parse(q); } catch { q = null; }
    // A session row exists before Pi accepts Start. Failed Starts must not
    // replace the previous display queue just because polling saw that row.
    if (q?.start_confirmed === false) return false;
    const source = q?.review_source;
    const review = reviewDisplayRef.current;
    if (review?.sessionId === st.session_id) return;
    if (source) {
      const index = review?.pendingStart && review.measurementId === source.measurement_id
        ? review.queueIndex
        : displayQueueRef.current.findIndex(item => item.alpl === source.number_alpl && item.sessionId === source.session_id);
      if (index >= 0) {
        reviewDisplayRef.current = { sessionId: st.session_id, originSessionId: source.session_id,
          queueIndex: index, measurementId: source.measurement_id, pendingStart: false, completed: false,
          updateExisting: !!source.update_existing };
        savePartEntryState();
        return;
      }
    }
    if (displaySessionIdRef.current === st.session_id) return;
    // One reset per successful normal Start, regardless of whether SSE, polling,
    // or the POST response arrives first. A late response cannot erase new results.
    reviewDisplayRef.current = null;
    displaySessionIdRef.current = st.session_id;
    resultsRef.current = [];
    setQueueStrip([]);
    clearedSidRef.current = null;
    setStats({ total: 0, ok: 0, ng: 0 });
    resetTelemetry();
  }

  function onSessionStarted(d: any) {
    if (prepareDisplaySession(d) === false) return;
    if (sessionRef.current.session_id === d.session_id) return;
    setReviewPhase("running");
    const started = { ...d, state: "running", measured_count: 0 };
    syncQueueStrip(started);
    updateSession(started);
  }
  async function ensureMeasurementSession(d: any) {
    if (d.session_id !== sessionRef.current.session_id) {
      // The agent can publish its first result before Start's HTTP response/SSE.
      // Fetch its queue metadata before mapping the result to the display queue.
      const current = await apiGet<SessionState>("/api/session/state");
      if (current.session_id !== d.session_id) return false;
      // A saved measurement itself confirms that the agent started, even if
      // its Start acknowledgement has not reached the backend yet.
      const q = typeof current.queue_state === "string" ? JSON.parse(current.queue_state) : current.queue_state;
      prepareDisplaySession({ ...current, queue_state: { ...q, start_confirmed: true } });
      syncQueueStrip(current);
      updateSession(current);
    }
    return true;
  }
  async function onNewMeasurement(d: any) {
    if (!await ensureMeasurementSession(d)) return;
    const review = reviewDisplayRef.current;
    // มีของใหม่จริงแล้ว → ปลดธง "ล้างจอไว้" ให้จอกลับมาแสดงตามปกติเอง
    clearedSidRef.current = null;

    // ⚠ ค่ามาถึงระหว่างที่ modal เปิดรอคำตอบอยู่ (FTP ส่งช้ากว่า MEASURE_TIMEOUT
    //   แต่มาถึงจริง) → ปิด modal ทิ้งเงียบ ๆ เพราะคำถามหมดความหมายแล้ว
    //   ถ้าไม่ปิด ผู้ใช้อาจกด "รับค่าจาก Pi" ทั้งที่ค่าลง DB ไปแล้ว → 2 แถวต่อ
    //   ชิ้นเดียว → position ขยับ 2 → ALPL เลื่อนทั้งคิว
    //   (Pi เช็ค measured_count ซ้ำก่อน POST อยู่แล้ว — ตัวนี้เป็นชั้นกันที่สอง
    //    และทำให้ผู้ใช้ไม่ต้องมานั่งงงว่าจะกดอะไรดี)
    // ⚠ ห้ามเรียก showToast() ข้างใน updater ของ setMtModal — updater ต้องเป็น
    //   ฟังก์ชันบริสุทธิ์ StrictMode เรียกมัน **2 ครั้ง** ตอน dev (toast เด้ง 2 อัน)
    //   และการ setState ของ ToastProvider ระหว่างที่ DashboardPage กำลัง render
    //   ทำให้ React โยน "Cannot update a component while rendering a different one"
    //   อ่านค่าปัจจุบันจาก closure ได้อยู่แล้ว เพราะ useSSE เก็บ handler ล่าสุด
    //   ไว้ใน ref (อัปเดตทุก render)
    if (mtTimerRef.current) { window.clearInterval(mtTimerRef.current); mtTimerRef.current = null; }
    if (mtModal) {
      showToast("ค่ามาถึงแล้ว — ปิดคำถามอัตโนมัติ", undefined, "success");
      setMtModal(null);
    }

    if (review && review.sessionId === d.session_id) {
      resultsRef.current[review.queueIndex] = d.result;
      setQueueStrip(prev => prev.map((q, i) => i === review.queueIndex
        ? { ...q, sessionId: d.session_id, state: chipStateFor(i) } : q));
      latestTelemetryRef.current = d;
      if (selectedQueueRef.current === null || selectedQueueRef.current === review.queueIndex) applyTelemetry(d);
      updateSession({ measured_count: d.measured, target_count: d.target });
      savePartEntryState();
      await loadMeasurementsPage();
      return;
    }
    updateSession({ measured_count: d.measured, target_count: d.target });
    latestTelemetryRef.current = d;
    if (selectedQueueRef.current === null) applyTelemetry(d);
    // เก็บผลรายชิ้นไว้ระบายสีชิปในแถบคิว — d.measured คือลำดับที่ 1..n
    if (d.measured > 0) resultsRef.current[d.measured - 1] = d.result;
    setQueueStrip((prev) =>
      prev.map((q, i) =>
        i < d.measured ? { ...q, state: chipStateFor(i) }
        : i === d.measured ? { ...q, state: "now" as const }
        : q,
      ),
    );
    savePartEntryState();
    updateStats(sessionRef.current.session_id);
    if (measPage === 1 && !measFilterAlplRef.current && !measFilterDate) {
      await loadMeasurementsPage(1, "", measFilterDate);
      setHighlightId(d.measurement_id);
      window.setTimeout(() => setHighlightId((h) => (h === d.measurement_id ? null : h)), 2600);
    }
  }
  async function onMeasurementReplaced(d: any) {
    if (!await ensureMeasurementSession(d)) return;
    const review = reviewDisplayRef.current;
    const index = review?.queueIndex ?? d.piece - 1;
    resultsRef.current[index] = d.result;
    setQueueStrip(prev => prev.map((q, i) => i === index ? { ...q, state: chipStateFor(i) } : q));
    if (review || latestTelemetryRef.current?.measurement_id === d.measurement_id) latestTelemetryRef.current = d;
    if (telemetryRef.current?.measurement_id === d.measurement_id || (review && selectedQueueRef.current === null)) applyTelemetry(d);
    if (mtTimerRef.current) { window.clearInterval(mtTimerRef.current); mtTimerRef.current = null; }
    setMtModal(null);
    if (review) updateSession({ measured_count: d.measured, target_count: d.target });
    savePartEntryState();
    updateStats(d.session_id);
    await loadMeasurementsPage();
  }
  function onMeasureTimeout(d: any) {
    setMtModal(d);
    setMtLeft(MT_ANSWER_TIMEOUT);
    // คำถามใหม่ = เริ่มนับใหม่ · ไม่งั้นความล้มเหลวจากชิ้นก่อนหน้าจะสะสมข้ามชิ้น
    // แล้วเด้ง dialog "เครื่องไม่ตอบสนอง" ตั้งแต่กดพลาดครั้งแรกของชิ้นใหม่
    mtFailRef.current = 0;
    if (mtTimerRef.current) window.clearInterval(mtTimerRef.current);

    // ⚠ นับถอยหลังด้วยตัวแปรใน closure ไม่ใช่ค่าใน updater ของ setMtLeft —
    //   ของเดิมเรียก resolveMeasureTimeout() (ซึ่ง setState หลายตัว + ยิง fetch)
    //   อยู่ข้างใน updater ที่ต้องเป็นฟังก์ชันบริสุทธิ์ StrictMode เรียก updater
    //   2 ครั้งตอน dev → หยุด session ซ้อนกัน 2 ครั้ง
    let left = MT_ANSWER_TIMEOUT;
    mtTimerRef.current = window.setInterval(() => {
      left -= 1;
      setMtLeft(left);
      if (left <= 0) {
        if (mtTimerRef.current) { window.clearInterval(mtTimerRef.current); mtTimerRef.current = null; }
        resolveMeasureTimeout("stop");
      }
    }, 1000);
  }

  /** เครื่องหน้างานรายงานว่าเกิดอะไรขึ้น (Pi หรือ Recieve_tm-x.py)
   *
   *  ⚠ **ไม่ใช่ตัวที่เด้ง modal** — modal มาจาก `measure_timeout` เท่านั้น
   *    ตัวนี้คือการ "แจ้งให้รู้" เฉย ๆ บางเรื่องแจ้งแล้วจบ ไม่มีใครต้องตอบ
   *    (เช่น IMAGE_UPLOAD_FAILED ที่ค่าลง DB ไปแล้ว แค่รูปไม่ขึ้น)
   *
   *  ก่อนหน้านี้ backend ยิง event นี้ออกมาตลอดแต่ **ไม่มีใครรับ** — สาเหตุ
   *  ของปัญหาเดินทางไปถึงเบราว์เซอร์แล้วตกพื้นเงียบ ๆ ทุกครั้ง
   */
  function onStationEvent(d: any) {
    const detail = d?.detail ? `: ${d.detail}` : "";
    showToast(`⚠ ${d?.event ?? "STATION_EVENT"}${detail}`, undefined,
      d?.type === "warning" ? "warning" : d?.type === "success" ? "success" : "error");
  }
  function onMcuDisconnected(d: any) {
    setMcuModal(d);
    mcuFailRef.current = 0;   // คำถามใหม่ = เริ่มนับความล้มเหลวใหม่ เหมือน mtFailRef
  }

  // ⚠ ถอด "ข้ามชิ้นนี้" (action `continue`) ออกแล้ว — 22 ส.ค. 2569
  //   `Pi.py` ไม่เคยรองรับ action นั้นเลย (ตอบ 400) กดแล้ว backend ขยับตำแหน่ง
  //   คิวไปเรียบร้อยแต่สั่ง Pi ไม่ผ่าน → คิวเหลื่อมหนึ่งช่องถาวรโดยไม่มีใครรู้
  async function resolveMeasureTimeout(action: "stop" | "retry" | "accept") {
    if (mtTimerRef.current) { window.clearInterval(mtTimerRef.current); mtTimerRef.current = null; }
    const sid = mtModal?.session_id ?? null;
    setMtModal(null);
    if (sid == null) return;

    // เลือกหยุด (หรือหมดเวลา) → วิ่งเข้า POST /api/session/stop เส้นเดียวกับ
    // ปุ่ม Stop ทุกประการ ตั้งใจไม่ให้มีทางที่สองที่ปิด session ได้
    //
    // ⚠ เรียก `doStopSession` ไม่ใช่ `stopSession` — ตัวหลังมี dialog ถามยืนยัน
    //   ซึ่งผิดทั้ง 2 กรณีที่มาถึงตรงนี้: หมดเวลา 60 วิ (ไม่มีคนอยู่ให้กด → ค้าง
    //   ตลอดกาล ไม่มีอะไรหยุดเลย) และกด "หยุดการวัด" ในโมดัล (เพิ่งเลือกไปหมาด ๆ)
    //   ⚠ ส่ง sid ของโมดัลไปด้วย ไม่ใช้ `session.session_id` จาก state เพราะ
    //     closure อาจถือค่าเก่าอยู่ ณ จังหวะที่ timer ยิง
    if (action === "stop") { await doStopSession(sid); return; }

    try {
      await apiPost(`/api/session/${action}`, { session_id: sid });
      mtFailRef.current = 0;        // ส่งผ่านแล้ว เริ่มนับใหม่
    } catch (e: any) {
      // 502 = backend ยิง /command ไปแล้วแต่ Pi ไม่รับ — Pi ยังบล็อกรอคำตอบอยู่
      // เฉย ๆ ไม่มีอะไรเดินหน้า ถ้าเงียบไว้ผู้ใช้จะยืนรอเครื่องที่ไม่มีวันขยับ
      // (backend คืนคำถามค้างให้แล้ว กดซ้ำได้)
      mtFailRef.current += 1;

      /* ── 2 ครั้งแรกให้ลองใหม่ · ครั้งที่ 3 เลิกแนะนำให้กดซ้ำ ────────────────
         อาจเป็นเน็ตสะดุดชั่วคราวจริง ๆ จึงควรให้โอกาสก่อน — แต่ถ้าพลาด 3 ครั้ง
         ติดกันแปลว่าเครื่องไม่ตอบสนองแล้ว **กดอีกกี่ครั้งก็ไม่มีทางสำเร็จ**
         ต้องเปลี่ยนคำแนะนำจาก "กดใหม่" เป็น "ไปจัดการที่เครื่อง" ไม่งั้นผู้ใช้
         จะกดวนอยู่จนกว่า backend จะ mark timeout เอง (5-20 วิ) โดยไม่รู้ว่า
         ควรทำอะไรต่อ

         ใช้ dialog ไม่ใช่ toast เพราะต้องกดรับทราบ — เป็นคำแนะนำที่ต้องลงมือทำ
         ไม่ใช่แค่รายงานสถานะ (กติกาเดียวกับกรณี Stop สั่งไม่ผ่าน)            */
      if (mtFailRef.current >= 3) {
        dialog.alert(
          `ส่งคำตอบไปที่เครื่องไม่สำเร็จ ${mtFailRef.current} ครั้งติดกัน\n\n${e?.message ?? ""}\n\n` +
          `เครื่องไม่ตอบสนองแล้ว — กด Stop แล้วทำการ Restart Raspberry Pi ` +
          `(ถอดสายไฟแล้วเสียบใหม่ โปรแกรมจะรันเองตอนเปิดเครื่อง)`,
          { title: "⚠ เครื่องไม่ตอบสนอง", danger: true },
        );
      } else {
        showToast(`ส่งคำตอบไม่สำเร็จ: ${e?.message ?? ""} — กดใหม่อีกครั้ง หรือกด Stop`);
      }
    }
  }

  /** ตอบ modal "ถาดเต็ม" — วัดต่อ หรือ หยุด
   *
   *  ⚠ ปิด modal **หลัง** request สำเร็จเท่านั้น ต่างจาก `resolveMeasureTimeout`
   *    ที่ปิดก่อนได้เพราะมีตัวนับถอยหลังบังคับปิดอยู่แล้ว · ตัวนี้ถ้าปิดไปก่อน
   *    แล้วคำสั่งส่งไม่ถึง Pi ผู้ใช้จะเหลือหน้าจอเปล่าที่ไม่มีปุ่มอะไรให้กด
   *    ทั้งที่เครื่องยังยืนรอคำตอบอยู่จริง — ไม่มีทางไปต่อนอกจากกด Stop
   */

  
  async function resolveTrayFull(action: "resume" | "stop") {
    const sid = trayModal?.session_id ?? null;
    if (sid == null) { setTrayModal(null); return; }

    // หยุด = เดินเส้นทางเดียวกับปุ่ม Stop ทุกประการ (ทางหยุด session มีทางเดียว)
    if (action === "stop") { setTrayModal(null); await doStopSession(sid); return; }

    try {
      await apiPost("/api/session/resume", { session_id: sid });
      setTrayModal(null);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      // 404 = คำถามหมดอายุ (session ถูกหยุดจากที่อื่นไปแล้ว) — ปิด modal ได้เลย
      //       ไม่มีใครรออยู่แล้ว ค้างไว้มีแต่ให้กดแล้วได้ 404 ซ้ำ ๆ
      if (msg.includes("404")) {
        setTrayModal(null);
        showToast("session นี้ถูกหยุดไปแล้ว");
        return;
      }
      // 502 = backend ยิง /command ไปแล้วแต่ Pi ไม่รับ — Pi ยังบล็อกรออยู่จริง
      //       ต้องคง modal ไว้ให้กดซ้ำได้ ไม่งั้นเครื่องค้างโดยไม่มีทางสั่งต่อ
      showToast(`สั่งวัดต่อไม่สำเร็จ: ${msg} — กดใหม่อีกครั้ง หรือกดหยุดการวัด`);
    }
  }

  async function resolveMcuDisconnected(action: "retry" | "stop") {
    const sid = mcuModal?.session_id ?? null;
    if (sid == null) { setMcuModal(null); return; }

    if (action === "stop") { setMcuModal(null); await doStopSession(sid); return; }

    try {
      await apiPost("/api/session/mcu-retry", { session_id: sid });
      // Pi อาจแจ้งล้มเหลวรอบใหม่ก่อน response นี้กลับมา อย่าปิดคำถามใหม่
      setMcuModal((current) => current === mcuModal ? null : current);
      mcuFailRef.current = 0;
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (msg.includes("404")) {
        setMcuModal(null);
        showToast("session นี้ถูกหยุดไปแล้ว");
        return;
      }
      mcuFailRef.current += 1;
      if (mcuFailRef.current >= 3) {
        dialog.alert(
          `สั่งลองใหม่ไม่สำเร็จ ${mcuFailRef.current} ครั้งติดกัน\n\n${msg}\n\n` +
          `ตรวจสอบสาย/การเชื่อมต่อ MCU ที่เครื่องจริง แล้วกด Stop ถ้ายังไม่หาย`,
          { title: "⚠ MCU ยังเชื่อมต่อไม่ได้", danger: true },
        );
      } else {
        showToast(`สั่งลองใหม่ไม่สำเร็จ: ${msg} — กดใหม่อีกครั้ง หรือกดหยุดการวัด`);
      }
    }
  }

  function onSessionStopped(d?: { agent_error?: string | null }) {
    const review = reviewDisplayRef.current;
    if (review && review.sessionId === sessionRef.current.session_id) {
      review.completed = true;
      setReviewPhase("complete");
    }
    updateSession({ state: "stopped" });
    clearAllQueuesAndForms();
    // session จบแล้ว ไม่มีใครรอคำตอบอีก — ถ้าไม่ปิด modal จะค้างบนจอโดยที่
    // กดปุ่มไหนก็ได้ 404 (backend ล้าง tray_pending ไปพร้อมกับ session แล้ว)
    setTrayModal(null);
    setMcuModal(null);   // ← เพิ่ม เหตุผลเดียวกัน
    setMtModal(null);
    if (mtTimerRef.current) { window.clearInterval(mtTimerRef.current); mtTimerRef.current = null; }
    savePartEntryState();

    // แท็บที่ **ไม่ได้เป็นคนกด Stop** ก็ต้องรู้ด้วยว่าเครื่องอาจยังวัดต่ออยู่
    // (คนกดได้เห็นจาก response ของตัวเองไปแล้วใน doStopSession)
    if (d?.agent_error) {
      dialog.alert(
        `session ถูกหยุดแล้ว แต่สั่งเครื่องไม่สำเร็จ\n\n${d.agent_error}\n\n` +
        `เครื่องอาจยังวัดต่ออยู่ — กรุณาตรวจที่เครื่อง`,
        { title: "⚠ ต้องไปหยุดที่เครื่อง", danger: true },
      );
    }
  }
  function onSessionComplete(d: any) {
    const review = reviewDisplayRef.current;
    if (review && review.sessionId === d.session_id) {
      review.completed = true;
      setReviewPhase("complete");
    }
    // เก็บ session_id ไว้ "ก่อน" clearAllQueuesAndForms() — ตัวนั้นล้าง state ทิ้ง
    const sid = d.session_id ?? sessionRef.current.session_id;
    setTrayModal(null);      // เหตุผลเดียวกับ onSessionStopped
    setMcuModal(null);
    setMtModal(null);
    if (mtTimerRef.current) { window.clearInterval(mtTimerRef.current); mtTimerRef.current = null; }
    updateSession({ state: "stopped", measured_count: d.measured, target_count: d.target });
    clearAllQueuesAndForms();
    savePartEntryState();
    if (!review) showIpmSummary(sid);
  }

  /** เด้งสรุปผลตอนวัดครบ — เฉพาะโหมด IPM
   *
   *  ⚠ เช็คโหมดจาก measure_type "ในข้อมูลที่ดึงมา" ไม่ใช่จาก state ipmQueue ฝั่ง
   *    หน้าเว็บ เพราะ state นั้นหายได้หลายทาง: refresh หน้ากลาง session · เปิด
   *    จากอีกเครื่อง · clearAllQueuesAndForms() ทำงานไปก่อนแล้ว — พอหายจะแยก
   *    ไม่ออกว่ารอบที่จบเป็นโหมดอะไร แล้ว popup จะไม่เด้งโดยไม่มีอะไรบอกสาเหตุ
   */
  async function showIpmSummary(sessionId: number | null | undefined) {
    if (sessionId == null) return;
    try {
      const d = await apiGet<{ items: any[] }>("/api/measurements", { session_id: sessionId, limit: 1000 });
      const items = d.items ?? [];
      if (!items.length || items[0].measure_type !== "IPM") return;
      // API เรียงใหม่→เก่า แต่ตารางต้องเรียงตามลำดับที่วัดจริง (เก่า→ใหม่)
      items.sort((a, b) => a.measurement_id - b.measurement_id);
      setIpmSummary(items.map((m) => ({ x: m.value_x, y: m.value_y })));
    } catch (e) {
      console.warn("showIpmSummary:", e);
    }
  }
  function onSessionTimeout() {
    const review = reviewDisplayRef.current;
    if (review && review.sessionId === sessionRef.current.session_id) {
      review.completed = true;
      setReviewPhase("complete");
    }
    updateSession({ state: "timeout" });
    clearAllQueuesAndForms();
    setTrayModal(null);
    setMcuModal(null);
    setMtModal(null);
    if (mtTimerRef.current) { window.clearInterval(mtTimerRef.current); mtTimerRef.current = null; }
    savePartEntryState();
  }
  async function onImageUpdated(d: any) {
    setMeasurements((prev) => prev.map((m) => (m.measurement_id === d.measurement_id ? { ...m, image_path: d.image_path, image_upload_failed: !!d.upload_failed } : m)));
    if (d.measurement_id !== telemetryRef.current?.measurement_id) return;
    if (d.upload_failed) {
      cameraRequestRef.current += 1;
      setCameraImgUrl(null);
      applyLastImageId(null);
      return;
    }
    await updateCameraPreview(d.measurement_id);
  }

  async function updateCameraPreview(measurementId: number) {
    const request = ++cameraRequestRef.current;
    try {
      const data = await apiGet<{ url: string }>(`/api/image-url/${measurementId}`);
      // ผู้ใช้อาจเปลี่ยนคิวก่อนคำขอเดิมตอบกลับ หรือมี image_updated ใหม่กว่า
      if (request !== cameraRequestRef.current || telemetryRef.current?.measurement_id !== measurementId) return;
      setCameraImgUrl(data.url);
      applyLastImageId(measurementId);
      savePartEntryState();
    } catch (e) {
      if (request !== cameraRequestRef.current) return;
      // ผลวัดอาจมาถึงก่อนรูป; รอ image_updated แล้วโหลดใหม่
      setCameraImgUrl(null);
      applyLastImageId(null);
      console.warn("updateCameraPreview:", e);
    }
  }

  // ปิดรูปเต็มจอด้วย Esc — ผูก listener เฉพาะตอนเปิดอยู่ จะได้ไม่ค้างไว้ทั้งหน้า
  useEffect(() => {
    if (!zoomImgUrl) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoomImgUrl(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomImgUrl]);

  // ── Mount: โหลดข้อมูลเริ่มต้น + restore localStorage + polling สำรอง ──────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PART_ENTRY_STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.entryQueue) { setEntryQueue(d.entryQueue); entryQueueRef.current = d.entryQueue; }
        if (d.lastTelemetry) {
          latestTelemetryRef.current = d.lastTelemetry;
          applyTelemetry(d.lastTelemetry);
        }
        // ⚠ ต้องกู้ผลรายชิ้น **ก่อน** ที่ผล poll ตัวแรกจะมาถึงแล้วเรียก
        //   syncQueueStrip — effect นั้นอ่าน resultsRef เพื่อระบายสีชิป
        //   (effect ของ mount ทำงานแบบ synchronous จึงเสร็จก่อน response แน่นอน)
        if (Array.isArray(d.results)) resultsRef.current = d.results;
        clearedSidRef.current = d.clearedSid ?? null;
        displaySessionIdRef.current = d.displaySessionId ?? d.lastTelemetry?.session_id ?? d.clearedSid ?? null;
        if (Array.isArray(d.displayQueue)) setQueueStrip(d.displayQueue);
        if (d.reviewDisplay && !d.reviewDisplay.pendingStart) reviewDisplayRef.current = d.reviewDisplay;
      }
    } catch (e) {
      console.warn("loadPartEntryState:", e);
    }

    // สถานะ session ไม่ต้องโหลดตรงนี้แล้ว — useSessionState() ยิงให้ตั้งแต่ render
    // แรก แล้ว effect ที่ผูกกับ sessionSig จะรับช่วงต่อเองตอน response มาถึง
    //
    // ⚠ `dropdownAbort` จำเป็นเพราะ loadDropdownData() ลองใหม่ไม่จำกัดจำนวนครั้ง
    //   ถ้าไม่ยกเลิกตอน unmount ลูปจะเดินต่อหลังผู้ใช้สลับไปหน้า Edit แล้ว
    //   ค้างยิงทุก 8 วิไปจนกว่าจะปิดแท็บ
    const dropdownAbort = new AbortController();
    (async () => {
      await Promise.all([
        loadMeasurementsPage(1, "", ""),
        refreshParts(),
        loadDropdownData(dropdownAbort.signal),
      ]);
    })();
    return () => dropdownAbort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore persisted display references above before handling cached poll data.
  useEffect(() => {
    if (!polledSession) return;
    if (prepareDisplaySession(polledSession) === false) return;
    syncQueueStrip(polledSession);
    updateSession(polledSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSig]);

  // ── Measurements filter/pagination handlers ───────────────────────────
  function onMeasSearchChange(value: string) {
    setMeasFilterAlplInput(value);
    if (measSearchTimer.current) window.clearTimeout(measSearchTimer.current);
    measSearchTimer.current = window.setTimeout(async () => {
      measFilterAlplRef.current = value.trim();
      setMeasPage(1);
      await loadMeasurementsPage(1, measFilterAlplRef.current, measFilterDate);
    }, 300);
  }
  async function onMeasDateChange(value: string) {
    setMeasFilterDate(value);
    setMeasPage(1);
    await loadMeasurementsPage(1, measFilterAlplRef.current, value);
  }
  async function onMeasClearFilter() {
    if (measSearchTimer.current) window.clearTimeout(measSearchTimer.current);
    setMeasFilterAlplInput("");
    measFilterAlplRef.current = "";
    setMeasFilterDate("");
    setMeasPage(1);
    await loadMeasurementsPage(1, "", "");
  }
  async function onMeasPrev() {
    if (measPage <= 1) return;
    const p = measPage - 1;
    setMeasPage(p);
    await loadMeasurementsPage(p, measFilterAlplRef.current, measFilterDate);
  }
  async function onMeasNext() {
    if ((measPage - 1) * MEAS_PAGE_SIZE + measurements.length >= measTotal) return;
    const p = measPage + 1;
    setMeasPage(p);
    await loadMeasurementsPage(p, measFilterAlplRef.current, measFilterDate);
  }

  // ══════════════════════════════════════════════════════════════════
  // Session Start / Stop
  // ══════════════════════════════════════════════════════════════════
  // สัดส่วนแถบ OK/NG — หารด้วย target_count ไม่ใช่ measured_count เพื่อให้ส่วน
  // ที่ "ยังไม่วัด" เหลือเป็นพื้นเทาให้เห็น (ถ้าหารด้วยที่วัดแล้วแถบจะเต็ม 100%
  // ตั้งแต่ชิ้นแรก แล้วมองไม่ออกว่าเหลืออีกกี่ชิ้น)
  // ถูกสั่งล้างไว้ → แถบต้องว่างด้วย ไม่งั้นแถบเขียวยังเต็มอยู่ทั้งที่ตัวเลขเป็นขีด
  const barTotal = isTelemetryCleared() ? 0 : (reviewDisplayRef.current ? queueStrip.length : session.target_count || stats.total || 0);
  const barOkPct = barTotal ? (stats.ok / barTotal) * 100 : 0;
  const barNgPct = barTotal ? (stats.ng / barTotal) * 100 : 0;

  const hasQueue = !!entryQueue;

  /* ── ทำไมเช็ค `!== "offline"` ไม่ใช่ `=== "online"` ──────────────────────
     `stationStatus` เริ่มต้นเป็น "connecting" เสมอ และเปลี่ยนเป็น "online"
     ก็ต่อเมื่อ `es.onopen` ทำงาน — แต่ตอนเปิดหน้าครั้งแรก แอปยิงคำขอพรวดเดียว
     เป็นสิบตัว (parts · measurements · lookup 5 ตัว · session/state) เบราว์เซอร์
     จำกัดการเชื่อมต่อต่อโดเมนไว้ราว 6 ช่อง **สาย SSE จึงต้องต่อคิว** กว่าจะเปิด

     ของเดิมใช้ `=== "online"` ผลคือปุ่ม Start ถูกล็อกค้างอยู่หลายวินาทีตอนเปิด
     หน้าครั้งแรก แล้วพอกด Save รอบต่อไปกลับปลดล็อกทันที (เพราะสายเปิดค้างแล้ว)
     — อาการที่หาสาเหตุยากมากเพราะดูเหมือนเกี่ยวกับปุ่ม Save ทั้งที่ไม่ใช่

     **"connecting" ไม่ใช่สถานะล้มเหลว** จึงไม่ควรบล็อก ปลอดภัยเพราะ `piOnline`
     แข็งแรงกว่าอยู่แล้ว — เป็น true ได้ก็ต่อเมื่อ poll สำเร็จ *และ* backend ตอบ
     ว่า Pi ยังมีชีวิต ซึ่งพิสูจน์ว่า backend ติดต่อได้แน่นอน ไม่ต้องรอสายที่สอง
     มายืนยันซ้ำ (กติกาเดียวกับป้ายสถานะใน Layout.tsx ที่แก้ไปแล้ว)          */
  const canStart =
    session.state !== "running" && stationStatus !== "offline" && !dbOffline && piOnline && hasQueue;
  const reviewUnavailable = dbOffline ? "DB Offline"
    : stationStatus === "offline" ? "Server Offline"
    : !piOnline ? "Pi Offline / Waiting for Pi"
    : reviewBusy || telemetryLoading ? "กำลังประมวลผล"
    : session.state === "running" && !!reviewDisplayRef.current ? "รอรอบวัดซ้ำนี้เสร็จก่อนเลือกวัดชิ้นอื่น"
    : session.state === "running" && reviewPhase !== "paused" ? "รอ Pi พักคิวและรับผล/รูปให้เรียบร้อยก่อน"
    : "";

  // ปุ่มต้องบอก "ติดอะไรอยู่" ไม่ใช่แค่กดไม่ได้เฉยๆ — ไม่งั้นผู้ใช้จะนึกว่าระบบพัง
  // แล้วไปไล่หาที่ฟอร์ม Part Entry ทั้งที่ปัญหาอยู่ที่เครื่อง
  // เรียง DB ก่อน Pi เพราะ DB ล่มแล้วกด Start ไม่ได้แน่นอนไม่ว่า Pi จะเป็นยังไง
  // (start_session ต้องเขียน session ลง DB ก่อน) และเป็นอย่างเดียวที่ผู้ใช้แก้เองได้
  // ⚠ ทุกเงื่อนไขใน canStart ต้องมีสาขาของตัวเองที่นี่ ไม่งั้นปุ่มจะถูกล็อก
  //   โดยที่ป้ายยังขึ้นว่าพร้อมใช้งาน — ของเดิม stationStatus ไม่มีสาขาเลย
  //   ปุ่มเลยขึ้น "▶ Start (IPM ×3)" ดูปกติทุกอย่างแต่กดไม่ได้ tooltip ก็ว่าง
  const startLabel =
    session.state === "running"   ? "▶ Start"
    : dbOffline                   ? "▶ Start (DB Offline)"
    : stationStatus === "offline" ? "▶ Start (Server Offline)"
    : piStatus === false          ? "▶ Start (Pi Offline)"
    : !piOnline                   ? "▶ Start (Waiting for Pi)"
    : entryQueue                  ? `▶ Start (${entryQueue.mode} ×${entryQueue.list.length})`
    :                               "▶ Start (กด Save ก่อน)";

  const startTitle =
    dbOffline                     ? "Backend ต่อฐานข้อมูลไม่ได้ — เริ่มการวัดไม่ได้เพราะต้องเขียน session ลง DB ก่อน · ตรวจว่า MySQL ทำงานอยู่ไหม"
    : stationStatus === "offline" ? "ขาดการเชื่อมต่อกับ Backend — ตรวจว่า uvicorn ยังรันอยู่ไหม · ลองรีเฟรชหน้าเว็บ"
    : piStatus === false          ? "ไม่ได้รับสัญญาณจาก Pi เกินเวลาที่กำหนด — ตรวจว่า Pi.py รันอยู่ไหม · สาย LAN"
    : !piOnline                   ? "ยังไม่เคยได้รับ heartbeat จาก Pi ตั้งแต่ Backend เริ่มทำงาน — รอสักครู่ ถ้าไม่หายให้ตรวจว่า Pi.py รันอยู่ไหม"
    : !hasQueue                   ? "ยังไม่มีคิวที่จะวัด — กรอกฟอร์ม Part Entry แล้วกด Save ก่อน"
    :                               "";

  // Operator / Measure Type ของ session ที่กำลังวัด — แกะจาก queue_state ที่
  // backend แนบมากับ /api/session/state (ไม่ได้เก็บเป็นคอลัมน์แยกในตาราง sessions)
  const qState = (session as any).queue_state;
  const parsedQueue = (() => {
    if (!qState) return null;
    try { return typeof qState === "string" ? JSON.parse(qState) : qState; } catch { return null; }
  })();
  // ⚠ `sessionOperator` ถูกถอดออกแล้ว — ชิป Operator ไม่ได้แสดงบนแถบ Session
  //   Control อีกต่อไป (ชื่อคนอยู่ในดรอปดาวน์สรุปของ Part Entry แล้ว) ถ้าวันหลัง
  //   ต้องใช้อีก เอา `parsedQueue?.operator ?? parsedQueue?.groups?.[0]?.operator`
  //   กลับมาได้เลย — `parsedQueue` ยังถูกแกะไว้ให้อยู่
  //
  // `sessionMode` ยังต้องมี! ไม่ได้ใช้แสดงผลแล้วก็จริง แต่ `telemetry-grid` ใช้
  // ตัดสินว่าจะซ่อนการ์ด Offset ไหม (โหมด IPM ไม่เอา offset มาตัดสิน OK/NG)
  const sessionMode = parsedQueue?.measure_mode ?? parsedQueue?.mode ?? null;

  // ── ผลรายแกนของค่าที่เพิ่งวัด ────────────────────────────────────────────
  const axX = axisInfo(telemetry?.value_x, telemetry?.nominal_x, telemetry?.upper_tol, telemetry?.lower_tol, telemetry?.ok_x);
  const axY = axisInfo(telemetry?.value_y, telemetry?.nominal_y, telemetry?.upper_tol, telemetry?.lower_tol, telemetry?.ok_y);


  async function startFromQueue() {
    const q = entryQueue;
    if (!q) return;

    // สรุปทีละกลุ่มก่อนยืนยัน — ผู้ใช้ต้องเห็นว่าชิ้นไหนอยู่กลุ่มไหน ไม่ใช่เห็น
    // แค่เลขรวมกันพรืดเดียว (กลุ่มคือสิ่งที่กำหนดว่า Part แต่ละตัวจะได้ config อะไร)
    const ok = await dialog.confirm(
      <>
        เริ่ม session ด้วยคิว <strong>{q.mode}</strong> จำนวน <strong>{q.list.length} ALPL</strong>
        <br />
        <br />
        {q.groups.map((g, gi) => {
          const bits = [g.package_size, g.part_number].filter(Boolean).join(" · ");
          return (
            <div key={gi}>
              กลุ่มที่ {gi + 1}: {formatAlplRanges(g.number_alpl)}
              {bits ? <span style={{ opacity: 0.7 }}> ({bits})</span> : null}
            </div>
          );
        })}
      </>,
      { title: "เริ่มการวัด", okLabel: "▶ เริ่มวัด" },
    );
    if (!ok) return;

    // payload แบบกลุ่ม — backend คลี่เป็นคิวเส้นเดียวเองพร้อมจำว่าชิ้นไหนอยู่
    // กลุ่มไหน (ดู _flatten_groups / _group_config_for) · Operator อยู่นอกกลุ่ม
    // เพราะใช้ร่วมกันทั้ง session
    // ⚠ `?? "auto"` จำเป็น — คิวที่ค้างอยู่ใน localStorage จากก่อนมีฟีเจอร์นี้
    //   จะไม่มี triggerMode ถ้าส่ง undefined ไป backend จะเห็นเป็นคีย์ที่หายไป
    //   แล้วฝั่ง Pi ตกไปใช้ default ของตัวเอง (auto) ซึ่งบังเอิญตรงกัน — แต่
    //   ตรงกันโดยบังเอิญไม่ใช่สิ่งที่ควรพึ่ง เขียนให้ชัดตรงนี้เลยดีกว่า
    const body = {
      Measure_Type: q.mode,
      Operator: q.operator,
      Trigger_Mode: q.triggerMode ?? "auto",
      Tray_Capacity: q.triggerMode === "manual" ? null : q.trayCapacity ?? null,
      groups: q.groups,
    };

    try {
      const data = await apiPost<SessionState>("/api/session/start", body);
      // ⚠ ผูก session_id กับคิว "ก่อน" เรียก updateSession() — ไม่งั้นการเช็คว่า
      //   คิวเก่าค้างอยู่ไหม (queueIsStale) จะเห็น session_id ไม่ตรงแล้วล้างคิว
      //   ที่เพิ่ง start ทิ้งทันที
      const bound = { ...q, session_id: data.session_id };
      setEntryQueue(bound);
      entryQueueRef.current = bound;
      savePartEntryState();
      onSessionStarted(data);
      if (sessionRef.current.state !== "running") clearAllQueuesAndForms();
      refreshParts();
    } catch (e) {
      dialog.alert(e instanceof ApiError ? e.message : "เริ่ม session ไม่สำเร็จ", { title: "เริ่มการวัดไม่สำเร็จ", danger: true });
    }
  }


  /** หยุด session จริง ๆ — **ไม่ถามยืนยัน**
   *
   *  ⚠ แยกออกจาก `stopSession()` เพราะบางเส้นทาง "ตัดสินใจไปแล้ว" ห้ามถามซ้ำ:
   *    • โมดัลนับถอยหลังครบ 60 วิ → มีไว้สำหรับตอน **ไม่มีคนอยู่** ถ้าเด้ง
   *      confirm ขึ้นมามันจะค้างรอคนกดตลอดกาล = ไม่มีอะไรหยุดเลย
   *    • ผู้ใช้กด "หยุดการวัด" ในโมดัล → เพิ่งเลือกไปหมาด ๆ ถามซ้ำไม่มีประโยชน์
   */
  async function doStopSession(sid?: number | null) {
    try {
      /* ⚠ ต้องอ่าน `agent_error` ในผลลัพธ์ด้วย — backend ตอบ 200 แม้สั่ง Pi ไม่ผ่าน
         เพราะฝั่ง DB หยุดสำเร็จจริง กดซ้ำก็ไม่ช่วยอะไร **catch จึงไม่ทำงาน**

         แต่ "สั่ง Pi ไม่ผ่าน" แปลว่า **เครื่องอาจยังวัดต่ออยู่จริง** ทั้งที่ระบบ
         บอกว่าจบแล้ว — ของจะไหลต่อโดยไม่มีใครบันทึก ซึ่งอันตรายกว่ากรณี Start
         พังมาก (ดูคอมเมนต์ใน stop_session ฝั่ง backend)

         backend บันทึก STOP_NOT_DELIVERED ลง DB และ broadcast SSE ไว้ให้แล้ว
         ขาดแค่ฝั่งนี้ที่ต้องเอามาบอกคน                                        */
      const r = await apiPost<{ ok: boolean; agent_error?: string | null }>(
        "/api/session/stop", { session_id: sid ?? session.session_id });

      if (r?.agent_error) {
        dialog.alert(
          `ระบบหยุด session ให้แล้ว แต่สั่งเครื่องไม่สำเร็จ\n\n${r.agent_error}\n\n` +
          `เครื่องอาจยังวัดต่ออยู่ และค่าที่วัดหลังจากนี้จะไม่ถูกบันทึก — ` +
          `กรุณาไปหยุดที่เครื่องเอง`,
          { title: "⚠ ต้องไปหยุดที่เครื่อง", danger: true },
        );
      }
    } catch (e) {
      dialog.alert(e instanceof ApiError ? e.message : "หยุด session ไม่สำเร็จ", { title: "หยุดการวัดไม่สำเร็จ", danger: true });
    }
  }

  /** ปุ่ม Stop บน Session Control — ถามยืนยันก่อน เพราะกดโดนง่ายระหว่างวัดอยู่ */
  async function stopSession() {
    if (!await dialog.confirm("หยุด session ที่กำลังวัดอยู่ตอนนี้",
                              { title: "หยุดการวัด", okLabel: "■ หยุด", danger: true })) return;
    await doStopSession();
  }


  function openPeModal() {
    setPeModalOpen(true);
  }







  // ══════════════════════════════════════════════════════════════════
  // Report modal (คลิกแถวในตาราง Measurements)
  // ══════════════════════════════════════════════════════════════════
  async function openReportModal(measurementId: number) {
    const m = measurements.find((x) => x.measurement_id === measurementId);
    if (!m) return;
    let part: Part | null = null;
    try {
      part = await apiGet<Part>(`/api/parts/${m.number_alpl}`);
    } catch {
      part = partsRef.current.find((p) => p.number_alpl === m.number_alpl) ?? null;
    }
    setReportModal({ measurement: m, part, imageUrl: null, imageState: m.image_path ? "loading" : "none" });
    if (m.image_path) {
      try {
        const data = await apiGet<{ url: string }>(`/api/image-url/${measurementId}`);
        setReportModal((prev) => (prev && prev.measurement.measurement_id === measurementId ? { ...prev, imageUrl: data.url, imageState: "ok" } : prev));
      } catch {
        setReportModal((prev) => (prev && prev.measurement.measurement_id === measurementId ? { ...prev, imageState: "none" } : prev));
      }
    }
  }

  const isRunning = session.state === "running";
  function partEntryForSession(st: SessionState, queued: EntryQueue | null): EntryQueue | null {
    if (st.state !== "running") return queued;
    let q = st.queue_state;
    try { if (typeof q === "string") q = JSON.parse(q); } catch { q = null; }
    if (!Array.isArray(q?.groups) || !Array.isArray(q?.queue)) {
      return queued?.session_id === st.session_id ? queued : null;
    }
    const mode = q.measure_mode ?? q.entry_mode;
    return {
      mode: mode === "New" || mode === "Rework" ? mode : "IPM",
      operator: q.operator ?? "",
      triggerMode: q.trigger_mode === "manual" ? "manual" : "auto",
      trayCapacity: q.tray_capacity ?? null,
      groups: q.groups, list: q.queue, session_id: st.session_id,
    };
  }
  // Show the execution session, including a single-item review, independently
  // of the saved entry form and the retained Live Telemetry queue.
  const partEntryQueue = partEntryForSession(session, entryQueue);
  const activeTriggerMode = parsedQueue?.trigger_mode ?? partEntryQueue?.triggerMode;
  const showManualTrigger = activeTriggerMode ? activeTriggerMode === "manual" : manualTrigger;
  const triggerControlReady = triggerReady && manualTrigger && piOnline && !dbOffline
    && stationStatus !== "offline" && polledSession?.session_id === session.session_id;
  const runningControls = <>
    {isRunning && showManualTrigger && (
      <button className="btn-trigger" disabled={!triggerControlReady}
        title={triggerControlReady ? "ส่งสัญญาณให้เริ่มวัดชิ้นนี้ (แทน MCU ชั่วคราว)"
          : "ยังไม่ถึงจังหวะ — ระบบกำลังโหลดโปรแกรมวัด หรือกำลังรอผลของชิ้นก่อนหน้าอยู่"}
        onClick={sendManualTrigger}>⚡ Trigger</button>
    )}
    {isRunning && <button className="btn-stop" onClick={stopSession}>■ Stop</button>}
  </>;
  const canEditQueue = session.state !== "running";

  return (
    <div className="layout">
      <main className="main">
        {/* ══ Section 1 — Session Control (ซ้าย) + Part Entry (ขวา) ═══════════
            2 การ์ดวางคู่กัน แบ่งหน้าที่ให้ขาด:
              ซ้าย = **จอแสดงสถานะล้วน ๆ** ไม่มีอะไรให้กดเลย
              ขวา  = **ที่เดียวที่มีปุ่ม** (New Entry / Start / Trigger / Stop)

            ⚠ ปุ่ม Start/Trigger/Stop ถูกย้ายจากการ์ดซ้ายมาอยู่ขวาทั้งหมด —
              ปุ่มควบคุมการวัดควรอยู่ที่เดียว ไม่ใช่กระจายสองการ์ด ไม่งั้น
              ตอนฉุกเฉินคนจะต้องกวาดตาหาว่า Stop อยู่ไหน                    */}
        <section>
          <div className="session-split">
          <div className="card">
            <div className="card-title">Session Control</div>
            {/* ทุกอย่างอยู่บรรทัดเดียว — ชิปที่ยังไม่มีค่าถูกซ่อนทั้งชิป ไม่ใช่โชว์
                ขีดกลางไว้ แถบตอน idle จะได้ไม่รกด้วยช่องว่างเปล่า */}
            <div className="session-row">
              <div className="session-chip">
                <span className="sc-label">Status</span>
                {/* คลาสยังใช้ค่าดิบ (`timeout`) — เปลี่ยนเฉพาะข้อความ ดู sessionStateLabel */}
                <span className={`session-state-badge ${session.state}`}>{sessionStateLabel(session.state)}</span>
              </div>
              {/* ชิป Operator · Measure Type · Session (เลข id) ถอดออกแล้ว
                  ทั้งสามตัวซ้ำกับที่อื่นบนหน้าเดียวกัน: Operator กับ Measure Type
                  อยู่ในดรอปดาวน์สรุปของ Part Entry ข้าง ๆ อยู่แล้ว ส่วนเลข session
                  เป็นเลขรันนิ่งของฐานข้อมูลที่คนหน้าเครื่องเอาไปทำอะไรต่อไม่ได้
                  (ดูได้จากคอลัมน์ Session ในตาราง Measurements ด้านล่าง)

                  ⚠ ตัวแปร `sessionOperator` / `sessionMode` / `session.session_id`
                    ไม่ได้ถูกลบ ยังถูกใช้ในที่อื่นตามปกติ — ถอดเฉพาะการแสดงผล */}
              {/* ⚠ ชิป PI ไม่ซ่อนตอน idle ต่างจากชิปอื่น — ประโยชน์หลักคือดูก่อน
                  กด Start ว่าเครื่องพร้อมไหม ซ่อนตอนไม่มี session ก็หมดความหมาย */}
              <div className="session-chip">
                <span className="sc-label">Raspberry Pi</span>
                {/* 3 สถานะไม่ใช่ 2 — "Connecting" (piStatus เป็น null) คือ "ยังไม่เคย
                    ได้ heartbeat เลย" ต่างจาก "Offline" ที่แปลว่ารู้ว่าเงียบเกินเกณฑ์
                    ห้ามยุบรวมกัน ตอนไล่หาสาเหตุคนละเรื่องกัน */}
                <span className={`sc-value sc-pi ${piOnline ? "online" : piStatus === false ? "offline" : "unknown"}`}>
                  {piOnline ? "Online" : piStatus === false ? "Offline" : "Connecting"}
                </span>
              </div>
            </div>
          </div>

          {/* ── การ์ดขวา — Part Entry + ปุ่มควบคุมทั้งหมด ────────────────────
              2 สถานะชัดเจน:
                ยังไม่มีคิว → ปุ่ม "+ New Entry" อยู่กลางกล่อง ไม่มีอย่างอื่นเลย
                มีคิวแล้ว   → หัวข้อ + โหมด + Clear บรรทัดบน
                              แถวล่าง: dropdown สรุป (ซ้าย) · Start (ขวา)      */}
          <div className="card pe-card">
            {!partEntryQueue ? (
              <>
                <div className="card-title">Part Entry</div>
                {/* จัดกึ่งกลางทั้งแนวตั้งและแนวนอน — ตอนนี้มีอย่างเดียวที่ทำได้
                    ไม่ต้องให้ตาไปหาปุ่มที่มุมไหน */}
                {isRunning ? <>
                  <span className="session-entry-hint">กำลังโหลดข้อมูลชิ้นงานที่กำลังวัด…</span>
                  <div className="session-btns">
                    <button className="btn-start" disabled>▶ Start</button>
                    {runningControls}
                  </div>
                </> : <div className="pe-card-empty">
                  <button className="btn-pe-action" onClick={openPeModal}>
                    + New Entry
                  </button>
                  <span className="session-entry-hint">กด "New Entry" เพื่อเตรียมคิว</span>
                </div>}
              </>
            ) : (
              <div className="session-entry-filled">
                {/* หัวข้อ + โหมด + Clear อยู่บรรทัดบน ให้แถวล่างเหลือแค่
                    dropdown กับปุ่ม — ถ้ายัด badge เข้าไปในตัว toggle ด้วย
                    ชื่อ ALPL ที่ยาวจะถูกบีบจนอ่านไม่ออกก่อนใครเพื่อน */}
                <div className="session-entry-head" style={{ flexWrap: "wrap" }}>
                  <span className="session-entry-title">Part Entry</span>
                  <span className={`pe-mode-badge-lg ${partEntryQueue.mode.toLowerCase()}`}>
                    {partEntryQueue.mode}
                  </span>
                  {isRunning && <span className="session-entry-hint" style={{ flexBasis: "100%", order: 1 }}>
                    {parsedQueue?.review_source ? "วัดซ้ำ · " : ""}
                    {showManualTrigger ? "Manual (ปุ่มบนเว็บ)" : "Auto (MCU)"}
                  </span>}
                  {/* ล้างคิวที่กรอกไว้ทั้งหมด — ล็อกตอน running เพราะคิวระหว่างวัด
                      คือของที่ backend ถืออยู่จริง ล้างฝั่งหน้าเว็บอย่างเดียวจะทำให้
                      สองฝั่งไม่ตรงกัน แล้วผลวัดที่ตามมาจะไปแปะกับ ALPL ผิดตัว */}
                  <button
                    type="button"
                    className="btn-clear"
                    disabled={isRunning}
                    title={isRunning ? "กดไม่ได้ระหว่างกำลังวัด — กด Stop ก่อน"
                                     : "ล้างคิว Part Entry ที่กรอกไว้ทั้งหมด"}
                    onClick={clearPartEntry}
                  >
                    🧹 Clear
                  </button>
                </div>

                {/* dropdown สรุป — อยู่คอลัมน์ซ้ายของ grid ร่วมกับหัวข้อข้างบน
                    จึงกว้างเท่ากันเป๊ะ ทำให้ badge/Clear ที่ชิดขวาของหัวข้อ
                    ตรงกับขอบขวาของ dropdown พอดี ไม่เลยไปอยู่เหนือปุ่ม Start */}
                  <div className="pe-summary-dropdown session-entry-summary">
                    <button type="button" className="pe-summary-toggle" onClick={() => setPeSummaryOpen((v) => !v)}>
                      <span className="pe-summary-toggle-left">
                        <span>ALPL: {formatAlplRanges(partEntryQueue.list)}</span>
                      </span>
                      <span className={`pe-summary-arrow${peSummaryOpen ? " open" : ""}`}>▼</span>
                    </button>
                    {/* แสดงทีละกลุ่ม — ของเดิมโชว์ field ชุดเดียวเพราะมีได้กลุ่มเดียว
                        ตอนนี้ต้องบอกให้ได้ว่า ALPL ไหนใช้ config ชุดไหน ไม่งั้น
                        ผู้ใช้ตรวจก่อนกด Start ไม่ได้ว่ากรอกถูกกลุ่มหรือเปล่า */}
                    <div className={`pe-summary-body${peSummaryOpen ? " open" : ""}`}>
                      <div className="pe-summary-grid">
                        <span className="pg-label">Operator</span>
                        <span className="pg-value">{partEntryQueue.operator}</span>
                      </div>
                      {partEntryQueue.groups.map((g, gi) => (
                        <div key={gi} className="pe-summary-grid" style={{ marginTop: "0.6rem" }}>
                          <span className="pg-label">กลุ่มที่ {gi + 1}</span>
                          <span className="pg-value">{formatAlplRanges(g.number_alpl as number[])}</span>
                          {Object.entries(g)
                            .filter(([k, v]) => k !== "number_alpl" && v !== "" && v != null)
                            .map(([k, v]) => (
                              <span key={k} style={{ display: "contents" }}>
                                <span className="pg-label">{k.replace(/_/g, " ")}</span>
                                <span className="pg-value">{String(v)}</span>
                              </span>
                            ))}
                        </div>
                      ))}
                      <div className="pe-summary-actions">
                        {canEditQueue && (
                          <button className="btn-pe-action" onClick={openPeModal}>✎ Edit</button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* ⚠ ปุ่มควบคุมทั้งหมดอยู่ที่นี่ที่เดียว ไม่กระจายไปการ์ดซ้าย —
                      ตอนต้องกด Stop ด่วน คนต้องรู้ทันทีว่ามองที่ไหน ไม่ใช่กวาดตา
                      หาสองที่ · การ์ดซ้ายจึงเป็นจอแสดงสถานะล้วน ๆ ไม่มีปุ่มเลย */}
                  <div className="session-btns">
                    <button className="btn-start" disabled={!canStart} title={startTitle} onClick={startFromQueue}>
                      {startLabel}
                    </button>
                    {runningControls}
                  </div>
              </div>
            )}
          </div>
          </div>
        </section>

        {/* Section 2 — Live View */}
        <section>
          <div className="live-view-grid">
            <div className="card">
              <div className="telemetry-header">
                <div className="card-title" style={{ marginBottom: 0 }}>
                  Live Telemetry
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span className="telemetry-alpl-badge">ALPL {telemetry?.number_alpl ?? "—"}</span>
                  {(selectedQueueIndex !== null || (isRunning && reviewPhase !== "running")) && (
                    <button type="button" className="btn-clear" onClick={resumeLatestTelemetry}
                      disabled={reviewBusy || (isRunning && (reviewPhase === "remeasuring" || reviewPhase === "unknown"))}>
                      {isRunning ? "กลับไปค่าล่าสุดและวัดต่อ" : "กลับไปค่าล่าสุด"}
                    </button>
                  )}
                  {/* ล้างเฉพาะสิ่งที่แสดงบนจอ ไม่แตะฐานข้อมูล — ผลวัดที่บันทึกไปแล้ว
                      ยังอยู่ครบในตาราง Measurements ด้านล่าง
                      ⚠ ล็อกตอน running เพราะล้างกลางคันแล้ว SSE ตัวถัดไปจะเติม
                        กลับมาครึ่งๆ กลางๆ ดูสับสนกว่าเดิม */}
                  <button
                    type="button"
                    className="btn-clear"
                    disabled={isRunning}
                    title={isRunning ? "กดไม่ได้ระหว่างกำลังวัด — กด Stop ก่อน"
                                     : "ล้างค่าที่แสดงอยู่ ไม่กระทบข้อมูลที่บันทึกแล้ว"}
                    onClick={clearTelemetry}
                  >
                    🧹 Clear
                  </button>
                </div>
              </div>
              {selectedQueueIndex !== null && (
                <div style={{ marginBottom: "0.5rem" }}>
                  <span title={reviewUnavailable} style={{ display: "inline-block" }}>
                    <button type="button" className="btn-start" disabled={!!reviewUnavailable || !telemetry?.measurement_id}
                      onClick={remeasureSelected}>วัดใหม่</button>
                  </span>
                  {isRunning && <span role="status" style={{ marginLeft: "0.5rem" }}>
                    {reviewPhase === "paused" ? "พักคิวแล้ว — วางชิ้นงานที่เลือกก่อนวัดใหม่"
                      : reviewPhase === "remeasuring" ? "กำลังวัดซ้ำ — รอ Trigger / ผลและรูป"
                      : reviewPhase === "unknown" ? "กำลังตรวจสอบสถานะ Pi" : "กำลังรอพักคิว"}
                  </span>}
                </div>
              )}
              {selectedQueueIndex !== null && (
                <div role="status" style={{ marginBottom: "0.5rem", color: "var(--muted)" }}>
                  {telemetryLoading ? "กำลังโหลดผลวัด…" : `กำลังดูผล ALPL ${telemetry?.number_alpl ?? "—"}`}
                </div>
              )}
              <div className="telemetry-grid" aria-busy={telemetryLoading}>
                <div className="telemetry-xy-col">
                  <div className="telemetry-cell x">
                    <div className="tc-head">
                      <span className="tc-label">Value X</span>
                      {axX.ok != null && <span className={`tc-axis ${axX.ok ? "ok" : "ng"}`}>{axX.ok ? "OK" : "NG"}</span>}
                    </div>
                    <div className="tc-value">
                      {telemetry ? telemetry.value_x.toFixed(DP_MM) : "—"}
                      <span> mm</span>
                    </div>
                    <div className="tc-range">{telemetry ? axX.range : ""}</div>
                  </div>
                  <div className="telemetry-cell y">
                    <div className="tc-head">
                      <span className="tc-label">Value Y</span>
                      {axY.ok != null && <span className={`tc-axis ${axY.ok ? "ok" : "ng"}`}>{axY.ok ? "OK" : "NG"}</span>}
                    </div>
                    <div className="tc-value">
                      {telemetry ? telemetry.value_y.toFixed(DP_MM) : "—"}
                      <span> mm</span>
                    </div>
                    <div className="tc-range">{telemetry ? axY.range : ""}</div>
                  </div>
                  {/* ── Offset 2 แกน — ซ่อนทั้งคู่ในโหมด IPM ─────────────────
                      IPM ใช้เกณฑ์จากตาราง `package_size` ซึ่ง **ไม่เอา offset
                      มาตัดสิน OK/NG เลย** (ดู `_offset_limit` ฝั่ง backend)
                      ค่ายังถูกบันทึกลง DB ครบ ดูได้จาก Export/Power BI แค่ไม่เอา
                      มารกหน้าจอที่คนหน้าเครื่องใช้ตัดสินใจ — เหตุผลเดียวกับที่
                      `ReportAxis` ซ่อนการ์ด Offset ในโหมดนี้อยู่แล้ว

                      ⚠ ใช้ `offset_counts` จาก backend เป็นหลัก (มันคือคำตอบของ
                        `_offset_limit` ตัวจริง) แล้วค่อย fallback ไปดูโหมดของ
                        session — ห้ามเทียบ `sessionMode === "IPM"` อย่างเดียว
                        เพราะกฎว่าโหมดไหนนับ offset อยู่ที่ backend ที่เดียว
                        ถ้าวันหลังกฎเปลี่ยน หน้าเว็บจะตามเองโดยไม่ต้องแก้

                      ⚠ fallback ดูโหมด **เฉพาะตอน state = running** เท่านั้น
                        `sessionMode` แกะมาจาก `queue_state` ของ session ล่าสุด
                        ซึ่ง **ค้างอยู่ต่อหลัง session จบ** ถ้าเช็คโหมดตลอดเวลา
                        พอวัด IPM จบแล้วกด Clear การ์ดจะหายไปเลย ทั้งที่จอว่าง
                        ไม่มีค่าอะไรให้ซ่อน — เหลือช่องโหว่ในเลย์เอาต์แทน
                        ตอนว่าง/จบแล้วจึงโชว์โครงเปล่าไว้เสมอ

                      ⚠ ถอดช่อง GH-X / GH-Y ออกแล้ว — เลิกใช้เครื่องมือฝั่ง GH
                        (ถอดออกจาก MeasurementCreate + ตาราง measurements) */}
                </div>
                <div className={`telemetry-result-col${telemetry ? (telemetry.result === "OK" ? " ok" : " ng") : ""}`}>
                  <div className="telemetry-result-label">Result</div>
                  <div className={`telemetry-result-value${telemetry ? (telemetry.result === "OK" ? " ok" : " ng") : ""}`}>{telemetry?.result ?? "—"}</div>
                </div>
                {/* ⚠ ต้องเป็นลูกโดยตรงของ `.telemetry-grid` — ถ้าไปอยู่ใน
                    `.telemetry-xy-col` (ซึ่งเป็น flex column) `grid-column` จะ
                    ไม่มีผลเลย การ์ดจะแคบอยู่ในคอลัมน์ซ้ายเหมือนเดิม */}
                {(telemetry?.offset_counts ??
                  (session.state === "running"
                    ? (sessionMode ?? "").toUpperCase() !== "IPM"
                    : true)) && (
                  <div className="telemetry-cell offset telemetry-offset-cell">
                    <OffsetMap
                      title="Offset Opening"
                      offsetX={telemetry?.offset_opx}
                      offsetY={telemetry?.offset_opy}
                      posCode={telemetry?.offset_pos_op}
                      offsetTol={telemetry?.offset_tol}
                      ok={telemetry?.ok_offset}
                      measureType={telemetry?.measure_type}
                    />
                  </div>
                )}
              </div>
              {/* แถบคิว ALPL — **ซ่อนเฉพาะตอนไม่มีคิวเลย** เท่านั้น
                  ⚠ เดิม vanilla ซ่อนเมื่อคิว ≤ 1 ด้วยเหตุผลว่า "ตัวเดียวไม่มีอะไร
                    ให้ดู" แล้วเลิกทำ เพราะไม่จริงในการใช้งาน — ชิปตัวเดียวยังบอกได้
                    ว่า ALPL ไหนกำลังวัด/วัดไปแล้วผลเป็นอะไร และกดเปิดรายงานได้
                    ที่สำคัญคือมันหาย ๆ โผล่ ๆ ตามจำนวนชิ้นในรอบ ทำให้เลย์เอาต์ของ
                    การ์ดนี้ไม่นิ่ง คนใช้จำไม่ได้ว่าแถบนี้อยู่ตรงไหน */}
              {queueStrip.length > 0 && (
                <div className="telemetry-queue">
                  <div className="tq-label">Queue</div>
                  <div ref={queueStripRef} className="tq-strip" tabIndex={0} role="region" aria-label="Queue — เลื่อนแนวนอนเพื่อดูรายการเพิ่มเติม">
                    {queueStrip.map((q, i) => (
                      <button type="button" key={`${q.alpl}-${i}`}
                        className={`tq-chip ${q.state}${selectedQueueIndex === i ? " selected" : ""}`}
                        disabled={q.state === "wait" || q.state === "now"}
                        aria-pressed={selectedQueueIndex === i}
                        aria-label={`ALPL ${q.alpl} — ${q.state === "wait" || q.state === "now" ? "ยังไม่มีผลวัด" : "ดูผลวัด"}`}
                        onClick={() => selectQueueTelemetry(i, q.alpl)}>
                        {q.state === "now" && <span className="tq-dot" />}
                        {(q.state === "ok" || q.state === "ng" || q.state === "done") && (
                          <span
                            className="tq-ico"
                            title={q.state === "done" ? "วัดแล้ว — หน้านี้ยังไม่รู้ผล ดูที่ตาราง Measurements" : undefined}
                          >
                            {q.state === "ng" ? "✕" : q.state === "done" ? "?" : "✓"}
                          </span>
                        )}
                        {q.alpl}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* แถบสัดส่วนผลการวัดของ session ปัจจุบัน: เขียว=OK แดง=NG เทา=ยังไม่วัด
                  บอกครบ 3 อย่างในภาพเดียวโดยไม่ต้องอ่านตัวเลข */}
              <div className="telemetry-bar">
                <div className="tb-ok" style={{ width: `${barOkPct}%` }} />
                <div className="tb-ng" style={{ width: `${barNgPct}%` }} />
              </div>
              <div className="telemetry-footer">
                <span>Progress</span>
                <span className="telemetry-counts">
                  <span className="tcount ok">{stats.ok} OK</span>
                  <span className="tcount-sep">·</span>
                  <span className="tcount ng">{stats.ng} NG</span>
                  <span className="tcount-sep">·</span>
                  {/* isTelemetryCleared(): ผู้ใช้กด 🧹 Clear ไว้ — ต้องค้างที่ขีด
                      ไม่งั้นรอบ poll ถัดไปจะเขียน "1 / 1 measured" กลับมาเอง
                      (ตัวเลขนี้มาจาก session ไม่ใช่ stats จึงไม่โดน guard ชุดเดิม) */}
                  <strong>
                    {isTelemetryCleared() || session.state === "idle" || !session.session_id
                      ? "— / — measured"
                      : `${reviewDisplayRef.current ? stats.total : session.measured_count} / ${barTotal} measured`}
                  </strong>
                </span>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Camera Preview</div>
              <div className="camera-preview-box">
                {cameraImgUrl ? (
                  <img
                    src={cameraImgUrl}
                    alt={`Latest capture (measurement #${lastImageMeasurementId})`}
                    title="คลิกเพื่อดูเต็มจอ"
                    onClick={() => setZoomImgUrl(cameraImgUrl)}
                  />
                ) : (
                  <>
                    <span className="camera-preview-icon">🖼</span>
                    <span>No image yet</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Section 3 — Stats: ย้ายไปอยู่ในแถบล่างของการ์ด Live Telemetry แล้ว
            (Total ซ้ำกับ "x / y measured" ที่มีอยู่เดิม จึงเหลือแค่ OK/NG +
             แถบสัดส่วน) — ตรงกับ index.html ที่ถอด section นี้ออกไปแล้ว */}

        {/* Part Entry: ยุบขึ้นไปอยู่ในแถบ Session Control ข้างบนแล้ว (.session-entry)
            เดิมเป็นการ์ดแยกตรงนี้ ทำให้ operator ต้องเลื่อนหน้าจอลงมากรอกคิวทุกครั้ง
            ที่เริ่มรอบใหม่ แล้วเลื่อนกลับขึ้นไปดูค่าที่วัดได้ — สองอย่างที่ใช้
            ต่อเนื่องกันในรอบเดียวแต่อยู่คนละฟากของหน้าจอ */}

        {/* Section 5 — Measurements Table */}
        <section>
          <div className="card">
            <div className="card-header">
              <div className="card-title">
              
              Measurements History <span className="count">({measTotal})</span>
              </div>
            </div>
            <div className="filter-bar">
              <input type="text" placeholder="ค้นหาด้วย ALPL Number..." value={measFilterAlplInput} onChange={(e) => onMeasSearchChange(e.target.value)} />
              <input type="date" title="กรองตาม Timestamp (วันที่)" value={measFilterDate} onChange={(e) => onMeasDateChange(e.target.value)} />
              <button className="btn-clear-filter" onClick={onMeasClearFilter}>
                ✕ Clear Filter
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Session</th>
                    <th>ALPL</th>
                    {/* เกณฑ์ตัดสิน (Nominal / Tol / Offset Tol) ย้ายไปอยู่ตาราง Parts
                        หน้า Edit แล้ว — เป็นสเปกของ "ชิ้นงาน" ไม่ใช่ของ "การวัด
                        ครั้งนั้น" · ค่ายังถูกดึงมาใน MEASUREMENTS_SELECT อยู่ เพราะ
                        Value X/Y กับ Offset X/Y ใช้มันระบายสีว่าเกินสเปกไหม
                        (ดู axisValue / offsetValue) **ห้ามถอดออกจาก SELECT หรือ type**
                        อยากดูเกณฑ์ที่ใช้ตอนวัดจริงย้อนหลัง → Export CSV หรือกดที่แถว
                        เพื่อเปิด Report modal */}
                    {/* รวม X กับ Y ไว้ช่องเดียว — ระบายสีแยกทีละแกน จะได้เห็น
                        ทันทีว่าแกนไหนเป็นตัวที่ทำให้ทั้งแถวเป็น NG
                        (ตาราง Edit ใช้ชุดเดียวกัน ดู measurementCells.tsx) */}
                    <th>Value X/Y</th>
                    <th>Offset X/Y</th>
                    {/* ทิศที่เยื้อง — `offset_pos_op` เป็นรหัส 9 ค่าที่ backend
                        คำนวณให้ (TOP / BOTTOM / LEFT / … / CENTER) ไม่ได้เดาจาก
                        เครื่องหมายของตัวเลข · เงื่อนไขเดียวกับ Offset X/Y คือ
                        IPM ไม่เอา offset มาตัดสิน จึงขึ้น "—" ทั้งคอลัมน์ */}
                    <th>Offset Position</th>
                    <th>Result</th>
                    <th>Note</th>
                    <th>Operator</th>
                    <th>Measure Type</th>
                    <th>Image</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {measurements.length === 0 ? (
                    <tr className="empty-row">
                      <td colSpan={12}>{measFilterAlplRef.current || measFilterDate ? "ไม่พบ Measurement ที่ตรงกับตัวกรอง" : "No measurements"}</td>
                    </tr>
                  ) : (
                    measurements.map((m) => {
                      const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : "—";
                      const res = m.result || "—";
                      const cls = res === "OK" ? "ok" : res === "NG" ? "ng" : "";
                      // โหมดของ "แถวนี้" ไม่ใช่โหมดของ session ปัจจุบัน — ตารางนี้
                      // แสดงข้อมูลย้อนหลังที่ปนกันทุกโหมด
                      const isIpm = (m.measure_type ?? "").toUpperCase() === "IPM";
                      return (
                        <tr key={m.measurement_id} data-clickable className={highlightId === m.measurement_id ? "highlight-new" : ""} onClick={() => openReportModal(m.measurement_id)}>
                          <td>{m.measurement_id}</td>
                          <td>{m.session_id ?? "—"}</td>
                          <td>{m.number_alpl}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {xyPair(
                              axisValue(m.value_x, m.nominal_x, m.upper_tol, m.lower_tol, m.ok_x),
                              axisValue(m.value_y, m.nominal_y, m.upper_tol, m.lower_tol, m.ok_y),
                            )}
                          </td>
                          {/* ⚠ ตั้งใจไม่ใส่ผัง <OffsetMap compact> ตรงนี้ — ตารางนี้มี
                              คอลัมน์เยอะอยู่แล้ว รูปเล็ก ๆ ซ้ำทุกแถวทำให้แถวสูงขึ้น
                              และเบียดคอลัมน์อื่นโดยได้ข้อมูลเพิ่มน้อย · ทิศทางดูได้
                              จากรายงานที่กดเปิดทีละแถวอยู่แล้ว */}
                          <td style={{ whiteSpace: "nowrap" }}>
                            {isIpm ? "—"
                              : xyPair(
                                  offsetValue(m.offset_opx, m.offset_tol, m.ok_opx),
                                  offsetValue(m.offset_opy, m.offset_tol, m.ok_opy),
                                )}
                          </td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {isIpm ? "—" : (m.offset_pos_op || "—")}
                          </td>
                          <td>
                            <span className={`result-badge ${cls}`}>{res}</span>
                          </td>
                          <td>{m.note ?? ""}</td>
                          <td>{m.operator_name ?? ""}</td>
                          <td>{m.measure_type ?? ""}</td>
                          <td className="img-cell">
                            {/* 3 สถานะ: มีรูปแล้ว / Agent อัปโหลดไม่สำเร็จครบ 3 ครั้ง /
                                ยังไม่มีรูป — กรณีสุดท้าย **ปล่อยว่างไปเลย ไม่ใส่ขีด**
                                คอลัมน์นี้มีแค่ "มีรูป/ไม่มีรูป" การมีไอคอนโผล่เฉพาะ
                                แถวที่มีรูปอ่านง่ายกว่าขีดจาง ๆ เต็มคอลัมน์ (ต่างจาก
                                คอลัมน์ Note ที่ขีดสื่อว่า "กรอกได้แต่ยังไม่ได้กรอก") */}
                            {m.image_path ? (
                              <button
                                className="img-btn-inner"
                                title="View report"
                                onClick={(e) => { e.stopPropagation(); openReportModal(m.measurement_id); }}
                              >
                                <AlplIcon />
                              </button>
                            ) : m.image_upload_failed ? (
                              <span className="no-img upload-failed" title="Agent อัปโหลดรูปไม่สำเร็จหลังลอง 3 ครั้ง">⚠ Failed</span>
                            ) : (
                              ""
                            )}
                          </td>
                          <td style={{ whiteSpace: "nowrap" }}>{ts}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="pagination-bar">
              <button type="button" className="btn-icon" disabled={measPage <= 1} onClick={onMeasPrev}>
                ‹ Previous
              </button>
              <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--muted)" }}>
                {measTotal === 0 ? "ไม่มีรายการ" : `แสดง ${(measPage - 1) * MEAS_PAGE_SIZE + 1}–${(measPage - 1) * MEAS_PAGE_SIZE + measurements.length} จาก ${measTotal} รายการ`}
              </span>
              <button type="button" className="btn-icon" disabled={(measPage - 1) * MEAS_PAGE_SIZE + measurements.length >= measTotal} onClick={onMeasNext}>
                Next ›
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* ── Measurement Report modal ─────────────────────────────────── */}
      {/* สรุปผล IPM ตอนวัดครบ — ตารางสำหรับคัดลอกไปวางใน Excel */}
      {ipmSummary && ipmSummary.length > 0 && (
        <IpmSummaryModal rows={ipmSummary} onClose={() => setIpmSummary(null)} />
      )}

      {/* ── ถาดเต็ม — รอคนมาเคลียร์ ─────────────────────────────────────────
          ⚠⚠ **ไม่มีตัวนับถอยหลัง** ต่างจาก modal measure_timeout ข้างล่างโดยตั้งใจ
            เคลียร์ถาดเป็นงานมือที่ใช้เวลาไม่แน่นอน (เดินไปหยิบถาดใหม่ ยกของออก
            นับชิ้น อาจติดงานอื่นกลางทาง) ถ้าตั้งเพดานเวลาไว้จะมีวันที่ session
            ตายกลางคันเพราะคนเดินช้าไปนิดเดียว แล้วของทั้งถาดที่วัดไปแล้วเสียเปล่า
            — ฝั่ง Pi (`ask_tray_clear`) ก็รอไม่จำกัดเวลาเหมือนกัน

          ⚠ ไม่มีปุ่มปิด (✕) และคลิกพื้นหลังปิดไม่ได้ ด้วยเหตุผลเดียวกับ
            measure_timeout — Pi กำลังบล็อกรอคำตอบอยู่จริง ปิดทิ้งเฉย ๆ
            เครื่องจะค้างโดยไม่มีใครรู้ ทางออกมี 2 ทางคือวัดต่อหรือหยุด         */}
      {trayModal && (
        <div className="modal-overlay open">
          <div className="pe-modal-box" style={{ maxWidth: 460 }}>
            <div className="pe-modal-header">
              <div className="card-title">🧺 ถาดเต็มแล้ว</div>
            </div>
            <div style={{ fontSize: "0.9rem", lineHeight: 1.7, marginBottom: "0.75rem" }}>
              วัดครบ <strong>{trayModal.capacity ?? "—"}</strong> ชิ้นแล้ว
              {" "}(สะสม <strong>{trayModal.piece ?? "—"}/{trayModal.target ?? "—"}</strong> ชิ้น)
              <br />กรุณาเคลียร์ถาดรับชิ้นงาน แล้วกด &ldquo;วัดต่อ&rdquo;
            </div>
            <div style={{
              fontSize: "0.8rem", lineHeight: 1.6, color: "var(--muted)",
              background: "var(--surface2)", border: "1px solid var(--border)",
              borderRadius: "var(--radius)", padding: "0.6rem 0.75rem", marginBottom: "1.25rem",
            }}>
              เครื่องหยุดรออยู่ <strong>ไม่มีกำหนดเวลา</strong> — ใช้เวลาได้ตามต้องการ
              ชิ้นที่วัดไปแล้วถูกบันทึกครบแล้ว
            </div>
            <div className="entry-actions" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn-edit-entry" onClick={() => resolveTrayFull("stop")}>
                หยุดการวัด
              </button>
              <button type="button" className="btn-submit-entry" onClick={() => resolveTrayFull("resume")}>
                ▶ เคลียร์ถาดแล้ว วัดต่อ
              </button>
            </div>
          </div>
        </div>
      )}

      {mcuModal && (
        <div className="modal-overlay open">
          <div className="pe-modal-box" style={{ maxWidth: 460 }}>
            <div className="pe-modal-header">
              <div className="card-title">🔌 MCU ขาดการเชื่อมต่อ</div>
            </div>
            <div style={{ fontSize: "0.9rem", lineHeight: 1.7, marginBottom: "0.75rem" }}>
              เครื่องขาดการเชื่อมต่อ
              {mcuModal.piece != null && mcuModal.target != null && (
                <> ระหว่างวัดชิ้นที่ <strong>{mcuModal.piece}/{mcuModal.target}</strong></>
              )}
              <br />กรุณาตรวจสอบสาย/เครื่องที่หน้างาน แล้วกด &ldquo;ลองใหม่&rdquo;
            </div>
            <div style={{
              fontSize: "0.8rem", lineHeight: 1.6, color: "var(--muted)",
              background: "var(--surface2)", border: "1px solid var(--border)",
              borderRadius: "var(--radius)", padding: "0.6rem 0.75rem", marginBottom: "1.25rem",
            }}>
              เครื่องหยุดรออยู่ <strong>ไม่มีกำหนดเวลา</strong> — ใช้เวลาได้ตามต้องการ
            </div>
            <div className="entry-actions" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn-edit-entry" onClick={() => resolveMcuDisconnected("stop")}>
                หยุดการวัด
              </button>
              <button type="button" className="btn-submit-entry" onClick={() => resolveMcuDisconnected("retry")}>
                🔁 ลองใหม่
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Measure timeout ────────────────────────────────────────────────
          ⚠ ตั้งใจ **ไม่มีปุ่มปิด (✕) และคลิกพื้นหลังปิดไม่ได้** เพราะเครื่องฝั่ง Pi
            กำลังค้างรอคำตอบอยู่จริง ๆ ถ้าปิดทิ้งเฉย ๆ session จะค้างโดยไม่มีใครรู้
          หน้าตา/ปุ่มเปลี่ยนตาม `event` ที่ backend แนบมา — ดู MT_VIEW */}
      {mtModal && (() => {
        const v = mtView(mtModal.event);
        return (
        <div className="modal-overlay open">
          <div className="pe-modal-box" style={{ maxWidth: 480 }}>
            <div className="pe-modal-header">
              <div className="card-title">{v.title}</div>
            </div>
            <div style={{ fontSize: "0.9rem", lineHeight: 1.7, marginBottom: "0.75rem" }}>
              {mtModal.number_alpl != null && <>ALPL <strong>{mtModal.number_alpl}</strong> </>}
              (ชิ้นที่ <strong>{mtModal.piece ?? "—"}/{mtModal.target ?? "—"}</strong>)
              {" "}{v.body}
              {mtModal.detail && (
                <><br /><span style={{ color: "var(--warn)" }}>สาเหตุ: {mtModal.detail}</span></>
              )}
              <br />{v.question}
              <br />
              <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                จะหยุดการวัดอัตโนมัติใน {mtLeft} วินาที
              </span>
            </div>
            <div style={{
              fontSize: "0.8rem", lineHeight: 1.6, color: "var(--muted)",
              background: "var(--surface2)", border: "1px solid var(--border)",
              borderRadius: "var(--radius)", padding: "0.6rem 0.75rem", marginBottom: "1.25rem",
            }}>
              {v.hint}
            </div>
            <div className="entry-actions" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn-edit-entry" onClick={() => resolveMeasureTimeout("stop")}>
                หยุดการวัด
              </button>
              <button type="button" className="btn-submit-entry" onClick={() => resolveMeasureTimeout(v.action)}>
                {v.actionLabel}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* ── Measurement report ──────────────────────────────────────────────
          แถวบน: รูป (ซ้าย) + การ์ดผลรายแกนพร้อมแถบเทียบสเปค (ขวา)
          แถวล่าง: ข้อมูล Part แบบอ้างอิง (ไม่ใช่สิ่งที่คนเปิดหน้านี้มาหา) */}
      <div className={`modal-overlay${reportModal ? " open" : ""}`}>
        <div className="report-modal-box">
          {reportModal && (() => {
            const m = reportModal.measurement;
            const part = reportModal.part;
            const verdict = m.result === "OK" ? "ok" : m.result === "NG" ? "ng" : "";
            // เกณฑ์เอาจากแถว measurement ก่อน (backend เลือกแหล่งตามโหมดให้แล้ว)
            // ค่อยถอยไปใช้ของ part ถ้าแถวเก่าไม่มี — ห้ามใช้ของ part เป็นหลัก
            // เพราะ part อาจถูกแก้ทีหลัง แล้วรายงานจะไม่ตรงกับตอนวัดจริง
            const nomX = m.nominal_x ?? part?.nominal_x;
            const nomY = m.nominal_y ?? part?.nominal_y;
            const upTol = m.upper_tol ?? part?.upper_tol;
            const loTol = m.lower_tol ?? part?.lower_tol;
            const specRows: [string, string][] = [
              ["Vendor", part?.vendor || "—"],
              ["Owner", part?.owner || "—"],
              ["PO number", part?.po_number != null ? String(part.po_number) : "—"],
              ["Template", part?.template_name || "—"],
              ["Receive date", part?.recieve_date ? new Date(part.recieve_date).toLocaleDateString() : "—"],
              ["Operator", m.operator_name || "—"],
              ["Measure type", m.measure_type || "—"],
              ["Note", m.note || "—"],
            ];
            return (
              <>
                <div className="report-header">
                  <div>
                    <div className="report-header-title">Measurement report — ALPL {m.number_alpl}</div>
                    <div className="report-header-sub">
                      {m.timestamp ? new Date(m.timestamp).toLocaleString() : "—"} ·{" "}
                      {m.session_id != null ? `Session #${m.session_id}` : "Session —"} · {m.operator_name || "—"}
                    </div>
                  </div>
                  <div className="report-header-right">
                    <span className={`report-verdict ${verdict}`}>{m.result || "—"}</span>
                    <button className="report-close" title="Close" onClick={() => setReportModal(null)}>✕</button>
                  </div>
                </div>

                <div className="report-body">
                  {/* คลิกรูปเพื่อดูเต็มจอ — ใช้ overlay `.img-zoom` ตัวเดียวกับ Camera
                      Preview ไม่ได้สร้างใหม่ จะได้ปิดด้วย Esc เหมือนกันโดยไม่ต้อง
                      เขียน listener ซ้ำ · `.img-zoom` z-index สูงกว่า `.modal-overlay`
                      จึงลอยทับโมดัลรายงานที่เปิดค้างอยู่ได้ */}
                  <div className="report-image-cell">
                    {reportModal.imageState === "loading" ? (
                      <span className="report-no-image">Loading…</span>
                    ) : reportModal.imageState === "ok" && reportModal.imageUrl ? (
                      <img
                        src={reportModal.imageUrl}
                        alt={`Measurement #${m.measurement_id} image`}
                        title="คลิกเพื่อดูเต็มจอ"
                        onClick={() => setZoomImgUrl(reportModal.imageUrl)}
                      />
                    ) : (
                      <span className="report-no-image">No image</span>
                    )}
                  </div>
                  <div className="report-axes">
                    <ReportAxis axis="X" value={m.value_x} nominal={nomX} upperTol={upTol} lowerTol={loTol} ok={m.ok_x} />
                    <ReportAxis axis="Y" value={m.value_y} nominal={nomY} upperTol={upTol} lowerTol={loTol} ok={m.ok_y} />
                    <OffsetMap
                      offsetX={m.offset_opx}
                      offsetY={m.offset_opy}
                      posCode={m.offset_pos_op}
                      offsetTol={m.offset_tol}
                      ok={m.ok_offset}
                      measureType={m.measure_type}
                    />
                  </div>
                </div>

                <div className="report-specs">
                  {specRows.map(([label, value]) => (
                    <div key={label}>
                      <div className="rs-label">{label}</div>
                      <div className="rs-value">{value}</div>
                    </div>
                  ))}
                  <div className="rs-full">
                    <div className="rs-label">Description</div>
                    <div className="rs-value">{part?.description || "—"}</div>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* ── Confirm modal (Promise-based — IPM เจอ ALPL ที่ยังไม่เคยลงทะเบียน) ── */}
      <div className={`modal-overlay${confirmModal ? " open" : ""}`}>
        <div className="pe-modal-box" style={{ maxWidth: 480 }}>
          <div className="pe-modal-header">
            <div className="card-title">ยืนยันการดำเนินการ</div>
          </div>
          <div style={{ fontSize: "0.9rem", lineHeight: 1.6, marginBottom: "1.25rem" }}>{confirmModal?.message}</div>
          <div className="entry-actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn-edit-entry" onClick={() => resolveConfirmModal(false)}>
              ยกเลิก
            </button>
            <button type="button" className="btn-submit-entry" onClick={() => resolveConfirmModal(true)}>
              ดำเนินการต่อ
            </button>
          </div>
        </div>
      </div>

      {/* ── Part Entry modal ─────────────────────────────────────────── */}
      {/* ── Part Entry ─────────────────────────────────────────────────────
          ฟอร์มเดียวใช้ทั้ง 3 โหมด กรอกได้หลายกลุ่ม (ดู PartEntryModal/EntryGroups)
          แทนที่ของเดิมที่แยกเป็น 3 ฟอร์มโหมดละชุด กลุ่มละ 1 ชุดเท่านั้น */}
      {peModalOpen && (
        <PartEntryModal
          /* คิวที่ค้างอยู่ — ปุ่ม "✎ Edit" จะได้เปิดมาพร้อมของเดิม ไม่ใช่ฟอร์มเปล่า
             (ตอนไม่มีคิว ปุ่มที่โผล่คือ "+ New Entry" และ entryQueue เป็น null
              อยู่แล้ว จึงได้ฟอร์มเปล่าตามที่ควรเป็นโดยไม่ต้องแยกเงื่อนไข) */
          initial={entryQueue ?? undefined}
          /* โหลดตัวเลือกไม่สำเร็จไหม — โชว์เป็นแถบเตือนในฟอร์ม ไม่ใช่บนการ์ด
             เพราะจุดที่ผู้ใช้เจอปัญหาคือตอนกดเปิด dropdown แล้วไม่มีอะไรให้เลือก
             ระบบยังลองใหม่อยู่เบื้องหลัง พอได้ครบแถบจะหายเอง */
          lookupFailed={dropdownFailed}
          operators={operatorOptions}
          vendors={vendorOptions}
          owners={ownerOptions}
          packageSizes={packageSizeOptions}
          partNumbersFor={(pkg) =>
            Array.from(
              new Set(
                partNumberCatalog
                  .filter((r) => !pkg || r.package_size === pkg)
                  .map((r) => r.part_number_name),
              ),
            ).sort()
          }
          /* เครื่องที่ขนาดนี้ลงได้ — มาจาก `handlers` ที่ /api/package-sizes แนบมา
             ให้แล้ว **ไม่ต้องยิง API เพิ่มตอนเปลี่ยน dropdown** (แบบเดียวกับ
             partNumbersFor ข้างบน) catalog พวกนี้เล็กและแทบไม่เปลี่ยนระหว่างวัน */
          handlersFor={(pkg) => packageSizeCatalog.find((p) => p.package_size === pkg)?.handlers ?? []}
          /* เครื่องของ part number นั้น — ใช้เติมช่อง Handler ให้อัตโนมัติในโหมด
             New/Rework คืน "" ถ้าไม่รู้จัก (ฟอร์มจะปล่อยช่องว่างไว้) */
          handlerOfPartNumber={(pn) =>
            partNumberCatalog.find((r) => r.part_number_name === pn)?.handler ?? ""
          }
          onNotify={showToast}
          /* ถามก่อนสลับโหมดเมื่อฟอร์มมีข้อมูลค้าง — ยกข้อความมาจาก confirmDiscard
             ของ vanilla เดิม (index.html) ที่หายไปตอนย้ายเป็น React */
          confirmSwitch={(target, current) =>
            dialog.confirm(
              <>
                หากเปลี่ยนไป <strong>{target}</strong> ข้อมูลที่กรอกไว้ในฟอร์ม{" "}
                <strong>{current}</strong> จะหายไป
              </>,
              { title: "เปลี่ยนโหมด", okLabel: "เปลี่ยนโหมด", danger: true },
            )
          }
          confirmRegister={async (items) =>
            dialog.confirm(
              <>
                <strong>ALPL ต่อไปนี้ยังไม่เคยบันทึกมาก่อน</strong>
                <div className="register-alpl-list" tabIndex={0} role="region" aria-label="ALPL ที่ยังไม่ลงทะเบียน — เลื่อนเพื่อดูรายการเพิ่มเติม">
                  {items.map((it) => (
                    <div key={it.alpl}>• ALPL {it.alpl} → Package Size "{it.package_size || "—"}"</div>
                  ))}
                </div>
                จะลงทะเบียนให้ตอนวัดชิ้นนั้นสำเร็จ แล้ววัดต่อเลยไหม
              </>,
              { title: "มี ALPL ที่ยังไม่ลงทะเบียน", okLabel: "ลงทะเบียนแล้ววัดต่อ" },
            )
          }
          confirmExisting={alpls => dialog.confirm(
            <>
              <strong>ALPL {formatAlplRanges(alpls)} มีอยู่ในระบบแล้ว</strong>
              <p>ใช้ข้อมูล Part ที่ลงทะเบียนไว้และบันทึกผลการวัดใหม่ ต้องการวัดต่อหรือไม่?</p>
            </>,
            { title: "มี ALPL ที่ลงทะเบียนแล้ว", okLabel: "วัดต่อ" },
          )}
          onSave={(q) => {
            setEntryQueue(q);
            entryQueueRef.current = q;
            savePartEntryState();
            setPeModalOpen(false);
          }}
          onClose={() => setPeModalOpen(false)}
        />
      )}

      {/* ดูรูปเต็มจอ — คลิกที่ไหนก็ปิด (รูปเองก็ปิด เพราะ cursor เป็น zoom-out ทั้งจอ) */}
      {zoomImgUrl && (
        <div className="img-zoom" onClick={() => setZoomImgUrl(null)}>
          <img src={zoomImgUrl} alt="Measurement image, full size" />
          <span className="img-zoom-hint">คลิกที่ใดก็ได้ หรือกด Esc เพื่อปิด</span>
        </div>
      )}
    </div>
  );
}
