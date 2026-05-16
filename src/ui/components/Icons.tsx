import type { JSX } from 'preact';

type Props = JSX.SVGAttributes<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: Props & { children: any }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconSun = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </Svg>
);
export const IconMoon = (p: Props) => (
  <Svg {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Svg>
);
export const IconBolt = (p: Props) => (
  <Svg {...p}>
    <polyline points="13 2 4 14 12 14 11 22 20 10 12 10 13 2" />
  </Svg>
);
export const IconBug = (p: Props) => (
  <Svg {...p}>
    <rect x="8" y="6" width="8" height="14" rx="4" />
    <path d="M12 6V3M5 9l3 1M19 9l-3 1M5 16l3-1M19 16l-3-1M9 3l1 2M15 3l-1 2" />
  </Svg>
);
export const IconFile = (p: Props) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </Svg>
);
export const IconFolder = (p: Props) => (
  <Svg {...p}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </Svg>
);
export const IconCheck = (p: Props) => (
  <Svg {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
);
export const IconX = (p: Props) => (
  <Svg {...p}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </Svg>
);
export const IconArrowRight = (p: Props) => (
  <Svg {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </Svg>
);
export const IconExternal = (p: Props) => (
  <Svg {...p}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </Svg>
);
export const IconCopy = (p: Props) => (
  <Svg {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);
export const IconPlay = (p: Props) => (
  <Svg {...p}>
    <polygon points="6 4 20 12 6 20 6 4" />
  </Svg>
);
export const IconChevron = (p: Props) => (
  <Svg {...p}>
    <polyline points="9 6 15 12 9 18" />
  </Svg>
);
export const IconRouter = (p: Props) => (
  <Svg {...p}>
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <path d="M6.01 18H6M10.01 18H10M15 10V6a3 3 0 0 1 6 0M12 10V6a3 3 0 0 0-6 0" />
  </Svg>
);
export const IconSearch = (p: Props) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </Svg>
);
export const IconHash = (p: Props) => (
  <Svg {...p}>
    <line x1="4" y1="9" x2="20" y2="9" />
    <line x1="4" y1="15" x2="20" y2="15" />
    <line x1="10" y1="3" x2="8" y2="21" />
    <line x1="16" y1="3" x2="14" y2="21" />
  </Svg>
);
