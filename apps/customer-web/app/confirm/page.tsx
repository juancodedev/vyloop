'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

function ConfirmContent() {
  const searchParams = useSearchParams();
  const name = searchParams.get('name') ?? 'Cliente';

  return (
    <div className="page page--centered fade-in">
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>

        <h1 className="title">¡Gracias, {name}!</h1>
        <p className="subtitle">
          Te has registrado correctamente. Ya podés empezar a acumular puntos
          con tus compras en este local.
        </p>

        <Link href="/" className="btn btn--primary" style={{ display: 'block' }}>
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense fallback={<div className="loading">Cargando...</div>}>
      <ConfirmContent />
    </Suspense>
  );
}
