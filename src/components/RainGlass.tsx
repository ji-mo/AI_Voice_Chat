import { useEffect, useRef, type ReactElement } from "react";
import { portraitSources } from "./Character";

interface Drop {
  zone: number;
  x: number;
  y: number;
  radius: number;
  speed: number;
  age: number;
  life: number;
  drift: number;
  moving: boolean;
  growth: number;
  releaseRadius: number;
  glideSpeed: number;
  pauseFor: number;
  travelRemaining: number;
}

interface Trail {
  x: number;
  y: number;
  endX: number;
  endY: number;
  life: number;
}

interface GlassZone {
  left: number;
  right: number;
  bottom: number;
  sizeScale: number;
}

// Photograph coordinates keep rain on the glass across crops and camera moves.
const WIDTH = 1672;

const HEIGHT = 941;

const GLASS_RIGHT = 752;

// Visual tuning does not alter the simulation's fall speed or pause rhythm.
const DROP_DENSITY = 0.525;

const DROP_SIZE = 0.4235;

const MAX_DROPS = Math.round(130 * DROP_DENSITY);

const MAX_TRAILS = 3600;

const TRAIL_LIFETIME = 3.8;

// Relative to the original 145 px/s ceiling; keep the requested pace explicit.
const RAIN_SPEED = 0.5;

const ORIGINAL_MAX_SPEED = 145;

// The first two zones share the left pane; the third is beyond its wooden mullion.
const GLASS_ZONES = [
  { left: 18, right: 228, bottom: 390, sizeScale: 1.15 },
  { left: 245, right: 463, bottom: 550, sizeScale: 1.15 },
  { left: 524, right: 734, bottom: 519, sizeScale: 1 },
] as const satisfies readonly GlassZone[];

function dropSize(zone: number): number {
  return DROP_SIZE * (GLASS_ZONES[zone]?.sizeScale ?? 1);
}

function makeDrop(
  initial = false,
  zone = Math.floor(Math.random() * GLASS_ZONES.length),
  forceMoving = false,
): Drop {
  const pane = GLASS_ZONES[zone] ?? GLASS_ZONES[0];
  const moving = forceMoving || (initial && Math.random() > 0.72);
  return {
    zone,
    x: pane.left + Math.random() * (pane.right - pane.left),
    y: Math.random() * (moving ? pane.bottom * 0.55 : pane.bottom - 35),
    radius: moving
      ? (zone === 0 ? 6 : 4.8) + Math.random() * 1.6
      : 0.6 + Math.random() * 1.5,
    speed: moving
      ? ORIGINAL_MAX_SPEED * RAIN_SPEED * (0.35 + Math.random() * 0.3)
      : 0,
    age: initial ? 1 : 0,
    life: 45 + Math.random() * 65,
    drift: Math.random() * Math.PI * 2,
    moving,
    growth: 0.025 + Math.random() * 0.045,
    releaseRadius: 2.6 + Math.random() * 1.1,
    glideSpeed: ORIGINAL_MAX_SPEED * RAIN_SPEED * (0.65 + Math.random() * 0.35),
    pauseFor: moving ? Math.random() * 0.8 : Math.random() * 2.5,
    travelRemaining: 55 + Math.random() * 155,
  };
}

export function RainGlass(): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect((): (() => void) | undefined => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const photograph = new Image();
    const glassTexture = document.createElement("canvas");
    glassTexture.width = WIDTH;
    glassTexture.height = HEIGHT;
    const glassContext = glassTexture.getContext("2d");
    let imageReady = false;
    let disposed = false;
    let frame = 0;
    let last = 0;
    let nextBirth = 0.3;
    const nextSlides = GLASS_ZONES.map(
      (_zone, index): number => 0.25 + index * 0.65 + Math.random() * 0.3,
    );
    let drops = Array.from(
      { length: Math.round(85 * DROP_DENSITY) },
      (_, index): Drop =>
        makeDrop(
          true,
          index % GLASS_ZONES.length,
          index < Math.round(3 * DROP_DENSITY) * GLASS_ZONES.length ||
            (index % GLASS_ZONES.length === 0 &&
              index < Math.round(6 * DROP_DENSITY) * GLASS_ZONES.length),
        ),
    );
    let trails: Trail[] = [];

    const draw = (): void => {
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.save();
      context.beginPath();
      context.moveTo(0, 0);
      context.lineTo(479, 0);
      context.lineTo(479, 550);
      // Keep rain behind the plant on the indoor windowsill.
      context.lineTo(165, 585);
      context.lineTo(125, 490);
      context.lineTo(70, 425);
      context.lineTo(0, 400);
      context.closePath();
      // Separate pane polygons exclude the solid vertical window mullion.
      context.moveTo(510, 0);
      context.lineTo(GLASS_RIGHT, 0);
      context.lineTo(GLASS_RIGHT, 519);
      context.lineTo(510, 548);
      context.closePath();
      context.clip();
      // Soften baked-in rain in the photograph once, then render moving beads
      // above it. Otherwise thousands of sharp static dots overwhelm motion.
      if (imageReady && glassContext) {
        context.globalAlpha = 0.88;
        context.drawImage(glassTexture, 0, 0, WIDTH, HEIGHT);
        context.globalAlpha = 1;
      }
      context.lineCap = "round";
      // Batch continuous wet paths by age. A shared short segment limit used
      // to erase the tracks before they were perceptible against the photo.
      for (let band = 0; band < 6; band += 1) {
        const fade = (band + 1) / 6;
        context.beginPath();
        for (const trail of trails) {
          const trailBand = Math.min(
            5,
            Math.floor((trail.life / TRAIL_LIFETIME) * 6),
          );
          if (trailBand !== band) continue;
          context.moveTo(trail.x, trail.y);
          context.lineTo(trail.endX, trail.endY);
        }
        context.lineWidth = 3.2 * DROP_SIZE;
        context.strokeStyle = `rgba(8,24,35,${0.3 * fade})`;
        context.stroke();
        context.lineWidth = 0.9 * DROP_SIZE;
        context.strokeStyle = `rgba(181,210,228,${0.26 * fade})`;
        context.stroke();
      }
      for (const drop of drops) {
        const size = dropSize(drop.zone);
        const r = drop.radius * size;
        const stretch = 1.08 + Math.min(drop.speed / 90, 0.42);
        const opacity = Math.min(1, drop.age * 0.8, drop.life / 3);
        context.save();
        context.globalAlpha = Math.max(0, opacity) * (drop.moving ? 0.96 : 0.6);
        context.beginPath();
        context.ellipse(drop.x, drop.y, r, r * stretch, 0.12, 0, Math.PI * 2);
        context.fillStyle = "rgba(12,28,40,0.34)";
        context.fill();
        if (imageReady && drop.radius > 1.3) {
          context.save();
          context.clip();
          const sx = photograph.naturalWidth / WIDTH;
          const sy = photograph.naturalHeight / HEIGHT;
          context.drawImage(
            photograph,
            Math.max(0, drop.x - r * 1.7 + 2 * size) * sx,
            Math.max(0, drop.y - r * 1.7 - 3 * size) * sy,
            r * 3.4 * sx,
            r * 3.4 * sy,
            drop.x - r,
            drop.y - r * stretch,
            r * 2,
            r * stretch * 2,
          );
          context.restore();
        }
        context.lineWidth = Math.min(0.95 * size, r * 0.22);
        context.strokeStyle = "rgba(187,210,225,0.5)";
        context.beginPath();
        context.ellipse(
          drop.x - r * 0.12,
          drop.y - r * 0.08,
          r * 0.74,
          r * stretch * 0.82,
          0.12,
          Math.PI * 1.08,
          Math.PI * 1.8,
        );
        context.stroke();
        context.fillStyle = "rgba(195,216,228,0.52)";
        context.beginPath();
        context.ellipse(
          drop.x + r * 0.15,
          drop.y + r * 0.58,
          r * 0.3,
          r * 0.15,
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
        context.restore();
      }
      context.restore();
    };

    const update = (seconds: number): void => {
      nextBirth -= seconds;
      if (nextBirth <= 0) {
        if (drops.length < MAX_DROPS) drops.push(makeDrop());
        nextBirth = (0.18 + Math.random() * 1.1) / DROP_DENSITY;
      }
      // Independent zone clocks keep the far-left pane visibly alive without
      // synchronizing its drops with either of the other glass regions.
      for (let zone = 0; zone < GLASS_ZONES.length; zone += 1) {
        const remaining = (nextSlides[zone] ?? 0) - seconds;
        nextSlides[zone] = remaining;
        if (remaining > 0) continue;
        const resting = drops.filter(
          (drop): boolean =>
            drop.zone === zone &&
            !drop.moving &&
            drop.radius > 1.1 &&
            drop.life > 12,
        );
        const selected = resting[Math.floor(Math.random() * resting.length)];
        if (selected) {
          selected.moving = true;
          selected.radius = Math.max(zone === 0 ? 6.4 : 5, selected.radius);
          selected.pauseFor = 0;
        } else if (drops.length < MAX_DROPS) {
          drops.push(makeDrop(false, zone, true));
        }
        nextSlides[zone] =
          (1.1 + Math.random() * (zone === 0 ? 1.5 : 2.1)) / DROP_DENSITY;
      }
      for (const drop of drops) {
        drop.age += seconds;
        drop.life -= seconds;
        drop.radius = Math.min(7.8, drop.radius + seconds * drop.growth);
        if (!drop.moving && drop.radius >= drop.releaseRadius) {
          drop.moving = true;
          drop.radius = Math.max(drop.zone === 0 ? 6.4 : 5, drop.radius);
        }
        if (!drop.moving) continue;
        drop.pauseFor = Math.max(0, drop.pauseFor - seconds);
        // Surface tension alternates gentle glides with independent pauses.
        const targetSpeed =
          drop.pauseFor > 0
            ? 0
            : drop.glideSpeed *
              (0.88 + Math.sin(drop.age * 0.7 + drop.drift) * 0.12);
        drop.speed += (targetSpeed - drop.speed) * (1 - Math.exp(-seconds * 2));
        if (drop.speed < 0.15) continue;
        const x = drop.x;
        const y = drop.y;
        drop.y += drop.speed * seconds;
        drop.x +=
          Math.sin(drop.y * 0.055 + drop.drift) * drop.speed * seconds * 0.045;
        drop.travelRemaining -= drop.speed * seconds;
        if (drop.travelRemaining <= 0 && drop.pauseFor === 0) {
          drop.pauseFor = 0.2 + Math.random() * 1.2;
          drop.travelRemaining = 55 + Math.random() * 155;
        }
        trails.push({
          x,
          y,
          endX: drop.x,
          endY: drop.y,
          life: TRAIL_LIFETIME,
        });
        // Moving beads collect smaller stationary droplets along their paths.
        for (const other of drops) {
          if (other === drop || other.moving || other.life <= 0) continue;
          const collisionRadius = drop.radius * dropSize(drop.zone);
          const otherRadius = other.radius * dropSize(other.zone);
          if (
            Math.abs(other.x - drop.x) < collisionRadius + otherRadius &&
            other.y >= y - collisionRadius &&
            other.y <= drop.y + collisionRadius
          ) {
            drop.radius = Math.min(
              7.8,
              Math.sqrt(drop.radius ** 2 + other.radius ** 2),
            );
            other.life = 0;
          }
        }
      }
      drops = drops.filter((drop): boolean => drop.life > 0 && drop.y < 610);
      trails = trails
        .filter((trail): boolean => {
          trail.life -= seconds;
          return trail.life > 0;
        })
        .slice(-MAX_TRAILS);
    };

    const tick = (now: number): void => {
      if (disposed || document.hidden || reducedMotion.matches) return;
      if (!last) last = now;
      const elapsed = now - last;
      if (elapsed >= 1000 / 30) {
        update(Math.min(elapsed / 1000, 0.075));
        draw();
        last = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const resume = (): void => {
      cancelAnimationFrame(frame);
      last = 0;
      if (disposed) return;
      draw();
      if (!document.hidden && !reducedMotion.matches)
        frame = requestAnimationFrame(tick);
    };
    const resize = (): void => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      context.setTransform(
        canvas.width / WIDTH,
        0,
        0,
        canvas.height / HEIGHT,
        0,
        0,
      );
      draw();
    };
    photograph.onload = (): void => {
      if (disposed) return;
      if (glassContext) {
        glassContext.filter = "blur(2.4px)";
        glassContext.drawImage(photograph, 0, 0, WIDTH, HEIGHT);
      }
      imageReady = true;
      draw();
    };
    photograph.onerror = (): void => {
      console.warn(
        "Rain refraction texture unavailable; using glass highlights.",
      );
    };
    photograph.src = portraitSources.neutral;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", resume);
    reducedMotion.addEventListener("change", resume);
    resize();
    resume();
    return (): void => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", resume);
      reducedMotion.removeEventListener("change", resume);
      photograph.onload = null;
      photograph.onerror = null;
    };
  }, []);

  return <canvas ref={ref} className="rain-glass" aria-hidden="true" />;
}
