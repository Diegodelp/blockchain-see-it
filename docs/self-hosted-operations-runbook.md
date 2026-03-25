# StreamChain · guía operativa corta self-hosted

Esta guía resume las operaciones mínimas para correr un nodo self-hosted con criterio operativo básico.

## 1. Instalación inicial

1. Define al menos estas variables de entorno:
   - `STREAMCHAIN_NODE_MODE=self-hosted`
   - `STREAMCHAIN_STORAGE_DIR=./storage`
   - `STREAMCHAIN_PUBLIC_URL=https://tu-nodo.example.com` si ya tienes una URL estable
   - `STREAMCHAIN_OPERATOR_TOKENS=...` con al menos un token de operador activo
2. Instala dependencias y compila:

```bash
npm install
npm run build
```

3. Arranca el nodo:

```bash
STREAMCHAIN_NODE_MODE=self-hosted STREAMCHAIN_STORAGE_DIR=./storage npm run start
```

4. Verifica salud operativa:

```bash
curl http://localhost:3000/api/health
```

Debes confirmar al menos `ok=true`, `mode=self-hosted`, storage legible, keystore legible y signer configurado.

## 2. Enlazar peers y node0

### Enlazar un `node0` público como referencia

Usa `POST /api/node/link-node0` con un token operador válido para registrar la URL pública de referencia. Esto sirve para discovery/bootstrap, no para sync bidireccional.

### Enlazar otro self-hosted como peer real

1. Asegúrate de que el peer remoto exponga:
   - `GET /api/node/export`
   - `POST /api/node/sync`
   - `GET /api/manifest`
2. Registra o enlaza el peer desde la UI o desde el endpoint de peers.
3. Revisa luego:
   - `GET /api/node/peers`
   - `GET /api/node/state`
   - logs estructurados de federación/auth si hay rechazos.

## 3. Rotación del node signer

Rotar el signer requiere disciplina porque rompe confianza si no se comunica bien al resto de peers.

### Procedimiento recomendado

1. Haz backup completo antes de tocar claves.
2. Genera el nuevo material del signer fuera del nodo productivo si es posible.
3. Actualiza las variables/configuración del signer en el nodo.
4. Reinicia el proceso y verifica en `GET /api/health` que el signer esté configurado.
5. Revisa el estado de peers y cualquier rotación pendiente antes de aceptar syncs sensibles.
6. Comunica el cambio a peers confiables para que aprueben la nueva clave si aplica.

### Si sospechas compromiso

1. Saca el nodo de exposición pública.
2. Rota inmediatamente el signer.
3. Revoca peers o confianzas que dependían del material comprometido si hace falta.
4. Revisa logs, backups y últimos bloques antes de volver a abrir sync.

## 4. Revocar peers

Usa revocación cuando un peer presente signer inesperado, forks inválidos, fallos repetidos de autenticación o comportamiento byzantine.

### Checklist rápido

1. Identifica la URL exacta del peer.
2. Ejecuta la revocación desde la ruta operator-only correspondiente.
3. Confirma después que:
   - el peer ya no figure como confiable para sync,
   - futuros ingests desde ese peer fallen,
   - quede un registro administrativo/auditable de la acción.

## 5. Backup y restore

### Crear backup

```bash
npm run backup:self-hosted
```

Esto genera un backup con manifiesto verificable.

### Restaurar

```bash
npm run restore:self-hosted -- --backup <ruta-del-backup>
```

### Recomendaciones mínimas

- Haz backup antes de rotar signer, tocar storage o hacer cambios de despliegue.
- Valida restore periódicamente en un entorno aparte.
- Conserva al menos una copia fuera del host principal.

## 6. Verificaciones post-operación

Después de instalar, enlazar, rotar signer, revocar peers o restaurar backups, revisa siempre:

1. `GET /api/health`
2. `GET /api/node/state`
3. `GET /api/node/peers`
4. logs estructurados recientes
5. capacidad de lectura/escritura básica del nodo

## 7. Mínimo antes de producción real

Aunque esta guía cubre operación básica, antes de producción real todavía conviene cerrar:

- acceso admin detrás de VPN/mTLS/IdP,
- monitoreo y alertas reales,
- backups externos con restore probado,
- runbooks de incidente más detallados,
- topología formal de despliegue y rollback.
