import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="not-found">
      <h1>Página no encontrada</h1>
      <p>Lo sentimos, la página que buscas no existe.</p>
      <Link href="/">Volver al inicio</Link>
    </main>
  );
}
