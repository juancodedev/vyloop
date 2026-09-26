'use client';

import { Check } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { ClubShell } from '../components/club-shell';
import { ClubLoading } from '../components/club-status';
import { displayNameFrom } from '../lib/display-name';

/**
 * The registration confirmation.
 *
 * The one route the design plan never described. It predates the club-barrio
 * redesign, nothing inside the app links to it, and before Stage 6 it rendered a
 * query parameter straight into a heading, a 48px emoji with no accessible
 * name, three inline styles with magic numbers, and a promise about the loyalty
 * programme that nothing in the system establishes.
 *
 * It is kept, not deleted: a URL like this can be printed on a QR code at the
 * counter, or sent in an email or an SMS, and nothing in the repository can
 * prove that no such link exists. So the route is hardened instead, and the
 * decision to remove it is left to whoever can answer that question.
 */
function ConfirmContent() {
  const searchParams = useSearchParams();
  // A display name, shaped and capped by `displayNameFrom`. Not trusted, not
  // validated, and never rendered as anything but text.
  const name = displayNameFrom(searchParams.get('name'));

  return (
    <ClubShell className="club-confirm-shell">
      {/*
        A landmark, a labelled region, and a heading: the three things a
        confirmation screen has to have before it is allowed to say "done".
        `ClubShell` is what supplies the `<main>`; before Stage 6 this was a
        bare `<div className="page">`, so it was the one route in the app with
        no landmark at all.
      */}
      <section className="card club-confirm" aria-labelledby="club-confirm-title">
        {/*
          Decorative. `aria-hidden` is the whole treatment, and it is the same
          one the movement arrows and the loading spinners use: the outcome is
          in the heading and the sentence below, so a screen reader is told
          what happened rather than being read a glyph. The previous version
          announced a bare emoji with no name at all, at 48px.
        */}
        <span className="confirm-icon" aria-hidden="true">
          <Check size={32} strokeWidth={3} />
        </span>

        <h1 id="club-confirm-title" className="club-confirm__title">
          ¡Gracias, {name}!
        </h1>

        {/*
          Says what the customer can do next, and nothing about what the
          programme will do for them. The previous copy told them they could
          "start accumulating points with their purchases at this store" — a
          claim about how the programme behaves that nothing on this route, or
          anywhere else in the app, establishes, and which the rest of the
          customer web is careful not to make.
        */}
        <p className="club-confirm__message">
          Te has registrado correctamente. Ingresá con tu teléfono para ver tu pase.
        </p>

        <Link href="/" className="btn btn--primary club-confirm__action">
          Volver al inicio
        </Link>
      </section>
    </ClubShell>
  );
}

export default function ConfirmPage() {
  return (
    // The same loading state every other route uses, instead of a bare centred
    // word in the legacy `.loading` class, so a status never arrives in a
    // different visual language from the screen that replaces it.
    <Suspense
      fallback={
        <ClubShell className="club-confirm-shell">
          <div className="club-confirm-loading">
            <ClubLoading label="Cargando tu confirmación…" />
          </div>
        </ClubShell>
      }
    >
      <ConfirmContent />
    </Suspense>
  );
}
