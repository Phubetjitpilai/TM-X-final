import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api/client";
import { useToast } from "../components/Toast";
import { useDialog } from "../components/Dialog";
import ExportFilters, {
  EMPTY_FILTERS, hasAnyFilter, toParams, validateAlpl,
  type FilterState, type MultiKey, type ToleranceOption,
} from "../components/export/ExportFilters";
import TemplateModal, { type ExportColumn } from "../components/export/TemplateModal";
import { useSessionState } from "../hooks/useSessionState";
import { useSSE } from "../hooks/useSSE";

// ExportPage — พอร์ตจาก Frontend/export.html (wizard 3 ขั้น)
//
// หน้านี้ใช้ร่วมกันทั้ง CSV / PDF / Excel ผ่าน ?format= ต่างกันแค่
//   · ชนิดเทมเพลตที่เลือกในขั้นที่ 1 (แยกลิสต์กันคนละชนิด)
//   · ไฟล์ที่ได้ตอนขั้นที่ 3
// ส่วนขั้นกรองข้อมูลใช้ตัวเดียวกันหมด

type Format = "csv" | "pdf" | "excel";
const FORMAT_LABEL: Record<Format, string> = { csv: "CSV", pdf: "PDF", excel: "Excel" };
const FILE_EXT: Record<Format, string> = { csv: ".csv", pdf: ".pdf", excel: ".xlsx" };

interface Template {
  export_template_id: number;
  name: string;
  kind: string;
  columns: string[];
  /** ผังตาราง — มีเฉพาะเทมเพลตชนิด pdf/excel (csv ใช้ columns เรียงเป็นแถวแทน) */
  layout?: { grid?: any[][]; nRows?: number; nCols?: number } | null;
  is_default: boolean;
}

interface FilterOptionsData {
  options: Record<MultiKey, string[]>;
  partNumberCatalog: { part_number_name: string; package_size: string }[];
  toleranceCatalog: ToleranceOption[];
}

interface CsvSelectionRow {
  measurement_id: number;
  number_alpl: number;
  values: (string | number | null)[];
}

interface CsvSelectionPage {
  total: number;
  columns: string[];
  column_keys: string[];
  sortable_keys: string[];
  max_texts: string[];
  items: CsvSelectionRow[];
}
interface CsvPreview { columns: string[]; rows: any[][]; total: number; template_name: string }

const CSV_SELECTION_PAGE_SIZE = 20;

function measureSelectionColumns(headers: string[], longestTexts: string[]): number[] {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return headers.map(() => 120);
  const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const family = getComputedStyle(document.body).fontFamily;
  const fontSize = rootSize * 0.78; // .pv-wrap th/td
  const padding = rootSize * 1.2; // 0.6rem on each side
  return headers.map((header, index) => {
    context.font = `400 ${fontSize}px ${family}`;
    const valueWidth = context.measureText(longestTexts[index] ?? "").width;
    context.font = `600 ${fontSize}px ${family}`;
    // Reserve the arrow even in Clear state, so the header never changes width.
    const headerWidth = context.measureText(header).width + fontSize * 1.7;
    return Math.ceil(Math.max(valueWidth, headerWidth) + padding + 2);
  });
}

const STEPS = ["Select Template", "Filter Data", "Examine & Export"];

/** ช่องข้อมูลที่ถูกใช้ในผังรายงาน เรียงตามลำดับที่เจอ (ซ้าย→ขวา บน→ล่าง)
 *
 *  ⚠ เทมเพลตชนิด pdf/excel **ไม่มี** รายการคอลัมน์เรียงเป็นแถวแบบ CSV —
 *    มันกระจายอยู่ตามเซลล์ในผัง ต้องไล่อ่านเอง ถ้าใช้ `t.columns` เหมือน CSV
 *    ชิปจะว่างเปล่าและเลขคอลัมน์ขึ้น 0 ทุกใบ (ของเดิมฝั่ง React เป็นแบบนั้น)
 *  ownerOf: ยุบลูกของบล็อกให้เป็นบล็อกตัวเดียว (value_x → tolerance_spec)
 *    เพื่อให้ชิปตรงกับสิ่งที่เห็นตอนจัดผัง ไม่ใช่แตกเป็นช่องย่อยเต็มไปหมด */
function layoutFields(layout: Template["layout"], catalog: ExportColumn[]): string[] {
  const ownerOf = (key: string) =>
    catalog.find((c) => c.block?.data?.some((d) => d.key === key))?.key ?? key;
  const out: string[] = [];
  (layout?.grid ?? []).forEach((row) =>
    (row ?? []).forEach((cell: any) => {
      const key = cell && (cell.hdr || cell.spec || cell.f);
      if (!key) return;
      const owner = ownerOf(key);
      if (!out.includes(owner)) out.push(owner);
    }),
  );
  return out;
}

/** ตัวอักษรที่ Windows ห้ามใช้ในชื่อไฟล์ — ถ้าปล่อยผ่านไป เบราว์เซอร์จะเซฟไม่ได้
 *  หรือเปลี่ยนชื่อให้เองเงียบๆ แล้วผู้ใช้จะหาไฟล์ไม่เจอ
 *  \ / : * ? " < > | ห้ามทั้งหมด · จุดกับเว้นวรรคท้ายชื่อก็ห้าม (Explorer ตัดทิ้ง) */
// eslint-disable-next-line no-control-regex
const BAD_FNAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

function sanitizeFilename(raw: string): string {
  return String(raw || "").replace(BAD_FNAME_CHARS, "").replace(/[. ]+$/, "").trim();
}

/** อ่านข้อความ error จาก response ของ backend ({"detail": "..."}) */
async function errText(r: Response, fallback: string): Promise<string> {
  try {
    const d = await r.json();
    return d?.detail || fallback;
  } catch {
    return fallback;
  }
}

export default function ExportPage() {
  const [params] = useSearchParams();
  // CSV, PDF and Excel share one route. A format change must start a fresh
  // wizard so filters, row selection and preview cannot leak across formats.
  return <ExportPageContent key={(params.get("format") ?? "csv").toLowerCase()} />;
}

function ExportPageContent() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const format = ((params.get("format") ?? "csv").toLowerCase() as Format) ?? "csv";
  const label = FORMAT_LABEL[format] ?? "CSV";

  const toast = useToast();
  const dialog = useDialog();
  const qc = useQueryClient();
  const { data: sessionState } = useSessionState();
  const sessionRunning = sessionState?.state === "running";
  const runningRef = useRef(sessionRunning);
  runningRef.current = sessionRunning;
  const refreshTimer = useRef<number | null>(null);
  const lastSessionSig = useRef<string | null>(null);

  function scheduleLiveRefresh() {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void qc.invalidateQueries({ queryKey: ["export-preview"] });
      void qc.invalidateQueries({ queryKey: ["export-selection-rows"] });
      void qc.invalidateQueries({ queryKey: ["export-filter-options"] });
    }, 150);
  }

  const sseStatus = useSSE({
    measurement: scheduleLiveRefresh,
    measurement_replaced: scheduleLiveRefresh,
    image_updated: scheduleLiveRefresh,
    session_complete: scheduleLiveRefresh,
    session_stopped: scheduleLiveRefresh,
    session_timeout: scheduleLiveRefresh,
  });

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
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
  }, []);

  const [step, setStep] = useState(1);
  const [selectedTplId, setSelectedTplId] = useState<number | null>(null);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [selectionPage, setSelectionPage] = useState(1);
  const [selectionSort, setSelectionSort] = useState<{ key: string; direction: "asc" | "desc" } | null>(null);
  const [excludedIds, setExcludedIds] = useState<number[]>([]);
  const [includedIds, setIncludedIds] = useState<number[] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTpl, setEditingTpl] = useState<Template | null>(null);
  useEffect(() => {
    if (sessionRunning) setModalOpen(false);
  }, [sessionRunning]);
  /** ข้อความชั่วคราวแทนบรรทัดนับจำนวน ระหว่างกำลังสร้างไฟล์/เตรียมพิมพ์ */
  const [busyNote, setBusyNote] = useState<string | null>(null);
  /** ผังรายงานแบบเต็ม (full=1) ที่รอพิมพ์ — วาดลง #print-root แล้วสั่ง print */
  const [printData, setPrintData] = useState<any>(null);

  // จำชื่อไฟล์ล่าสุดแยกตามรูปแบบ — export ซ้ำด้วยชื่อเดิมได้โดยไม่ต้องพิมพ์ใหม่
  // (ต้นฉบับใช้ localStorage key `tmx_export_filename_<format>` เหมือนกัน)
  const fnameKey = `tmx_export_filename_${format}`;
  const [filename, setFilename] = useState("");
  /** เตือนตอนผู้ใช้พิมพ์ตัวอักษรต้องห้าม — โชว์ 2.5 วิแล้วหายเอง */
  const [fnameWarn, setFnameWarn] = useState(false);
  useEffect(() => {
    setFilename(localStorage.getItem(fnameKey) ?? "");
  }, [fnameKey]);

  const cleanName = sanitizeFilename(filename);

  /** กรองตัวอักษรต้องห้ามทิ้งทันทีขณะพิมพ์ พร้อมคงตำแหน่งเคอร์เซอร์ไว้
   *  ไม่ให้เด้งไปท้ายช่อง (อาการที่เกิดถ้าแค่ setState ด้วยค่าที่กรองแล้ว) */
  function onFilenameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const el = e.target;
    const raw = el.value;
    const cleaned = raw.replace(BAD_FNAME_CHARS, "");
    setFilename(cleaned);
    if (cleaned !== raw) {
      const pos = Math.max(0, (el.selectionStart ?? raw.length) - (raw.length - cleaned.length));
      requestAnimationFrame(() => el.setSelectionRange(pos, pos));
      setFnameWarn(true);
      window.setTimeout(() => setFnameWarn(false), 2500);
    }
  }

  // เซฟชื่อไฟล์ทุกครั้งที่เปลี่ยน ไม่ใช่รอตอนกดดาวน์โหลด — ผู้ใช้พิมพ์ชื่อไว้
  // แล้วเปลี่ยนใจไปกรองต่อ พอกลับมาชื่อต้องยังอยู่
  useEffect(() => {
    if (!cleanName) return;
    try { localStorage.setItem(fnameKey, cleanName); } catch { /* โหมดส่วนตัว */ }
  }, [cleanName, fnameKey]);

  // ── ข้อมูลตั้งต้น ────────────────────────────────────────────────────────
  const columnsQ = useQuery<ExportColumn[]>({
    queryKey: ["export-columns", format],
    queryFn: () => apiGet<ExportColumn[]>("/api/export/columns", { kind: format }),
  });

  const templatesQ = useQuery<Template[]>({
    queryKey: ["export-templates", format],
    queryFn: ({ signal }) => apiGet<Template[]>("/api/export/templates", { kind: format }, signal),
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.status === "error" ? 4_000 : 30_000,
  });

  /* เลือก Template ค่าเริ่มต้น และเลือกใหม่ถ้า Template เดิมถูกลบ */
  useEffect(() => {
    const list = templatesQ.data;
    if (!list) return;                                   // ยังโหลดไม่เสร็จ
    if (!list.length) { setSelectedTplId(null); return; } // รูปแบบนี้ยังไม่มีเทมเพลตเลย
    if (list.some((t) => t.export_template_id === selectedTplId)) return;
    setSelectedTplId((list.find((t) => t.is_default) ?? list[0]).export_template_id);
  }, [templatesQ.data, selectedTplId]);

  // ตัวเลือกของ multi-select — ถ้าตารางใดโหลดไม่ได้ ให้ Query รายงาน error
  // ไม่แปลงเป็น [] เพราะจะดูเหมือน DB ไม่มีข้อมูลทั้งที่โหลดไม่สำเร็จ
  const optionsQ = useQuery<FilterOptionsData>({
    queryKey: ["export-filter-options"],
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.status === "error" ? 4_000 : 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const get = (path: string) => apiGet<any[]>(path, undefined, signal);
      const [ops, vendors, owners, handlers, pkgs, parts, tolerances] = await Promise.all([
        get("/api/operators"), get("/api/vendors"), get("/api/owners"),
        get("/api/handlers"), get("/api/package-sizes"), get("/api/part-numbers/all"),
        get("/api/package-size-tolerances"),
      ]);
      const names = (rows: any[], key: string) =>
        Array.from(new Set(rows.map((r) => r[key]).filter((v) => v != null).map(String))).sort();
      return {
        options: {
          result: ["OK", "NG"],
          // ⚠ มีแค่ IPM กับ New เท่านั้น (ตรงกับต้นฉบับ) — โหมด Rework ถูกบันทึก
          //   ลง DB เป็น New + note ส่วน "Manual" ไม่มีทางเกิดแล้วเพราะไม่มีปุ่ม
          //   เพิ่ม measurement เองใน UI · ใส่ค่าที่ไม่มีในข้อมูลจริงจะได้ช่องกรอง
          //   ที่เลือกแล้วผลลัพธ์ว่างเสมอ ซึ่งดูเหมือนระบบพัง
          measure_type: ["IPM", "New"],
          operator: names(ops, "operator_name"),
          vendor: names(vendors, "vendor_name"),
          owner: names(owners, "owner_name"),
          handler: names(handlers, "handler_name"),
          package_size: names(pkgs, "package_size"),
          part_number: [],   // ว่างไว้จนกว่าจะเลือก Package Size (cascade)
        } as Record<MultiKey, string[]>,
        partNumberCatalog: parts.map((r) => ({
          part_number_name: String(r.part_number_name ?? ""),
          package_size: String(r.package_size ?? ""),
        })),
        toleranceCatalog: tolerances.map((r) => ({
          tolerance_id: Number(r.tolerance_id),
          package_size: String(r.package_size ?? ""),
          nominal_x: Number(r.nominal_x), nominal_y: Number(r.nominal_y),
          upper_tol: Number(r.upper_tol), lower_tol: Number(r.lower_tol),
          offset_tol: Number(r.offset_tol),
        })),
      };
    },
  });

  const qs = useMemo(() => toParams(filters, selectedTplId), [filters, selectedTplId]);
  const alplError = validateAlpl(filters.alpl);
  const selectionScope = `${format}:${qs.toString()}`;
  const previousSelectionScope = useRef(selectionScope);
  useEffect(() => {
    if (previousSelectionScope.current === selectionScope) return;
    previousSelectionScope.current = selectionScope;
    setExcludedIds([]);
    setIncludedIds(null);
    setSelectionPage(1);
    setSelectionSort(null);
    setStep((current) => current === 3 ? 2 : current);
  }, [selectionScope, format]);

  const selectionQ = useQuery<CsvSelectionPage>({
    queryKey: ["export-selection-rows", selectionScope, selectionPage, selectionSort],
    queryFn: ({ signal }) => {
      const p = new URLSearchParams(qs);
      p.set("limit", String(CSV_SELECTION_PAGE_SIZE));
      p.set("offset", String((selectionPage - 1) * CSV_SELECTION_PAGE_SIZE));
      if (selectionSort) {
        p.set("sort_by", selectionSort.key);
        p.set("sort_dir", selectionSort.direction);
      }
      return apiGet<CsvSelectionPage>(`/api/export/selection-rows?${p}`, undefined, signal);
    },
    enabled: step === 2 && selectedTplId != null && !alplError
      && !!templatesQ.data?.some((template) => template.export_template_id === selectedTplId),
    // Keep the previous page visible while changing sort/page within the same filters.
    // Never show rows from a different template or filter as placeholder data.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === selectionScope ? previousData : undefined,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.status === "error" ? 4_000 : false,
  });
  const selectedCount = includedIds === null
    ? Math.max(0, (selectionQ.data?.total ?? 0) - excludedIds.length)
    : includedIds.length;
  const selectionPayload = useMemo(() => ({
    excluded_measurement_ids: excludedIds,
    included_measurement_ids: includedIds,
  }), [excludedIds, includedIds]);
  const isRowSelected = (id: number) => includedIds === null
    ? !excludedIds.includes(id) : includedIds.includes(id);
  function setRowsSelected(ids: number[], checked: boolean) {
    if (includedIds !== null) {
      setIncludedIds((current) => checked
        ? Array.from(new Set([...(current ?? []), ...ids]))
        : (current ?? []).filter((id) => !ids.includes(id)));
    } else {
      setExcludedIds((current) => checked
        ? current.filter((id) => !ids.includes(id))
        : Array.from(new Set([...current, ...ids])));
    }
  }
  const selectionColumnWidths = useMemo(
    () => measureSelectionColumns(selectionQ.data?.columns ?? [], selectionQ.data?.max_texts ?? []),
    [selectionQ.data],
  );

  /* สั่งพิมพ์หลังผังฉบับเต็มถูกวาดลง #print-root แล้วเท่านั้น
   * ⚠ ต้องรอ React commit DOM ก่อน — ถ้าเรียก window.print() ต่อท้าย fetch เลย
   *   หน้าต่างพิมพ์จะเปิดมาโดยที่ #print-root ยังว่างอยู่ (ได้กระดาษเปล่า) */
  useEffect(() => {
    if (!printData) return;
    const restore = document.title;
    // เบราว์เซอร์เอา document.title ไปเป็นชื่อไฟล์ที่เสนอในหน้าต่างพิมพ์ —
    // สั่งชื่อไฟล์ PDF ตรงๆ จากโค้ดไม่ได้ ต้องผ่านทางนี้ทางเดียว
    document.title = cleanName || printData.template_name || "report";
    // ⚠ คลาสนี้เป็นตัวเปิดกฎ @media print ทั้งชุด (ดู index.css) — ต้องใส่เฉพาะ
    //   ตอนสั่งพิมพ์รายงานเท่านั้น ถ้าปล่อยไว้ตลอด ผู้ใช้กด Ctrl+P ที่หน้าไหนก็ตาม
    //   จะได้กระดาษเปล่า เพราะกฎนั้นซ่อนทุกอย่างยกเว้น #print-root ที่มีแค่หน้านี้
    document.body.classList.add("printing-report");
    try {
      window.print();
    } finally {
      // finally เสมอ — ถ้า print() โยน exception (บาง環境/เบราว์เซอร์บล็อก)
      // แล้วคลาสค้างไว้ หน้าเว็บจะพิมพ์อะไรไม่ได้อีกเลยจนกว่าจะรีเฟรช
      document.body.classList.remove("printing-report");
      document.title = restore;
    }
    setPrintData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printData]);

  // ── preview ─────────────────────────────────────────────────────────────
  // โหลดตัวอย่างเฉพาะขั้นที่ 3 หลังเลือกแถวแล้ว
  const canPreview = step === 3 && selectedTplId != null && !alplError
    && !!templatesQ.data?.some((template) => template.export_template_id === selectedTplId);
  const previewQ = useQuery({
    queryKey: ["export-preview", format, qs.toString(), selectionPayload, selectionSort],
    refetchOnMount: "always",
    queryFn: () => {
      const p = new URLSearchParams(qs);
      if (selectionSort) {
        p.set("sort_by", selectionSort.key);
        p.set("sort_dir", selectionSort.direction);
      }
      if (format === "csv") {
        return apiPost<CsvPreview>(`/api/export/preview-selected?${p}`, selectionPayload);
      }
      p.set("full", "0");
      return apiPost<any>(`/api/export/report-preview-selected?${p}`, selectionPayload);
    },
    enabled: canPreview,
    // ⚠ ห้าม retry: ค่าเริ่มต้นของ TanStack คือลองใหม่ 3 ครั้งแบบ backoff ทำให้
    //   คำขอที่ 500 ค้างอยู่ในสถานะ "กำลังโหลด…" หลายวินาทีก่อนจะยอมโชว์ error
    //   ระหว่างนั้นตารางข้างล่างขึ้น "ไม่มีข้อมูลที่ตรงกับตัวกรอง" — คนอ่านแล้ว
    //   เข้าใจว่า "กรองแล้วไม่เจอ" ทั้งที่จริงคือฝั่ง server พัง หาสาเหตุไม่เจอเลย
    retry: false,
  });

  /* จำนวนคอลัมน์ของตารางตัวอย่าง ใช้เป็น colSpan ของแถวข้อความสถานะทั้ง 3 แบบ
     (กำลังโหลด / โหลดไม่สำเร็จ / ไม่มีข้อมูล) ให้พาดเต็มความกว้างตาราง

     ⚠ ต้องคำนวณ **นอกกิ่ง if** — ถ้าเขียน `previewQ.data?.columns?.length`
       ข้างในกิ่ง `previewQ.isLoading` จะไม่ผ่าน `tsc` (TS2339) เพราะ TanStack
       v5 คืน type เป็น union แยกตามสถานะ พอ narrow เข้ากิ่ง isLoading แล้ว
       `data` เหลือ `undefined` อย่างเดียว → `?.` ตัด undefined ทิ้งจนเหลือ
       `never` → หยิบ `.columns` จากของที่ไม่มีอยู่

       (กิ่ง `isError` ไม่มีปัญหานี้ เพราะมันครอบทั้ง "พังตั้งแต่แรก" และ
        "เคยสำเร็จแล้วพังตอน refetch" ตัวหลังยังมี data เก่าค้างอยู่)       */
  const previewColSpan = previewQ.data?.columns?.length || 1;

  // ── เทมเพลต CRUD ────────────────────────────────────────────────────────
  const refreshTpl = () => qc.invalidateQueries({ queryKey: ["export-templates", format] });

  const saveTpl = useMutation({
    mutationFn: async ({ name, columns }: { name: string; columns: string[] }) => {
      if (runningRef.current) throw new Error("กำลังวัดอยู่ ไม่สามารถแก้ไข Template ได้");
      if (editingTpl) {
        return apiPatch(`/api/export/templates/${editingTpl.export_template_id}`, { name, columns });
      }
      return apiPost<Template>("/api/export/templates", { name, columns, kind: format });
    },
    onSuccess: (res: any) => {
      toast.show(editingTpl ? "บันทึกการแก้ไขแล้ว" : "สร้าง Template แล้ว", undefined, "success");
      if (!editingTpl && res?.export_template_id) setSelectedTplId(res.export_template_id);
      setModalOpen(false);
      setEditingTpl(null);
      refreshTpl();
    },
    onError: (e: Error) => toast.show(`บันทึกไม่สำเร็จ — ${e.message}`),
  });

  const dupTpl = useMutation({
    mutationFn: (id: number) => {
      if (runningRef.current) throw new Error("กำลังวัดอยู่ ไม่สามารถคัดลอก Template ได้");
      return apiPost<Template>(`/api/export/templates/${id}/duplicate`);
    },
    onSuccess: (res: any) => {
      toast.show("คัดลอก Template แล้ว", undefined, "success");
      if (res?.export_template_id) setSelectedTplId(res.export_template_id);
      refreshTpl();
    },
    onError: (e: Error) => toast.show(`คัดลอกไม่สำเร็จ — ${e.message}`),
  });

  const delTpl = useMutation({
    mutationFn: (id: number) => {
      if (runningRef.current) throw new Error("กำลังวัดอยู่ ไม่สามารถลบ Template ได้");
      return apiDelete(`/api/export/templates/${id}`);
    },
    onSuccess: (_d, id) => {
      toast.show("ลบ Template แล้ว", undefined, "success");
      if (selectedTplId === id) setSelectedTplId(null);
      refreshTpl();
    },
    onError: (e: Error) => toast.show(`ลบไม่สำเร็จ — ${e.message}`),
  });

  // ── ดาวน์โหลด ───────────────────────────────────────────────────────────
  /** ดาวน์โหลด Excel ผ่าน fetch แทนการเปลี่ยน location ตรงๆ
   *  จะได้อ่านข้อความ error จาก backend มาโชว์เป็น toast ได้ (เช่นตอนข้อมูล
   *  เกินเพดาน REPORT_MAX_ROWS) — ถ้าเปลี่ยน location เลย ผู้ใช้จะเจอหน้า
   *  error ดิบๆ ของเบราว์เซอร์แทน แล้วหน้าที่กรอกไว้ก็หายไปด้วย */
  async function downloadXlsx(p: URLSearchParams) {
    setBusyNote("กำลังสร้างไฟล์ Excel…");
    try {
      if (selectionSort) {
        p.set("sort_by", selectionSort.key);
        p.set("sort_dir", selectionSort.direction);
      }
      const r = await fetch(`/api/export/xlsx-selected?${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectionPayload),
      });
      if (!r.ok) { toast.show(await errText(r, "สร้างไฟล์ไม่สำเร็จ")); return; }
      const blob = await r.blob();
      // ชื่อจากผู้ใช้มาก่อนเสมอ — Content-Disposition ของ backend เป็นแค่ตัวสำรอง
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cleanName}${FILE_EXT.excel}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.show("ต่อ Backend ไม่ได้");
    } finally {
      setBusyNote(null);
    }
  }

  async function downloadSelectedCsv(p: URLSearchParams) {
    setBusyNote("กำลังสร้างไฟล์ CSV…");
    try {
      if (selectionSort) {
        p.set("sort_by", selectionSort.key);
        p.set("sort_dir", selectionSort.direction);
      }
      const r = await fetch(`/api/export/csv-selected?${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectionPayload),
      });
      if (!r.ok) { toast.show(await errText(r, "สร้างไฟล์ไม่สำเร็จ")); return; }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cleanName}.csv`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.show("ต่อ Backend ไม่ได้");
    } finally {
      setBusyNote(null);
    }
  }

  /** พิมพ์เป็น PDF — ใช้ตัวพิมพ์ของเบราว์เซอร์แทนการสร้าง PDF ฝั่ง backend
   *  เพราะภาษาไทยแสดงถูกแน่นอน (ไลบรารีฝั่ง server ต้องฝังฟอนต์เอง ไม่งั้นได้
   *  สี่เหลี่ยม) และสิ่งที่เห็นใน preview = สิ่งที่ได้ในไฟล์ เพราะวาดจาก HTML
   *  ก้อนเดียวกัน
   *
   *  ⚠ ต้องดึง full=1 ก่อนพิมพ์ — preview ถูกตัดที่ REPORT_PREVIEW_LIMIT แถว
   *    ถ้าพิมพ์จากของที่เห็นบนจอ ไฟล์ที่ได้จะขาดแถวไปเงียบๆ
   *  ⚠ ชื่อไฟล์ PDF สั่งจากโค้ดตรงๆ ไม่ได้ — เบราว์เซอร์เอา document.title ไป
   *    เป็นชื่อที่เสนอในหน้าต่างพิมพ์ ทางนี้ทางเดียว */
  async function printReport(p: URLSearchParams) {
    setBusyNote("กำลังเตรียมไฟล์สำหรับพิมพ์…");
    try {
      p.set("full", "1");
      if (selectionSort) {
        p.set("sort_by", selectionSort.key);
        p.set("sort_dir", selectionSort.direction);
      }
      const r = await fetch(`/api/export/report-preview-selected?${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectionPayload),
      });
      if (!r.ok) { toast.show(await errText(r, "เตรียมไฟล์ไม่สำเร็จ")); return; }
      setPrintData(await r.json());
    } catch {
      toast.show("ต่อ Backend ไม่ได้");
    } finally {
      setBusyNote(null);
    }
  }

  function doDownload() {
    if (runningRef.current) return;
    const p = new URLSearchParams(qs);
    p.set("filename", cleanName);
    try { localStorage.setItem(fnameKey, cleanName); } catch { /* โหมดส่วนตัวเขียนไม่ได้ */ }

    if (format === "excel") { void downloadXlsx(p); return; }
    if (format === "pdf") { void printReport(p); return; }
    void downloadSelectedCsv(p);
  }

  async function onClickDownload() {
    if (runningRef.current) return;
    if (!cleanName || total === 0) return;
    // ไม่ได้กรองอะไรเลย = กำลังจะดึงข้อมูลทั้งระบบ — ถามยืนยันก่อน กันเผลอกด
    // แล้วได้ไฟล์ใหญ่เกินคาด (โดยเฉพาะตอนติ๊ก "เฉพาะล่าสุด" ออกด้วย)
    if (!hasAnyFilter(filters) && includedIds === null && excludedIds.length === 0) {
      const scope = filters.latestOnly ? "การวัดล่าสุดของทุก ALPL" : "ประวัติการวัดทั้งหมดทุกครั้ง";
      const ok = await dialog.confirm(
        <>
          <strong>ยังไม่ได้ตั้งตัวกรองไว้เลย</strong>
          <br />
          <br />
          กำลังจะ Export {scope}
          <br />
          จำนวน <strong>{(total ?? 0).toLocaleString()} แถว</strong>
        </>,
        { title: "ยืนยันการ Export", okLabel: "Export" },
      );
      if (!ok) return;
    }
    doDownload();
  }

  /** ข้อความ error เรื่อง ALPL ที่มาจาก backend — แยกจาก error อื่นเพราะต้อง
   *  ไปโผล่ใต้ช่อง ALPL ไม่ใช่ที่บรรทัดนับจำนวน */
  const serverAlplError =
    previewQ.isError && (previewQ.error as Error).message.includes("ALPL")
      ? (previewQ.error as Error).message
      : null;

  /** เปิดตัวแก้เทมเพลต — csv ใช้ modal เลือกคอลัมน์ · pdf/excel ไปหน้าจัดผัง
   *  แบบสเปรดชีต (report-template) เพราะรายงานไม่ได้เรียงคอลัมน์เป็นแถวเดียว
   *
   *  ⚠ ห้ามให้ pdf/excel ตกมาใช้ modal เลือกคอลัมน์เด็ดขาด — modal นั้นส่ง
   *    {name, columns} ไป PATCH ซึ่งไม่มี layout_json ติดไปด้วย ผังที่ผู้ใช้
   *    จัดไว้จะถูกทับหายทั้งใบโดยที่หน้าจอขึ้นว่า "บันทึกแล้ว" ตามปกติ */
  function openTemplateEditor(t: Template | null) {
    if (runningRef.current) return;
    if (format === "csv") {
      setEditingTpl(t);
      setModalOpen(true);
      return;
    }
    const q = new URLSearchParams({ format });
    if (t) q.set("id", String(t.export_template_id));
    navigate(`/report-template?${q}`);
  }

  const templates = templatesQ.data ?? [];
  const total: number | undefined = previewQ.data?.total;
  const templateName: string | undefined = previewQ.data?.template_name;

  /** ข้อความปุ่มดาวน์โหลด — บอกจำนวนแถวจริงที่จะได้ ไม่ใช่ป้ายนิ่งๆ
   *  ผู้ใช้จะได้เห็นตั้งแต่ก่อนกดว่าไฟล์จะมีกี่แถว (และรู้ทันทีถ้าเป็น 0) */
  const downloadLabel =
    total === 0 ? "⤓ No Data to Download"
    : format === "pdf" ? `🖨 Print PDF${total != null ? ` (${total} rows)` : ""}`
    : `⤓ Download ${label}${total != null ? ` (${total} rows)` : ""}`;

  return (
    <div className="main-edit">
      {sessionRunning && <div className="mock-banner">⏳ กำลังวัดอยู่ — ดูข้อมูลและ Preview ได้ แต่แก้ Template หรือ Export ได้หลังวัดเสร็จ</div>}
      <div className="card">
        <div className="card-head">Export · {label}</div>

        <div className="steps">
          {STEPS.map((s, i) => {
            const n = i + 1;
            const cls = step === n ? "step on" : step > n ? "step done" : "step";
            return (
              <span key={s} style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                {i > 0 && <span>→</span>}
                <span className={cls}>
                  <span className="num">{n}</span>
                  {s}
                </span>
              </span>
            );
          })}
        </div>

        {/* ── ขั้นที่ 1 — เลือก Template ─────────────────────────────────── */}
        {step === 1 && (
          <section>
            {templatesQ.isPending ? (
              <div className="filter-result-note">กำลังโหลด Template…</div>
            ) : templatesQ.isError ? (
              <div className="empty">โหลดข้อมูล Template ไม่สำเร็จ กำลังลองใหม่อีกครั้ง</div>
            ) : templates.length === 0 ? (
              <div className="empty">ยังไม่มี Template — กดปุ่มด้านล่างเพื่อสร้าง</div>
            ) : (
              templates.map((t) => {
                // เทมเพลตค่าเริ่มต้นแก้/ลบไม่ได้ — เป็นตัวสำรองที่ต้องมีเหลืออยู่
                // เสมอ ไม่งั้นผู้ใช้ลบหมดแล้วเปิดหน้ามาไม่มีอะไรให้เลือก
                const lock = t.is_default;
                // csv → columns_json (เรียงตามลำดับในไฟล์)
                // pdf/excel → ไล่อ่านจากผัง เพราะคอลัมน์กระจายอยู่ในเซลล์
                const keys = format === "csv" ? t.columns : layoutFields(t.layout, columnsQ.data ?? []);
                const sizeText = format === "csv"
                  ? `${t.columns.length} คอลัมน์`
                  : `${keys.length} คอลัมน์ · ${t.layout?.nRows ?? 0} แถว × ${t.layout?.nCols ?? 0} ช่อง`;
                return (
                  <div
                    key={t.export_template_id}
                    className={`tpl${selectedTplId === t.export_template_id ? " sel" : ""}`}
                    onClick={() => setSelectedTplId(t.export_template_id)}
                  >
                    <div className="tpl-head">
                      <span className="tpl-name">{t.name}</span>
                      {lock && <span className="badge lock">🔒 ค่าเริ่มต้น</span>}
                      <span className="badge">{sizeText}</span>
                      <span className="tpl-acts" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn-mini"
                          disabled={lock || sessionRunning}
                          title={lock ? "เทมเพลตค่าเริ่มต้นแก้ไขไม่ได้" : ""}
                          onClick={() => openTemplateEditor(t)}
                        >
                          Edit
                        </button>
                        <button type="button" className="btn-mini" disabled={sessionRunning} onClick={() => dupTpl.mutate(t.export_template_id)}>
                          Duplicate
                        </button>
                        <button
                          type="button"
                          className="btn-mini del"
                          disabled={lock || sessionRunning}
                          title={lock ? "เทมเพลตค่าเริ่มต้นลบไม่ได้" : ""}
                          onClick={async () => {
                            const ok = await dialog.confirm(
                              <>ลบ Template <strong>"{t.name}"</strong></>,
                              { title: "ลบ Template", okLabel: "🗑 Delete", danger: true },
                            );
                            if (ok) delTpl.mutate(t.export_template_id);
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    </div>
                    <div className="chips">
                      {keys.map((k) => {
                        const col = columnsQ.data?.find((c) => c.key === k);
                        return (
                          <span key={k} className={`chip${col?.group === "ข้อมูลการวัด" ? " meas" : ""}`}>
                            {col?.label ?? k}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}

            <button type="button" className="btn-add-tpl" disabled={sessionRunning || templatesQ.isError || templatesQ.isPending} onClick={() => openTemplateEditor(null)}>
              + Create New Template
            </button>

            <div className="actions">
              <span />
              <button
                type="button"
                className="btn-primary"
                disabled={selectedTplId == null || templatesQ.isError || templatesQ.isPending}
                title={selectedTplId == null ? "เลือก Template ก่อน" : ""}
                onClick={() => setStep(2)}
              >
                Next · Filter Data
              </button>
            </div>
          </section>
        )}

        {/* ── ขั้นที่ 2–3 — กรอง + ตรวจสอบ ──────────────────────────────── */}
        {step >= 2 && (
          <section>
            {step === 2 && <>
            {optionsQ.isError && (
              <div className="filter-result-note">
                {optionsQ.data
                  ? "ข้อมูลในตัวเลือกเป็นข้อมูลเก่า กำลังลองโหลดใหม่อีกครั้ง"
                  : "โหลดตัวเลือก Filter ไม่สำเร็จ กำลังลองใหม่อีกครั้ง"}
              </div>
            )}
            {optionsQ.data ? (
              <ExportFilters
                value={filters}
                onChange={setFilters}
                options={optionsQ.data.options}
                partNumberCatalog={optionsQ.data.partNumberCatalog}
                toleranceCatalog={optionsQ.data.toleranceCatalog}
                onClear={() => { setFilters(EMPTY_FILTERS); setExcludedIds([]); setIncludedIds(null); setSelectionPage(1); }}
                serverAlplError={serverAlplError}
                collapsibleAdvanced primaryMultiKeys={["result", "package_size"]}
              />
            ) : !optionsQ.isError && (
              <div className="filter-result-note">กำลังโหลดตัวเลือก Filter…</div>
            )}
            </>}

            {step === 2 ? <>
              <div className="count">
                {alplError ? "แก้ช่อง ALPL ให้ถูกรูปแบบก่อน"
                  : selectionQ.isPending ? "กำลังโหลดรายการ…"
                  : selectionQ.isError ? "โหลดรายการไม่สำเร็จ — ลองใหม่อีกครั้ง"
                  : <>
                    พบ <strong>{selectionQ.data.total}</strong> รายการ · เลือกไว้ <strong>{selectedCount}</strong> รายการ
                    {selectionQ.isPlaceholderData && <span className="csv-selection-loading" role="status">กำลังเรียงข้อมูล…</span>}
                    {(includedIds !== null || excludedIds.length > 0) && <button type="button" className="btn-mini csv-select-all"
                      title="เลือกทุกรายการที่ตรงกับตัวกรอง" disabled={selectionQ.isPlaceholderData}
                      onClick={() => { setIncludedIds(null); setExcludedIds([]); }}>Select All</button>}
                    {selectedCount > 0 && <button type="button" className="btn-mini csv-select-all"
                      title="ยกเลิกการเลือกทุกรายการที่ตรงกับตัวกรอง" disabled={selectionQ.isPlaceholderData}
                      onClick={() => { setIncludedIds([]); setExcludedIds([]); }}>Clear All</button>}
                  </>}
              </div>
              <div className="pv-wrap csv-selection-wrap">
                <table style={{ width: selectionColumnWidths.length
                  ? `${48 + selectionColumnWidths.reduce((sum, width) => sum + width, 0)}px` : "100%" }}>
                  <colgroup>
                    <col style={{ width: "48px" }} />
                    {selectionColumnWidths.map((width, index) => <col key={index} style={{ width: `${width}px` }} />)}
                  </colgroup>
                  <thead><tr>
                    <th><input type="checkbox" aria-label="เลือกหรือยกเลิกแถวในหน้านี้"
                      disabled={!selectionQ.data?.items.length || selectionQ.isPlaceholderData}
                      checked={!!selectionQ.data?.items.length && selectionQ.data.items.every((r) => isRowSelected(r.measurement_id))}
                      ref={(el) => {
                        if (!el || !selectionQ.data?.items.length) return;
                        const selected = selectionQ.data.items.filter((r) => isRowSelected(r.measurement_id)).length;
                        el.indeterminate = selected > 0 && selected < selectionQ.data.items.length;
                      }}
                      onChange={(e) => {
                        const ids = selectionQ.data?.items.map((r) => r.measurement_id) ?? [];
                        setRowsSelected(ids, e.target.checked);
                      }}
                    /></th>
                    {(selectionQ.data?.columns ?? []).map((column, index) => {
                      const key = selectionQ.data?.column_keys?.[index] ?? String(index);
                      const direction = selectionSort?.key === key ? selectionSort.direction : null;
                      return <th key={key} aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}>
                        {selectionQ.data?.sortable_keys?.includes(key) ? <button type="button" className="csv-sort-button"
                          disabled={selectionQ.isPlaceholderData}
                          aria-label={`Sort ${column}${direction === "asc" ? " descending" : direction === "desc" ? " clear" : " ascending"}`}
                          onClick={() => {
                            setSelectionSort(direction === "asc" ? { key, direction: "desc" }
                              : direction === "desc" ? null : { key, direction: "asc" });
                            setSelectionPage(1);
                          }}>
                          {column}{direction && <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>}
                        </button> : <span className="csv-static-header">{column}</span>}
                      </th>;
                    })}
                  </tr></thead>
                  <tbody>
                    {alplError || selectionQ.isPending || selectionQ.isError || !selectionQ.data?.items.length ? (
                      <tr><td className="empty" colSpan={(selectionQ.data?.columns.length ?? 0) + 1}>
                        {alplError ? "กรุณาแก้รูปแบบ ALPL" : selectionQ.isPending ? "กำลังโหลด…"
                          : selectionQ.isError ? "โหลดรายการไม่สำเร็จ กำลังลองใหม่อีกครั้ง" : "ไม่พบข้อมูลที่ตรงกับตัวกรอง"}
                      </td></tr>
                    ) : selectionQ.data.items.map((row) => (
                      <tr key={row.measurement_id}>
                        <td><input type="checkbox" aria-label={`เลือก ALPL ${row.number_alpl} รายการ ${row.measurement_id}`}
                          disabled={selectionQ.isPlaceholderData}
                          checked={isRowSelected(row.measurement_id)}
                          onChange={(e) => setRowsSelected([row.measurement_id], e.target.checked)}
                        /></td>
                        {row.values.map((value, index) => <td key={index} title={String(value ?? "")}>{value ?? ""}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pagination-bar">
                <button type="button" className="btn-icon" disabled={selectionPage <= 1 || selectionQ.isPending || selectionQ.isError || selectionQ.isPlaceholderData}
                  onClick={() => setSelectionPage((page) => page - 1)}>‹ Previous</button>
                <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                  {selectionQ.isPending || selectionQ.isPlaceholderData ? "กำลังโหลด…" : !selectionQ.data?.total ? "ไม่มีรายการ"
                    : `แสดง ${(selectionPage - 1) * CSV_SELECTION_PAGE_SIZE + 1}–${(selectionPage - 1) * CSV_SELECTION_PAGE_SIZE + selectionQ.data.items.length} จาก ${selectionQ.data.total} รายการ`}
                </span>
                <button type="button" className="btn-icon"
                  disabled={selectionQ.isPending || selectionQ.isError || selectionQ.isPlaceholderData || selectionPage * CSV_SELECTION_PAGE_SIZE >= (selectionQ.data?.total ?? 0)}
                  onClick={() => setSelectionPage((page) => page + 1)}>Next ›</button>
              </div>
              <div className="actions">
                <button type="button" className="btn-ghost" onClick={() => setStep(1)}>← Change Template</button>
                <button type="button" className="btn-primary"
                  disabled={!!alplError || selectionQ.isPending || selectionQ.isError || selectionQ.isPlaceholderData || selectedCount === 0}
                  onClick={() => setStep(3)}>Next · Preview ({selectedCount} rows)</button>
              </div>
            </> : <>

            {/* บรรทัดสรุป — ต้องบอกว่าใช้ Template ไหน เจอกี่แถว และตัวอย่างที่เห็น
                ถูกตัดไหม ไม่งั้นผู้ใช้เห็นตาราง 300 แถวแล้วนึกว่าไฟล์จะได้แค่นั้น */}
            <div className="count">
              {busyNote ? busyNote
                : alplError ? "แก้ช่อง ALPL ให้ถูกรูปแบบก่อน"
                : previewQ.isLoading ? "กำลังโหลด…"
                : previewQ.isError ? (serverAlplError ? "—" : (previewQ.error as Error).message)
                : previewQ.data ? (
                  <>
                    Template <strong>{templateName}</strong> · พบ <strong>{total}</strong> รายการ
                    {format !== "csv" && <> · แบ่ง <strong>{previewQ.data.groups ?? 0}</strong> กลุ่มตามสเปก Tolerance</>}
                    {format !== "csv" && previewQ.data.truncated && (
                      <span style={{ color: "var(--warn)" }}>
                        {" "}· ตัวอย่างแสดงแค่ {previewQ.data.shown} แถวแรก (ไฟล์จริงได้ครบทุกแถว)
                      </span>
                    )}
                    {format === "csv" && previewQ.data.rows?.length
                      ? ` · แสดงตัวอย่าง ${previewQ.data.rows.length} แถวแรก`
                      : ""}
                  </>
                ) : "—"}
            </div>


            {format === "csv" ? (
              <div className="pv-wrap">
                <table>
                  <thead>
                    <tr>{(previewQ.data?.columns ?? []).map((c: string) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {/* ⚠ 3 สถานะนี้ต้องแยกกันให้ขาด — ของเดิมยุบเหลือข้อความเดียวคือ
                        "ไม่มีข้อมูลที่ตรงกับตัวกรอง" ทำให้ตอน server ตอบ error
                        หน้าเว็บโกหกว่ากรองแล้วไม่เจอ แล้วไล่หาสาเหตุผิดทางทั้งวัน */}
                    {previewQ.isLoading ? (
                      <tr><td className="empty" colSpan={previewColSpan}>กำลังโหลด…</td></tr>
                    ) : previewQ.isError ? (
                      <tr>
                        <td className="empty" colSpan={previewColSpan}
                            style={{ color: "var(--ng)" }}>
                          โหลดตัวอย่างไม่สำเร็จ — {(previewQ.error as Error).message}
                        </td>
                      </tr>
                    ) : previewQ.data?.rows?.length ? (
                      previewQ.data.rows.map((row: any[], i: number) => (
                        <tr key={i}>{row.map((cell, j) => <td key={j}>{cell == null ? "" : String(cell)}</td>)}</tr>
                      ))
                    ) : (
                      <tr>
                        <td className="empty" colSpan={previewColSpan}>
                          ไม่มีข้อมูลที่ตรงกับตัวกรอง
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="pv-wrap rpt-wrap">
                {/* เหตุผลเดียวกับฝั่ง CSV — ReportSheet ที่ไม่มี data วาดเป็นกระดาษ
                    เปล่า ซึ่งหน้าตาเหมือน "ไม่มีข้อมูล" ทั้งที่อาจเป็น error */}
                {previewQ.isLoading ? (
                  <div className="empty">กำลังโหลด…</div>
                ) : previewQ.isError ? (
                  <div className="empty" style={{ color: "var(--ng)" }}>
                    โหลดตัวอย่างไม่สำเร็จ — {(previewQ.error as Error).message}
                  </div>
                ) : (
                  <ReportSheet data={previewQ.data} />
                )}
              </div>
            )}

            <div className="actions">
              <button type="button" className="btn-ghost" onClick={() => setStep(2)}>← Back to Select Rows</button>

              {/* ช่องชื่อไฟล์วางติดกับปุ่มโดยตั้งใจ — ถ้าไปวางบนสุดจะมีตัวกรองกับ
                  ตัวอย่างข้อมูลยาวๆ คั่น พอเลื่อนลงมาถึงปุ่มก็ลืมไปแล้ว */}
              <div className="fname-group">
                <label className="fname-label">
                  ชื่อไฟล์ <span className="req">*</span>
                </label>
                <div className="fname-row">
                  <input
                    type="text"
                    placeholder="เช่น IPM-Report-2026-08"
                    autoComplete="off"
                    value={filename}
                    onChange={onFilenameChange}
                  />
                  <span className="fname-ext">{FILE_EXT[format]}</span>
                </div>
              </div>

              <button
                type="button"
                className="btn-primary"
                disabled={sessionRunning || !optionsQ.data || !cleanName || !!alplError || previewQ.isPending || previewQ.isError || total === 0 || busyNote != null}
                onClick={onClickDownload}
              >
                {downloadLabel}
              </button>
            </div>
            <div className={`fname-hint${fnameWarn ? " warn" : ""}`}>
              {fnameWarn
                ? 'ตัวอักษร \\ / : * ? " < > | ใช้ในชื่อไฟล์ไม่ได้'
                : cleanName
                  ? `จะได้ไฟล์ชื่อ ${cleanName}${FILE_EXT[format]}`
                  : "กรอกชื่อไฟล์ก่อนถึงจะกดดาวน์โหลดได้"}
            </div>
            </>}
          </section>
        )}
      </div>

      {modalOpen && (
        <TemplateModal
          editing={editingTpl}
          catalog={columnsQ.data ?? []}
          saving={saveTpl.isPending}
          onSave={(name, columns) => { if (!runningRef.current) saveTpl.mutate({ name, columns }); }}
          onClose={() => { setModalOpen(false); setEditingTpl(null); }}
        />
      )}

      {/* ── ที่วางผังรายงานตอนสั่งพิมพ์ ──────────────────────────────────
          @media print ซ่อน #root ทั้งก้อนแล้วเหลือแค่บล็อกนี้ (ดู index.css)

          ⚠ วาดลงหน้านี้แล้วสั่ง print เลย ไม่เปิดหน้าต่างใหม่ เพราะ
            1) ไม่โดน pop-up blocker
            2) ไม่ต้องประกอบ HTML ทั้งหน้าเป็นสตริง ซึ่งพลาดง่ายมาก

          ⚠ ต้อง portal ออกไปนอก #root — ห้ามวางไว้ในต้นไม้ของหน้าเว็บ
            ของเดิมวางไว้ข้างใน `#root > fieldset.page-lock > .main-edit` ทำให้
            ซ่อนหน้าเว็บด้วย `display:none` ไม่ได้ (บล็อกนี้จะหายตามไปด้วย)
            เลยต้องใช้ `visibility:hidden` แทน ซึ่ง **ยังกินพื้นที่ layout อยู่**
            → เบราว์เซอร์นับความสูงของหน้าเว็บมาคิดจำนวนหน้า ได้กระดาษเปล่า
              ต่อท้ายทุกครั้ง (เจอจริง: ข้อมูล 1 หน้า เปล่าอีก 2)
            พอย้ายออกมาอยู่ใต้ body ตรง ๆ แล้ว ซ่อน #root ด้วย display:none
            ได้เลย ความสูงของเอกสารจึงเหลือเท่ากับผังรายงานพอดี             */}
      {createPortal(
        <div id="print-root">
          {printData && (
            <>
              {/* หัวกระดาษของเราเอง — โลโก้ซ้าย · ชื่อไฟล์กลาง · วันที่ขวา
                  ⚠ ต้องมีอันนี้เพราะปิดหัว/ท้ายกระดาษของเบราว์เซอร์ไปแล้ว
                    (@page margin: 0 ใน index.css) ไม่งั้นจะไม่มีอะไรบอกเลยว่า
                    รายงานนี้คืออะไร ออกเมื่อไหร่ */}
              <div className="print-head">
                <img src="/assets/ADI-LOGO.svg" alt="Analog Devices" />
                <span className="print-head-title">
                  {cleanName || printData.template_name || "report"}
                </span>
                <span className="print-head-date">
                  Date : {new Date().toLocaleDateString("en-GB")}
                </span>
              </div>
              <ReportSheet data={printData} />
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** สไตล์ 1 เซลล์ตามที่ผู้ใช้จัดไว้ในผัง — ยกจาก cellStyle() ใน export.html
 *  ตัวต่อตัว รวมทั้ง indent ที่แปลงเป็น padding-left */
export function reportCellStyle(s: any = {}): React.CSSProperties {
  return {
    fontFamily: s.font || undefined,
    fontSize: `${s.size || 11}pt`,
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: s.underline ? "underline" : undefined,
    background: s.fill || undefined,
    color: s.color || undefined,
    textAlign: s.align || "center",
    verticalAlign: s.valign || "middle",
    paddingLeft: s.indent ? `${0.4 + s.indent * 0.7}rem` : undefined,
  };
}

/** วาดผังรายงาน (PDF/Excel) จากผลของ /api/export/report-preview
 *
 *  ⚠ รูปทรงที่ backend คืนมาคือ `{nCols, rows: [[{v, s, span?, hidden?, data?,
 *    head?}]]}` (ดู _render_report / _cell_out ใน routers/export.py)
 *    **ไม่ใช่** `{grid: [[{text, style, colspan, ...}]]}` — ของเดิมฝั่ง React
 *    อ่านคีย์ที่ไม่มีอยู่จริง เลยขึ้น "ยังไม่มีผังรายงาน" ทุกครั้งทั้งที่ backend
 *    ส่งข้อมูลมาครบ
 *
 *  สไตล์ทุกตัวมาจากผังที่ผู้ใช้จัดไว้ ไม่ได้ hardcode ที่นี่ — เซลล์ที่มีเนื้อหา
 *  ได้เส้นขอบหนา (.bx) เหมือนที่ openpyxl ใส่ให้ในไฟล์ .xlsx
 */
export function ReportSheet({ data }: { data: any }) {
  if (!data?.rows?.length) {
    return <div className="empty">ไม่มีข้อมูลที่ตรงกับตัวกรอง</div>;
  }
  return (
    <table className="rpt-sheet">
      <tbody>
        {data.rows.map((row: any[], r: number) => (
          <tr key={r}>
            {row.map((cell: any, c: number) => {
              if (cell?.hidden) return null;   // ถูกกลืนจากการผสานเซลล์
              const sp = cell?.span ?? { r: 1, c: 1 };
              // เซลล์ที่ "มีเนื้อหาจริง" เท่านั้นที่ได้เส้นขอบ — ช่องเว้นว่างใน
              // ผังต้องไม่มีกรอบ ไม่งั้นรายงานจะเต็มไปด้วยตารางเปล่า
              const filled = (cell?.v && String(cell.v).trim()) || cell?.data || cell?.head;
              return (
                <td
                  key={c}
                  className={filled ? "bx" : undefined}
                  colSpan={sp.c > 1 ? sp.c : undefined}
                  rowSpan={sp.r > 1 ? sp.r : undefined}
                  style={reportCellStyle(cell?.s)}
                >
                  {cell?.v ?? ""}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
