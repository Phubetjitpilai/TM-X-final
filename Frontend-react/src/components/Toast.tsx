import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ToastType = "warning" | "error" | "success";
export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  type: ToastType;
}

interface ToastContextValue {
  show: (title: string, message?: string, type?: ToastType) => void;
  remove: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const activeToast = toasts[0];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (activeToast && dialog && !dialog.open) dialog.showModal();
  }, [activeToast]);

  const show = useCallback((title: string, message?: string, type: ToastType = "error") => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, title, message, type }]);
  }, []);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // Success ใช้เป็นข้อความยืนยันสั้น ๆ จึงไม่ควรบังคับให้ผู้ใช้กดปุ่ม
  // ตกลงเหมือน error/warning — ปล่อยให้กล่องหายเองหลัง 2 วินาที
  useEffect(() => {
    if (!activeToast || activeToast.type !== "success") return;
    const timer = window.setTimeout(() => remove(activeToast.id), 1000);
    return () => window.clearTimeout(timer);
  }, [activeToast, remove]);

  return (
    <ToastContext.Provider value={{ show, remove }}>
      {children}
      {activeToast && (
        <dialog
          key={activeToast.id}
          ref={dialogRef}
          className={`ui-dialog-box toast-dialog toast-dialog-${activeToast.type}`}
          aria-labelledby="toast-dialog-title"
          aria-describedby="toast-dialog-message"
          onCancel={(event) => { event.preventDefault(); remove(activeToast.id); }}
        >
          <div className="ui-dialog-title" id="toast-dialog-title">
            {activeToast.type === "warning" ? "แจ้งเตือน" : activeToast.type === "success" ? "สำเร็จ" : "เกิดข้อผิดพลาด"}
          </div>
          <div className="ui-dialog-msg" id="toast-dialog-message">
            {activeToast.title}
            {activeToast.message && <><br />{activeToast.message}</>}
          </div>
          {activeToast.type !== "success" && (
            <div className="ui-dialog-actions">
              <button type="button" className="ui-dialog-ok" autoFocus onClick={() => remove(activeToast.id)}>
                ตกลง
              </button>
            </div>
          )}
        </dialog>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast ต้องถูกเรียกภายใน <ToastProvider>");
  return ctx;
}
