function StatCard({ label, value, detail }) {
  return (
    <article className="statCard statCardAccent">
      <p className="statLabel">{label}</p>
      <strong className="statValue">{value}</strong>
      {detail ? <span className="statDetail">{detail}</span> : null}
    </article>
  );
}

function SectionHeader({ eyebrow, title, description, badge }) {
  return (
    <div className="panelHeader panelHeaderStack">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {description ? <p className="muted sectionLead">{description}</p> : null}
      </div>
      {badge ? <span className="badge">{badge}</span> : null}
    </div>
  );
}

function SectionNav({ items }) {
  return (
    <nav className="sectionNav" aria-label="Secciones principales">
      {items.map((item) => (
        <a key={item.href} className="ghostButton" href={item.href}>{item.label}</a>
      ))}
    </nav>
  );
}

function ActionCard({ title, description, detail, href, cta }) {
  return (
    <article className="actionCard">
      <strong>{title}</strong>
      <p className="muted">{description}</p>
      {detail ? <p className="actionDetail">{detail}</p> : null}
      {href ? <a className="primaryButton" href={href}>{cta || 'Abrir'}</a> : null}
    </article>
  );
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('es-AR') : '—';
}

function formatRate(value) {
  return `${Number(value || 0) * 100}%`;
}

function buildContactActions(contact) {
  return [
    {
      label: 'Soporte',
      href: contact?.supportUrl || (contact?.supportEmail ? `mailto:${contact.supportEmail}` : null),
      detail: contact?.supportEmail || 'Canal principal para onboarding y soporte',
    },
    {
      label: 'Partnerships',
      href: contact?.partnershipUrl || (contact?.businessEmail ? `mailto:${contact.businessEmail}` : null),
      detail: contact?.businessEmail || 'Licencias, alianzas y demos',
    },
    {
      label: 'Documentación',
      href: contact?.docsUrl || null,
      detail: 'Instalación, bootstrap y operación self-hosted',
    },
    {
      label: 'Discord',
      href: contact?.discordUrl || null,
      detail: 'Canal comunitario para feedback operativo',
    },
    {
      label: 'Telegram',
      href: contact?.telegramUrl || null,
      detail: 'Canal rápido para coordinación entre nodos',
    },
    {
      label: 'Agenda',
      href: contact?.calendlyUrl || null,
      detail: `Respuesta estimada: ${contact?.responseSla || '48h'} · ${contact?.timezone || 'UTC'}`,
    },
  ].filter((item) => item.href);
}

export function Node0Dashboard({ state, references }) {
  const peerTotals = references?.totals || {
    configuredPeers: 0,
    onlinePeers: 0,
    aggregateChainHeight: 0,
    aggregateListings: 0,
    aggregateFeatured: 0,
    aggregateTreasuryBalance: 0,
  };
  const registrations = state.registrations || [];
  const contactActions = buildContactActions(state.contact);
  const sectionItems = [
    { href: '#overview', label: 'Resumen ejecutivo' },
    { href: '#instalacion', label: 'Instalación guiada' },
    { href: '#operacion', label: 'Operación de red' },
    { href: '#catalogo', label: 'Marketplace demo' },
    { href: '#contacto', label: 'Contacto' },
  ];
  const setupActions = [
    {
      title: 'Descarga el bundle self-hosted',
      description: 'Obtén un paquete listo para desplegar con APIs, dashboard, persistence y tooling operativo.',
      detail: 'Ideal para arrancar un nodo propio sin reconstruir la base del proyecto.',
      href: '/api/install/self-hosted',
      cta: 'Descargar bundle',
    },
    {
      title: 'Revisa el flujo de instalación',
      description: 'Sigue un camino corto para configurar variables, storage y arranque en local o Docker.',
      detail: 'Pensado para operadores técnicos, founders e integradores.',
      href: '#instalacion',
      cta: 'Ver pasos',
    },
    {
      title: 'Coordina onboarding con el equipo',
      description: 'Abre un canal para soporte, integraciones, partnerships o revisiones de arquitectura.',
      detail: state.contact?.headline || 'Node0 también funciona como punto de contacto comercial y operativo.',
      href: '#contacto',
      cta: 'Hablar con el equipo',
    },
  ];

  return (
    <>
      <section className="hero heroSplit" id="overview">
        <div>
          <p className="eyebrow">StreamChain · Node 0 público</p>
          <h1>Una home más clara para operar la red, instalar nodos self-hosted y entender el estado público del ecosistema.</h1>
          <p className="heroText">
            Este `node0` funciona como capa pública y liviana: centraliza onboarding, métricas de referencia, contacto con operadores
            y visibilidad de peers, mientras que cada nodo self-hosted mantiene la ejecución completa de wallets, uploads,
            marketplace, moderación y sincronización de estado.
          </p>
          <div className="ctaRow">
            <a className="primaryButton" href="/api/install/self-hosted">Descargar nodo self-hosted</a>
            <a className="ghostButton" href="#instalacion">Explorar instalación</a>
            <a className="ghostButton" href="#operacion">Ver operación de red</a>
          </div>
        </div>
        <div className="heroAsideStack">
          <div className="heroCard heroCardAccent">
            <span className="badge">{state.network.role}</span>
            <ul className="checkList">
              <li>Node0 público y Vercel-friendly</li>
              <li>Kit self-hosted con despliegue guiado</li>
              <li>Registro visible de peers y economía</li>
              <li>Separación clara entre discovery y ejecución</li>
            </ul>
          </div>
          <div className="proofBox compactPanel">
            <strong>Qué resuelve esta portada</strong>
            <p className="muted">
              Presenta la red con una estructura más profesional: visión general, instalación, operación federada,
              preview comercial y canales de contacto en una sola página legible.
            </p>
          </div>
        </div>
      </section>

      <section className="statsGrid statsGridWide">
        <StatCard label="Peers online" value={`${peerTotals.onlinePeers}/${peerTotals.configuredPeers}`} detail="Disponibilidad observada" />
        <StatCard label="Nodos registrados" value={String(registrations.length)} detail="Registro visible en este node0" />
        <StatCard label="Listings de referencia" value={String(peerTotals.aggregateListings)} detail="Catálogo agregado" />
        <StatCard label="Altura agregada" value={String(peerTotals.aggregateChainHeight)} detail="Salud de cadena de peers" />
        <StatCard label="Treasury agregada" value={`${peerTotals.aggregateTreasuryBalance} SCH`} detail="Economía pública de referencia" />
      </section>

      <SectionNav items={sectionItems} />

      <section className="panel" id="acciones">
        <SectionHeader
          eyebrow="Operator journey"
          title="Acciones principales para empezar"
          description="Separamos las tareas clave para que un visitante pueda pasar de discovery a despliegue o soporte sin perderse en la UI."
          badge="Onboarding"
        />
        <div className="actionGrid actionGridThree">
          {setupActions.map((item) => (
            <ActionCard key={item.title} {...item} />
          ))}
        </div>
      </section>

      <section className="panel" id="operacion">
        <SectionHeader
          eyebrow="Live registry"
          title="Registro público de nodos enlazados a este node0"
          description="La tabla resume los peers que pasaron por el flujo de registro. Sirve como bitácora pública ligera incluso si el runtime todavía no logró un crawl completo del peer."
          badge="Public registry"
        />
        <div className="tableWrap">
          <table className="dataTable">
            <thead><tr><th>URL</th><th>Estado</th><th>Modo auth</th><th>Último registro</th><th>Detalle</th></tr></thead>
            <tbody>
              {registrations.length > 0 ? registrations.map((peer) => (
                <tr key={peer.url}>
                  <td className="mono">{peer.url}</td>
                  <td>{peer.status || 'verified'}</td>
                  <td>{peer.authorizationMode || 'public-verified'}</td>
                  <td>{formatDate(peer.verifiedAt || peer.registeredAt)}</td>
                  <td>{peer.publicUrl || peer.lastBlockHash || '—'}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={5}>Todavía no hay registros visibles en este runtime.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="instalacion">
        <SectionHeader
          eyebrow="Instalación guiada"
          title="Despliegue del self-hosted en tres secciones claras"
          description="Ahora el home divide el journey de instalación en pasos concretos: bundle, configuración y arranque."
          badge="Deploy path"
        />
        <div className="actionGrid actionGridThree">
          <ActionCard
            title="1. Descarga el kit"
            description="Baja un `.tar.gz` con el repo listo para operar tu nodo self-hosted con dashboard y APIs incluidas."
            detail="Te ahorra armar manualmente el bootstrap del proyecto."
            href="/api/install/self-hosted"
            cta="Descargar bundle"
          />
          <ActionCard
            title="2. Configura tu entorno"
            description="Define modo self-hosted, storage persistente, claves y fees para adaptar la operación a tu infraestructura."
            detail="Variables base: `STREAMCHAIN_NODE_MODE=self-hosted` y `STREAMCHAIN_STORAGE_DIR=./storage`."
          />
          <ActionCard
            title="3. Arranca el nodo"
            description="Levántalo con Docker o Node.js y habilita wallets, uploads, marketplace y validación humana desde la misma UI."
            detail="Ejemplos: `docker compose up --build` o `npm install && npm run dev`."
          />
        </div>
      </section>

      <section className="panel" id="red">
        <SectionHeader
          eyebrow="Read-only federation"
          title="Cómo node0 construye una vista pública de la red"
          description="Node0 consulta exports públicos de peers configurados, agrega el estado visible y mantiene una referencia de red sin asumir autoridad de escritura."
          badge="Federation overview"
        />
        <div className="twoColumns">
          <div className="proofBox">
            <strong>Snapshot agregado</strong>
            <ul className="bulletList compactList">
              <li>Peers configurados: {peerTotals.configuredPeers}</li>
              <li>Peers online: {peerTotals.onlinePeers}</li>
              <li>Chain height agregada: {peerTotals.aggregateChainHeight}</li>
              <li>Listings agregados: {peerTotals.aggregateListings}</li>
              <li>Featured agregados: {peerTotals.aggregateFeatured}</li>
              <li>Treasury agregada: {peerTotals.aggregateTreasuryBalance} SCH</li>
            </ul>
          </div>
          <div className="proofBox">
            <strong>Configuración esperada</strong>
            <code>STREAMCHAIN_NODE0_PEERS=http://peer-a:3000,http://peer-b:3000</code>
            <p className="muted">Si un peer cae, `node0` lo marca offline y sigue respondiendo con el resto del agregado.</p>
          </div>
        </div>
        <div className="tableWrap">
          <table className="dataTable">
            <thead><tr><th>Peer</th><th>Estado</th><th>Chain</th><th>Wallets</th><th>Listings</th><th>Treasury</th><th>Última referencia</th></tr></thead>
            <tbody>
              {(references?.peers || []).map((peer) => (
                <tr key={peer.url}>
                  <td className="mono">{peer.url}</td>
                  <td>{peer.status}</td>
                  <td>{peer.chainHeight}</td>
                  <td>{peer.walletCount}</td>
                  <td>{peer.listingCount}</td>
                  <td>{peer.treasuryBalance} SCH</td>
                  <td>{formatDate(peer.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="catalogo">
        <SectionHeader
          eyebrow="Economics + marketplace"
          title="Qué puede monetizar un operador con un nodo self-hosted"
          description="La home ahora presenta la propuesta comercial del stack: fees del nodo, royalties y catálogo aprobado como una historia más comprensible para producto, negocio y operaciones."
          badge="Commercial view"
        />
        <div className="twoColumns">
          <div className="proofBox">
            <strong>Split económico de referencia</strong>
            <ul className="bulletList compactList">
              <li>Fee por transferencia: {formatRate(state.economics.transactionFeeRate)}</li>
              <li>Fee marketplace: {formatRate(state.economics.marketplaceFeeRate)}</li>
              <li>Royalty creator: {formatRate(state.economics.creatorRoyaltyRate)}</li>
              <li>Tesorería demo acumulada: {state.economics.treasuryBalance} SCH</li>
              <li>Volumen marketplace demo: {state.metrics?.marketplaceVolume ?? 0} SCH</li>
              <li>Reventas demo cerradas: {state.metrics?.resaleSales ?? 0}</li>
            </ul>
          </div>
          <div className="proofBox">
            <strong>Lectura ejecutiva</strong>
            <ul className="bulletList compactList">
              <li>Las transferencias simples financian la operación del nodo.</li>
              <li>Las compras reparten ingresos entre seller, nodo y creador.</li>
              <li>El ownership cambia tras cada compra y habilita mercado secundario real.</li>
              <li>La propuesta comercial se entiende sin entrar al panel operativo completo.</li>
            </ul>
          </div>
        </div>
        <div className="actionGrid actionGridTwo">
          {(state.listings || []).map((listing) => (
            <article className="actionCard" key={listing.id}>
              <strong>{listing.title}</strong>
              <p className="muted">{listing.description || 'Activo aprobado y listo para monetización.'}</p>
              <ul className="bulletList compactList">
                <li>Seller: {listing.sellerName}</li>
                <li>Creator: {listing.creatorName}</li>
                <li>Precio: {listing.amount} {listing.currency}</li>
                <li>Ventas demo: {listing.purchaseCount}</li>
                <li>Última compra: {formatDate(listing.lastPurchasedAt)}</li>
              </ul>
              <code>{listing.videoProof}</code>
              <a href={listing.mediaUrl} target="_blank" rel="noreferrer">Ver media aprobada</a>
            </article>
          ))}
        </div>
      </section>

      <section className="panel" id="contacto">
        <SectionHeader
          eyebrow="Contacto"
          title="Canales abiertos para soporte, partnerships y feedback"
          description={state.contact?.headline || 'Node0 expone vías públicas para que operadores, creadores e integradores pidan ayuda o abran conversaciones comerciales.'}
          badge="Contact surface"
        />
        <div className="actionGrid actionGridThree">
          {contactActions.map((action) => (
            <ActionCard
              key={action.label}
              title={action.label}
              description={action.detail}
              href={action.href}
              cta="Abrir canal"
            />
          ))}
        </div>
      </section>

      <section className="panel">
        <SectionHeader
          eyebrow="Roadmap"
          title="Alcance del proyecto y próximos hitos"
          description="Dejamos visible el roadmap para que la portada también sirva como documento ejecutivo del estado del producto."
          badge="Objetivos"
        />
        <div className="timeline">
          {(state.roadmap || []).map((item) => (
            <article className="timelineItem" key={item.title}>
              <div>
                <p className="timelineHash">{item.status}</p>
                <h3>{item.title}</h3>
                <p className="muted">{item.summary}</p>
              </div>
              <div className="timelineMeta">
                <span>{item.status}</span>
                <span>Project scope</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
