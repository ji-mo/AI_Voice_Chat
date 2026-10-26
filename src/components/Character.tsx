import { useState, type ReactElement } from "react";
import type { Action, CharacterPhase, Emotion } from "../../shared/contracts";

export const portraitSources = {
  neutral: "/assets/mira-cinema.webp",
  warm: "/assets/mira-warm.webp",
  curious: "/assets/mira-curious.webp",
  window: "/assets/mira-window.webp",
  blink: "/assets/mira-blink.webp",
};

type Portrait = keyof typeof portraitSources;

interface CharacterProps {
  phase: CharacterPhase;
  emotion: Emotion;
  action: Action;
}

export function Character({
  phase,
  emotion,
  action,
}: CharacterProps): ReactElement {
  const [loaded, setLoaded] = useState<Partial<Record<Portrait, boolean>>>({});
  const requested: Portrait =
    action === "look_window"
      ? "window"
      : phase === "thinking" || phase === "listening"
        ? "curious"
        : emotion;
  const active = loaded[requested] ? requested : "neutral";
  const description =
    action === "look_window"
      ? "望向雨窗"
      : phase === "listening"
        ? "专注地听你说话"
        : phase === "thinking"
          ? "若有所思"
          : emotion === "warm"
            ? "温暖微笑"
            : emotion === "curious"
              ? "好奇地看着你"
              : "神情温柔";
  return (
    <div
      className={`character phase-${phase} action-${action} portrait-${active}`}
      role="img"
      aria-label={`Mira，26 岁的旅行摄影师，${description}`}
    >
      <div className="character-breath">
        {(Object.entries(portraitSources) as [Portrait, string][]).map(
          ([name, src]) => (
            <img
              key={name}
              className={`portrait-frame frame-${name} ${name === active ? "is-active" : ""} ${loaded[name] ? "is-ready" : ""}`}
              src={src}
              alt=""
              aria-hidden="true"
              decoding="async"
              draggable={false}
              onLoad={(): void => {
                setLoaded((current) => ({ ...current, [name]: true }));
              }}
              onError={(): void => {
                setLoaded((current) => ({ ...current, [name]: false }));
                console.error(`Character frame unavailable: ${name}`);
              }}
            />
          ),
        )}
      </div>
    </div>
  );
}
