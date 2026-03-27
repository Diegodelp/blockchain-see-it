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

function StatCard({ label, value, detail }) {
  return (
    <article className="statCard statCardAccent">
      <p className="statLabel">{label}</p>
      <strong className="statValue">{value}</strong>
      {detail ? <span className="statDetail">{detail}</span> : null}
    </article>
  );
}

function PageCard({ title, description, href, detail }) {
  return (
    <article className="actionCard">
      <strong>{title}</strong>
      <p className="muted">{description}</p>
      {detail ? <p className="actionDetail">{detail}</p> : null}
      <a className="primaryButton" href={href}>Abrir página</a>
    </article>
  );
}

function ContactCard({ label, href, detail }) {
  const external = href.startsWith('http');
  return (
    <article className="actionCard">
      <strong>{label}</strong>
      <p className="muted">{detail}</p>
      <a className="primaryButton" href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
        Abrir canal
      </a>
    </article>
  );
}

function Node0Shell({ title, description, badge, children }) {
  return (
    <div className="node0Site chainExperience chainExperienceNode0">
      <div className="chainBackdrop" aria-hidden="true">
        <span className="chainOrb chainOrbA" />
        <span className="chainOrb chainOrbB" />
        <span className="chainGrid" />
      </div>
      <header className="minimalHeader">
        <a className="minimalBrand" href="/">StreamChain</a>
        <nav className="minimalNav" aria-label="Node0 primary">
          <a href="/node0">Home</a>
          <a href="/node0/install">Install</a>
          <a href="/node0/network">Network</a>
          <a href="/node0/contact">Contact</a>
        </nav>
      </header>
      <section className="hero heroSplit node0Hero">
        <div>
          <p className="eyebrow">StreamChain · Node0</p>
          <h1>{title}</h1>
          <p className="heroText">{description}</p>
          <div className="ctaRow">
            <a className="primaryButton" href="/">Inicio</a>
            <a className="ghostButton" href="/node0/install">Instalación</a>
            <a className="ghostButton" href="/node0/network">Network</a>
            <a className="ghostButton" href="/node0/contact">Contacto</a>
          </div>
        </div>
        <div className="heroAsideStack">
          <div className="heroCard heroCardAccent">
            <span className="badge">{badge || 'Public control plane'}</span>
            <ul className="checkList">
              <li>Discovery público de peers</li>
              <li>Onboarding de operadores</li>
              <li>Instalación guiada del self-hosted</li>
              <li>Surface comercial y técnica unificada</li>
            </ul>
          </div>
          <div className="heroSignalGrid">
            <span className="servicePill">Network visibility</span>
            <span className="servicePill">Install journey</span>
            <span className="servicePill">Support channels</span>
          </div>
        </div>
      </section>
      {children}
    </div>
  );
}

export function Node0LandingPage({ state, references }) {
  const peerTotals = references?.totals || {
    configuredPeers: 0,
    onlinePeers: 0,
    aggregateChainHeight: 0,
    aggregateListings: 0,
    aggregateFeatured: 0,
    aggregateTreasuryBalance: 0,
  };
  const registrations = state.registrations || [];
  const pageCards = [
    {
      title: 'Instalación self-hosted',
      description: 'Una página dedicada para descargar el bundle, configurar variables y levantar un nodo con criterio operativo.',
      detail: 'Pensada para equipos técnicos y operadores que necesitan un paso a paso claro.',
      href: '/node0/install',
    },
    {
      title: 'Network & peers',
      description: 'Vista ejecutiva de peers, estado de red y operación read-only del node0.',
      detail: 'Útil para revisar salud de la red sin entrar al full node.',
      href: '/node0/network',
    },
    {
      title: 'Contacto y go-to-market',
      description: 'Canales públicos para soporte, partnerships, demos y onboarding comercial.',
      detail: 'Un único hub para soporte, ventas técnicas y demos.',
      href: '/node0/contact',
    },
  ];

  return (
    <Node0Shell
      title="Build, scale and connect your StreamChain network from one public control plane."
      description="Node0 centraliza descubrimiento de peers, instalación self-hosted y contacto técnico/comercial en una experiencia clara por secciones."
      badge={state.network?.role || 'node0'}
    >
      <section className="statsGrid statsGridWide">
        <StatCard label="Peers online" value={`${peerTotals.onlinePeers}/${peerTotals.configuredPeers}`} detail="Disponibilidad observada" />
        <StatCard label="Nodos registrados" value={String(registrations.length)} detail="Registro visible" />
        <StatCard label="Listings agregados" value={String(peerTotals.aggregateListings)} detail="Catálogo público" />
        <StatCard label="Altura agregada" value={String(peerTotals.aggregateChainHeight)} detail="Referencia de cadena" />
        <StatCard label="Treasury agregada" value={`${peerTotals.aggregateTreasuryBalance} SCH`} detail="Economía observada" />
      </section>
      <section className="mediaStrip">
        <figure className="mediaCard">
          <img loading="lazy" src="https://images.unsplash.com/photo-1639762681485-074b7f938ba0?auto=format&fit=crop&w=1200&q=80" alt="Blockchain neon network art" />
          <figcaption>Decentralized network surface</figcaption>
        </figure>
        <figure className="mediaCard">
          <img loading="lazy" src="https://images.unsplash.com/photo-1642052502485-2f7f7620b3ab?auto=format&fit=crop&w=1200&q=80" alt="Server racks in datacenter" />
          <figcaption>Self-hosted infrastructure ready</figcaption>
        </figure>
        <figure className="mediaCard">
          <img loading="lazy" src="https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80" alt="Circuit board macro view" />
          <figcaption>Security and integrity by design</figcaption>
        </figure>
      </section>

      <section className="panel sectionBand sectionBandInstall">
        <SectionHeader
          eyebrow="Public navigation"
          title="Servicios principales"
          description="Tres rutas para operar la plataforma: instalar nodos, monitorear la red y abrir canales de soporte."
          badge="3 rutas"
        />
        <div className="actionGrid actionGridThree">
          {pageCards.map((card) => <PageCard key={card.title} {...card} />)}
        </div>
      </section>

      <section className="panel sectionBand sectionBandNetwork">
        <SectionHeader
          eyebrow="Executive overview"
          title="Qué resuelve Node0"
          description="El plano público coordina visibilidad de red, onboarding técnico y contexto económico sin exponer operaciones de escritura."
          badge="Overview"
        />
        <div className="twoColumns">
          <div className="proofBox">
            <strong>Control plane público</strong>
            <ul className="bulletList compactList">
              <li>Referencias públicas de peers y health.</li>
              <li>Journey de onboarding self-hosted.</li>
              <li>Punto central para demos y partnerships.</li>
              <li>Catálogo y economía visibles de forma liviana.</li>
            </ul>
          </div>
          <div className="proofBox">
            <strong>Economía observada</strong>
            <ul className="bulletList compactList">
              <li>Fee por transferencia: {formatRate(state.economics?.transactionFeeRate)}</li>
              <li>Fee marketplace: {formatRate(state.economics?.marketplaceFeeRate)}</li>
              <li>Royalty creator: {formatRate(state.economics?.creatorRoyaltyRate)}</li>
              <li>Featured agregados: {peerTotals.aggregateFeatured}</li>
            </ul>
          </div>
        </div>
      </section>
    </Node0Shell>
  );
}

export function Node0InstallPage({ state }) {
  return (
    <Node0Shell
      title="Instala tu nodo self-hosted con una experiencia mucho más clara."
      description="Esta página concentra solo el journey de despliegue: qué descargar, cómo configurar el entorno y cómo levantar el nodo para tener wallets, moderación, marketplace y federation operativos."
      badge="Install journey"
    >
      <section className="panel">
        <SectionHeader eyebrow="Deployment" title="Instalación guiada" description="Una sola página pensada para el operador técnico, con el bundle, la configuración mínima y los comandos de arranque principales." badge="3 steps" />
        <div className="actionGrid actionGridThree">
          <PageCard title="1. Descarga el bundle" description="Obtén el paquete base del self-hosted listo para desplegar." detail="Incluye app, APIs, scripts y layout operacional." href="/api/install/self-hosted" />
          <PageCard title="2. Configura el entorno" description="Define modo, storage, claves y fees antes de arrancar." detail="Variables base: `STREAMCHAIN_NODE_MODE=self-hosted` y `STREAMCHAIN_STORAGE_DIR=./storage`." href="/node0/install" />
          <PageCard title="3. Arranca el servicio" description="Levanta el nodo con Docker o Node.js y habilita la experiencia completa." detail="Ejemplos: `docker compose up --build` y `npm install && npm run dev`." href="/node0/install" />
        </div>
        <div className="twoColumns">
          <div className="proofBox">
            <strong>Variables de referencia</strong>
            <code>STREAMCHAIN_NODE_MODE=self-hosted</code>
            <code>STREAMCHAIN_STORAGE_DIR=./storage</code>
            <code>STREAMCHAIN_PUBLIC_URL=https://tu-dominio.example.com</code>
          </div>
          <div className="proofBox">
            <strong>Qué obtienes</strong>
            <ul className="bulletList compactList">
              <li>Wallets y transferencias.</li>
              <li>Uploads, moderación y appeals.</li>
              <li>Marketplace con royalty y resale.</li>
              <li>Federation y registro contra node0.</li>
            </ul>
          </div>
        </div>
      </section>
    </Node0Shell>
  );
}

export function Node0NetworkPage({ state, references }) {
  const peerTotals = references?.totals || {
    configuredPeers: 0,
    onlinePeers: 0,
    aggregateChainHeight: 0,
    aggregateListings: 0,
    aggregateFeatured: 0,
    aggregateTreasuryBalance: 0,
  };
  return (
    <Node0Shell
      title="Monitorea la red desde una página dedicada a peers, health y referencias públicas."
      description="Esta vista separa la lectura operacional de la landing para que node0 funcione más como un control plane público y menos como una página genérica con todo mezclado."
      badge="Network view"
    >
      <section className="statsGrid statsGridWide">
        <StatCard label="Peers configurados" value={String(peerTotals.configuredPeers)} detail="Descubiertos por configuración" />
        <StatCard label="Peers online" value={String(peerTotals.onlinePeers)} detail="Disponibles ahora" />
        <StatCard label="Chain agregada" value={String(peerTotals.aggregateChainHeight)} detail="Altura de referencia" />
        <StatCard label="Listings" value={String(peerTotals.aggregateListings)} detail="Inventario público" />
      </section>
      <section className="panel">
        <SectionHeader eyebrow="Federation" title="Estado de red y referencias de peers" description="Node0 consulta exports públicos y compone una vista read-only para operadores, partners y equipos internos." badge="Read-only federation" />
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
        <div className="proofBox">
          <strong>Variable de configuración</strong>
          <code>STREAMCHAIN_NODE0_PEERS=http://peer-a:3000,http://peer-b:3000</code>
        </div>
      </section>
      <section className="panel">
        <SectionHeader eyebrow="Marketplace pulse" title="Resumen económico visible" description="Un dashboard público para mostrar el pulso comercial del ecosistema sin exponer operaciones de escritura." badge="Public analytics" />
        <div className="twoColumns">
          <div className="proofBox">
            <ul className="bulletList compactList">
              <li>Treasury agregada: {peerTotals.aggregateTreasuryBalance} SCH</li>
              <li>Featured agregados: {peerTotals.aggregateFeatured}</li>
              <li>Volumen demo: {state.metrics?.marketplaceVolume ?? 0} SCH</li>
            </ul>
          </div>
          <div className="proofBox">
            <ul className="bulletList compactList">
              <li>Transaction fee: {formatRate(state.economics?.transactionFeeRate)}</li>
              <li>Marketplace fee: {formatRate(state.economics?.marketplaceFeeRate)}</li>
              <li>Royalty: {formatRate(state.economics?.creatorRoyaltyRate)}</li>
            </ul>
          </div>
        </div>
      </section>
    </Node0Shell>
  );
}

export function Node0ContactPage({ state }) {
  const actions = buildContactActions(state.contact);
  return (
    <Node0Shell
      title="Una página de contacto y partnerships que sí se siente como producto."
      description="Separamos soporte, documentación, partnerships y canales comunitarios para que node0 también sirva como una superficie comercial y de onboarding seria."
      badge="Contact hub"
    >
      <section className="panel">
        <SectionHeader eyebrow="Go to market" title="Canales públicos del proyecto" description={state.contact?.headline || 'Node0 expone vías públicas para soporte, demos, feedback e integraciones.'} badge="Contact surface" />
        <div className="actionGrid actionGridThree">
          {actions.map((action) => <ContactCard key={action.label} {...action} />)}
        </div>
      </section>
    </Node0Shell>
  );
}
