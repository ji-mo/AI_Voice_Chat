import type { ReactElement } from "react";
import type { Notice } from "../state/scene-reducer";
import { Icon } from "./Icons";

interface StatusNoticeProps {
  notice: Notice | null;
  onDismiss: () => void;
  onRetry: () => void;
}

export function StatusNotice({
  notice,
  onDismiss,
  onRetry,
}: StatusNoticeProps): ReactElement | null {
  if (!notice) return null;
  return (
    <div
      className={`status-notice ${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <span>{notice.message}</span>
      {notice.kind === "error" && <button onClick={onRetry}>重试</button>}
      <button aria-label="关闭提示" onClick={onDismiss}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
