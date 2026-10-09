import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "../api/client";
import { useToast } from "../components/Toast";
import TrashCard from "../components/TrashCard";
import LookupTables from "../components/LookupTables";
import HistoryCard from "../components/HistoryCard";
import SingleSelect from "../components/SingleSelect";
import { normalizePackageSize } from "../utils/packageSize";
import { toleranceLabel } from "../utils/toleranceLabel";
import { toUiTerms } from "../utils/displayTerms";
import { axisValue, offsetValue, xyPair, DP_MM, DP_OFF } from "../components/measurementCells";
import { useSessionState } from "../hooks/useSessionState";
import { useSSE } from "../hooks/useSSE";
import { useLookups } from "../hooks/useLookups";
import ExportFilters, { EMPTY_FILTERS, hasAnyFilter, toParams, validateAlpl, type FilterState, type MultiKey } from "../components/export/ExportFilters";

// EditPage — พอร์ตจาก Frontend/edit.html (Database Editor) แบบยึดโครงสร้าง/
// field/คอลัมน์/ข้อความ ตามต้นฉบับเป็นหลัก
//
// ความต่างจากต้นฉบับที่ตั้งใจ (ตามที่ผู้ใช้ขอ): ต้นฉบับ edit.html มีฟิลด์
// "Category" (dropdown จาก GET /api/categories) ในฟอร์ม/ตาราง Parts แต่
// backend (main.py) ปัจจุบันไม่มี endpoint /api/categories และ PARTS_SELECT
// ก็ไม่ได้ SELECT คอลัมน์ category เลย — dropdown นี้เลยว่างเปล่าเสมอและใช้
// งานจริงไม่ได้ จึงตัด Category ออกทั้งฟอร์มและคอลัมน์ตาราง แล้วใช้
// "Receive Date" (recieve_date — มีอยู่จริงใน parts/PARTS_SELECT/PartCreate)
// แทนที่ตำแหน่งเดิม

const PAGE_SIZE = 10;
const LOOKUP_QUERY_KEYS = [
  "operators", "owners", "vendors", "handlers", "package-sizes",
  "package-size-tolerances", "part-numbers-all",
] as const;

interface Part {
  part_id: number;
  number_alpl: number;
  part_number: string | null;
  description: string | null;
  po_number: number | null;
  recieve_date: string | null;
  handler: string | null;
  vendor: string | null;
  owner: string | null;
  package_size: string | null;
  tolerance_id: number | null;
  nominal_x: number | null;
  nominal_y: number | null;
  upper_tol: number | null;
  lower_tol: number | null;
  offset_tol: number | null;      // ← เพิ่มบรรทัดนี้
  template_name: string | null;
}

interface Measurement {
  measurement_id: number;
  part_id: number;
  session_id: number | null;
  number_alpl: number;
  value_x: number | null;
  value_y: number | null;
  result: string | null;
  note: string | null;
  timestamp: string | null;
  operator_name?: string | null;
  /** ระยะเยื้องแยกแกน — โหมด IPM ไม่เอามาตัดสิน OK/NG (ดู _judge ฝั่ง backend)
   *
   *  ⚠ ตาราง measurements **ไม่มีคอลัมน์ `offset` เดี่ยว** แล้ว ถูกแยกเป็น
   *    offset_opx / offset_opy ตั้งแต่ตอนแก้ _judge ให้ตรวจทีละแกน —
   *    ของเดิมหน้านี้อ่าน `m.offset` ซึ่ง backend ไม่เคยส่งมา ช่อง Offset
   *    จึงว่างเปล่าทุกแถวโดยไม่มี error อะไรเตือน */
  offset_opx?: number | null;
  offset_opy?: number | null;
  /** ทิศที่เยื้อง — รหัส 9 ค่าจาก `_get_min_position_label` ฝั่ง backend
   *  (TOP / BOTTOM / LEFT / RIGHT / TOP LEFT / … / CENTER)
   *  offset_opx/opy เป็น "ขนาด" ไม่มีเครื่องหมาย ตัวนี้เป็นตัวบอก "ทิศ" */
  offset_pos_op?: string | null;
  offset_tol?: number | null;
  measure_type?: string | null;
  nominal_x?: number | null;
  nominal_y?: number | null;
  upper_tol?: number | null;
  lower_tol?: number | null;
  /** ผลตัดสินรายแกนจาก backend (`_ok_flags` ใน shared.py) — ⚠ **ต้องใช้ตัวนี้
   *  ระบายสี ห้ามคำนวณ `nominal ± tol` เองที่หน้าเว็บ** เพราะ backend ปัด
   *  ทศนิยมด้วย `_DP` ก่อนเทียบ ถ้าคำนวณเองแบบไม่ปัด ชิ้นที่ตกขอบพอดีจะขึ้น
   *  สีแดงทั้งที่คอลัมน์ Result บอก OK · `null` = ตัดสินไม่ได้ ไม่ใช่ไม่ผ่าน */
  ok_x?: boolean | null;
  ok_y?: boolean | null;
  /** แยกรายแกน — ใช้ระบายสีช่องตัวเลข Offset_X / Y */
  ok_opx?: boolean | null;
  ok_opy?: boolean | null;
  /** ⚠ ผลรวมของทั้ง 2 แกน — ห้ามเอาไประบายสีช่องรายแกน (ใช้ ok_opx/ok_opy แทน) */
  ok_offset?: boolean | null;
}

interface EditContext {
  table: "parts" | "measurements" | null;
  mode: "add" | "edit" | null;
  key: number | null;
  original: Part | Measurement | null;
}

interface ConfirmState {
  message: ReactNode;
  onConfirm: () => void | Promise<void>;
}

/* ⚠ `valueCell` / `offsetCell` ที่เคยอยู่ตรงนี้ ย้ายไป
   components/measurementCells.tsx แล้ว (เป็น axisValue / offsetValue) เพราะ
   ตาราง Measurements ของหน้า Home ใช้เกณฑ์สีชุดเดียวกัน — ถ้าปล่อยให้ต่างคน
   ต่างมีจะกลายเป็นแถวเดียวกันแต่คนละสีในสองหน้าจอ */

function pageInfoText(page: number, total: number, count: number): string {
  if (total === 0) return "ไม่มีรายการ";
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = (page - 1) * PAGE_SIZE + count;
  return `แสดง ${start}–${end} จาก ${total} รายการ`;
}

function errMsg(err: unknown, fallback: string): string {
  return toUiTerms(err instanceof ApiError ? err.message : fallback);
}

/** 1 ช่องในกล่องค่า read-only (label เล็กจางอยู่บน ค่าอยู่ล่าง) — ใช้ทั้งกล่อง
 *  "ค่าที่ผูกมากับ DWG#" ของฟอร์ม Part และ "ข้อมูลของรายการนี้" ของฟอร์ม
 *  Measurement เพราะต้นฉบับใช้หน้าตาเดียวกันทั้งคู่ */
function DerivedCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="derived-cell-label">{label}</div>
      <div>{value}</div>
    </div>
  );
}

export default function EditPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  // ── ต่อสายกับถังขยะ ──────────────────────────────────────────────────
  // TrashCard ยังใช้ reloadKey; ส่วน HistoryCard รีเฟรชผ่าน Query invalidation
  // หลังการเขียน DB
  //
  // ⚠ ทุกจุดที่ยิง DELETE ต้องเรียก bumpTrash() ด้วย — ตอนนี้มี 3 จุด (Part /
  //   Measurement / Lookup) ถ้าวันหลังเพิ่มปุ่มลบที่ 4 แล้วลืมเติม ถังขยะจะไม่
  //   อัปเดตเฉพาะปุ่มนั้น อาการจะสับสนมากเพราะที่อื่นทำงานปกติดี
  //   (ต้นฉบับใช้ afterDelete() เป็นตัวกลางกันลืมด้วยเหตุผลเดียวกัน)
  const [trashReload, setTrashReload] = useState(0);
  /** ประวัติต้องรีเฟรชทุกครั้งที่มีการเขียน DB ไม่ใช่เฉพาะตอนลบ */
  const bumpHistory = () => { void queryClient.invalidateQueries({ queryKey: ["edit-history"] }); };
  const bumpTrash = () => { setTrashReload((v) => v + 1); bumpHistory(); };
  const formRef = useRef<HTMLFormElement>(null);

  // ── Parts state (server-side pagination + search) ──────────────────
  const [partsPage, setPartsPage] = useState(1);
  const [partsFilters, setPartsFilters] = useState<FilterState>({ ...EMPTY_FILTERS, latestOnly: false });
  const [appliedPartsFilters, setAppliedPartsFilters] = useState<FilterState>({ ...EMPTY_FILTERS, latestOnly: false });
  const partsSearchTimer = useRef<number | null>(null);
  const partsParams = toParams(appliedPartsFilters, null);
  partsParams.delete("latest_only");
  partsParams.set("limit", String(PAGE_SIZE));
  partsParams.set("offset", String((partsPage - 1) * PAGE_SIZE));
  const partsQueryString = partsParams.toString();
  const partsQuery = useQuery<{ items: Part[]; total: number }, ApiError>({
    queryKey: ["edit-parts", partsQueryString],
    queryFn: ({ signal }) => apiGet<{ items: Part[]; total: number }>(`/api/parts?${partsQueryString}`, undefined, signal),
    enabled: !validateAlpl(appliedPartsFilters.alpl),
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.status === "error" ? 5_000 : 30_000,
  });
  const partsFilterPending = toParams(partsFilters, null).toString() !== toParams(appliedPartsFilters, null).toString();
  const partsData = partsQuery.isError ? [] : partsQuery.data?.items ?? [];
  const partsTotal = partsQuery.isError ? 0 : partsQuery.data?.total ?? 0;

  // ── Measurements state (server-side pagination + filter) ───────────
  const [measPage, setMeasPage] = useState(1);
  const [measFilters, setMeasFilters] = useState<FilterState>({ ...EMPTY_FILTERS, latestOnly: false });
  const [appliedMeasFilters, setAppliedMeasFilters] = useState<FilterState>({ ...EMPTY_FILTERS, latestOnly: false });
  const measSearchTimer = useRef<number | null>(null);
  const measParams = toParams(appliedMeasFilters, null);
  measParams.set("limit", String(PAGE_SIZE));
  measParams.set("offset", String((measPage - 1) * PAGE_SIZE));
  const measQueryString = measParams.toString();
  const measurementsQuery = useQuery<{ items: Measurement[]; total: number }, ApiError>({
    queryKey: ["edit-measurements-history", measQueryString],
    queryFn: ({ signal }) => apiGet<{ items: Measurement[]; total: number }>(`/api/measurements?${measQueryString}`, undefined, signal),
    enabled: !validateAlpl(appliedMeasFilters.alpl),
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.status === "error" ? 5_000 : 30_000,
  });
  const measFilterPending = toParams(measFilters, null).toString() !== toParams(appliedMeasFilters, null).toString();
  const measurementsData = measurementsQuery.isError ? [] : measurementsQuery.data?.items ?? [];
  const measTotal = measurementsQuery.isError ? 0 : measurementsQuery.data?.total ?? 0;

  // ── Session running lock ────────────────────────────────────────────
  /** กำลังมีการวัดอยู่ไหม — ใช้ล็อกปุ่มแก้/ลบทั้งหน้า
   *
   *  ⚠ เดิมหน้านี้ตั้ง setInterval ยิง /api/session/state เองทุก 4 วิ ตอนนี้ไป
   *    เกาะ useSessionState() แทน เพราะ:
   *      · TanStack Query รวมคำขอให้ตาม queryKey — Layout ก็เรียก hook เดียวกัน
   *        อยู่แล้ว เปิดหน้านี้จึงไม่ได้เพิ่มคำขอใหม่เลย (ของเดิมเพิ่ม 1 ชุด)
   *      · ตรรกะแยก 503 / อ่าน pi_status จาก body ของ error / retry:false
   *        อยู่ในนั้นครบแล้ว ไม่ต้องลอกมาไว้ที่นี่อีกชุด
   *
   *  ⚠ ผลข้างเคียงที่ยอมรับ: ตอน session กำลัง running จะ poll ถี่ขึ้นเป็น 1 วิ
   *    (ของเดิม 4 วิคงที่) เพราะ useSessionState เร่งความถี่เองตอนวัดอยู่
   *
   *  `undefined` (ยังโหลดไม่เสร็จ / ถามไม่ได้) → ถือว่า **ไม่ได้วัดอยู่** เพื่อไม่ให้
   *  หน้าจอล็อกค้างตอน backend ล่ม — ฝั่ง backend มี _block_if_session_running()
   *  กันอีกชั้นอยู่แล้ว ตัวนี้เป็นแค่การบอกผู้ใช้ล่วงหน้า
   */
  const { data: sessionState } = useSessionState();
  const sessionRunning = sessionState?.state === "running";
  const liveRefreshTimer = useRef<number | null>(null);
  const lastSessionSig = useRef<string | null>(null);

  // Filter และฟอร์มแก้ไขใช้ lookup cache ชุดเดียวกับหน้า Measure
  const lookups = useLookups();
  const handlerOptions = lookups.handlers.map((h) => h.handler_name);
  const vendorOptions = lookups.vendors.map((v) => v.vendor_name);
  const ownerOptions = lookups.owners.map((o) => o.owner_name);
  const operatorOptions = lookups.operators.map((o) => o.operator_name);
  const packageSizeOptions = lookups.packageSizes.map((p) => p.package_size);
  const partNumberCatalog = lookups.partNumbers;
  const toleranceCatalog = lookups.tolerances;

  // ── Modal / form state ───────────────────────────────────────────────
  const [editContext, setEditContext] = useState<EditContext>({ table: null, mode: null, key: null, original: null });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [alplNoteConsumed, setAlplNoteConsumed] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  /** popup แจ้งเตือนเฉยๆ (ปุ่ม "ตกลง" อย่างเดียว) — แยกจาก confirmState ที่มีปุ่ม
   *  ลบซึ่งทำ action จริง ใช้กับกรณี "ลบไม่ได้เพราะยังมีตารางอื่นอ้างอิงอยู่" (409)
   *  ที่ต้องให้ผู้ใช้เห็นชัดๆ ไม่ใช่ toast ที่หายไปเองใน 3 วิ */
  const [alertText, setAlertText] = useState<string | null>(null);

  // ── ฟอร์ม Part: ช่องที่ต้อง cascade กันจึงคุมด้วย state (ที่เหลืออ่านจาก FormData)
  //    Opening → กำหนดตัวเลือก DWG# และ Tolerance
  const [pkgValue, setPkgValue] = useState("");
  const [toleranceValue, setToleranceValue] = useState("");
  const [pnValue, setPnValue] = useState("");
  const pnOptions = partNumberCatalog
    .filter((p) => p.package_size === pkgValue.trim())
    .map((p) => p.part_number_name);
  const [handlerValue, setHandlerValue] = useState("");
  const [vendorValue, setVendorValue] = useState("");
  const [ownerValue, setOwnerValue] = useState("");
  const [measOperatorValue, setMeasOperatorValue] = useState("");

  // ── Row highlight (highlight-row, 2.2s fade — เหมือนต้นฉบับ) ─────────
  const [highlight, setHighlight] = useState<{ table: "parts" | "measurements"; key: number } | null>(null);
  function flashHighlight(table: "parts" | "measurements", key: number) {
    setHighlight({ table, key });
    window.setTimeout(() => setHighlight((h) => (h && h.key === key && h.table === table ? null : h)), 2300);
  }

  async function loadParts(page: number, filters: FilterState) {
    if (validateAlpl(filters.alpl)) return null;
    const params = toParams(filters, null);
    params.delete("latest_only");
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String((page - 1) * PAGE_SIZE));
    const queryString = params.toString();
    try {
      const d = await queryClient.fetchQuery({
        queryKey: ["edit-parts", queryString],
        queryFn: ({ signal }) => apiGet<{ items: Part[]; total: number }>(`/api/parts?${queryString}`, undefined, signal),
        staleTime: 0,
      });
      return d.items ?? [];
    } catch (e) {
      console.error("loadParts:", e);
      toast.show("ไม่สามารถดึงข้อมูล Parts จาก Database ได้");
      return null;
    }
  }

  async function loadMeasurements(page: number, filters: FilterState) {
    if (validateAlpl(filters.alpl)) return null;
    const params = toParams(filters, null);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String((page - 1) * PAGE_SIZE));
    const queryString = params.toString();
    try {
      const d = await queryClient.fetchQuery({
        queryKey: ["edit-measurements-history", queryString],
        queryFn: ({ signal }) => apiGet<{ items: Measurement[]; total: number }>(`/api/measurements?${queryString}`, undefined, signal),
        staleTime: 0,
      });
      return d.items ?? [];
    } catch (e) {
      console.error("loadMeasurements:", e);
      toast.show("ไม่สามารถดึงข้อมูล Measurements จาก Database ได้");
      return null;
    }
  }

  async function refreshLookups() {
    await Promise.all(LOOKUP_QUERY_KEYS.map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] })));
  }

  function scheduleLiveRefresh() {
    if (liveRefreshTimer.current !== null) window.clearTimeout(liveRefreshTimer.current);
    liveRefreshTimer.current = window.setTimeout(() => {
      liveRefreshTimer.current = null;
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["edit-parts"] }),
        queryClient.invalidateQueries({ queryKey: ["edit-measurements-history"] }),
      ]);
      bumpHistory();
    }, 150);
  }

  // useSSE แชร์ EventSource กับ Layout; หน้านี้ลงทะเบียนเฉพาะตอนเปิด Edit
  const sseStatus = useSSE({
    measurement: scheduleLiveRefresh,
    measurement_replaced: scheduleLiveRefresh,
    image_updated: scheduleLiveRefresh,
    session_complete: scheduleLiveRefresh,
    session_stopped: scheduleLiveRefresh,
    session_timeout: scheduleLiveRefresh,
  });

  // Poll ของ session ช่วยกู้ผลที่เข้ามาตอน SSE หลุด โดยไม่รีเฟรชทุก heartbeat
  useEffect(() => {
    if (!sessionState) return;
    const sig = `${sessionState.session_id}|${sessionState.measured_count}|${sessionState.state}`;
    if (lastSessionSig.current !== null && lastSessionSig.current !== sig) scheduleLiveRefresh();
    lastSessionSig.current = sig;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState?.session_id, sessionState?.measured_count, sessionState?.state]);

  useEffect(() => {
    if (sseStatus !== "online") return;
    scheduleLiveRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sseStatus]);

  useEffect(() => () => {
    if (liveRefreshTimer.current !== null) window.clearTimeout(liveRefreshTimer.current);
    if (partsSearchTimer.current !== null) window.clearTimeout(partsSearchTimer.current);
    if (measSearchTimer.current !== null) window.clearTimeout(measSearchTimer.current);
  }, []);

  async function reloadPartsAfterMutation(highlightAlpl?: number) {
    await queryClient.invalidateQueries({ queryKey: ["edit-parts"], refetchType: "none" });
    let page = partsPage;
    let items = await loadParts(page, appliedPartsFilters);
    if (items?.length === 0 && page > 1) {
      page -= 1;
      setPartsPage(page);
      items = await loadParts(page, appliedPartsFilters);
    }
    if (highlightAlpl != null) flashHighlight("parts", highlightAlpl);
  }
  async function reloadMeasAfterMutation(highlightId?: number) {
    await queryClient.invalidateQueries({ queryKey: ["edit-measurements-history"], refetchType: "none" });
    let page = measPage;
    let items = await loadMeasurements(page, appliedMeasFilters);
    if (items?.length === 0 && page > 1) {
      page -= 1;
      setMeasPage(page);
      items = await loadMeasurements(page, appliedMeasFilters);
    }
    if (highlightId != null) flashHighlight("measurements", highlightId);
  }

  // ── Parts filter handlers ────────────────────────────────────────────
  function onPartsFiltersChange(next: FilterState) {
    setPartsFilters(next);
    if (partsSearchTimer.current) window.clearTimeout(partsSearchTimer.current);
    if (validateAlpl(next.alpl)) return;
    partsSearchTimer.current = window.setTimeout(() => {
      setPartsPage(1);
      setAppliedPartsFilters(next);
    }, 300);
  }
  function onPartsClearFilter() {
    if (partsSearchTimer.current) window.clearTimeout(partsSearchTimer.current);
    const empty: FilterState = { ...EMPTY_FILTERS, multi: { ...EMPTY_FILTERS.multi }, latestOnly: false };
    setPartsFilters(empty);
    setPartsPage(1);
    setAppliedPartsFilters(empty);
  }
  function onPartsPrev() {
    if (partsPage <= 1) return;
    setPartsPage(partsPage - 1);
  }
  function onPartsNext() {
    if ((partsPage - 1) * PAGE_SIZE + partsData.length >= partsTotal) return;
    setPartsPage(partsPage + 1);
  }

  // ── Measurements filter handlers ─────────────────────────────────────
  function onMeasFiltersChange(next: FilterState) {
    setMeasFilters(next);
    if (measSearchTimer.current) window.clearTimeout(measSearchTimer.current);
    if (validateAlpl(next.alpl)) return;
    measSearchTimer.current = window.setTimeout(() => {
      setMeasPage(1);
      setAppliedMeasFilters(next);
    }, 300);
  }
  function onMeasClearFilter() {
    if (measSearchTimer.current) window.clearTimeout(measSearchTimer.current);
    const empty: FilterState = { ...EMPTY_FILTERS, multi: { ...EMPTY_FILTERS.multi }, latestOnly: false };
    setMeasFilters(empty);
    setMeasPage(1);
    setAppliedMeasFilters(empty);
  }
  function onMeasPrev() {
    if (measPage <= 1) return;
    setMeasPage(measPage - 1);
  }
  function onMeasNext() {
    if ((measPage - 1) * PAGE_SIZE + measurementsData.length >= measTotal) return;
    setMeasPage(measPage + 1);
  }

  // ── Modal open/close ─────────────────────────────────────────────────
  function openPartModal(mode: "add" | "edit", partId: number | null = null) {
    const part = mode === "edit" ? partsData.find((p) => p.part_id === partId) ?? null : null;
    setEditContext({ table: "parts", mode, key: partId, original: part });
    setFieldErrors({});
    setAlplNoteConsumed(false);
    // ตั้งค่าตั้งต้นของคู่ที่ cascade กัน — DWG# กรองจาก catalog ใน Query
    setPkgValue(String(part?.package_size ?? ""));
    setToleranceValue(String(part?.tolerance_id ?? ""));
    setPnValue(String(part?.part_number ?? ""));
    setHandlerValue(String(part?.handler ?? ""));
    setVendorValue(String(part?.vendor ?? ""));
    setOwnerValue(String(part?.owner ?? ""));
  }

  // Opening → DWG#: กรองจาก catalog ที่โหลดไว้แล้ว ไม่ยิง request
  // ทุกครั้งที่เปลี่ยนขนาด และยังคงค่าเดิมไว้ระหว่างที่ catalog โหลดครั้งแรก
  useEffect(() => {
    if (editContext.table !== "parts" || !lookups.partNumbersLoaded) return;
    const validNames = new Set(partNumberCatalog
      .filter((p) => p.package_size === pkgValue.trim())
      .map((p) => p.part_number_name));
    setPnValue((value) => validNames.has(value) ? value : "");
  }, [pkgValue, editContext.table, partNumberCatalog, lookups.partNumbersLoaded]);
  function openMeasModal(mode: "add" | "edit", measurementId: number | null = null) {
    const m = mode === "edit" ? measurementsData.find((x) => x.measurement_id === measurementId) ?? null : null;
    setEditContext({ table: "measurements", mode, key: measurementId, original: m });
    setFieldErrors({});
    setAlplNoteConsumed(false);
    setMeasOperatorValue(String(m?.operator_name ?? ""));
  }
  function closeEditModal() {
    setEditContext({ table: null, mode: null, key: null, original: null });
    setFieldErrors({});
  }

  // ── Save Part ─────────────────────────────────────────────────────────
  async function savePart(e: FormEvent) {
    e.preventDefault();
    if (sessionRunning) return;
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    const get = (k: string) => ((fd.get(k) as string) ?? "").trim();
    const errors: Record<string, string> = {};
    const isAdd = editContext.mode === "add";

    const numberAlplRaw = get("number_alpl");
    const nAlpl = Number(numberAlplRaw);
    if (numberAlplRaw === "" || !Number.isInteger(nAlpl) || nAlpl <= 0) {
      errors.number_alpl = "ต้องเป็นเลขจำนวนเต็มบวก";
    } else if (partsData.some((p) => p.number_alpl === nAlpl && p.package_size === pkgValue.trim() && p.part_id !== editContext.key)) {
      errors.number_alpl = `Part Number ${nAlpl} กับ Opening นี้มีอยู่ในตารางแล้ว`;
    }

    /* บังคับกรอกแค่ **Part Number กับ Opening** เท่านั้น (ตอน Add) — ที่เหลือ
       เว้นว่างได้หมด และตอน Edit ไม่บังคับอะไรเลย

       ทำไม Opening ยังบังคับ: มันเป็น **แหล่งเกณฑ์ตัดสิน OK/NG เดียว
       ของทั้งระบบ** ทุกโหมด (ดู `_load_criteria` ใน shared.py) — Part Number ที่ไม่มี
       package_size จะวัดไม่ได้เลย กด Start แล้วเด้ง 404 "หาเกณฑ์ตัดสินไม่เจอ"
       และมันยังเป็นตัวกรอง catalog ของ DWG# ที่เลือกได้ด้วย

       ทำไมตัวอื่นไม่บังคับ: ทุกคอลัมน์ใน `parts_specifications` ยอมให้เป็น NULL
       (ดู init.sql) และการลงทะเบียนแบบ IPM ก็มีแค่ Part Number + Opening อยู่แล้ว
       — ฟอร์มนี้จึงไม่ควรเข้มกว่าเส้นทางที่ระบบใช้จริง

       ⚠ DWG# ว่าง = ไม่มี Handler/Template มาให้อัตโนมัติ ต้องเลือกเอง
         (ถ้าเว้นทั้งคู่ Part นั้นจะไม่มีเครื่องผูกอยู่ ซึ่งจะหลุดจากรายงานที่
          จัดกลุ่มตาม Handler) */
    if (!pkgValue.trim()) errors.package_size = "เลือก Opening";
    if (!toleranceCatalog.some((t) => t.package_size === pkgValue.trim() && String(t.tolerance_id) === toleranceValue)) {
      errors.tolerance_id = "เลือก Tolerance ที่ตรงกับ Opening";
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.number_alpl) setAlplNoteConsumed(true);
      return;
    }

    /* ⚠ คอมเมนต์เดิมตรงนี้บอกว่า "ไม่มี handler ใน record เพราะ backend derive
       จาก part_number ให้เอง" — **ตกรุ่นแล้ว** ตอนนี้ parts_specifications เก็บ
       handler_id ของตัวเอง เพราะ "Part Number ตัวนี้อยู่บนเครื่องไหน" เป็นข้อเท็จจริง
       ของ Part Number ไม่ใช่ของ catalog (part เดียวกันอาจมี Part Number อยู่คนละเครื่อง)
       ฝั่ง backend อ่านด้วย COALESCE(ของ Part Number, ของ part_number) เสมอ */
    const record: Record<string, unknown> = {
      number_alpl: nAlpl,
      part_number: pnValue,
      handler: get("handler") || null,
      vendor: get("vendor") || null,
      description: get("description") || null,
      po_number: get("po_number") === "" ? null : Number(get("po_number")),
      package_size: pkgValue.trim() || null,
      tolerance_id: Number(toleranceValue),
      owner: get("owner") || null,
      recieve_date: get("recieve_date") || null,
    };

    if (!isAdd && editContext.original) {
      const orig = editContext.original as unknown as Record<string, unknown>;
      const changed = Object.keys(record).some((k) => String(orig[k] ?? null) !== String(record[k] ?? null));
      if (!changed) {
        closeEditModal();
        return;
      }
    }

    try {
      if (isAdd) await apiPost("/api/parts", record);
      else await apiPatch(`/api/parts/${editContext.key}`, record);
      toast.show(isAdd ? `เพิ่ม Part Number ${nAlpl} สำเร็จ` : `บันทึก Part Number ${nAlpl} สำเร็จ`, undefined, "success");
      bumpHistory();
      await reloadPartsAfterMutation(nAlpl);
      closeEditModal();
    } catch (err) {
      toast.show(errMsg(err, "บันทึกข้อมูล Part ไม่สำเร็จ"));
    }
  }

  function confirmDeletePart(partId: number, numberAlpl: number) {
    // ลบ Part ได้ต่อเมื่อ Part Number นี้ไม่มี Session/Measurement เหลืออยู่เลยเท่านั้น —
    // FK เป็น RESTRICT (ไม่มีโหมด cascade ตามที่ตกลงกันว่า "เก็บประวัติไว้เหมือนเดิม")
    // ถ้ายังมีประวัติอยู่ backend ปฏิเสธด้วย 409 พร้อมบอกจำนวนที่ติดอยู่ → เอาข้อความ
    // นั้นมาเด้งเป็น alert ให้เห็นชัด ไม่ใช่ toast ที่หายไปเองก่อนอ่านทัน
    setConfirmState({
      message: (
        <>
          ลบ Part <strong>Part Number {numberAlpl}</strong> ออกจากตารางใช่ไหม?
        </>
      ),
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await apiDelete(`/api/parts/${partId}`);
          await reloadPartsAfterMutation();
          bumpTrash();
          closeEditModal();
          toast.show(`ลบ Part Number ${numberAlpl} สำเร็จ`, undefined, "success");
        } catch (err) {
          setAlertText(errMsg(err, "ลบ Part ไม่สำเร็จ"));
        }
      },
    });
  }

  // ── Save Measurement ──────────────────────────────────────────────────
  async function saveMeas(e: FormEvent) {
    e.preventDefault();
    if (sessionRunning) return;
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    const get = (k: string) => ((fd.get(k) as string) ?? "").trim();
    const isEdit = editContext.mode === "edit";
    const errors: Record<string, string> = {};

    const numberAlplRaw = get("number_alpl");
    const nAlpl = Number(numberAlplRaw);
    if (numberAlplRaw === "" || !Number.isInteger(nAlpl) || nAlpl <= 0) {
      errors.number_alpl = "ต้องเป็นเลขจำนวนเต็มบวก";
    } else if (!partsData.some((p) => p.number_alpl === nAlpl)) {
      errors.number_alpl = `Part Number ${nAlpl} ยังไม่ได้ลงทะเบียนในตาราง Parts`;
    }

    const originalMeasurement = editContext.original as Measurement | null;
    const samePart = originalMeasurement?.number_alpl === nAlpl
      ? originalMeasurement.part_id : null;
    const candidates = partsData.filter((p) => p.number_alpl === nAlpl);
    const selectedPartId = samePart ?? (candidates.length === 1 ? candidates[0].part_id : null);
    if (!errors.number_alpl && selectedPartId == null) {
      errors.number_alpl = `Part Number ${nAlpl} มีหลาย Opening — ต้องเลือก Part ให้ชัดเจนก่อนแก้ผลวัด`;
    }

    let sessionId: number | null = null;
    if (isEdit) {
      const existing = measurementsData.find((m) => m.measurement_id === editContext.key);
      sessionId = existing?.session_id ?? null;
    }

    // ตอน Edit แก้ได้เฉพาะ Part Number กับ Performed by เท่านั้น — ช่อง Measuring_X / Measuring_Y และ Note
    // ถูกย้ายไปอยู่ในกล่อง 🔒 read-only แล้ว (ผลการวัดจริงจากเครื่อง แก้ย้อนหลังไม่ได้)
    let valueX: number | undefined;
    let valueY: number | undefined;
    let operator: string | null = null;
    if (!isEdit) {
      const vx = get("value_x");
      const vy = get("value_y");
      if (vx === "" || isNaN(Number(vx))) errors.value_x = "กรอก Measuring_X เป็นตัวเลข";
      if (vy === "" || isNaN(Number(vy))) errors.value_y = "กรอก Measuring_Y เป็นตัวเลข";
      valueX = Number(vx);
      valueY = Number(vy);
    } else {
      // operator_id ใน DB เป็น NOT NULL — เว้นว่างไม่ได้
      operator = get("operator");
      if (!operator) errors.operator = "เลือก Performed by";
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.number_alpl) setAlplNoteConsumed(true);
      return;
    }

    // ไม่ส่ง result — backend คำนวณ OK/NG ใหม่เองเสมอจาก value + tolerance ของ Part Number ที่เลือก
    const payload: Record<string, unknown> = isEdit
      ? { session_id: sessionId, number_alpl: nAlpl, part_id: selectedPartId, operator }
      : { session_id: sessionId, number_alpl: nAlpl, part_id: selectedPartId, value_x: valueX, value_y: valueY, note: get("note") || null };

    if (isEdit && editContext.original) {
      const orig = editContext.original as Measurement;
      const alplSame = String(orig.number_alpl ?? null) === String(payload.number_alpl ?? null);
      const operatorSame = String(orig.operator_name ?? null) === String(payload.operator ?? null);
      if (alplSame && operatorSame) {
        closeEditModal();
        return;
      }
    }

    try {
      const res = isEdit
        ? await apiPatch<{ result?: string }>(`/api/measurements/${editContext.key}`, payload)
        : await apiPost<{ result?: string }>("/api/measurements", payload);
      const resultNote = res?.result ? ` (Result: ${res.result})` : "";
      toast.show(isEdit ? `บันทึก Measurement ID ${editContext.key} เรียบร้อยแล้ว${resultNote}` : `เพิ่ม Measurement เรียบร้อยแล้ว${resultNote}`, undefined, "success");
      bumpHistory();
      await reloadMeasAfterMutation((editContext.key as number) ?? undefined);
      closeEditModal();
    } catch (err) {
      toast.show(errMsg(err, "บันทึกข้อมูล Measurement ไม่สำเร็จ"));
    }
  }

  function confirmDeleteMeas(measurementId: number) {
    setConfirmState({
      message: (
        <>
          ลบ Measurement <strong>ID {measurementId}</strong> ออกจากตารางใช่ไหม?
        </>
      ),
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await apiDelete(`/api/measurements/${measurementId}`);
          bumpTrash();
          await reloadMeasAfterMutation();
          closeEditModal();
      toast.show(`ลบ Measurement ID ${measurementId} สำเร็จ`, undefined, "success");
        } catch (err) {
          setAlertText(errMsg(err, "ลบ Measurement ไม่สำเร็จ"));
        }
      },
    });
  }

  const isEdit = editContext.mode === "edit";
  const reqMark = editContext.mode === "add" ? <span className="req">*</span> : null;
  const partOrig = editContext.table === "parts" ? (editContext.original as Part | null) : null;
  const measOrig = editContext.table === "measurements" ? (editContext.original as Measurement | null) : null;
  const pv = (field: keyof Part) => (partOrig ? (partOrig[field] as string | number | null) ?? "" : "");
  const mv = (field: keyof Measurement) => (measOrig ? (measOrig[field] as string | number | null) ?? "" : "");
  const filterOptions: Record<MultiKey, string[]> = {
    result: ["OK", "NG"], package_size: packageSizeOptions, part_number: [],
    handler: handlerOptions, operator: operatorOptions, measure_type: ["IPM", "New"],
    vendor: vendorOptions, owner: ownerOptions,
  };

  return (
    <div className="main-edit">
      {sessionRunning && (
        <div className="mock-banner">
          ⏳ กำลังวัดอยู่ — ตารางจะอัปเดตตามผลวัด ดูและค้นหาได้ แต่เพิ่ม แก้ไข ลบ หรือกู้ข้อมูลได้หลังวัดเสร็จ
        </div>
      )}

      {/* ═══════════════════════ PARTS TABLE ═══════════════════════ */}
      <section className="card">
        <div className="card-header">
          <div className="card-title">
            Part Number Profile <span className="count">({partsTotal})</span>
          </div>
          <button type="button" className="btn-add" disabled={sessionRunning} onClick={() => openPartModal("add")}>
            + Add Part
          </button>
        </div>

        <div className="measurement-history-filters">
          <ExportFilters
            value={partsFilters} onChange={onPartsFiltersChange} onClear={onPartsClearFilter}
            options={filterOptions} partNumberCatalog={partNumberCatalog} toleranceCatalog={toleranceCatalog}
            showLatestOnly={false} showMeasureDate={false}
            hiddenMultiKeys={["result", "operator", "measure_type"]}
            collapsibleAdvanced
          />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {/* ⚠ `th-derived` (มีกุญแจ 🔒 ต่อท้าย + สีจาง) = คอลัมน์ read-only ที่
                    ระบบ derive มาให้ แก้ที่ตารางนี้ไม่ได้
                    มี 4 ตัว: Template · Nominal_X / Nominal_Y · USL / LSL · Centering Offset
                    ทั้งหมดมาจาก `package_size` ที่ Part Number ตัวนี้ผูกอยู่ (ดู PARTS_SELECT)
                    จะแก้ค่าพวกนี้ต้องไปที่การ์ด Lookup Tables › Opening
                    ย้ายมาจากตาราง Measurements เพราะเป็นสเปกของ "ชิ้นงาน"
                    ไม่ใช่ของ "การวัดครั้งนั้น"

                    ⚠ **Handler ไม่ใช่ derived แล้ว** — `parts_specifications` เก็บ
                      `handler_id` ของตัวเอง และฟอร์มมี dropdown ให้แก้ได้จริง
                      (ค่าที่โชว์คือ COALESCE ของ Part Number ก่อน ถ้าไม่มีค่อยของ part_number) */}
                <th>Part ID</th>
                <th>Part Number</th>
                <th>DWG#</th>
                <th>H/L</th>
                <th>Opening</th>
                <th>Tolerance ID</th>
                <th className="th-derived">Template</th>
                <th className="th-derived">Nominal_X / Nominal_Y</th>
                <th className="th-derived">USL / LSL</th>
                <th className="th-derived">Centering Offset</th>
                <th>Vendor</th>
                <th>Order by</th>
                <th>PO#</th>
                <th>Desc.</th>
                <th>Receive Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {validateAlpl(partsFilters.alpl) ? (
                <tr className="empty-row"><td colSpan={16}>กรุณาแก้รูปแบบ Part Number ในตัวกรอง</td></tr>
              ) : partsFilterPending || partsQuery.isPending ? (
                <tr className="empty-row"><td colSpan={16}>กำลังโหลด Part Number Profile...</td></tr>
              ) : partsQuery.isError ? (
                <tr className="empty-row"><td colSpan={16}>โหลด Part Number Profile ไม่สำเร็จ กำลังลองใหม่อีกครั้ง</td></tr>
              ) : partsData.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={16}>{hasAnyFilter(partsFilters) ? "ไม่พบ Part ที่ตรงกับตัวกรอง" : "ยังไม่มีข้อมูล Parts"}</td>
                </tr>
              ) : (
                partsData.map((p) => (
                  <tr key={p.part_id} className={highlight?.table === "parts" && highlight.key === p.number_alpl ? "highlight-row" : ""}>
                    <td>{p.part_id ?? "—"}</td>
                    <td>
                      <strong>{p.number_alpl}</strong>
                    </td>
                    <td>{p.part_number ?? ""}</td>
                    <td>{p.handler ?? ""}</td>
                    <td>{p.package_size ?? ""}</td>
                    <td>{p.tolerance_id ?? "—"}</td>
                    <td className="td-derived">{p.template_name ?? ""}</td>
                    <td className="td-derived">
                      {p.nominal_x != null && p.nominal_y != null
                        ? `${Number(p.nominal_x).toFixed(DP_MM)} / ${Number(p.nominal_y).toFixed(DP_MM)}`
                        : "—"}
                    </td>
                    <td className="td-derived">
                      {p.upper_tol != null && p.lower_tol != null
                        ? `+${Number(p.upper_tol).toFixed(DP_MM)} / -${Number(p.lower_tol).toFixed(DP_MM)}`
                        : "—"}
                    </td>
                    <td className="td-derived">
                      {p.offset_tol != null ? Number(p.offset_tol).toFixed(DP_OFF) : "—"}
                    </td>
                    <td>{p.vendor ?? ""}</td>
                    <td>{p.owner ?? ""}</td>
                    <td>{p.po_number ?? ""}</td>
                    <td className="desc-cell" title={p.description ?? ""}>
                      {p.description ?? ""}
                    </td>
                    <td>{p.recieve_date ? String(p.recieve_date).slice(0, 10) : ""}</td>
                    <td className="row-actions">
                      <div className="actions-inner">
                        <button
                          className="btn-icon edit"
                          disabled={sessionRunning}
                          title={sessionRunning ? "กำลังวัดอยู่ ไม่สามารถแก้ไขได้" : undefined}
                          onClick={() => openPartModal("edit", p.part_id)}
                        >
                          ✎ Edit
                        </button>
                        <button
                          className="btn-icon delete"
                          disabled={sessionRunning}
                          title={sessionRunning ? "กำลังวัดอยู่ ไม่สามารถลบได้" : undefined}
                          onClick={() => confirmDeletePart(p.part_id, p.number_alpl)}
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="pagination-bar">
          <button type="button" className="btn-icon" disabled={partsPage <= 1 || partsFilterPending || partsQuery.isPending || partsQuery.isError} onClick={onPartsPrev}>
            ‹ Previous
          </button>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{pageInfoText(partsPage, partsTotal, partsData.length)}</span>
          <button
            type="button"
            className="btn-icon"
            disabled={partsFilterPending || partsQuery.isPending || partsQuery.isError || (partsPage - 1) * PAGE_SIZE + partsData.length >= partsTotal}
            onClick={onPartsNext}
          >
            Next ›
          </button>
        </div>
      </section>

      {/* ═══════════════════════ MEASUREMENTS TABLE ═══════════════════════ */}
      <section className="card">
        <div className="card-header">
          <div className="card-title">
            Measurements History <span className="count">({measTotal})</span>
          </div>
        </div>

        <div className="measurement-history-filters">
          <ExportFilters
            value={measFilters} onChange={onMeasFiltersChange} onClear={onMeasClearFilter}
            options={filterOptions} partNumberCatalog={partNumberCatalog} toleranceCatalog={toleranceCatalog}
            showLatestOnly={false}
            collapsibleAdvanced primaryMultiKeys={["result", "package_size"]}
          />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {/* ⚠ ลำดับ/ชื่อคอลัมน์ต้องตรงกับตาราง Measurements หน้า Home
                    (DashboardPage) ทุกตัว **ยกเว้น Image** ที่ไม่เอามา เพราะ
                    หน้านี้เป็นหน้าแก้ข้อมูล ไม่ใช่หน้าดูผล — คนที่อยากดูรูป
                    เปิดจากหน้า Home ซึ่งกดแถวแล้วมีรายงานเต็มให้อยู่แล้ว
                    ถ้าแก้ที่นี่ต้องไปแก้อีกฝั่งด้วย ไม่งั้นสองหน้าจะเล่าคนละเรื่อง

                    🔒 = แก้ไม่ได้ · แก้ได้เฉพาะ Part Number กับ Performed by เท่านั้น
                    (ค่าที่วัดมาจริงกับข้อมูลของ session แก้ย้อนหลังไม่ได้) */}
                <th className="th-derived">ID</th>
                <th className="th-derived">Session</th>
                <th>Part Number</th>
                {/* เกณฑ์ตัดสิน (Nominal / Tol / Centering Offset) ย้ายไปอยู่ตาราง Parts
                    ด้านบนแล้ว — เป็นสเปกของ "ชิ้นงาน" ไม่ใช่ของ "การวัดครั้งนั้น"
                    ค่ายังถูกดึงมาใน MEASUREMENTS_SELECT อยู่ เพราะ Measuring_X / Measuring_Y กับ
                    Offset_X / Offset_Y ใช้มันระบายสีว่าเกินสเปกไหม (ดู axisValue/offsetValue)
                    ถ้าอยากดูเกณฑ์ที่ใช้ตอนวัดจริงย้อนหลัง ดูได้จาก Export CSV */}
                <th className="th-derived">Measuring_X / Measuring_Y</th>
                <th className="th-derived">Offset_X / Offset_Y</th>
                {/* ทิศที่เยื้อง — รหัส 9 ค่าที่ backend คำนวณให้ (ดู `_get_min_position_label`)
                    เงื่อนไขเดียวกับ Offset_X / Offset_Y คือ IPM ขึ้น "—" ทั้งคอลัมน์ */}
                <th className="th-derived">Opening shift</th>
                <th className="th-derived">Result</th>
                <th className="th-derived">Note</th>
                <th>Performed by</th>
                <th className="th-derived">Measure Type</th>
                <th className="th-derived">Performed date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {validateAlpl(measFilters.alpl) ? (
                <tr className="empty-row"><td colSpan={12}>กรุณาแก้รูปแบบ Part Number ในตัวกรอง</td></tr>
              ) : measFilterPending || measurementsQuery.isPending ? (
                <tr className="empty-row"><td colSpan={12}>กำลังโหลด Measurement History...</td></tr>
              ) : measurementsQuery.isError ? (
                <tr className="empty-row"><td colSpan={12}>โหลด Measurement History ไม่สำเร็จ กำลังลองใหม่อีกครั้ง</td></tr>
              ) : measurementsData.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={12}>{hasAnyFilter(measFilters) ? "ไม่พบ Measurement ที่ตรงกับตัวกรอง" : "ยังไม่มีข้อมูล Measurements"}</td>
                </tr>
              ) : (
                measurementsData.map((m) => {
                  const res = m.result || "—";
                  const cls = res === "OK" ? "ok" : res === "NG" ? "ng" : "";
                  const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : "—";
                  // โหมดของ "แถวนี้" ไม่ใช่โหมดของ session ปัจจุบัน — ตารางนี้
                  // แสดงข้อมูลย้อนหลังที่ปนกันทุกโหมด (กติกาเดียวกับหน้า Home)
                  const isIpm = (m.measure_type ?? "").toUpperCase() === "IPM";
                  return (
                    <tr
                      key={m.measurement_id}
                      className={highlight?.table === "measurements" && highlight.key === m.measurement_id ? "highlight-row" : ""}
                    >
                      <td>{m.measurement_id}</td>
                      <td className="td-derived">{m.session_id ?? ""}</td>
                      <td>
                        <strong>{m.number_alpl}</strong>
                      </td>
                      <td className="td-derived" style={{ whiteSpace: "nowrap" }}>
                        {xyPair(
                          axisValue(m.value_x, m.nominal_x, m.upper_tol, m.lower_tol, m.ok_x),
                          axisValue(m.value_y, m.nominal_y, m.upper_tol, m.lower_tol, m.ok_y),
                        )}
                      </td>
                      <td className="td-derived" style={{ whiteSpace: "nowrap" }}>
                        {isIpm ? "—"
                          : xyPair(
                              offsetValue(m.offset_opx, m.offset_tol, m.ok_opx),
                              offsetValue(m.offset_opy, m.offset_tol, m.ok_opy),
                            )}
                      </td>
                      <td className="td-derived" style={{ whiteSpace: "nowrap" }}>
                        {isIpm ? "—" : (m.offset_pos_op || "—")}
                      </td>
                      <td>
                        <span className={`result-badge ${cls}`}>{res}</span>
                      </td>
                      <td className="td-derived">{m.note ?? ""}</td>
                      <td>{m.operator_name ?? ""}</td>
                      <td className="td-derived">{m.measure_type ?? ""}</td>
                      <td className="td-derived">{ts}</td>
                      <td className="row-actions">
                        <div className="actions-inner">
                          <button
                            className="btn-icon edit"
                            disabled={sessionRunning}
                            title={sessionRunning ? "กำลังวัดอยู่ ไม่สามารถแก้ไขได้" : undefined}
                            onClick={() => openMeasModal("edit", m.measurement_id)}
                          >
                            ✎ Edit
                          </button>
                          <button
                            className="btn-icon delete"
                            disabled={sessionRunning}
                            title={sessionRunning ? "กำลังวัดอยู่ ไม่สามารถลบได้" : undefined}
                            onClick={() => confirmDeleteMeas(m.measurement_id)}
                          >
                            🗑
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="pagination-bar">
          <button type="button" className="btn-icon" disabled={measPage <= 1 || measFilterPending || measurementsQuery.isPending || measurementsQuery.isError} onClick={onMeasPrev}>
            ‹ Previous
          </button>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{pageInfoText(measPage, measTotal, measurementsData.length)}</span>
          <button
            type="button"
            className="btn-icon"
            disabled={measFilterPending || measurementsQuery.isPending || measurementsQuery.isError || (measPage - 1) * PAGE_SIZE + measurementsData.length >= measTotal}
            onClick={onMeasNext}
          >
            Next ›
          </button>
        </div>
      </section>

      {/* ── Lookup Tables ─────────────────────────────────────────────────
          จัดการตาราง lookup ทั้ง 7 ตัว · ลำดับตรงกับ edit.html คือ
          Parts → Measurements → Lookup Tables → Trash */}
      <LookupTables
        readOnly={sessionRunning}
        onDeleted={bumpTrash}
        onChanged={() => { void refreshLookups(); bumpHistory(); }}
        onAlert={setAlertText}
        // ใช้ confirm modal ตัวเดียวกับ Parts/Measurements — ปุ่มลบทุกจุดในหน้านี้
        // จะได้ถามยืนยันหน้าตาเหมือนกันหมด ไม่มีจุดไหนลบทันทีโดยไม่ถาม
        // ปิด confirm ก่อนเสมอ ไม่งั้นถ้า action เด้ง alert ต่อ (ลบไม่ได้ 409)
        // จะเห็น 2 modal ซ้อนกันแล้วอ่านไม่ออกว่าต้องกดอันไหน
        onConfirm={(message, action) => setConfirmState({ message, onConfirm: () => { setConfirmState(null); action(); } })}
      />

      {/* ── ประวัติการแก้ไข ─────────────────────────────────────────────
          วางก่อนถังขยะ — เป็นของที่เปิดดูบ่อยกว่า ส่วนถังขยะยังอยู่ท้ายสุด
          ตามต้นฉบับ (เผลอลบแล้วเลื่อนลงมากู้ได้ทันที) */}
      <HistoryCard />

      {/* ── ถังขยะ ────────────────────────────────────────────────────────
          วางไว้ท้ายสุดของหน้าโดยตั้งใจ (ตามต้นฉบับ) — เป็นหน้าเดียวกับที่ผู้ใช้
          กดลบ เผลอลบแล้วเลื่อนลงมากู้ได้ทันที ไม่ต้องจำว่าต้องไปหน้าไหน */}
      <TrashCard
        readOnly={sessionRunning}
        reloadKey={trashReload}
        onPurged={bumpHistory}
        onRestored={async () => {
          bumpHistory();
          // กู้คืนแล้วของกลับเข้าตารางไหนก็ไม่รู้ (Part / Measurement / Lookup)
          // โหลดใหม่ทั้งหมดง่ายกว่าและถูกเสมอ — หน้านี้โหลดทีละหน้าอยู่แล้ว
          // ไม่ได้แพงอะไร
          await Promise.all([
            reloadPartsAfterMutation(),
            reloadMeasAfterMutation(),
            refreshLookups(),
          ]);
        }}
      />

      {/* ── Edit/Add modal (ใช้ร่วมกันทั้ง Parts และ Measurements) ────── */}
      <div className={`modal-overlay${editContext.table ? " open" : ""}`}>
        <div className={`edit-modal-box${editContext.table === "parts" ? " part-edit-modal" : ""}`}>
          <div className="edit-modal-header">
            <div className="card-title">
              {editContext.table === "parts"
                ? isEdit
                  ? `Edit Part — Part Number ${editContext.key}`
                  : "Add New Part"
                : editContext.table === "measurements"
                  ? isEdit
                    ? `Edit Measurement — ID ${editContext.key}`
                    : "Add New Measurement"
                  : ""}
            </div>
            <button type="button" className="modal-close" onClick={closeEditModal}>
              ✕
            </button>
          </div>
          <form ref={formRef} onSubmit={editContext.table === "parts" ? savePart : saveMeas}>
            <div className={`entry-form-grid${editContext.table === "parts" ? " part-edit-grid" : ""}`}>
              {editContext.table === "parts" && (
                <>
                  <div className="form-group">
                    <label htmlFor="f-number_alpl">
                      Part Number <span className="req">*</span>
                    </label>
                    <input type="number" id="f-number_alpl" name="number_alpl" defaultValue={pv("number_alpl") || editContext.key || ""} />
                    <div className="field-error">
                      {fieldErrors.number_alpl ? (
                        fieldErrors.number_alpl
                      ) : isEdit && !alplNoteConsumed ? (
                        <span className="field-locked-note">
                          แก้ Part Number ได้ — ระวัง: ถ้า Part Number นี้มีประวัติ session/measurement ผูกอยู่แล้ว การเปลี่ยนจะถูก DB ปฏิเสธ (FK constraint)
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="f-package_size">Opening {reqMark}</label>
                    <SingleSelect
                      id="f-package_size"
                      label="Opening"
                      options={packageSizeOptions}
                      value={pkgValue}
                      onChange={(value) => { setPkgValue(value); setToleranceValue(""); setPnValue(""); }}
                      placeholder="เลือก Opening"
                      normalizeQuery={normalizePackageSize}
                      invalid={!!fieldErrors.package_size}
                    />
                    <div className="field-error">{fieldErrors.package_size}</div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="f-part_number">DWG#</label>
                    {/* disabled จนกว่าจะมี Opening ที่หา DWG# เจอ —
                        เลือกก่อนไม่ได้เพราะ catalog ของ DWG# ผูกกับ
                        Opening อยู่ (ดู schema part_number) */}
                    <SingleSelect
                      id="f-part_number"
                      label="DWG#"
                      options={pnOptions}
                      value={pnValue}
                      disabled={pnOptions.length === 0}
                      onChange={setPnValue}
                      placeholder={!pkgValue.trim() ? "เลือก Opening ก่อน" : "เลือก DWG#"}
                      emptyText="Opening นี้ยังไม่มี DWG#"
                      invalid={!!fieldErrors.part_number}
                    />
                    <div className="field-error">{fieldErrors.part_number}</div>
                  </div>
                  {/* Handler — เลือกได้เอง ไม่ผูกกับ DWG# แล้ว
                      (Part Number ตัวเดียวกันย้ายเครื่องได้ ส่วน part_number เป็นแค่แคตตาล็อก)
                      เว้นว่างได้ = ยังไม่ระบุ */}
                  <div className="form-group">
                    <label htmlFor="f-handler">H/L</label>
                    <SingleSelect id="f-handler" label="H/L"
                      options={[{ value: "", label: "ยังไม่ระบุ" }, ...handlerOptions]}
                      value={handlerValue} onChange={setHandlerValue}
                      placeholder="ยังไม่ระบุ" invalid={!!fieldErrors.handler}
                      searchable={false} showRadio={false} />
                    <input type="hidden" name="handler" value={handlerValue} />
                    <div className="field-error">{fieldErrors.handler}</div>
                  </div>
                  <div className="form-group span-2">
                    <label htmlFor="f-tolerance_id">Tolerance <span className="req">*</span></label>
                    <SingleSelect id="f-tolerance_id" label="Tolerance"
                      options={toleranceCatalog.filter((t) => t.package_size === pkgValue.trim()).map((t) => ({
                        value: String(t.tolerance_id), label: toleranceLabel(t),
                      }))}
                      value={toleranceValue} onChange={setToleranceValue}
                      disabled={!pkgValue.trim()}
                      placeholder={pkgValue.trim() ? "เลือก Tolerance" : "เลือก Opening ก่อนถึงจะเลือก Tolerance ได้"}
                      invalid={!!fieldErrors.tolerance_id}
                      searchable={false} showRadio={false} />
                    <div className="field-error">{fieldErrors.tolerance_id}</div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="f-vendor">Vendor</label>
                    <SingleSelect id="f-vendor" label="Vendor"
                      options={[{ value: "", label: "ยังไม่ระบุ" }, ...vendorOptions]}
                      value={vendorValue} onChange={setVendorValue}
                      placeholder="เลือก Vendor" searchable={false} showRadio={false} />
                    <input type="hidden" name="vendor" value={vendorValue} />
                    <div className="field-error">{fieldErrors.vendor}</div>
                  </div>
                  <div className="form-group span-2">
                    <label htmlFor="f-description">Desc.</label>
                    <input type="text" id="f-description" name="description" defaultValue={pv("description")} />
                    <div className="field-error">{fieldErrors.description}</div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="f-po_number">PO#</label>
                    <input type="number" id="f-po_number" name="po_number" defaultValue={pv("po_number")}
                      onWheel={(e) => e.currentTarget.blur()} />
                    <div className="field-error">{fieldErrors.po_number}</div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="f-owner">Order by</label>
                    <SingleSelect id="f-owner" label="Order by"
                      options={[{ value: "", label: "ยังไม่ระบุ" }, ...ownerOptions]}
                      value={ownerValue} onChange={setOwnerValue}
                      placeholder="เลือก Order by" searchable={false} showRadio={false} />
                    <input type="hidden" name="owner" value={ownerValue} />
                    <div className="field-error">{fieldErrors.owner}</div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="f-recieve_date">Receive Date</label>
                    <input
                      type="date"
                      id="f-recieve_date"
                      name="recieve_date"
                      defaultValue={partOrig?.recieve_date ? String(partOrig.recieve_date).slice(0, 10) : ""}
                    />
                    <div className="field-error">
                      {fieldErrors.recieve_date ? (
                        fieldErrors.recieve_date
                      ) : (
                        <span className="field-locked-note">เว้นว่างได้ (จะถูกบันทึกเป็นค่าว่าง)</span>
                      )}
                    </div>
                  </div>
                </>
              )}

              {editContext.table === "measurements" && (
                <>
                  <div className="form-group">
                    <label htmlFor="f-number_alpl">
                      Part Number <span className="req">*</span>
                    </label>
                    <input type="number" id="f-number_alpl" name="number_alpl" defaultValue={mv("number_alpl")} />
                    <div className="field-error">
                      {fieldErrors.number_alpl ? (
                        fieldErrors.number_alpl
                      ) : isEdit && !alplNoteConsumed ? (
                        <span className="field-locked-note">
                          แก้ Part Number ได้ — ใช้กรณี IPM เลือกชิ้นที่มีอยู่จริงผิดตัว (ต้องเป็น Part Number ที่ลงทะเบียนใน Parts แล้ว)
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {!isEdit && (
                    <>
                      <div className="form-group">
                        <label htmlFor="f-value_x">
                          Measuring_X (mm) <span className="req">*</span>
                        </label>
                        <input type="number" step="0.001" id="f-value_x" name="value_x" defaultValue={mv("value_x")} />
                        <div className="field-error">{fieldErrors.value_x}</div>
                      </div>
                      <div className="form-group">
                        <label htmlFor="f-value_y">
                          Measuring_Y (mm) <span className="req">*</span>
                        </label>
                        <input type="number" step="0.001" id="f-value_y" name="value_y" defaultValue={mv("value_y")} />
                        <div className="field-error">{fieldErrors.value_y}</div>
                      </div>
                    </>
                  )}
                  {isEdit ? (
                    <>
                      <div className="form-group">
                        <label htmlFor="f-operator">
                          Performed by <span className="req">*</span>
                        </label>
                        <SingleSelect id="f-operator" label="Performed by"
                          options={operatorOptions}
                          value={measOperatorValue} onChange={setMeasOperatorValue}
                          placeholder="เลือก Performed by" searchable={false} showRadio={false}
                          invalid={!!fieldErrors.operator} />
                        <input type="hidden" name="operator" value={measOperatorValue} />
                        <div className="field-error">{fieldErrors.operator}</div>
                      </div>
                      {/* ผลการวัดจริงจากเครื่อง + ข้อมูลของ session — ดูได้อย่างเดียว
                          แก้ย้อนหลังไม่ได้ทุกกรณี (ไม่ใช่แค่ disabled ช่องกรอกไว้
                          แต่ไม่ส่งไปใน payload เลย — backend ใช้ whitelist อยู่แล้ว) */}
                      <div className="form-group span-2">
                        <label>🔒 ข้อมูลของรายการนี้ (แก้ไม่ได้)</label>
                        <div className="derived-preview">
                          <DerivedCell label="Measuring_X" value={String(mv("value_x") || "—")} />
                          <DerivedCell label="Measuring_Y" value={String(mv("value_y") || "—")} />
                          <DerivedCell label="Note" value={String(mv("note") || "—")} />
                          <DerivedCell label="Measure Type" value={String(mv("measure_type") || "—")} />
                        </div>
                        <div className="field-locked-note">
                          ผลการวัดจริงจากเครื่องกับข้อมูลของ session แก้ย้อนหลังไม่ได้ — Result (OK/NG)
                          จะถูกคำนวณใหม่อัตโนมัติจาก tolerance ของ Part Number ที่เลือก
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="form-group span-2">
                        <label htmlFor="f-note">Note</label>
                        <textarea id="f-note" name="note" defaultValue={mv("note") ?? ""} />
                        <div className="field-error" />
                      </div>
                      <div className="form-group span-2">
                        <div className="field-locked-note">
                          Result (OK/NG) คำนวณอัตโนมัติจาก Measuring_X / Measuring_Y เทียบกับ tolerance ของ Part Number — ไม่ต้องเลือกเอง
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            <div className="modal-actions">
              <div className="modal-actions-right">
                <button type="button" className="btn-cancel" onClick={closeEditModal}>
                  Cancel
                </button>
                <button type="submit" className="btn-save" disabled={sessionRunning}>
                  ✔ Save
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* ── Alert modal (แจ้งเตือนเฉยๆ ไม่มีปุ่ม Cancel) ────────────────
          แยกจาก confirm modal เพราะอันนั้นมีปุ่ม "ลบ" ที่ทำ action จริง ส่วนอันนี้
          แค่โชว์ข้อความแล้วกดตกลงปิดไปเฉยๆ (เช่น ลบไม่ได้เพราะยังมีข้อมูลอ้างอิงอยู่) */}
      <div className={`modal-overlay${alertText ? " open" : ""}`}>
        <div className="confirm-box alert-box-warning">
          <p>{alertText}</p>
          <div className="confirm-actions">
            <button type="button" className="btn-save" onClick={() => setAlertText(null)}>
              OK
            </button>
          </div>
        </div>
      </div>

      {/* ── Confirm delete modal ─────────────────────────────────────── */}
      <div className={`modal-overlay${confirmState ? " open" : ""}`}>
        <div className="confirm-box">
          <p>{confirmState?.message}</p>
          <div className="confirm-actions">
            <button type="button" className="btn-cancel" onClick={() => setConfirmState(null)}>
              Cancel
            </button>
            <button type="button" className="btn-delete-inline" disabled={sessionRunning} onClick={() => confirmState?.onConfirm()}>
              🗑 Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
