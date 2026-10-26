import {
  useState,
  useRef,
  useEffect,
  type ReactElement,
  type FormEvent,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import type { SceneState } from "../state/scene-reducer";
import { Icon } from "./Icons";

interface InputBarProps {
  state: SceneState;
  onSend: (text: string) => void;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onExample: () => void;
}

export function InputBar({
  state,
  onSend,
  onStart,
  onStop,
  onCancel,
  onExample,
}: InputBarProps): ReactElement {
  const [text, setText] = useState("");
  const holding = useRef<number | "keyboard" | null>(null);

  useEffect(() => {
    const cancelHolding = (): void => {
      if (holding.current === null) return;
      holding.current = null;
      onCancel();
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) cancelHolding();
    };
    window.addEventListener("blur", cancelHolding);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return (): void => {
      window.removeEventListener("blur", cancelHolding);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onCancel]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (text.trim()) {
      onSend(text);
      setText("");
    }
  };

  const start = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!event.isPrimary || event.button !== 0 || holding.current !== null)
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    holding.current = event.pointerId;
    onStart();
  };

  const stop = (): void => {
    if (holding.current !== null) {
      holding.current = null;
      onStop();
    }
  };

  const cancel = (): void => {
    if (holding.current !== null) {
      holding.current = null;
      onCancel();
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.code !== "Space" && event.code !== "Enter") return;
    event.preventDefault();
    if (event.repeat || holding.current !== null) return;
    holding.current = "keyboard";
    onStart();
  };

  const keyUp = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault();
      if (holding.current === "keyboard") stop();
    }
  };

  return (
    <div className="interaction-area">
      <div className="conversation-suggestions" aria-label="话题建议">
        {["你在等谁？", "能看看你的照片吗？", "雨是不是小了？"].map(
          (suggestion) => (
            <button
              key={suggestion}
              onClick={(): void => {
                onSend(suggestion);
              }}
            >
              {suggestion}
              <span>↗</span>
            </button>
          ),
        )}
      </div>
      <div className="input-row">
        <form onSubmit={submit} className="text-form">
          <input
            aria-label="对 Mira 说句话"
            value={text}
            onChange={(event): void => {
              setText(event.target.value);
            }}
            maxLength={500}
            placeholder="对 Mira 说句话…"
            enterKeyHint="send"
            autoComplete="off"
          />
          <button
            type="submit"
            className="send-button"
            disabled={!text.trim()}
            aria-label="发送文字"
          >
            <Icon name="send" />
          </button>
        </form>
        <button
          className={`mic-button ${state.recording ? "recording" : ""}`}
          aria-label="按住说话，松开发送"
          aria-busy={state.micPending}
          onPointerDown={start}
          onPointerUp={(event): void => {
            if (holding.current === event.pointerId) stop();
          }}
          onPointerCancel={(event): void => {
            if (holding.current === event.pointerId) cancel();
          }}
          onLostPointerCapture={(event): void => {
            if (holding.current === event.pointerId) cancel();
          }}
          onKeyDown={keyDown}
          onKeyUp={keyUp}
          onBlur={(): void => {
            if (holding.current === "keyboard") cancel();
          }}
          onContextMenu={(event): void => {
            event.preventDefault();
          }}
        >
          <Icon name="mic" />
          <span>
            {state.recording
              ? "松开发送"
              : state.micPending
                ? "连接中"
                : "按住说话"}
          </span>
        </button>
        {(state.phase === "speaking" ||
          state.phase === "thinking" ||
          state.micPending ||
          state.gate) && (
          <button
            className="stop-button"
            onClick={onCancel}
            aria-label={state.micPending ? "取消麦克风等待" : "打断当前回复"}
          >
            <Icon name="pause" />
          </button>
        )}
      </div>
      <div className="input-footnote">
        <span>
          {state.recording
            ? "松开发送 · 最长 30 秒"
            : "随时开口，故事就会有新的方向"}
        </span>
        <span>
          {state.mode === "mock" && (
            <button className="example-voice" onClick={onExample}>
              示例语音
            </button>
          )}
          {state.mode === "mock" ? "演示脚本 · 合成语音" : "AI 角色 · 合成语音"}
        </span>
      </div>
    </div>
  );
}
