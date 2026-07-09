import {
  LayoutDashboard,
  Users,
  BarChart3,
  Gift,
  Star,
  QrCode,
  Settings,
  LogOut,
  MessageSquare,
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

export const NAV_SECTIONS: NavSection[] = [
  // First section has no title (it's the primary nav)
  {
    items: [
      { label: 'Inicio', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Clientes', href: '/dashboard/customers', icon: Users },
      { label: 'Analytics', href: '/dashboard/analytics', icon: BarChart3 },
    ],
  },
  {
    title: 'Lealtad',
    items: [
      { label: 'Programa', href: '/dashboard/loyalty', icon: Gift },
      { label: 'Canjes', href: '/dashboard/loyalty/rewards', icon: Star },
      { label: 'QR', href: '/dashboard/qr', icon: QrCode },
    ],
  },
  {
    title: 'Comunicación',
    items: [
      { label: 'Plantillas', href: '/dashboard/communication/templates', icon: MessageSquare },
      { label: 'Mensajes', href: '/dashboard/communication/messages', icon: MessageSquare },
      { label: 'Flujos', href: '/dashboard/communication/workflows', icon: MessageSquare },
    ],
  },
  {
    title: 'Cuenta',
    items: [
      { label: 'Configuración', href: '/dashboard/settings', icon: Settings },
    ],
  },
];

export const BOTTOM_ITEMS: NavItem[] = [
  { label: 'Cerrar Sesión', href: '#', icon: LogOut, isBottom: true, isAction: true },
];

/** Check if a nav item matches the current pathname */
export function isActive(pathname: string, item: NavItem): boolean {
  if (item.isAction) return false;
  return pathname === item.href;
}

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Panel Principal',
  '/dashboard/customers': 'Clientes',
  '/dashboard/analytics': 'Analytics',
  '/dashboard/loyalty': 'Lealtad',
  '/dashboard/loyalty/config': 'Configuración de Lealtad',
  '/dashboard/loyalty/tiers': 'Niveles de Lealtad',
  '/dashboard/loyalty/rewards': 'Recompensas',
  '/dashboard/loyalty/customers': 'Puntos de Clientes',
  '/dashboard/qr': 'QR del Negocio',
  '/dashboard/settings': 'Configuración',
  '/dashboard/communication/templates': 'Plantillas',
  '/dashboard/communication/messages': 'Mensajes',
  '/dashboard/communication/workflows': 'Flujos',
  '/dashboard/communication/send': 'Enviar Mensaje',
};

/** Resolve a human-readable page title from the current pathname */
export function getPageTitle(pathname: string): string {
  // Exact match first
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];

  // Customer detail route
  if (/^\/dashboard\/customers\//.test(pathname)) {
    return 'Detalle del Cliente';
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
