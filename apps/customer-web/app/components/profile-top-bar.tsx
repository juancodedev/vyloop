import type { CustomerBusiness } from '../lib/api';

/**
 * The club's name above the profile.
 *
 * The design also places an "Ayuda" link here. It is left out until there is a
 * help destination: a link that leads nowhere is worse than no link.
 */
export function ProfileTopBar({ business }: { business: CustomerBusiness | null }) {
  return (
    <div className="club-topbar">
      <p className="club-topbar__club">{business ? business.name : 'Club del barrio'}</p>
    </div>
  );
}
