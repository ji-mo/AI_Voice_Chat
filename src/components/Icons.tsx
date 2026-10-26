import type { ReactElement } from "react";

interface IconProps {
  name:
    | "mic"
    | "send"
    | "reset"
    | "sound"
    | "muted"
    | "pause"
    | "star"
    | "arrow"
    | "close";
  size?: number;
}

export function Icon({ name, size = 20 }: IconProps): ReactElement {
  const paths: Record<IconProps["name"], ReactElement> = {
    mic: (
      <>
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
      </>
    ),
    send: (
      <>
        <path d="m4 5 17 7-17 7 3-7-3-7Zm3 7h14" />
      </>
    ),
    reset: (
      <>
        <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" />
      </>
    ),
    sound: (
      <>
        <path d="m4 9 4 0 5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
      </>
    ),
    muted: <path d="m4 9 4 0 5-4v14l-5-4H4zM17 9l5 6m0-6-5 6" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" strokeWidth="3" />
      </>
    ),
    star: (
      <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" />
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
