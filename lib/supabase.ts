// Cliente de Supabase para el navegador.
//
// En Vercel la app habla directo con Supabase usando supabase-js (en la
// versión de Muse hacía falta un puente por el servidor porque el webview
// bloqueaba esa conexión; en un navegador normal no hay ese problema).
//
// Las dos variables son públicas por diseño: la clave publicable puede ir
// en el navegador porque la seguridad la dan Supabase Auth y las políticas
// RLS del proyecto (cada estudiante solo ve sus propios datos). NUNCA pongas
// aquí la clave service_role ni un token personal de administración.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Faltan las variables de entorno de Supabase. Copia .env.example a .env.local " +
      "(o configúralas en Vercel → Settings → Environment Variables): " +
      "NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
  );
}

export const SUPABASE_URL = supabaseUrl;
export const SUPABASE_PUBLISHABLE_KEY = supabasePublishableKey;
export const FILES_BUCKET = "archivos-pacientes";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
