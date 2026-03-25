'use client';

import { useMemo, useState } from 'react';

async function sha256(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function DraftLab() {
  const [title, setTitle] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [owner, setOwner] = useState('');
  const [proof, setProof] = useState('');
  const payload = useMemo(
    () => JSON.stringify({ title, mediaUrl, owner }, null, 2),
    [title, mediaUrl, owner]
  );

  async function handleGenerateProof() {
    setProof(await sha256(payload));
  }

  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Client-side lab</p>
          <h2>Borrador sin costo</h2>
        </div>
        <span className="badge">No persistence</span>
      </div>
      <p className="muted">
        Node 0 no guarda archivos ni metadata en servidor. Este formulario genera el proof del post en tu navegador para que luego lo publiques en un nodo self-hosted.
      </p>
      <div className="draftGrid">
        <label>
          Título
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Mi video / recuerdo" />
        </label>
        <label>
          URL externa del media
          <input value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="https://..." />
        </label>
        <label>
          Wallet / owner
          <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="0x... o address" />
        </label>
      </div>
      <button className="primaryButton" type="button" onClick={handleGenerateProof}>
        Generar proof SHA-256 local
      </button>
      <div className="proofBox">
        <strong>Payload</strong>
        <pre>{payload}</pre>
      </div>
      <div className="proofBox">
        <strong>Proof</strong>
        <code>{proof || 'Aún no generado.'}</code>
      </div>
    </section>
  );
}
