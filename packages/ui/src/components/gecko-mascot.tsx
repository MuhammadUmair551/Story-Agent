import type { ImgHTMLAttributes } from "react";

export type GeckoMascotState = "idle" | "thinking" | "speaking" | "happy" | "success" | "error";
export type GeckoMascotProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & Readonly<{ state?: GeckoMascotState }>;

export const GeckoMascot = ({ state = "idle", className, ...props }: GeckoMascotProps): React.JSX.Element => (
  <img
    aria-hidden="true"
    alt=""
    src="/images/gecko-mascot.png"
    className={`gecko-mascot gecko-mascot--${state} ${className ?? ""}`}
    draggable={false}
    {...props}
  />
);
