# StreamChain · backlog de salida a producción

> Este archivo es la lista viva de lo que **todavía falta** para sacar la blockchain a producción.
> En los próximos chats iremos cerrando puntos, y cuando uno quede resuelto lo movemos a **Hecho recientemente** o lo eliminamos de la sección de pendientes.
>
> Última revisión: 2026-03-23.

## Cómo usar este archivo
- Mantener en **Pendiente** solo lo que realmente siga faltando.
- Cuando un punto se implemente, moverlo a **Hecho recientemente** con una nota corta.
- Si un punto es grande, abrir subtareas debajo antes de implementarlo.
- Si algo deja de aplicar, borrarlo para que el backlog siga siendo útil.

## Hecho recientemente
- [x] Autenticación de federación con firma asimétrica entre nodos cuando existe confianza previa.
- [x] Protección anti-replay con `timestamp` + `nonce` persistido en SQLite.
- [x] Revocación explícita de peers/signers y bloqueo de nuevos syncs para peers revocados.
- [x] Auditoría persistente de acciones administrativas críticas (rotaciones, revocaciones y registro con node0).
- [x] Healthcheck self-hosted con validaciones operativas más profundas (storage, keystore, signer y operator token).
- [x] Backup/restore con manifiesto versionado y verificación explícita de integridad antes de restaurar.
- [x] Separación básica de roles operativos en endpoints sensibles (`viewer`, `operator`, `validator-admin`, `incident-response`).
- [x] Soporte básico de versionado/expiración en credenciales operator RBAC para facilitar rotación.
- [x] Logs estructurados básicos con `requestId`/`route` en auth de operador, federación y registro de peers en `node0`.
- [x] Límites básicos de tipo/tamaño/rate y cuota por actor para uploads de media self-hosted desde configuración.
- [x] Hardening HTTP básico con headers de seguridad y allowlist opcional de orígenes admin para endpoints operator-only.
- [x] Guía operativa corta publicada para instalar, enlazar peers, rotar signer, revocar peers y restaurar backups.

## Pendiente antes de producción

### 1. Seguridad de acceso y operación
- [ ] Poner todos los endpoints de operador detrás de un plano de acceso fuerte: IdP admin, VPN o mTLS.
- [ ] Definir rotación periódica de secretos (`STREAMCHAIN_OPERATOR_TOKEN`, secretos de node0 y credenciales de storage).
- [ ] Agregar expiración, versionado y revocación formal de credenciales operativas.
- [ ] Documentar y automatizar la rotación del `node signer` y la recuperación ante pérdida/compromiso.
- [ ] Bloquear por red los endpoints sensibles para que no queden expuestos públicamente sin necesidad.
- [ ] Añadir hardening HTTP básico: trusted proxy, allowlist de orígenes admin y política clara de CORS si aplica.

### 2. Seguridad de nodos y federación
- [ ] Definir un modelo de trust bootstrap inicial para peers nuevos (cómo entra un peer por primera vez en confianza).
- [ ] Implementar cuarentena/manual approval para peers nuevos antes de aceptar sync automático en entornos productivos.
- [ ] Añadir auditoría de eventos de federación: alta de peer, rotación, revocación, rechazo por replay, rechazo por allowlist.
- [ ] Guardar evidencia operativa suficiente para investigar incidentes entre nodos.
- [ ] Definir política de slashing/aislamiento para peers byzantine o repetidamente inconsistentes.
- [ ] Añadir límites y alertas por volumen/frecuencia de sync entre peers para evitar abuso o loops.

### 3. Persistencia, backups y recuperación
- [ ] Cifrar en reposo la base SQLite, backups y material sensible del keystore.
- [ ] Mover backups a almacenamiento externo/versionado con retención definida.
- [ ] Probar restore end-to-end con una rutina periódica documentada.
- [ ] Definir RPO/RTO objetivo para nodos self-hosted y para `node0`.
- [ ] Diseñar estrategia de migraciones de esquema con rollback seguro.
- [ ] Separar claramente datos públicos, secretos, medios y snapshots para facilitar recuperación selectiva.

### 4. Observabilidad y respuesta a incidentes
- [ ] Exportar métricas a un sistema real de monitoreo (Prometheus/Grafana o equivalente).
- [ ] Crear alertas sobre caídas de health, errores de sync, fallos de firma, replays y revocaciones.
- [ ] Añadir dashboards de operación para chain height, peers online, latencia de sync y estado de backups.
- [ ] Estandarizar logs estructurados con `request_id`, `peer_url`, `wallet`, `route` y severidad.
- [ ] Definir runbooks de incident response para compromiso de signer, peer malicioso, corrupción de DB y restore.

### 5. Calidad, testing y validación previa al release
- [ ] Añadir tests de carga/concurrencia para wallets, compras, uploads y sync multi-peer.
- [ ] Añadir chaos testing o fault injection para reinicios, cortes de red y estados parciales.
- [ ] Cubrir con tests la ruta operator-only de revocación y los flujos UI si se exponen en panel.
- [ ] Añadir tests de compatibilidad/migración entre versiones de storage y snapshots.
- [ ] Validar escenarios de doble gasto, forks largos, reorgs inválidos y abuso de marketplace bajo presión.
- [ ] Ejecutar una prueba de soak/stability prolongada antes del primer despliegue real.

### 6. Infraestructura y despliegue
- [ ] Definir topología recomendada de producción: reverse proxy, TLS, almacenamiento persistente, backup worker y monitoreo.
- [ ] Documentar despliegue de referencia para un nodo self-hosted y para `node0`.
- [ ] Versionar releases e introducir un procedimiento formal de rollout/rollback.
- [ ] Añadir pinning/revisión de dependencias y cadencia de actualización de seguridad.
- [ ] Validar ejecución detrás de Docker/Kubernetes con volúmenes persistentes reales.

### 7. Protección de contenido y media
- [ ] Definir estrategia de almacenamiento de media para producción (S3-compatible, lifecycle, cifrado y retención).
- [ ] Añadir antivirus/escaneo o validaciones de archivos subidos antes de publicar media.
- [ ] Limitar tamaño, tipo, rate y cuota de uploads por actor.
- [ ] Separar claramente metadata on-chain, media off-chain y políticas de acceso al archivo.
- [ ] Añadir limpieza/garbage collection de media huérfana.

### 8. Economía, gobernanza y reglas del protocolo
- [ ] Documentar parámetros económicos productivos: fees, royalties, slashing, bonds y límites.
- [ ] Definir cómo se cambian esos parámetros y quién aprueba los cambios.
- [ ] Formalizar reglas de admisión de validadores y criterios de suspensión/revocación.
- [ ] Publicar un documento de amenazas y supuestos de seguridad del protocolo.
- [ ] Revisar incentivos anti-sybil y posibles vectores de colusión entre validadores.

### 9. Cumplimiento, privacidad y aspectos legales
- [ ] Revisar retención de datos, PII y políticas de privacidad de wallets/operadores/contactos.
- [ ] Definir términos de uso y política de contenido para la capa de media/marketplace.
- [ ] Aclarar implicancias legales de revocaciones, moderación y evidencia de autenticidad.
- [ ] Revisar licencias de dependencias y del material distribuido en el bundle self-hosted.

### 10. Producto y experiencia operativa
- [ ] Exponer en UI el estado de seguridad de peers: trusted, pending-rotation, revoked, unreachable.
- [ ] Añadir explicaciones accionables para errores de sync y fallos de autenticación.
- [ ] Mejorar onboarding para operadores no técnicos que despliegan un nodo por primera vez.

## Candidatos para próximos chats
- [ ] Endurecer autenticación de endpoints de operador con roles reales o mTLS.
- [ ] Diseñar y automatizar rotación de node signer con playbook de recuperación.
- [ ] Añadir alertas y dashboards de operación.
- [ ] Añadir cifrado a backups/restore y gestión segura de claves de respaldo.
