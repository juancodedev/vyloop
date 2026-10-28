/**
 * Why a delivery failed, in words a merchant can act on.
 *
 * The communication worker stores the reason in `message_log.metadata.error`,
 * in English and written for engineers (`workers/communication/src/
 * push-delivery.ts`). The known ones are translated here; anything else is
 * shown as it was stored rather than hidden, because an unknown reason is
 * still more useful than none.
 */
export function describeDeliveryFailure(metadata: unknown): string {
  const error =
    metadata && typeof metadata === 'object' && 'error' in metadata
      ? String((metadata as { error: unknown }).error ?? '').trim()
      : '';

  if (error === '') return 'No quedó registrado el motivo.';

  if (/no longer registered/i.test(error)) {
    return 'El navegador del cliente ya no acepta notificaciones: las desactivó o borró los datos del sitio.';
  }

  const status = /push service returned (\d{3})/i.exec(error);
  if (status) {
    return `El servicio de notificaciones del navegador rechazó el envío (código ${status[1]}).`;
  }

  return `No se pudo entregar: ${error}`;
}
