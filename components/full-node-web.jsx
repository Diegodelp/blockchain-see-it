'use client';

import { useEffect, useState } from 'react';
import { ChainBackgroundThree } from './chain-background-three';

const GENESIS_NODE0_URL = 'https://blockchain-see-it.vercel.app';

const emptyState = {
  network: null,
  manifest: null,
  economics: null,
  chain: [],
  featuredVideos: [],
  rejectedVideos: [],
  wallets: [],
  pendingVideos: [],
  transactions: [],
  peers: [],
  listings: [],
  peerRegistry: [],
  metrics: null,
};

function SectionTitle({ eyebrow, title, badge, endpoint }) {
  return (
    <div className="panelHeader">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <div className="panelBadges">
        {endpoint ? <span className="endpointBadge">{endpoint}</span> : null}
        {badge ? <span className="badge">{badge}</span> : null}
      </div>
    </div>
  );
}

function QuickNav() {
  const items = [
    ['operating-model', 'Modelo'],
    ['networking', 'Networking'],
    ['wallets', 'Wallets'],
    ['transactions', 'Pagos'],
    ['publishing', 'Publishing'],
    ['validation', 'Moderación'],
    ['marketplace', 'Marketplace'],
    ['checkout', 'Checkout'],
    ['results', 'Resultados'],
    ['explorer', 'Explorer'],
  ];

  return (
    <nav className="sectionNav" aria-label="Secciones del full node">
      {items.map(([id, label]) => (
        <a key={id} className="ghostButton" href={`#${id}`}>{label}</a>
      ))}
    </nav>
  );
}

function ActionCard({ title, description, detail, href, ctaLabel = 'Ir a la sección' }) {
  return (
    <article className="actionCard">
      <strong>{title}</strong>
      <p className="muted">{description}</p>
      {detail ? <p className="actionDetail">{detail}</p> : null}
      <a className="ghostButton" href={href}>{ctaLabel}</a>
    </article>
  );
}

function formatDate(value) {
  if (!value) {
    return '—';
  }

  return new Date(value).toLocaleString('es-AR');
}

function formatRate(value) {
  return `${Number(value || 0) * 100}%`;
}

function formatNode0RegistrationStatus(registration) {
  if (!registration) {
    return 'Todavía no enviado';
  }

  if (registration.status === 'registered') {
    return 'Registrado en node0';
  }

  if (registration.status === 'failed') {
    return 'Registro rechazado';
  }

  return registration.status;
}

export function FullNodeWeb({ initialState }) {
  const [state, setState] = useState(initialState ?? emptyState);
  const [message, setMessage] = useState('');
  const [walletResult, setWalletResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [walletForm, setWalletForm] = useState({ username: '' });
  const [txForm, setTxForm] = useState({ senderAddress: '', senderSecret: '', receiverAddress: '', amount: '' });
  const [mediaForm, setMediaForm] = useState({ uploaderAddress: '', uploaderSecret: '', title: '', type: 'video', externalUrl: '' });
  const [validatorForm, setValidatorForm] = useState({
    pendingId: '',
    validatorAddress: '',
    validatorSecret: '',
    authenticity: 'approve',
    manipulated: false,
    duplicate: false,
    notes: '',
  });
  const [peerForm, setPeerForm] = useState({ url: '' });
  const [node0LinkForm, setNode0LinkForm] = useState({ node0Url: GENESIS_NODE0_URL, registrationSecret: '', publicUrl: '' });
  const [listingForm, setListingForm] = useState({ sellerAddress: '', sellerSecret: '', videoProof: '', price: '', description: '' });
  const [purchaseForm, setPurchaseForm] = useState({ listingId: '', buyerAddress: '', buyerSecret: '' });

  async function refreshState() {
    const response = await fetch('/api/node/state', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'No se pudo cargar el estado del nodo.');
    }
    setState(payload);
    return payload;
  }

  useEffect(() => {
    refreshState().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const origin = window.location.origin;
    const looksPublic = !origin.includes('localhost') && !origin.includes('127.0.0.1');
    if (looksPublic) {
      setNode0LinkForm((current) => ({
        ...current,
        publicUrl: current.publicUrl || origin,
      }));
    }
  }, []);

  async function handleJsonSubmit(url, body, onSuccess, successMessage = 'Operación completada.') {
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'La operación falló.');
      }
      if (payload.state) {
        setState(payload.state);
      } else {
        setState(payload);
      }
      onSuccess?.(payload);
      setMessage(successMessage);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleWalletCreate(event) {
    event.preventDefault();
    await handleJsonSubmit('/api/node/wallets', walletForm, (payload) => {
      setWalletResult(payload);
      setWalletForm({ username: '' });
    }, 'Wallet creada correctamente.');
  }

  async function handleTransaction(event) {
    event.preventDefault();
    await handleJsonSubmit('/api/node/transactions', txForm, () => {
      setTxForm({ senderAddress: '', senderSecret: '', receiverAddress: '', amount: '' });
    }, 'Transferencia registrada on-chain con fee del nodo.');
  }

  async function handleMine(event) {
    event.preventDefault();
    await handleJsonSubmit('/api/node/mine', validatorForm, () => {
      setValidatorForm({
        pendingId: '',
        validatorAddress: '',
        validatorSecret: '',
        authenticity: 'approve',
        manipulated: false,
        duplicate: false,
        notes: '',
      });
    }, 'Validación registrada en la cadena.');
  }

  async function handleMediaUpload(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const formData = new FormData(event.currentTarget);
      const response = await fetch('/api/node/media', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'No se pudo enviar el media.');
      }
      setState(payload);
      setMediaForm({ uploaderAddress: '', uploaderSecret: '', title: '', type: 'video', externalUrl: '' });
      event.currentTarget.reset();
      setMessage('Contenido enviado a pending.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateListing(event) {
    event.preventDefault();
    await handleJsonSubmit('/api/node/listings', listingForm, () => {
      setListingForm({ sellerAddress: '', sellerSecret: '', videoProof: '', price: '', description: '' });
    }, 'Listing publicado en el marketplace.');
  }

  async function handlePurchase(event) {
    event.preventDefault();
    await handleJsonSubmit('/api/node/purchases', purchaseForm, () => {
      setPurchaseForm({ listingId: '', buyerAddress: '', buyerSecret: '' });
    }, 'Compra liquidada con reparto seller / royalty / fee y registrada en la cadena.');
  }

  async function handlePeerRegister(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch('/api/node/peers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(peerForm),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'No se pudo registrar el peer.');
      }
      setState(payload.state);
      setPeerForm({ url: '' });
      setMessage(payload.message || 'Peer agregado.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleNode0Link(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch('/api/node/link-node0', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(node0LinkForm),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'No se pudo registrar este nodo en node0.');
      }
      setState(payload.state);
      setMessage(payload.message || 'Node0 aceptó el registro.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  const peerRegistry = state.peerRegistry || [];
  const linkedPeers = peerRegistry.filter((peer) => peer.linkStatus === 'linked').length;
  const syncedPeers = peerRegistry.filter((peer) => peer.syncStatus === 'synchronized').length;
  const node0Registration = state.network?.node0Registration || null;
  const operatorSections = [
    {
      title: 'Modelo operativo',
      description: 'Entiende fees, tesorería, peers y el registro con node0 antes de ejecutar acciones.',
      detail: 'Ideal para onboarding técnico y lectura ejecutiva.',
      href: '#operating-model',
      ctaLabel: 'Ver modelo',
    },
    {
      title: 'Operar wallets y pagos',
      description: 'Crea wallets, mueve SCH y prueba la economía del nodo desde el navegador.',
      detail: 'Secciones: wallets y transferencias.',
      href: '#wallets',
      ctaLabel: 'Crear y mover fondos',
    },
    {
      title: 'Publicar y moderar media',
      description: 'Sube contenido, valida casos pendientes y revisa aprobados/rechazados.',
      detail: 'Secciones: publishing, validation y results.',
      href: '#publishing',
      ctaLabel: 'Subir y validar media',
    },
    {
      title: 'Monetizar el catálogo',
      description: 'Publica listings, liquida compras y audita ownership en el explorer.',
      detail: 'Secciones: marketplace, checkout y explorer.',
      href: '#marketplace',
      ctaLabel: 'Abrir flujo de venta',
    },
  ];
  const workspaceNav = [
    ['operating-model', 'Overview'],
    ['networking', 'Network'],
    ['wallets', 'Wallets'],
    ['transactions', 'Payments'],
    ['publishing', 'Publishing'],
    ['validation', 'Moderation'],
    ['marketplace', 'Marketplace'],
    ['checkout', 'Checkout'],
    ['results', 'Library'],
    ['explorer', 'Explorer'],
  ];

  return (
    <div className="appShell chainExperience chainExperienceSelfHosted">
      <ChainBackgroundThree />
      <aside className="appSidebar">
        <div className="appSidebarBrand">
          <p className="eyebrow">StreamChain OS</p>
          <strong>Self-hosted workspace</strong>
          <p className="muted">Consola operativa para desplegar, validar contenido y monetizar en una red blockchain-style.</p>
        </div>
        <nav className="appSidebarNav" aria-label="Navegación del workspace">
          {workspaceNav.map(([id, label]) => (
            <a key={id} className="appSidebarLink" href={`#${id}`}>{label}</a>
          ))}
        </nav>
        <div className="appSidebarCard">
          <span className="badge">{state.network?.role ?? 'self-hosted'}</span>
          <ul className="bulletList compactList">
            <li>Wallets: {state.wallets.length}</li>
            <li>Pendings: {state.pendingVideos.length}</li>
            <li>Listings: {state.listings.length}</li>
            <li>Peers sync: {state.peers?.length ?? 0}</li>
          </ul>
        </div>
      </aside>
      <div className="appContent">
        <header className="minimalHeader">
          <a className="minimalBrand" href="/">StreamChain</a>
          <nav className="minimalNav" aria-label="Self-hosted primary">
            <a href="#operating-model">Overview</a>
            <a href="#networking">Network</a>
            <a href="#publishing">Publishing</a>
            <a href="#marketplace">Market</a>
          </nav>
        </header>
        <header className="appTopbar">
          <div>
            <p className="eyebrow">Operator console</p>
            <h1>Self-hosted command center</h1>
          </div>
          <span className="badge">Online workflow</span>
        </header>
      <section className="hero heroSplit">
        <div>
          <p className="eyebrow">Self-hosted full node</p>
          <h1>Operate your own blockchain media node with production-ready flows.</h1>
          <p className="heroText">
            Publica contenido, modera validaciones, sincroniza peers y liquida compras desde una sola interfaz con secciones especializadas.
          </p>
          <div className="ctaRow">
            <a className="primaryButton" href="#wallets">Start with wallets</a>
            <a className="ghostButton" href="#marketplace">Open marketplace flow</a>
          </div>
        </div>
        <div className="heroAsideStack">
          <div className="heroCard heroCardAccent">
            <span className="badge">{state.network?.role ?? 'self-hosted'}</span>
            <ul className="checkList">
              <li>Persistencia local separada del node0</li>
              <li>Wallets, uploads y moderación desde web</li>
              <li>Monetización con fees, royalties y resale</li>
              <li>Sincronización y registro con node0</li>
            </ul>
          </div>
          <div className="proofBox compactPanel">
            <strong>Service architecture</strong>
            <p className="muted">
              Cada sección representa un dominio operativo: network, treasury, publishing, moderation y commerce.
            </p>
          </div>
          <div className="heroSignalGrid">
            <span className="servicePill">Wallet economy</span>
            <span className="servicePill">Content validation</span>
            <span className="servicePill">Marketplace settlement</span>
          </div>
        </div>
      </section>

      <section className="statsGrid statsGridWide">
        <article className="statCard"><p className="statLabel">Wallets</p><strong className="statValue">{state.wallets.length}</strong></article>
        <article className="statCard"><p className="statLabel">Pendings</p><strong className="statValue">{state.pendingVideos.length}</strong></article>
        <article className="statCard"><p className="statLabel">Listings</p><strong className="statValue">{state.listings.length}</strong></article>
        <article className="statCard"><p className="statLabel">TX</p><strong className="statValue">{state.transactions.length}</strong></article>
        <article className="statCard"><p className="statLabel">Treasury</p><strong className="statValue">{state.economics?.treasuryBalance ?? 0} SCH</strong></article>
        <article className="statCard"><p className="statLabel">Volumen market</p><strong className="statValue">{state.metrics?.marketplaceVolume ?? 0} SCH</strong></article>
        <article className="statCard"><p className="statLabel">Reventas</p><strong className="statValue">{state.metrics?.resaleSales ?? 0}</strong></article>
        <article className="statCard"><p className="statLabel">Peers sync</p><strong className="statValue">{state.peers?.length ?? 0}</strong></article>
        <article className="statCard"><p className="statLabel">Peers linkeados</p><strong className="statValue">{linkedPeers}</strong></article>
        <article className="statCard"><p className="statLabel">Peers sincronizados</p><strong className="statValue">{syncedPeers}</strong></article>
      </section>
      <section className="mediaStrip">
        <figure className="mediaCard">
          <img loading="lazy" src="https://images.unsplash.com/photo-1639322537228-f710d846310a?auto=format&fit=crop&w=1200&q=80" alt="Crypto themed abstract illustration" />
          <figcaption>Operator cockpit for blockchain operations</figcaption>
        </figure>
        <figure className="mediaCard">
          <img loading="lazy" src="/blockchain-grid.svg" alt="Digital blockchain network visual" />
          <figcaption>Wallet and settlement workflows</figcaption>
        </figure>
        <figure className="mediaCard">
          <img loading="lazy" src="https://images.unsplash.com/photo-1518186285589-2f7649de83e0?auto=format&fit=crop&w=1200&q=80" alt="Cloud infrastructure lights" />
          <figcaption>Scalable self-hosted infrastructure</figcaption>
        </figure>
      </section>

      <QuickNav />

      <section className="panel sectionBand sectionBandInstall" id="operating-model">
        <SectionTitle eyebrow="Operator sections" title="Mapa de acciones del nodo self-hosted" badge="Modular UI" endpoint="Home sections" />
        <p className="muted">Acceso rápido a cada capability del nodo para operar sin fricción entre onboarding técnico y ejecución diaria.</p>
        <div className="actionGrid actionGridTwo">
          {operatorSections.map((section) => (
            <ActionCard key={section.title} {...section} />
          ))}
        </div>
      </section>

      {message ? <section className="panel panelNotice"><p className="muted">{message}</p></section> : null}

      <section className="panel sectionBand sectionBandNetwork" id="economics">
        <SectionTitle eyebrow="Economics" title="Parámetros económicos del nodo" badge="Roadmap cerrado" endpoint="ENV + /api/node/state" />
        <div className="twoColumns">
          <div className="proofBox">
            <strong>Configuración actual</strong>
            <ul className="bulletList compactList">
              <li>Fee por transferencia: {formatRate(state.economics?.transactionFeeRate)}</li>
              <li>Fee marketplace: {formatRate(state.economics?.marketplaceFeeRate)}</li>
              <li>Royalty creator: {formatRate(state.economics?.creatorRoyaltyRate)}</li>
              <li>Tesorería acumulada: {state.economics?.treasuryBalance ?? 0} SCH</li>
            </ul>
          </div>
          <div className="proofBox">
            <strong>Métricas históricas</strong>
            <ul className="bulletList compactList">
              <li>Volumen marketplace: {state.metrics?.marketplaceVolume ?? 0} SCH</li>
              <li>Primary sales: {state.metrics?.primarySales ?? 0}</li>
              <li>Reventas cerradas: {state.metrics?.resaleSales ?? 0}</li>
              <li>Royalties pagados: {state.metrics?.royaltiesPaid ?? 0} SCH</li>
              <li>Fee revenue total: {state.metrics?.totalFeeRevenue ?? 0} SCH</li>
              <li>Transfers de ownership: {state.metrics?.ownershipTransfers ?? 0}</li>
            </ul>
          </div>
        </div>
        <div className="twoColumns">
          <div className="proofBox">
            <strong>Variables para ajustar esto por nodo</strong>
            <code>STREAMCHAIN_TX_FEE_RATE</code>
            <code>STREAMCHAIN_MARKETPLACE_FEE_RATE</code>
            <code>STREAMCHAIN_CREATOR_ROYALTY_RATE</code>
            <p className="muted">Cada nodo self-hosted puede definir sus porcentajes desde variables de entorno y quedan reflejados en el estado público.</p>
          </div>
          <div className="proofBox">
            <strong>Qué cerró el paso 4</strong>
            <ul className="bulletList compactList">
              <li>Scoring histórico por wallet con reputación compuesta.</li>
              <li>Analytics públicos de mercado y fees del nodo.</li>
              <li>Reventas reales: cada compra transfiere ownership y cierra el listing vendido.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="panel sectionBand sectionBandNetwork" id="networking">
        <SectionTitle eyebrow="Networking" title="Peers y sincronización" badge="Multi-node" endpoint="/api/node/peers + /api/node/sync" />
        <p className="muted">
          Si pegas una URL de Vercel/node0 pública quedará <strong>linkeada</strong> como referencia read-only. Solo un nodo
          self-hosted que exponga <code>/api/node/export</code> aparecerá además como <strong>sincronizado</strong>.
        </p>
        <p className="muted">
          Importante: agregar aquí la URL de Vercel <strong>no hace que node0 te descubra a ti</strong>. Para que el node0 público vea tu
          nodo self-hosted, debes configurar en Vercel <code>STREAMCHAIN_NODE0_PEERS=https://tu-self-hosted.example.com</code>.
        </p>
        <p className="muted">
          También puedes pedir auto-registro contra un `node0` que exponga <code>POST /api/node0/register</code> con un secret compartido y una
          URL pública (por ejemplo un túnel ngrok) para que el `node0` verifique <code>/api/node/export</code> antes de aceptarte.
        </p>
        <p className="muted">
          Si defines <code>STREAMCHAIN_PUBLIC_URL</code>, este nodo también intentará anunciarse automáticamente a otros peers self-hosted y a los
          `node0` listados en <code>STREAMCHAIN_NODE0_REGISTRATION_TARGETS</code>.
        </p>
        <div className="twoColumns">
          <div className="proofBox">
            <strong>Paso a paso · si este nodo ya tiene URL pública</strong>
            <ol className="bulletList compactList">
              <li>Deja la URL de `node0 genesis` como viene por defecto.</li>
              <li>Verifica que “URL pública de este nodo” tenga tu dominio o tu deploy de Vercel.</li>
              <li>Si `node0` usa secret, pégalo. Si no, déjalo vacío.</li>
              <li>Haz click en <em>Conectar con node0 genesis</em>.</li>
            </ol>
          </div>
          <div className="proofBox">
            <strong>Paso a paso · si corres en localhost</strong>
            <ol className="bulletList compactList">
              <li>Abre un túnel público como ngrok o cloudflared.</li>
              <li>Pega esa URL pública en el campo “URL pública de este nodo”.</li>
              <li>Deja el `node0 genesis` por defecto.</li>
              <li>Haz click en <em>Conectar con node0 genesis</em>.</li>
            </ol>
          </div>
        </div>
        <div className="proofBox">
          <strong>Qué pasa cuando haces click</strong>
          <ol className="bulletList compactList">
            <li>Este nodo guarda la URL pública que escribiste para reutilizarla en su `/api/integrity`.</li>
            <li>Este nodo enlaza localmente el `node0` madre como referencia read-only.</li>
            <li>Calcula su `integrityHash` SHA-256.</li>
            <li>Envía el POST a `node0/register` con tu URL pública.</li>
            <li>Si la verificación pasa, apareces en la live version del `node0`.</li>
          </ol>
        </div>
        <div className="proofBox">
          <strong>Importante: que `node0` figure como read-only es normal</strong>
          <p className="muted">
            Si ves `https://blockchain-see-it.vercel.app` como <strong>linked / read-only</strong>, eso no significa que falló.
            Solo significa que `node0` es un catálogo público y no un peer de sync bidireccional.
          </p>
          <p className="muted">
            Lo importante aquí es el estado de <strong>registro en node0</strong>: <strong>{formatNode0RegistrationStatus(node0Registration)}</strong>.
          </p>
          {node0Registration ? (
            <ul className="bulletList compactList">
              <li>Node0: {node0Registration.node0Url}</li>
              <li>Estado: {node0Registration.status}</li>
              <li>Última actualización: {formatDate(node0Registration.updatedAt)}</li>
              <li>Detalle: {node0Registration.message}</li>
            </ul>
          ) : null}
        </div>
        <div className="proofBox">
          <strong>Conectar este nodo con node0 genesis</strong>
          <p className="muted">Si quieres aparecer en la live version pública, aquí tienes el flujo más simple: un clic si tu URL pública ya está lista.</p>
          <form className="formStack" onSubmit={handleNode0Link}>
            <label>
              1. URL pública de node0
              <input value={node0LinkForm.node0Url} onChange={(event) => setNode0LinkForm({ ...node0LinkForm, node0Url: event.target.value })} placeholder="https://tu-node0.vercel.app" />
            </label>
            <label>
              2. URL pública de este nodo
              <input value={node0LinkForm.publicUrl} onChange={(event) => setNode0LinkForm({ ...node0LinkForm, publicUrl: event.target.value })} placeholder="https://tu-tunel-ngrok.ngrok-free.app" />
            </label>
            <label>
              3. Secret de registro de node0 (opcional)
              <input value={node0LinkForm.registrationSecret} onChange={(event) => setNode0LinkForm({ ...node0LinkForm, registrationSecret: event.target.value })} placeholder="si el node0 lo exige, pégalo aquí" />
            </label>
            <button className="primaryButton" type="submit">Conectar con node0 genesis</button>
          </form>
        </div>
        <form className="formStack" onSubmit={handlePeerRegister}>
          <label>
            Peer base URL
            <input value={peerForm.url} onChange={(event) => setPeerForm({ url: event.target.value })} placeholder="http://192.168.1.10:3000" />
          </label>
          <button className="primaryButton" type="submit">Agregar peer</button>
        </form>
        <div className="tableWrap">
          <table className="dataTable">
            <thead><tr><th>Peer</th><th>Role</th><th>Link</th><th>Sync</th><th>Último chequeo</th><th>Detalle</th></tr></thead>
            <tbody>
              {peerRegistry.map((peer) => (
                <tr key={peer.url}>
                  <td className="mono">{peer.url}</td>
                  <td>{peer.role || 'unknown'}</td>
                  <td>{peer.linkStatus || 'pending'}</td>
                  <td>{peer.syncStatus || 'pending'}</td>
                  <td>{formatDate(peer.lastCheckedAt)}</td>
                  <td>{peer.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel sectionBand sectionBandWallets" id="wallets">
        <SectionTitle eyebrow="Wallets" title="Crear wallet" badge={loading ? 'Procesando…' : 'Web form'} endpoint="/api/node/wallets" />
        <form className="formStack" onSubmit={handleWalletCreate}>
          <label>
            Username
            <input value={walletForm.username} onChange={(event) => setWalletForm({ username: event.target.value })} placeholder="diego" />
          </label>
          <button className="primaryButton" type="submit">Crear wallet</button>
        </form>
        {walletResult ? (
          <div className="proofBox">
            <strong>Secret de la nueva wallet</strong>
            <code>{walletResult.secret}</code>
            <p className="muted">Guárdalo: se pide para transacciones, uploads, listings, compras y minado.</p>
          </div>
        ) : null}
        <div className="tableWrap">
          <table className="dataTable">
            <thead><tr><th>Username</th><th>Address</th><th>Balance</th><th>Media</th><th>Rep base</th><th>Score</th><th>Ventas</th><th>Compras</th><th>Royalties</th><th>Validaciones</th></tr></thead>
            <tbody>
              {state.wallets.map((wallet) => (
                <tr key={wallet.address}>
                  <td>{wallet.username}</td>
                  <td className="mono">{wallet.address}</td>
                  <td>{wallet.balance}</td>
                  <td>{wallet.mediaCount}</td>
                  <td>{wallet.reputation ?? 0}</td>
                  <td>{wallet.reputationScore ?? wallet.metrics?.reputationScore ?? 0}</td>
                  <td>{wallet.metrics?.sellerEarnings ?? 0} SCH</td>
                  <td>{wallet.metrics?.grossVolumeBought ?? 0} SCH</td>
                  <td>{wallet.metrics?.royaltiesEarned ?? 0} SCH</td>
                  <td>{wallet.validatedCount ?? wallet.metrics?.validationsCount ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel sectionBand sectionBandWallets" id="transactions">
        <SectionTitle eyebrow="Transactions" title="Enviar SCH desde la web" badge="Immediate" endpoint="/api/node/transactions" />
        <p className="muted">Las transferencias simples también aportan fee a la tesorería del nodo.</p>
        <form className="draftGrid" onSubmit={handleTransaction}>
          <label>
            Sender address
            <input value={txForm.senderAddress} onChange={(event) => setTxForm({ ...txForm, senderAddress: event.target.value })} />
          </label>
          <label>
            Sender secret
            <input value={txForm.senderSecret} onChange={(event) => setTxForm({ ...txForm, senderSecret: event.target.value })} />
          </label>
          <label>
            Receiver address
            <input value={txForm.receiverAddress} onChange={(event) => setTxForm({ ...txForm, receiverAddress: event.target.value })} />
          </label>
          <label>
            Amount
            <input value={txForm.amount} onChange={(event) => setTxForm({ ...txForm, amount: event.target.value })} />
          </label>
          <div className="formActions"><button className="primaryButton" type="submit">Enviar transacción</button></div>
        </form>
        <div className="tableWrap">
          <table className="dataTable">
            <thead><tr><th>ID</th><th>Tipo</th><th>Sender</th><th>Receiver</th><th>Monto</th><th>Fee</th><th>Total debitado</th><th>Estado</th></tr></thead>
            <tbody>
              {state.transactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td className="mono">{transaction.id}</td>
                  <td>{transaction.type ?? 'transfer'}</td>
                  <td className="mono">{transaction.senderAddress}</td>
                  <td className="mono">{transaction.receiverAddress}</td>
                  <td>{transaction.amount}</td>
                  <td>{transaction.feeAmount ?? 0}</td>
                  <td>{transaction.totalDebited ?? transaction.amount}</td>
                  <td>{transaction.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel sectionBand sectionBandPublishing" id="publishing">
        <SectionTitle eyebrow="Publishing" title="Subir video o memory" badge="Filesystem / external URL" endpoint="/api/node/media" />
        <form className="formStack" onSubmit={handleMediaUpload}>
          <div className="draftGrid">
            <label>
              Wallet uploader
              <input name="uploaderAddress" value={mediaForm.uploaderAddress} onChange={(event) => setMediaForm({ ...mediaForm, uploaderAddress: event.target.value })} />
            </label>
            <label>
              Secret uploader
              <input name="uploaderSecret" value={mediaForm.uploaderSecret} onChange={(event) => setMediaForm({ ...mediaForm, uploaderSecret: event.target.value })} />
            </label>
            <label>
              Título
              <input name="title" value={mediaForm.title} onChange={(event) => setMediaForm({ ...mediaForm, title: event.target.value })} />
            </label>
            <label>
              Tipo
              <select name="type" value={mediaForm.type} onChange={(event) => setMediaForm({ ...mediaForm, type: event.target.value })}>
                <option value="video">Video</option>
                <option value="memory">Memory</option>
              </select>
            </label>
            <label>
              URL externa opcional
              <input name="externalUrl" value={mediaForm.externalUrl} onChange={(event) => setMediaForm({ ...mediaForm, externalUrl: event.target.value })} placeholder="https://..." />
            </label>
            <label>
              Archivo opcional
              <input name="file" type="file" />
            </label>
          </div>
          <button className="primaryButton" type="submit">Enviar a pending</button>
        </form>
      </section>

      <section className="panel sectionBand sectionBandPublishing" id="validation">
        <SectionTitle eyebrow="Validation" title="Minar desde el navegador" badge="2 confirmations" endpoint="/api/node/mine" />
        <div className="tableWrap">
          <table className="dataTable">
            <thead><tr><th>Título</th><th>Uploader</th><th>Confirmations</th><th>Hash</th><th>Asignados</th><th>URL</th></tr></thead>
            <tbody>
              {state.pendingVideos.map((pending) => (
                <tr key={pending.id}>
                  <td>{pending.title}</td>
                  <td>{pending.uploaderName}</td>
                  <td>{pending.confirmations}</td>
                  <td className="mono">{pending.contentHash}</td>
                  <td>{(pending.assignedValidators || []).length ? pending.assignedValidators.join(', ') : 'Abierto'}</td>
                  <td><a href={pending.mediaUrl} target="_blank" rel="noreferrer">Abrir</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="draftGrid" onSubmit={handleMine}>
          <label>
            Pending ID
            <input value={validatorForm.pendingId} onChange={(event) => setValidatorForm({ ...validatorForm, pendingId: event.target.value })} />
          </label>
          <label>
            Validator address
            <input value={validatorForm.validatorAddress} onChange={(event) => setValidatorForm({ ...validatorForm, validatorAddress: event.target.value })} />
          </label>
          <label>
            Validator secret
            <input value={validatorForm.validatorSecret} onChange={(event) => setValidatorForm({ ...validatorForm, validatorSecret: event.target.value })} />
          </label>
          <label>
            Decisión
            <select value={validatorForm.authenticity} onChange={(event) => setValidatorForm({ ...validatorForm, authenticity: event.target.value })}>
              <option value="approve">Aprobar</option>
              <option value="reject">Rechazar</option>
            </select>
          </label>
          <label>
            Sospecha de manipulación
            <select value={String(validatorForm.manipulated)} onChange={(event) => setValidatorForm({ ...validatorForm, manipulated: event.target.value === 'true' })}>
              <option value="false">No</option>
              <option value="true">Sí</option>
            </select>
          </label>
          <label>
            Sospecha de duplicado
            <select value={String(validatorForm.duplicate)} onChange={(event) => setValidatorForm({ ...validatorForm, duplicate: event.target.value === 'true' })}>
              <option value="false">No</option>
              <option value="true">Sí</option>
            </select>
          </label>
          <label>
            Notas
            <input value={validatorForm.notes} onChange={(event) => setValidatorForm({ ...validatorForm, notes: event.target.value })} />
          </label>
          <div className="formActions"><button className="primaryButton" type="submit">Validar / minar</button></div>
        </form>
      </section>

      <section className="panel sectionBand sectionBandMarket" id="marketplace">
        <SectionTitle eyebrow="Marketplace" title="Listar videos aprobados" badge="Monetización real" endpoint="/api/node/listings" />
        <p className="muted">Cada compra distribuye el valor entre seller, tesorería del nodo y royalty del creador si corresponde. Además, ahora la compra transfiere el ownership y habilita reventas reales.</p>
        <form className="draftGrid" onSubmit={handleCreateListing}>
          <label>
            Seller address
            <input value={listingForm.sellerAddress} onChange={(event) => setListingForm({ ...listingForm, sellerAddress: event.target.value })} />
          </label>
          <label>
            Seller secret
            <input value={listingForm.sellerSecret} onChange={(event) => setListingForm({ ...listingForm, sellerSecret: event.target.value })} />
          </label>
          <label>
            Video proof
            <input value={listingForm.videoProof} onChange={(event) => setListingForm({ ...listingForm, videoProof: event.target.value })} placeholder="sha256:..." />
          </label>
          <label>
            Price (SCH)
            <input value={listingForm.price} onChange={(event) => setListingForm({ ...listingForm, price: event.target.value })} />
          </label>
          <label className="spanTwo">
            Descripción
            <input value={listingForm.description} onChange={(event) => setListingForm({ ...listingForm, description: event.target.value })} placeholder="Licencia, acceso premium, uso comercial, etc." />
          </label>
          <div className="formActions"><button className="primaryButton" type="submit">Publicar listing</button></div>
        </form>
        <div className="tableWrap">
          <table className="dataTable">
            <thead><tr><th>Video</th><th>Proof</th><th>Seller</th><th>Creator</th><th>Tipo</th><th>Status</th><th>Price</th><th>Ventas</th><th>Última compra</th></tr></thead>
            <tbody>
              {state.listings.map((listing) => (
                <tr key={listing.id}>
                  <td>
                    <strong>{listing.title}</strong>
                    <div className="muted">{listing.description || 'Sin descripción'}</div>
                  </td>
                  <td className="mono">{listing.videoProof}</td>
                  <td>{listing.sellerName}</td>
                  <td>{listing.creatorName}</td>
                  <td>{listing.saleType || listing.saleTypeHint || 'primary'}</td>
                  <td>{listing.status}</td>
                  <td>{listing.amount} {listing.currency}</td>
                  <td>{listing.purchaseCount ?? 0}</td>
                  <td>{formatDate(listing.lastPurchasedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel sectionBand sectionBandMarket" id="checkout">
        <SectionTitle eyebrow="Checkout" title="Comprar un listing entre wallets" badge="On-chain settlement" endpoint="/api/node/purchases" />
        <form className="draftGrid" onSubmit={handlePurchase}>
          <label>
            Listing ID
            <input value={purchaseForm.listingId} onChange={(event) => setPurchaseForm({ ...purchaseForm, listingId: event.target.value })} />
          </label>
          <label>
            Buyer address
            <input value={purchaseForm.buyerAddress} onChange={(event) => setPurchaseForm({ ...purchaseForm, buyerAddress: event.target.value })} />
          </label>
          <label>
            Buyer secret
            <input value={purchaseForm.buyerSecret} onChange={(event) => setPurchaseForm({ ...purchaseForm, buyerSecret: event.target.value })} />
          </label>
          <div className="formActions"><button className="primaryButton" type="submit">Comprar video</button></div>
        </form>
        <div className="twoColumns">
          {state.listings.map((listing) => (
            <div className="proofBox" key={`${listing.id}-history`}>
              <strong>{listing.title}</strong>
              <p className="muted">{listing.amount} {listing.currency} · seller {listing.sellerName} · creator {listing.creatorName} · {listing.saleType || listing.saleTypeHint || 'primary'} · {listing.status}</p>
              <code>{listing.id}</code>
              <ul className="bulletList compactList">
                {(listing.purchaseHistory || []).length ? (
                  listing.purchaseHistory.map((purchase) => (
                    <li key={purchase.id}>
                      {purchase.buyerName} → seller {purchase.sellerAmount} SCH · royalty {purchase.royaltyAmount} SCH · fee {purchase.marketplaceFeeAmount} SCH · {purchase.saleType || 'primary'} · nivel {purchase.resaleLevel ?? 0} · {formatDate(purchase.purchasedAt)}
                    </li>
                  ))
                ) : (
                  <li>Sin compras aún.</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="panel sectionBand sectionBandResults" id="results">
        <SectionTitle eyebrow="TrueWork results" title="Aprobados y rechazados" badge="Auditable" endpoint="/api/node/state" />
        <div className="twoColumns">
          <div className="proofBox">
            <strong>Aprobados</strong>
            <ul className="bulletList">
              {state.featuredVideos.map((item) => (
                <li key={item.proof}>
                  <strong>{item.title}</strong> · owner {item.owner} · transfers {item.transferCount ?? Math.max(0, (item.ownershipHistory || []).length - 1)}
                  {item.contentHash ? <span className="mono"> · {item.contentHash}</span> : null}
                  <div><a href={item.url} target="_blank" rel="noreferrer">Abrir media</a></div>
                </li>
              ))}
            </ul>
          </div>
          <div className="proofBox">
            <strong>Rechazados</strong>
            <ul className="bulletList">
              {(state.rejectedVideos || []).map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong> · {item.owner}
                  {item.contentHash ? <span className="mono"> · {item.contentHash}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="panel sectionBand sectionBandResults" id="explorer">
        <SectionTitle eyebrow="Explorer" title="Cadena actual del nodo" badge="Self-hosted" endpoint="/api/node/export" />
        <div className="timeline">
          {state.chain.map((block) => (
            <article className="timelineItem" key={block.id}>
              <div>
                <p className="timelineHash">#{block.id} · {block.hash}</p>
                <h3>{block.summary}</h3>
                <p className="muted">Uploader: {block.uploader} · Validator: {block.validator}</p>
              </div>
              <div className="timelineMeta">
                <span>{block.type}</span>
                <span>{formatDate(block.timestamp)}</span>
                {block.mediaUrl ? <a href={block.mediaUrl} target="_blank" rel="noreferrer">Abrir media</a> : <span>Sin media</span>}
              </div>
            </article>
          ))}
        </div>
      </section>
      </div>
    </div>
  );
}
