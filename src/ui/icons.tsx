import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function base(props: IconProps, children: ReactNode) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      {children}
    </svg>
  )
}

export function PlayIcon(props: IconProps) {
  return base(props, <path d="M8 5.2v13.6c0 .8.9 1.3 1.5.8l9.5-6.8c.6-.4.6-1.2 0-1.6L9.5 4.4C8.9 3.9 8 4.4 8 5.2Z" fill="currentColor" />)
}

export function PauseIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="7" y="5" width="3.6" height="14" rx="1.4" fill="currentColor" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.4" fill="currentColor" />
    </>,
  )
}

export function StopIcon(props: IconProps) {
  return base(props, <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" />)
}

export function MusicIcon(props: IconProps) {
  return base(
    props,
    <path
      d="M9 18.2V6.4c0-.6.4-1.1 1-1.2l8-1.6c.8-.2 1.5.4 1.5 1.1v10.8M9 18.2c0 1.5-1.2 2.8-2.8 2.8S3.5 19.7 3.5 18.2s1.2-2.8 2.8-2.8S9 16.7 9 18.2Zm10.5-4.2c0 1.5-1.2 2.8-2.8 2.8s-2.8-1.3-2.8-2.8 1.2-2.8 2.8-2.8 2.8 1.3 2.8 2.8Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />,
  )
}

export function MicIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 11.2a6.5 6.5 0 0 0 13 0M12 17.8V21M9 21h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>,
  )
}

export function DisplayIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="3" y="4" width="18" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 12.5v-2M10.3 14V9M13.5 15.2V7.8M16.8 13.2v-2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </>,
  )
}

export function SettingsIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.3 9c.12.63.65 1.07 1.29 1.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5.9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>,
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return base(props, <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />)
}

export function ArrowUpIcon(props: IconProps) {
  return base(props, <path d="M12 19V5m0 0-6 6m6-6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />)
}

export function ArrowDownIcon(props: IconProps) {
  return base(props, <path d="M12 5v14m0 0 6-6m-6 6-6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />)
}

export function HeadphonesIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="3" y="13" width="4.5" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <rect x="16.5" y="13" width="4.5" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
    </>,
  )
}
