# StreamChain Web Blockchain

Este repo ahora corre en **dos modos** con la misma app Next.js:

- **`node0`** → modo read-only para Vercel, barato y simple.
- **`self-hosted`** → modo full node con wallets, transacciones, uploads, pending validation, marketplace, royalties y minado desde la web.

## 1. Modo Vercel / Node 0

Usa este modo cuando quieres:

- landing pública
- explorer read-only
- bootstrap de red
- manifiesto de capacidades
- preview del marketplace aprobado
- preview de la economía del protocolo
- referencias read-only a peers self-hosted
- descarga directa del kit self-hosted
- costo inicial prácticamente cero

### Deploy

1. Importa el repo en Vercel.
2. Framework preset: **Next.js**.
3. Root directory: `/`.
4. No necesitas variables obligatorias.
5. Si quieres que `node0` tome referencia de otros nodos, define `STREAMCHAIN_NODE0_PEERS` con URLs separadas por comas.

En Vercel el nodo 0 **no escribe** en disco ni guarda uploads.

Además, la home pública puede ofrecer descarga directa del kit self-hosted vía `GET /api/install/self-hosted`.

## 2. Modo self-hosted / Full node

Usa este modo cuando quieres la app completa desde navegador:

- crear wallets
- enviar transacciones
- subir videos o memories
- validar pendientes
- minar bloques
- servir media subida localmente
- registrar peers y propagar estado entre nodos
- registrar decisiones humanas de Proof of TrueWork
- listar videos aprobados para venta
- ejecutar compras wallet-to-wallet on-chain
- cobrar fees del nodo y repartir royalties al creador

### Variables de entorno

```bash
STREAMCHAIN_NODE_MODE=self-hosted
STREAMCHAIN_STORAGE_DIR=./storage
STREAMCHAIN_TX_FEE_RATE=0.01
STREAMCHAIN_MARKETPLACE_FEE_RATE=0.05
STREAMCHAIN_CREATOR_ROYALTY_RATE=0.10
STREAMCHAIN_AUTO_BOOTSTRAP=true
STREAMCHAIN_AUTO_NGROK=true
STREAMCHAIN_NGROK_AUTHTOKEN=tu-token-de-ngrok
```

Si ya tienes `ngrok` instalado y autenticado en la máquina, el token también puede omitirse: `npm run start` primero intenta reutilizar un `ngrok` ya disponible/configurado y solo descarga/configura uno nuevo cuando hace falta.

Importante: el wrapper de `npm run start` ahora también lee tu archivo `.env` antes de decidir si debe correr en modo `self-hosted`, abrir ngrok y hacer el auto-link con `node0`.
Además, la detección de `ngrok` ya no depende de `bash`, así que también funciona en Windows/PowerShell si `ngrok.exe` está en tu `PATH`.
Si usas un `ngrok.exe` portable fuera del proyecto, el arranque también intenta encontrarlo automáticamente en ubicaciones típicas como `Desktop`, `Downloads`, `Documents` y `OneDrive/Desktop`. Si lo tienes en otro lugar, puedes indicarlo con `STREAMCHAIN_NGROK_BINARY` o una lista de carpetas con `STREAMCHAIN_NGROK_SEARCH_DIRS`.
Cuando el nodo arranca en modo self-hosted, no solo mira el snapshot público de `node0`: también consulta el registro live de `node0` para importar automáticamente los otros peers ya conocidos por esa red.

### Desarrollo local

```bash
npm install
STREAMCHAIN_NODE_MODE=self-hosted npm run dev
```

### Producción simple en un VPS

```bash
npm install
npm run build
STREAMCHAIN_NODE_MODE=self-hosted STREAMCHAIN_STORAGE_DIR=./storage npm run start
```

Si detecta `ngrok` ya instalado/configurado —o si defines `STREAMCHAIN_NGROK_AUTHTOKEN` para descargar/configurarlo automáticamente— `npm run start` intenta abrir un túnel ngrok antes de arrancar Next.js, reutiliza esa URL como `STREAMCHAIN_PUBLIC_URL`, se registra contra el `node0` genesis y trae los peers self-hosted que ese `node0` ya conoce.

Guía operativa corta para instalar, enlazar peers, rotar signer, revocar peers y restaurar backups: [`docs/self-hosted-operations-runbook.md`](docs/self-hosted-operations-runbook.md).

### Docker

```bash
docker compose up --build
```

Eso levanta la app en `http://localhost:3000` y persiste el estado en `./storage`.

## 3. Cómo funciona el modo full node

En self-hosted, la app guarda estado en una base **SQLite + WAL** (`storage/state.sqlite`) y media en `storage/media/`. La persistencia se separa en block log append-only, consensus state, snapshots de app state y evidence store para recovery determinístico tras reinicios.

El flujo de validación sigue un esquema de **Proof of TrueWork**:

- cada contenido entra a `pending`
- se asignan validadores humanos
- cada validador marca si aprueba o rechaza y puede señalar manipulación o duplicado
- al completarse el mínimo de validaciones, el sistema decide `approved` o `rejected`
- la decisión, el hash del contenido y los resultados quedan auditables en la cadena
- los videos aprobados pueden convertirse en listings comerciales
- las compras mueven saldo entre wallets y quedan asentadas on-chain
- cada nodo puede definir sus porcentajes de fee y royalty por variables de entorno

Los challenges y apelaciones de moderación se registran como **ModerationCase** formales con `policyVersion`, `reasonCode`, evidencia humana/modelo, bond bloqueado y votos de moderación firmados por validador para dejar una auditoría verificable.
- las compras del marketplace reparten seller / creator / treasury del nodo

### Endpoints del nodo completo

- `GET /api/node/state`
- `POST /api/node/wallets`
- `POST /api/node/transactions`
- `POST /api/node/media`
- `POST /api/node/mine`
- `GET /api/node/peers`
- `POST /api/node/peers`
- `GET /api/node/listings`
- `POST /api/node/listings`
- `POST /api/node/purchases`
- `POST /api/node/sync`
- `GET /api/node/export` (para sincronización entre peers)
- `GET /api/node/media/:filename`

## 4. Qué expone Node 0

El nodo 0 público sirve como bootstrap estático y catálogo de referencia:

- `GET /api/bootstrap` → snapshot rápido con hash bootstrap, altura de cadena, conteos y referencias agregadas de peers
- `GET /api/manifest` → capacidades, monetización, economics preview, roadmap, canales públicos de contacto y snapshot de peers referenciados
- `GET /api/chain` → cadena pública, featured videos, listings de demo y resumen read-only de peers

Esto permite enseñar el proyecto y el flujo económico sin tener que habilitar escrituras en Vercel.

### Cómo hace `node0` para tomar referencia de otros nodos

Configura una variable como esta:

```bash
STREAMCHAIN_NODE0_PEERS=http://peer-a:3000,http://peer-b:3000
```

Con eso, `node0` consulta `GET /api/node/export` en cada peer configurado, arma un snapshot agregado (chain height, wallets, listings, treasury, etc.) y lo muestra como referencia pública de red.
Además, si uno de esos peers ya conoce otros peers, `node0` puede descubrirlos y agregarlos a la referencia read-only automáticamente.

### Paso 9 · Contacto público configurable

`node0` ahora también puede publicar un bloque de contacto real para soporte, partnerships y demos desde la UI pública y `GET /api/manifest`.

Variables opcionales:

```bash
STREAMCHAIN_CONTACT_HEADLINE="Habla con el equipo de StreamChain"
STREAMCHAIN_CONTACT_SUPPORT_EMAIL=support@example.com
STREAMCHAIN_CONTACT_BUSINESS_EMAIL=partners@example.com
STREAMCHAIN_CONTACT_DOCS_URL=https://tu-node0.example.com/#instalacion
STREAMCHAIN_CONTACT_SUPPORT_URL=mailto:support@example.com?subject=StreamChain%20support
STREAMCHAIN_CONTACT_PARTNERSHIP_URL=mailto:partners@example.com?subject=StreamChain%20partnership
STREAMCHAIN_CONTACT_DISCORD_URL=https://discord.com/invite/example
STREAMCHAIN_CONTACT_TELEGRAM_URL=https://t.me/example
STREAMCHAIN_CONTACT_CALENDLY_URL=https://calendly.com/example/streamchain-intro
STREAMCHAIN_CONTACT_RESPONSE_SLA=48h
STREAMCHAIN_CONTACT_TIMEZONE=UTC
```

Si no defines estas variables, el sitio usa los datos seed del proyecto como fallback para que el “paso 9” siga visible también en demos locales.

### Link vs sync cuando pegas una URL de Vercel

Si pegas en la UI de un nodo self-hosted la URL pública que te da Vercel para `node0`, ahora el sistema la registra como **linkeada** pero **read-only**.

- **Linkeada** significa que la URL responde como app pública de StreamChain.
- **Sincronizada** significa que la URL expone `POST /api/node/sync` y `GET /api/node/export`, o sea, que realmente es otro nodo self-hosted capaz de replicar estado.

En otras palabras: una deployment pública de Vercel sirve como referencia visible, pero no como peer de sincronización bidireccional.
No sincroniza bloques ni escribe datos: solo observa y resume.

Y al revés también aplica: si quieres que el `node0` público desplegado en Vercel vea tu nodo self-hosted, no alcanza con pegar la URL de Vercel dentro del self-hosted.
Debes configurar en el proyecto de Vercel la variable:

```bash
STREAMCHAIN_NODE0_PEERS=https://tu-self-hosted.example.com
```

`node0` descubre peers desde esa variable de entorno del lado de Vercel; no se auto-registra cuando agregas peers desde la UI del nodo self-hosted.

### Auto-registro opcional desde self-hosted hacia node0

Ahora `node0` también puede exponer un endpoint seguro para aceptar auto-registro de peers self-hosted:

```bash
POST /api/node0/register
Authorization: Bearer $STREAMCHAIN_NODE0_REGISTRATION_SECRET
Content-Type: application/json

{
  "url": "https://tu-tunel-ngrok.ngrok-free.app",
  "source": "ngrok",
  "tunnel": "ngrok"
}
```

Cuando recibe esa solicitud, `node0`:

- valida el secret compartido
- consulta `GET /api/integrity` y usa su `integrityHash` SHA-256 como huella del entorno remoto
- consulta `GET /api/node/export` del nodo remoto
- valida que el peer remoto sea `self-hosted-full-node`
- verifica estructura básica de la chain
- consulta `GET /api/manifest`
- si todo da bien, lo agrega al registro dinámico que también participa del live crawl de `node0`

En Vercel este registro dinámico puede funcionar como **best effort** usando almacenamiento temporal del runtime, pero si quieres persistencia fuerte deberías apuntarlo a un storage durable con `STREAMCHAIN_NODE0_REGISTRY_DIR` o desplegar `node0` donde tenga filesystem estable.

### Linkeo automático entre nodos

Si quieres que el proceso sea mucho más automático entre nodos locales, self-hosted públicos y `node0`, configura en cada self-hosted:

```bash
STREAMCHAIN_AUTO_BOOTSTRAP=true
STREAMCHAIN_AUTO_NGROK=true
STREAMCHAIN_NGROK_AUTHTOKEN=tu-token-de-ngrok
STREAMCHAIN_NODE0_REGISTRATION_TARGETS=https://tu-node0.vercel.app
STREAMCHAIN_NODE0_REGISTRATION_SECRET=replace-with-a-long-random-secret
STREAMCHAIN_GENESIS_NODE0_URL=https://blockchain-gilt-rho.vercel.app
```

Si el servidor ya tiene `ngrok` instalado y autenticado globalmente, puedes dejar `STREAMCHAIN_NGROK_AUTHTOKEN` vacío y el arranque intentará reutilizar ese binario/config existente.

Con eso, cuando ejecutas `npm run start` en un nodo self-hosted:

- intenta abrir su túnel público automáticamente con ngrok
- se linkea automáticamente con el `node0 genesis`
- se auto-registra en `POST /api/node0/register`
- importa también los peers self-hosted que el `node0` ya tenga sincronizados

Además, cuando un nodo:

- agrega otro peer self-hosted
- o enlaza un `node0` read-only

intenta anunciar su propia URL pública automáticamente:

- hacia los peers self-hosted para que agreguen el backlink
- hacia `POST /api/node0/register` para auto-registrarse en el `node0`, incluso si ese `node0` no exige secret

El endpoint `GET /api/integrity` está pensado como una huella SHA-256 del entorno visible (modo, role, capacidades, superficie API, altura de chain y bootstrap hash).  
**No es una remote attestation criptográfica completa**, pero sí una verificación consistente para evitar aceptar nodos que expongan una superficie inesperada o alterada.

Endurecimiento adicional del prototipo:

- si `node0` tiene `STREAMCHAIN_NODE0_REGISTRATION_SECRET`, ahora el registro falla si ese secret no coincide
- los peers self-hosted deben exponer chains firmadas coherentes con su `nodeSignerPublicKey`
- el sync entre peers ya no acepta transacciones legacy sin firma
- cada transacción firmada usa `nonce` por wallet para reducir replay
- la asignación de validadores prioriza wallets con stake mínimo e historial de validación/reputación y penaliza económicamente votos desalineados
- una chain remota solo reemplaza la local cuando es válida **y extiende la chain actual**, no por ser simplemente “más larga”

### Flujo guiado para usuarios no técnicos

En la UI self-hosted ahora existe una tarjeta **“Conectar este nodo con node0”**.

Solo pide 3 datos:

1. URL pública de `node0`
2. URL pública de este nodo (localhost publicado con túnel o dominio propio)
3. Secret de registro de `node0`

La app llama a `POST /api/node/link-node0`, enlaza localmente el `node0` como referencia read-only y luego envía el POST a `POST /api/node0/register` por ti.  
Así el usuario no necesita conocer manualmente la API ni preparar el curl a mano.

Además, el flujo ya viene orientado al `node0 genesis` por defecto:

- `https://blockchain-gilt-rho.vercel.app`
- intenta usar el `window.location.origin` como URL pública cuando no es localhost
- permite secret opcional si ese `node0` exige autenticación adicional

Si el nodo corre en localhost, el usuario solo necesita pegar una URL pública/túnel (ngrok, cloudflared, etc.) y hacer clic.

### Step by step claro para linkear nodos con el node0 madre

#### Caso A · Tu nodo ya tiene URL pública

Ejemplo: VPS, Docker con dominio propio, o deploy en otro Vercel.

1. Abre tu nodo en modo `self-hosted`.
2. Ve a la sección **Networking**.
3. En la tarjeta **Conectar este nodo con node0 genesis**, deja por defecto:
   - `https://blockchain-gilt-rho.vercel.app`
4. En **URL pública de este nodo**, pega la URL real donde tu nodo responde públicamente.
5. Si el `node0` madre usa secret, pégalo en **Secret de registro de node0 (opcional)**. Si no, déjalo vacío.
6. Haz click en **Conectar con node0 genesis**.
7. La app:
   - guarda la URL pública elegida dentro del nodo self-hosted para que `/api/integrity` publique esa misma URL
   - linkea localmente el `node0` como referencia read-only
   - calcula el `integrityHash`
   - hace el POST a `POST /api/node0/register`
   - espera la verificación remota (`/api/node/export`, `/api/manifest`, `/api/integrity`)
8. Si todo sale bien, el nodo debería aparecer en la live version de `node0`.

#### Caso B · Tu nodo corre en localhost

1. Levanta tu nodo local.
2. Publica ese localhost con un túnel:
   - ngrok
   - cloudflared
   - cualquier URL pública equivalente
3. Copia esa URL pública.
4. Ve a la tarjeta **Conectar este nodo con node0 genesis**.
5. Pega la URL del túnel en **URL pública de este nodo**.
6. Deja `https://blockchain-gilt-rho.vercel.app` como `node0` madre.
7. Haz click en **Conectar con node0 genesis**.

#### Caso C · Quieres linkear otro host de Vercel con el node0 madre

1. Despliega tu app en Vercel pero en modo `self-hosted`.
2. Abre ese deploy.
3. Ve a **Networking**.
4. Usa la misma tarjeta **Conectar este nodo con node0 genesis**.
5. La URL pública normalmente se puede detectar sola desde el browser; si no, pégala manualmente.
6. Haz click en **Conectar con node0 genesis**.

#### Cómo saber si funcionó

- En tu UI local/self-hosted verás el mensaje de éxito.
- El `node0` madre podrá registrarte y usarte como referencia.
- Si la tabla muestra `https://blockchain-gilt-rho.vercel.app` como `linked / read-only`, **eso es normal**: `node0` es una referencia pública, no un peer de sync.
- Lo que debes mirar como señal de éxito es el estado de **registro en node0**.
- Si falla, revisa normalmente estas tres cosas:
  1. la URL pública realmente responde desde internet
  2. `/api/node/export` y `/api/integrity` están accesibles
  3. el `publicUrl` del integrity coincide con la URL que enviaste

En la home pública de `node0` también existe una tabla de **Live registrations** para mostrar los nodos que se registraron aunque todavía no
hayan sido incorporados al crawl read-only completo.

Si necesitas depurar un fallo entre ngrok/self-hosted y `node0`, ahora hay logs explícitos en ambos lados:

- `streamchain:link-node0`
- `streamchain:self-hosted`
- `streamchain:node0-register`

En Vercel los verás en los logs del route handler y en self-hosted/ngrok en la consola del servidor.

## 5. Flujo recomendado

### Para Vercel
- deja el modo por defecto (`node0`)
- úsalo como explorer, bootstrap público y catálogo read-only

### Para tu nodo real
- corre otro deploy en un VPS / Docker / casa / servidor propio
- activa `STREAMCHAIN_NODE_MODE=self-hosted`
- usa ahí toda la funcionalidad completa desde la web
- conecta peers desde la UI para replicar estado entre nodos self-hosted
- publica listings desde videos aprobados y acepta compras on-chain

## 6. Estado de objetivos

### Ya cubierto
- Node 0 público, barato y sin escrituras
- nodo self-hosted con estado persistente
- uploads locales o por URL externa
- validación humana auditable
- balances entre wallets
- peers y sincronización básica
- explorer web
- marketplace inicial para videos aprobados
- fees configurables por nodo
- royalties base para creadores
- scoring histórico por wallet con reputación compuesta
- métricas públicas de mercado/fiscalidad del nodo
- ownership transfer + reventas (secondary market)
- suite automatizada de tests de integración para marketplace/reventas y sync multi-node
- cobertura automatizada para bundle self-hosted y helpers críticos del launcher/startup
- cobertura automatizada del surface público read-only de node0 (bootstrap/manifest/chain + agregación de peers)
- lockfile y versiones de runtime fijadas para que CI y despliegues reproduzcan la misma base de dependencias
- CI de GitHub Actions para lint + test + build en cada push/PR, usando un build estable de webpack y un runner de tests sin warnings experimentales

### Próximos pasos para cerrar al 100%
- analytics/licencias más específicas por vertical o tipo de activo
- ampliar la cobertura de tests hacia UI/browser y smoke tests de deploy
- endurecer aún más políticas de gobernanza / moderación distribuida

## 7. Idea de arquitectura

La idea correcta para “blockchain web” es:

- **Vercel Node 0** → bootstrap público, barato, sin escrituras
- **self-hosted nodes** → escritura, media, validación, minado, tx, marketplace y sync entre peers
- **TrueWork** → validación humana auditable con resultado aprobado/rechazado
- **web única** → misma UI, distinto modo según dónde lo corras

## 8. Estado del prototipo legacy

El directorio `blockchain/` queda como referencia del prototipo Python original, pero la app activa y deployable es la de Next.js en la raíz del repo.
