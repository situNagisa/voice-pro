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

export function CloseIcon(props: IconProps) {
  return base(
    props,
    <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  )
}

export function ChevronRightIcon(props: IconProps) {
  return base(
    props,
    <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />,
  )
}

export function SongIcon(props: IconProps) {
  return base(
    props,
    <>
      <path
        d="M9 17.5V6.2c0-.6.4-1.1 1-1.2l7.4-1.5c.8-.2 1.6.4 1.6 1.2v10.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.6" cy="17.8" r="2.6" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="16.4" cy="15.8" r="2.6" stroke="currentColor" strokeWidth="1.8" />
    </>,
  )
}

export function TunerIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M4 15.5V9M8 18V6M12 16.5v-9M16 20V4M20 14v-4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </>,
  )
}

export function HistoryIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M5.2 8.2A8 8 0 1 1 4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4.4 4.5v4.2h4.2M12 7.6V12l3.2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  )
}

export function PlusIcon(props: IconProps) {
  return base(props, <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />)
}

export function UploadIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M12 16V4m0 0L7.2 8.8M12 4l4.8 4.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </>,
  )
}

export function TrashIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M4.5 7h15M9.5 7V4.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8V7M7 7l.8 12.2c0 .7.6 1.3 1.3 1.3h5.8c.7 0 1.3-.6 1.3-1.3L17 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 10.5v6M14 10.5v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>,
  )
}

export function RefreshIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M19.5 9.5A8 8 0 1 0 20 14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M20 4.5v5h-5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  )
}

export function CheckIcon(props: IconProps) {
  return base(props, <path d="m5 12.5 4.5 4.5L19 6.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />)
}
