import Modal from "./Modal";

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// ConfirmDialog: ใช้ก่อน action ที่ทำแล้วย้อนกลับไม่ได้ (ลบ Part/Measurement,
// ลงทะเบียน ALPL ใหม่ตอน IPM เจอเลขที่ยังไม่เคยลงทะเบียน ฯลฯ)
export default function ConfirmDialog({
  title = "ยืนยันการดำเนินการ",
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal title={title} onClose={onCancel} maxWidth={440}>
      <div style={{ fontSize: "0.9rem", lineHeight: 1.6, marginBottom: "1.25rem" }}>{message}</div>
      <div className="modal-actions">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
