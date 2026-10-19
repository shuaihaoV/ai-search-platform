/**
 * 内联 SVG 图标组件。
 *
 * 全站唯一图标来源：不使用外部图标字体 / 图片，避免额外网络请求与 CSP 问题。
 */

import type { ReactElement } from 'react';

interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

function svgProps(size: number, className?: string): {
  width: number;
  height: number;
  viewBox: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'round';
  strokeLinejoin: 'round';
  'aria-hidden': boolean;
  focusable: 'false';
  className?: string;
} {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: 'false',
    ...(className === undefined ? {} : { className }),
  };
}

export function SearchIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function SunIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function HomeIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.6V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.6" />
    </svg>
  );
}

export function MoonIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function AutoThemeIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18" />
      <path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function CopyIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function OpenExternalIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </svg>
  );
}

export function RefreshIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M21 12a9 9 0 1 1-3.5-7.1" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function CloseIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function WarningIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

export function InfoIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

export function CheckIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}

export function DocumentIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

export function CodeIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  );
}

export function SlidersIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

export function LinkIcon({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

export function SparkIcon({ size = 20, className }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </svg>
  );
}
