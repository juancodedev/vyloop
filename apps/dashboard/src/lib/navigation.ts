import {
  BellRing,
  FileText,
  Gift,
  Inbox,
  LayoutDashboard,
  LogOut,
  MapPin,
  QrCode,
  ScanLine,
  Settings,
  Sparkles,
  Star,
  Users,
  Wallet,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: number;
  /** Section title for grouping */
  section?: string;
  /** Render in bottom area (settings, logout) */
  isBottom?: boolean;
  /** Action item, not a route link */
  isAction?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

/**
 * The till leads the sidebar: it is the screen the counter opens all day, and
 * before this it was only reachable from a card on another page.
 */
export const PRIMARY_ACTION: NavItem = {
  label: 'Abrir caja',
  href: '/dashboard/loyalty/pos',
  icon: ScanLine,
};

export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { label: 'Resumen', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Clientes', href: '/dashboard/customers', icon: Users },
    ],
  },
  {
    title: 'Programa',
    items: [
      { label: 'Puntos', href: '/dashboard/loyalty/config', icon: Sparkles },
      { label: 'Niveles', href: '/dashboard/loyalty/tiers', icon: Star },
      { label: 'Premios', href: '/dashboard/loyalty/rewards', icon: Gift },
      { label: 'Saldos', href: '/dashboard/loyalty/customers', icon: Wallet },
    ],
  },
  {
    title: 'Avisos',
    items: [
      { label: 'Campañas', href: '/dashboard/communication/campaigns', icon: BellRing },
      { label: 'Mensajes', href: '/dashboard/communication/messages', icon: Inbox },
      { label: 'Plantillas', href: '/dashboard/communication/templates', icon: FileText },
      { label: 'Flujos', href: '/dashboard/communication/workflows', icon: Workflow },
    ],
  },
  {
    title: 'Tu local',
    items: [
      { label: 'QR para el mesón', href: '/dashboard/qr', icon: QrCode },
      { label: 'Sucursales', href: '/dashboard/settings/venues', icon: MapPin },
      { label: 'Ajustes', href: '/dashboard/settings', icon: Settings },
    ],
  },
];

export const BOTTOM_ITEMS: NavItem[] = [
  { label: 'Cerrar sesión', href: '#', icon: LogOut, isBottom: true, isAction: true },
];

/** Check if a nav item matches the current pathname */
export function isActive(pathname: string, item: NavItem): boolean {
  if (item.isAction) return false;
  return pathname === item.href;
}

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Resumen',
  '/dashboard/customers': 'Clientes',
  '/dashboard/loyalty/config': 'Puntos',
  '/dashboard/loyalty/tiers': 'Niveles',
  '/dashboard/loyalty/rewards': 'Premios',
  '/dashboard/loyalty/pos': 'Caja',
  '/dashboard/settings/venues': 'Sucursales',
  '/dashboard/loyalty/customers': 'Saldos de clientes',
  '/dashboard/qr': 'QR para el mesón',
  '/dashboard/settings': 'Ajustes',
  '/dashboard/communication/templates': 'Plantillas',
  '/dashboard/communication/messages': 'Mensajes',
  '/dashboard/communication/workflows': 'Flujos',
  '/dashboard/communication/campaigns': 'Campañas',
  '/dashboard/communication/send': 'Enviar mensaje',
};

/** Resolve a human-readable page title from the current pathname */
export function getPageTitle(pathname: string): string {
  // Exact match first
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];

  // Customer detail route
  if (/^\/dashboard\/customers\//.test(pathname)) {
    return 'Cliente';
  }

  // Prefix match for nested routes (longest first)
  const keys = Object.keys(PAGE_TITLES).filter((k) => k !== '/dashboard');
  keys.sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (pathname.startsWith(key)) return PAGE_TITLES[key];
  }

  // Fallback: title-case the last segment
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  return last.charAt(0).toUpperCase() + last.slice(1);
}
