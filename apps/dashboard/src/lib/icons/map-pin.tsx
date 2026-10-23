import { MapPin as LucideMapPin } from "lucide-react";
import { forwardRef } from "react";

// Wrapper to fix the type mismatch - LucideIcon expects className?: string
// but Lucide MapPin requires className: string
export const MapPinIcon = forwardRef<SVGSVGElement, { className?: string }>((props, ref) => {
  return <LucideMapPin ref={ref} className={props.className} />;
});
MapPinIcon.displayName = "MapPinIcon";
