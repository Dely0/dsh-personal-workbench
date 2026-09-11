/**
 * 内联 SVG 图标集（从 index.tsx 抽出，行为不变）。
 */
export function Icon({ name, size = 16 }: { name: string; size?: number }): JSX.Element {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }
  switch (name) {
    case 'today': return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M8 5.5V8l1.8 1.8" /></svg>
    case 'calendar': return <svg {...common}><rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 2v3M10.5 2v3" /></svg>
    case 'list': return <svg {...common}><path d="M3 4h10M3 8h10M3 12h7" /></svg>
    case 'sparkles': return <svg {...common}><path d="M8 2l1.4 2.8L12 6 9.8 7.4 8 10 6.2 7.4 4 6l2.6-1.2L8 2zM4 12l.8 1.6L6.5 14l-1.7.4L4 16l-.4-1.6L2 14l1.7-.4L4 12zM12 10l.8 1.6 1.7.4-1.7.4L12 14l-.4-1.6L9.9 12l1.7-.4L12 10z" /></svg>
    case 'plus': return <svg {...common}><path d="M8 2v12M2 8h12" /></svg>
    case 'settings': return <svg {...common}><circle cx="8" cy="8" r="2.5" /><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M11.8 4.2l-1.4 1.4M5.6 10.4l-1.4 1.4" /></svg>
    case 'back': return <svg {...common}><path d="M10 2L4 8l6 6" /></svg>
    case 'edit': return <svg {...common}><path d="M9.5 2.5L3 9l-.5 4.5L7 13l6.5-6.5-4-4z" /><path d="M8 7l2 2" /></svg>
    case 'report': return <svg {...common}><path d="M3 13V3h8l2 2v8H3z" /><path d="M5 7h4M5 9.5h4" /></svg>
    case 'bell': return <svg {...common}><path d="M8 2a4 4 0 0 0-4 4v3l-1.5 2.5h11L12 9V6a4 4 0 0 0-4-4z" /><path d="M6.5 14a1.8 1.8 0 0 0 3 0" /></svg>
    case 'check': return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="M5.5 8.5l1.8 1.8 3.4-4" /></svg>
    case 'refresh': return <svg {...common}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5" /></svg>
    case 'trash': return <svg {...common}><path d="M3 4h10M6.5 4V2.5h3V4M5 4l.5 10h5L11 4" /></svg>
    case 'ai': return <svg {...common}><path d="M8 2l1.4 2.8L12 6 9.8 7.4 8 10 6.2 7.4 4 6l2.6-1.2L8 2z" /></svg>
    case 'breakdown': return <svg {...common}><path d="M3 4h4M3 8h4M3 12h4M9.5 4h3.5M9.5 8h3.5M9.5 12h3.5" /></svg>
    case 'subtask': return <svg {...common}><path d="M8 2v12M2 8h12" /></svg>
    case 'archive': return <svg {...common}><rect x="2.5" y="3" width="11" height="3.5" rx="1" /><path d="M4 6.5h8v6H4v-6zM6.5 9h3" /></svg>
    case 'book': return <svg {...common}><path d="M3 2.5h6.5v11H3zM9.5 2.5H13v11H9.5z" /><path d="M3 2.5v11M13 2.5v11" /></svg>
    case 'file': return <svg {...common}><path d="M4 1.5h5.5L13 5v9.5H4z" /><path d="M9.5 1.5V5H13" /></svg>
    case 'folder': return <svg {...common}><path d="M2.5 4h4l1.5 2h5.5v7h-11z" /></svg>
    case 'idea': return <svg {...common}><path d="M8 2a4 4 0 0 0-1 7.8V12h2V9.8A4 4 0 0 0 8 2z" /><path d="M6.5 14h3" /></svg>
    case 'chevron': return <svg {...common}><path d="M6 3l5 5-5 5" /></svg>
    case 'skill': return <svg {...common}><path d="M4.5 2.5h7v11h-7z" /><path d="M6.5 5.5h3M6.5 8h3M6.5 10.5h2" /></svg>
    default: return <svg {...common}><circle cx="8" cy="8" r="5" /></svg>
  }
}
