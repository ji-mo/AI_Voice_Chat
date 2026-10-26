import type { ReactElement } from "react";
import { Character } from "./Character";
import { RainGlass } from "./RainGlass";
import type { SceneState } from "../state/scene-reducer";

interface SceneStageProps {
  state: SceneState;
  characterAvailable: boolean;
}

export function SceneStage({
  state,
  characterAvailable,
}: SceneStageProps): ReactElement {
  return (
    <div
      className={`scene-world camera-${state.snapshot.camera} ${state.entered ? "is-entered" : ""}`}
      aria-label="雨夜咖啡馆场景"
    >
      <div className="scene-camera">
        <div className="scene-plane">
          <div className="cafe-background" />
          <RainGlass />
          {characterAvailable ? (
            <Character
              phase={state.phase}
              emotion={state.snapshot.emotion}
              action={state.action}
            />
          ) : (
            <div className="character-fallback">
              Mira<span>角色画面暂不可用，你仍然可以与她交谈。</span>
            </div>
          )}
        </div>
      </div>
      <div className="scene-vignette" />
      {state.snapshot.photoVisible && (
        <figure className="memory-photo" aria-label="Mira 展示的灯塔照片">
          <img
            src="/assets/lighthouse-cinema.webp"
            alt="夕阳下的海岸灯塔，通向小屋的弯曲小径"
          />
          <figcaption>
            North coast, a summer ago.<span>一场迷路，和一个很长的夏天。</span>
          </figcaption>
        </figure>
      )}
    </div>
  );
}
