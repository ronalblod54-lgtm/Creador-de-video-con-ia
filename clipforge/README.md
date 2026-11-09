# Creador de Clips IA — MVP web + proyecto Android

Implementación nueva basada en la lista de sistemas suministrada. **No incluye el código original de Muse**.

## Funciona hoy
- Registro y login con PBKDF2-SHA256 (120 000 iteraciones), sesión 30 días y roles; primera cuenta = admin.
- Cuentas aisladas en SQLite; bloqueo de usuarios desde el panel admin.
- Subir MP4/MOV/MKV/WEBM (hasta 1 GB), guardar proyectos, crear clips por tiempo, renderizar 1080x1920 H.264/AAC mediante FFmpeg, descargar, marcar usados, editar títulos y hashtags, borrar clips.
- Guardar enlaces de directos (sin seguimiento automático aún).
- PWA instalable (requiere HTTPS en producción) y estructura Capacitor para Android.

## No implementado todavía
- Importación directa de videos/canales YouTube, subtítulos/transcripción, análisis viral con IA, score real, auto-recorte, subtítulos quemados, facecam, chat en vivo, DVR, cron, compartir con TikTok, barra de progreso real (solo estados 10% y 100%), administración avanzada de bibliotecas, pagos.
- No se incluye un APK compilado. El proyecto Android requiere instalar Node, Android Studio y compilarlo.

## Ejecutar localmente
Requiere Python 3.10+, FFmpeg y FFprobe disponibles en PATH.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```
Abre http://localhost:8000. **Crea primero tu cuenta de administrador** antes de compartir la URL. Los datos se guardan en `data/`.

## Publicar la web
Hospeda el servidor Python en un proveedor que permita procesos largos, FFmpeg, HTTPS y almacenamiento persistente. Vercel serverless no es adecuado para renderizados de varios minutos sin un worker externo. Configura almacenamiento persistente, HTTPS, copias de seguridad, límite de concurrencia y un servicio de jobs para producción.

## Crear APK con Capacitor
1. Publica el backend y PWA en un dominio HTTPS real.
2. Edita `android/capacitor.config.json` y reemplaza `server.url` por tu URL HTTPS.
3. En `android/`: `npm install && npx cap add android && npx cap sync android`.
4. Abre Android Studio con `npx cap open android`, configura SDK y compila APK con Build > Build Bundle(s) / APK(s) > Build APK(s).

**Seguridad**: esta es una base MVP, no una plataforma de producción auditada. Antes de abrir registros públicos, añade rate limiting, verificación de email, controles de uso, colas persistentes, cuotas, comprobación de medios, protección ante abuso, límites por usuario y backups. El render por hilos no sobrevive a reinicios del servidor.

## Entrega de integración (9 nov 2026)
Se incluye `original-muse/` con el **código fuente original aportado por el usuario**, sin modificar. El directorio `web/` + `backend/` es una **implementación independiente y ejecutable** para pruebas; **no** es una conversión completa del frontend React de Muse. No confundir las dos implementaciones.

### Inicio con Docker
Con Docker instalado, ejecuta `docker compose up --build` desde la carpeta principal y abre `http://localhost:8000`. El volumen `clip_data` conserva la base de datos y videos. El primer registro recibe rol admin: crea esa cuenta **antes** de abrir el servicio a terceros. En producción configura HTTPS, restricciones de registro y protección contra abuso.

### Despliegue en Render
`render.yaml` incluye un servicio Docker con disco persistente; revisa disponibilidad y precios del plan antes de desplegar. Requiere conectar el repositorio GitHub y configurar dominio HTTPS. **No se ha desplegado** en una cuenta externa.

### Android
`android/` contiene configuración de Capacitor, no un APK compilado. Después de publicar la web por HTTPS, reemplaza `server.url` en `android/capacitor.config.json`, instala las dependencias (`npm install`) y ejecuta `npx cap add android`, `npx cap sync android`, `npx cap open android`. Requiere Android Studio para compilar.
