import { Workflow } from 'lucide-react';

/**
 * Flujos, until it is built.
 *
 * The page used to edit workflows as raw JSON against `/v1/automation/workflows`,
 * a route the automation worker does not serve, so every visit ended in a 404.
 * The worker already runs workflows stored in the database; what is missing is
 * the API to manage them and a form a merchant can use. Both are specified in
 * `openspec/changes/workflow-builder`.
 */
export default function WorkflowsPage() {
  return (
    <div className="page fade-in">
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Flujos</h1>
          <p className="dash-subtitle">Mensajes automáticos según lo que hace cada cliente</p>
        </div>
      </div>

      <div className="card">
        <div className="card-body empty-state">
          <Workflow size={40} aria-hidden="true" />
          <span className="badge badge-warning">Próximamente</span>
          <p>
            Muy pronto podrás enviar un aviso automático cuando un cliente se registra, está de
            cumpleaños, canjea un premio, llega a cierta cantidad de puntos o lleva tiempo sin
            venir.
          </p>
          <p className="text-muted">
            Mientras tanto, puedes escribirles desde Campañas y Mensajes.
          </p>
        </div>
      </div>
    </div>
  );
}
