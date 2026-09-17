import { css } from "@emotion/css";
import { html } from "lit";

import { IconProps } from "../common-types";
import { buildIconColorRule, ruleNames, themes } from "../constants/styles";

export function Shield({ ariaHidden = true, color, theme }: IconProps) {
  const shapeColor = color || themes[theme].brandLogo;

  return html`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="10 12 86 96"
      fill="none"
      aria-hidden="${ariaHidden}"
    >
      <g
        class=${css(buildIconColorRule(shapeColor, ruleNames.stroke))}
        fill="none"
        stroke-width="7"
        stroke-linecap="round"
      >
        <path d="M63.74 51.81 A10 10 0 1 0 63.74 68.19" />
        <path d="M68.33 45.26 A18 18 0 1 0 68.33 74.74" />
        <path d="M72.92 38.71 A26 26 0 1 0 72.92 81.29" />
        <path d="M77.52 32.15 A34 34 0 1 0 77.52 87.85" />
        <path d="M82.11 25.6 A42 42 0 1 0 82.11 94.4" />
      </g>
      <g class=${css(buildIconColorRule(shapeColor, ruleNames.fill))}>
        <circle cx="58" cy="60" r="4.2" />
        <rect x="88" y="14" width="6" height="92" rx="3" />
      </g>
    </svg>
  `;
}
