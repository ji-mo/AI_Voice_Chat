import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { SessionController } from "./lib/session-controller";
import { preloadSceneImage } from "./lib/scene-assets";
import { AmbientAudio } from "./lib/ambient-audio";
import { SceneStage } from "./components/SceneStage";
import { portraitSources } from "./components/Character";
import { Subtitle } from "./components/Subtitle";
import { InputBar } from "./components/InputBar";
import { StatusNotice } from "./components/StatusNotice";
import { Icon } from "./components/Icons";
import type { AppMode, DemoFault } from "../shared/contracts";
import "./styles.css";

export function App(): ReactElement {
  const [controller] = useState(() => new SessionController());
  const [ambience] = useState(() => new AmbientAudio());
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const ambient = useSyncExternalStore(
    ambience.subscribe,
    ambience.getSnapshot,
  );
  const [assets, setAssets] = useState({
    loading: true,
    character: true,
    failed: false,
  });
  const [assetAttempt, setAssetAttempt] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const aborter = new AbortController();
    const paths = [portraitSources.neutral, "/assets/lighthouse-cinema.webp"];
    setAssets((current) => ({ ...current, loading: true }));

    Promise.allSettled(
      paths.map((path) => preloadSceneImage(path, aborter.signal)),
    )
      .then((results): void => {
        if (aborter.signal.aborted) return;
        controller.setPhotoAvailable(results[1]?.status === "fulfilled");
        setAssets({
          loading: false,
          character: results[0]?.status === "fulfilled",
          failed: results.some((result) => result.status === "rejected"),
        });
      })
      .catch((error: unknown): void => {
        if (aborter.signal.aborted) return;
        console.error("Scene preload failed", error);
        setAssets((current) => ({ ...current, loading: false, failed: true }));
      });
    return (): void => {
      aborter.abort();
    };
  }, [controller, assetAttempt]);

  useEffect(() => {
    void controller.refreshAvailability();
    const onHidden = (): void => {
      if (document.hidden) controller.cancelActiveTurn("page_hidden");
    };
    document.addEventListener("visibilitychange", onHidden);
    return (): void => {
      document.removeEventListener("visibilitychange", onHidden);
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    // Subscribe directly: microphone muting must happen in the same turn as
    // the controller state change, before the recorder acquires an audio track.
    const sync = (): void => {
      ambience.syncScene(controller.getSnapshot());
    };
    const unsubscribe = controller.subscribe(sync);
    const onVisibility = (): void => {
      ambience.handleVisibility();
    };
    sync();
    document.addEventListener("visibilitychange", onVisibility);
    return (): void => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      ambience.dispose();
    };
  }, [ambience, controller]);

  const connect = (mode?: AppMode): void => {
    void ambience.unlock();
    void controller.connect(mode);
  };

  const ambienceLabel =
    ambient.status === "loading"
      ? "氛围音准备中，点击关闭"
      : ambient.status === "error" || ambient.status === "paused"
        ? "重试播放氛围音"
        : ambient.enabled && ambient.status === "playing"
          ? "关闭氛围音"
          : "开启氛围音";

  const send = (text: string): void => {
    void controller.sendText(text);
  };

  const retry = (): void => {
    controller.retryInput();
  };

  return (
    <main className={`experience ${state.entered ? "entered" : "welcome"}`}>
      <SceneStage state={state} characterAvailable={assets.character} />
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="雨停之前首页">
          <Icon name="star" size={25} />
          <span>
            AFTER RAIN<small>雨 停 之 前</small>
          </span>
        </a>
        <div className="topbar-right">
          <span className="chapter-tag">
            INTERACTIVE STORY <i /> 01
          </span>
          <button
            className="mode-button"
            onClick={(): void => {
              if (!settingsOpen) void controller.refreshAvailability();
              setSettingsOpen(!settingsOpen);
            }}
            disabled={state.loading}
            aria-expanded={settingsOpen}
          >
            {state.mode === "mock" ? "演示模式" : "真实对话"}
            <span>⌄</span>
          </button>
          {state.entered && (
            <button
              className={`icon-button ambience-button ${ambient.enabled ? "is-enabled" : ""} ${ambient.status === "loading" ? "is-loading" : ""}`}
              aria-label={ambienceLabel}
              title={ambienceLabel}
              aria-pressed={ambient.enabled}
              onClick={(): void => {
                if (
                  ambient.enabled &&
                  ["error", "paused", "off"].includes(ambient.status)
                )
                  ambience.retry();
                else ambience.toggle();
              }}
            >
              <Icon
                name={ambient.enabled && ambient.volume > 0 ? "sound" : "muted"}
              />
            </button>
          )}
          {state.entered && (
            <button
              className="icon-button"
              aria-label="重新开始相遇"
              onClick={(): void => {
                connect();
              }}
            >
              <Icon name="reset" />
            </button>
          )}
        </div>
      </header>
      {settingsOpen && (
        <aside className="settings-panel">
          <p>选择这次相遇</p>
          <button
            className={state.mode === "mock" ? "selected" : ""}
            disabled={state.loading}
            onClick={(): void => {
              setSettingsOpen(false);
              connect("mock");
            }}
          >
            演示模式 <span>无需密钥 · 本地故事与语音</span>
          </button>
          <button
            className={state.mode === "live" ? "selected" : ""}
            disabled={
              state.loading ||
              state.availabilityStatus !== "ready" ||
              !state.availableModes.includes("live")
            }
            onClick={(): void => {
              setSettingsOpen(false);
              connect("live");
            }}
          >
            真实对话{" "}
            <span>
              {state.availabilityStatus === "loading"
                ? "正在检查服务配置…"
                : state.availabilityStatus === "error"
                  ? "暂时无法确认服务配置"
                  : state.availableModes.includes("live")
                    ? "模型生成 · 真实语音识别"
                    : "服务端尚未启用真实对话"}
            </span>
          </button>
          {state.availabilityStatus === "error" && (
            <div className="mode-status" role="alert">
              <span>{state.availabilityError}</span>
              <button
                onClick={(): void => {
                  void controller.refreshAvailability();
                }}
              >
                重新检查
              </button>
            </div>
          )}
          {state.demoFaults && (
            <label className="fault-control">
              演示一次降级
              <select
                value={state.fault}
                onChange={(event): void => {
                  controller.setFault(event.target.value as DemoFault | "");
                }}
              >
                <option value="">正常体验</option>
                <option value="audio_failure">下一轮语音不可用</option>
                <option value="delay_reply">下一轮延迟 8 秒</option>
                <option value="model_timeout">下一轮回应超时</option>
              </select>
            </label>
          )}
          {state.entered && (
            <div className="ambience-settings">
              <div className="ambience-heading">
                <label htmlFor="ambience-volume">咖啡馆氛围</label>
                <button
                  type="button"
                  aria-pressed={ambient.enabled}
                  onClick={(): void => {
                    ambience.toggle();
                  }}
                >
                  {ambient.enabled ? "关闭" : "开启"}
                </button>
              </div>
              <div className="ambience-volume">
                <input
                  id="ambience-volume"
                  aria-label="氛围音量"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  disabled={!ambient.enabled}
                  value={Math.round(ambient.volume * 100)}
                  onChange={(event): void => {
                    ambience.setVolume(Number(event.target.value) / 100);
                  }}
                />
                <output htmlFor="ambience-volume">
                  {Math.round(ambient.volume * 100)}%
                </output>
              </div>
              <p className="ambience-description">
                说话时轻一点，录音时安静下来。
              </p>
              {ambient.status === "loading" && (
                <p className="ambience-status" role="status">
                  正在准备氛围音…
                </p>
              )}
              {ambient.message && (
                <div className="ambience-status" role="status">
                  <span>{ambient.message}</span>
                  <button
                    type="button"
                    onClick={(): void => {
                      ambience.retry();
                    }}
                  >
                    重试氛围音
                  </button>
                </div>
              )}
            </div>
          )}
        </aside>
      )}
      <div className="scene-caption">
        <span className="location-mark" />
        <span>THE LAST CUP CAFÉ</span>
        <span className="scene-time">22:48 · 雨夜</span>
      </div>
      {!state.entered && (
        <section className="welcome-copy">
          <div className="eyebrow">A SMALL ENCOUNTER, AFTER THE STORM</div>
          <h1>
            雨停之前，
            <br />
            聊一会儿。
          </h1>
          <p>
            一杯还温热的咖啡，一个等待的人。
            <br />
            有些故事，从一句「你好」开始。
          </p>
          <button
            className="enter-button"
            disabled={assets.loading || state.loading}
            onClick={(): void => {
              ambience.queueEntryBell();
              connect();
            }}
          >
            {assets.loading
              ? "正在推开咖啡馆的门…"
              : state.loading
                ? "正在准备这次相遇…"
                : "走进咖啡馆"}
            <Icon name="arrow" />
          </button>
        </section>
      )}
      <div className="character-card">
        <span className="tiny-label">A CHANCE ENCOUNTER</span>
        <div>
          Mira <span>米拉</span>
          <span className={`presence-dot ${state.phase}`} />
        </div>
        <p>26 岁 / 旅行摄影师</p>
        <span className="character-location">雨夜 · 即将打烊的咖啡馆</span>
      </div>
      {assets.failed && (
        <div className="asset-notice">
          部分场景没有加载出来，仍可继续对话。
          <button
            disabled={assets.loading}
            onClick={(): void => {
              setAssetAttempt((value) => value + 1);
            }}
          >
            {assets.loading ? "正在重试…" : "重试画面"}
          </button>
        </div>
      )}
      <div
        className={`conversation-dock ${state.entered ? "" : "welcome-dock"}`}
      >
        <StatusNotice
          notice={state.notice}
          onDismiss={(): void => {
            controller.clearNotice();
          }}
          onRetry={retry}
        />
        {state.entered && (
          <>
            <Subtitle
              state={state}
              onResume={(): void => {
                controller.resumePlayback();
              }}
            />
            <InputBar
              state={state}
              onSend={send}
              onStart={(): void => {
                void controller.startVoice();
              }}
              onStop={(): void => {
                void controller.stopVoice();
              }}
              onCancel={(): void => {
                controller.cancelActiveTurn("user_cancel");
              }}
              onExample={(): void => {
                void controller.sendExampleVoice();
              }}
            />
          </>
        )}
      </div>
      {!state.entered && (
        <footer className="welcome-footer">
          <span>每一次倾听，都是故事的一部分。</span>
          <span>ORIGINAL CHARACTER · AI VOICE</span>
        </footer>
      )}
    </main>
  );
}
