# Pacientes Odontología — versión para publicar en Vercel

Esta carpeta es la app completa (la misma que vive en Muse) preparada como
proyecto de **Next.js** listo para desplegar en Vercel con dirección pública,
por ejemplo `https://pacientes-odontologia.vercel.app`.

## Lo importante: no se pierde nada

- Usa **el mismo proyecto de Supabase** (`pacientes-odontologia`,
  `https://lcgetuepivxunqhlxkav.supabase.co`): mismas cuentas, mismas tablas
  `patients` y `sessions`, mismo bucket `archivos-pacientes` y mismas
  políticas RLS. **No hay migración de datos**: los estudiantes entran con su
  mismo correo y contraseña y ven sus mismos pacientes.
- La única diferencia técnica con la versión de Muse es que aquí el
  navegador habla **directo con Supabase** (supabase-js), sin el puente por
  el servidor que Muse necesitaba por su webview. En un navegador normal
  esa conexión directa es la forma estándar y funciona sin el error
  «Failed to fetch».
- Incluye todo: login con Supabase, pacientes, sesiones con signos vitales
  y alertas, ficha en PDF, archivos por paciente (la subida es directa a
  Supabase, así que ya no aplica el límite de 8 MB del puente) y
  **verificación de correo**: al registrarse, el enlace de verificación
  regresa a esta app publicada, ya no a localhost.
- Trae el **logo de Creatibox** sobre la pantalla de acceso
  (`public/logo.png`, mostrado por `components/App.tsx`) y el **favicon**
  con el monograma CB en la pestaña del navegador (`public/favicon.png` y
  `public/icon.png`, declarados en los `metadata.icons` de
  `app/layout.tsx`).

## Paso 1 — Subir esta carpeta a GitHub

1. Crea un repositorio nuevo en GitHub (puede ser privado).
2. Sube **el contenido de esta carpeta** como raíz del repositorio (que
   `package.json` quede en la raíz).

   Alternativa sin GitHub: con la CLI de Vercel (`npm i -g vercel`), entra a
   esta carpeta y ejecuta `vercel` para el primer despliegue y
   `vercel --prod` para publicarlo.

> **Si ya habías subido una versión anterior a GitHub:** vuelve a subir el
> contenido completo de esta carpeta **reemplazando todos los archivos**,
> incluidos `components/App.tsx` y `app/layout.tsx`. Si solo se suben las
> imágenes de `public/`, el logo y el favicon no se ven: quien muestra el
> logo es `components/App.tsx` y quien declara el favicon es
> `app/layout.tsx`. Al confirmar la subida, Vercel redespliega solo.

## Paso 2 — Importar en Vercel

1. En [vercel.com](https://vercel.com) → **Add New → Project** → elige el
   repositorio.
2. Vercel detecta **Next.js** solo; no cambies el framework ni los comandos.
3. Antes de desplegar, agrega las **variables de entorno**
   (Settings → Environment Variables, o en la misma pantalla de importación):

   | Nombre | Valor |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://lcgetuepivxunqhlxkav.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | La clave publicable del proyecto (está en `.env.example` de esta carpeta y en Supabase → Project Settings → API Keys) |

   La clave publicable es pública por diseño: la seguridad la dan Auth y
   las políticas RLS. **Nunca** pongas la clave `service_role` ni un token
   personal en Vercel.
4. **Deploy**. Al terminar, Vercel te da la dirección pública del proyecto.

## Paso 3 — Que el correo de verificación regrese a la app (clave)

Sin este paso, el enlace del correo seguiría apuntando a localhost:

1. En Supabase → tu proyecto → **Authentication → URL Configuration**:
   - **Site URL**: pega la dirección pública de Vercel
     (ej. `https://pacientes-odontologia.vercel.app`).
   - **Redirect URLs**: agrega esa misma dirección.
2. En **Authentication → Providers → Email**, deja **Confirm email**
   activado (ya quedó activado): así ninguna cuenta nueva entra sin tocar
   el enlace de su correo. El correo puede ser cualquiera, sin restricción
   de dominio.
3. Guarda. Desde ese momento, quien se registre toca el enlace del correo,
   regresa a la app ya verificado y puede iniciar sesión.

## Paso 4 — Probar de punta a punta

1. Crea una cuenta nueva con un correo tuyo.
2. Revisa que llegue el correo de verificación y que el enlace te regrese
   a la app publicada (no a localhost).
3. Inicia sesión, registra un paciente, una sesión con signos vitales y
   sube un archivo a su ficha.
4. Entra también a la app de Muse con una cuenta que ya tenga pacientes:
   deben verse los mismos datos, porque es el mismo Supabase.

## Correr en tu computadora (opcional)

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Estructura

- `app/` — layout, página principal y estilos (Next.js App Router).
- `components/App.tsx` — toda la interfaz (acceso, pacientes, ficha,
  sesiones, signos vitales, archivos, PDF, eliminar cuenta).
- `lib/supabase.ts` — cliente de Supabase desde las variables de entorno.
- `lib/data.ts` — la capa de datos: Auth, pacientes, sesiones y archivos
  contra Supabase, con la misma interfaz que usa la interfaz gráfica.
