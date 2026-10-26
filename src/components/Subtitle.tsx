import type { ReactElement } from "react";
import type { SceneState } from "../state/scene-reducer";
import { Icon } from "./Icons";

interface SubtitleProps {
  state: SceneState;
  onResume: () => void;
}

const phases = {
  idle: "在你身边",
  listening: "正在听你说",
  thinking: "想一想…",
  speaking: "轻声说",
};

export function Subtitle({ state, onResume }: SubtitleProps): ReactElement {
  return (
    <section
      className={`subtitle-panel ${state.subtitle ? "has-subtitle" : ""}`}
      aria-label="当前对话"
    >
      <div className="speaker-line">
        <span className="speaker-name">Mira</span>
        <span className={`voice-indicator ${state.phase}`}>
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>{phases[state.phase]}</span>
      </div>
      <p className="subtitle-text" aria-live="polite">
        {state.subtitle ||
          (state.phase === "listening"
            ? "我在听，慢慢说。"
            : state.phase === "thinking"
              ? "她停顿了一下，像是在回忆什么。"
              : "窗外的雨还没停。要不要坐一会儿？")}
      </p>
      {state.gate && (
        <button className="playback-gate" onClick={onResume}>
          <Icon name={state.gate === "blocked" ? "sound" : "arrow"} size={16} />
          {state.gate === "blocked"
            ? "点击播放这句语音"
            : state.gate === "read_start"
              ? "阅读这句回复"
              : "读完了，继续"}
        </button>
      )}
    </section>
  );
}
