import Link from 'next/link';

/**
 * The 404.
 *
 * Rendered inside the root layout, so it already has the club palette and the
 * font from `body.customer-web`. What it did not have was a class with a rule:
 * the CSS contract had to exempt `not-found` by name as the one class applied
 * without a rule, and the exemption's own comment called it "a hook waiting for
 * a design pass". This is that pass — the same card, the same type and the same
 * 44px-plus action as every other route — so the exemption can go.
 */
export default function NotFound() {
  return (
    <main className="not-found">
      <div className="card not-found__card">
        <h1 className="not-found__title">Página no encontrada</h1>
        <p className="not-found__description">Lo sentimos, la página que buscas no existe.</p>
        <Link href="/" className="btn btn--primary not-found__action">
          Volver al inicio
        </Link>
      </div>
    </main>
  );
}
