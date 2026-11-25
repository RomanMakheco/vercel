// Capa de datos del cliente (versión Vercel).
//
// Misma interfaz que usa la interfaz de la app, pero hablando directo con
// Supabase mediante supabase-js: Auth (correo y contraseña, con verificación
// de correo), las tablas `patients` y `sessions`, y el bucket privado
// `archivos-pacientes`. Es el MISMO proyecto de Supabase que ya usa la app
// de Muse, así que los datos existentes no se mueven ni se pierden: cada
// estudiante entra con su misma cuenta y ve sus mismos pacientes.
//
// La seguridad la siguen dando las políticas RLS: todas las consultas van
// con el token del estudiante y cada quien solo puede ver y tocar lo suyo.

import {
  FILES_BUCKET,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  supabase,
} from "./supabase";

export interface Vitals {
  systolic: number | null;
  diastolic: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperature: number | null;
  spo2: number | null;
  glucose: number | null;
}

export interface Patient {
  id: string;
  fullName: string;
  birthDate: string | null;
  phone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  allergies: string;
  conditions: string;
  medications: string;
  consentSigned: boolean;
  notes: string;
  createdAt: string;
}

export interface PatientListItem extends Patient {
  sessionCount: number;
  lastSessionDate: string | null;
  nextAppointment: string | null;
}

export interface Session {
  id: string;
  patientId: string;
  date: string;
  reason: string;
  treatment: string;
  pending: string;
  nextAppointment: string | null;
  vitals: Vitals;
  notes: string;
  createdAt: string;
}

export interface PatientFile {
  name: string;
  path: string;
  size: number | null;
  createdAt: string | null;
}

export interface AuthUser {
  id: string;
  email: string;
}

/* ---------------- Filas de Supabase (snake_case) ---------------- */

interface PatientRow {
  id: string;
  full_name: string;
  birth_date: string | null;
  phone: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  allergies: string | null;
  conditions: string | null;
  medications: string | null;
  consent_signed: boolean;
  notes: string | null;
  created_at: string;
}

interface SessionRow {
  id: string;
  patient_id: string;
  date: string;
  reason: string | null;
  treatment: string | null;
  pending: string | null;
  next_appointment: string | null;
  systolic: number | null;
  diastolic: number | null;
  heart_rate: number | null;
  respiratory_rate: number | null;
  temperature: number | string | null;
  spo2: number | null;
  glucose: number | null;
  notes: string | null;
  created_at: string;
}

function toPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    fullName: row.full_name,
    birthDate: row.birth_date,
    phone: row.phone ?? "",
    emergencyContactName: row.emergency_contact_name ?? "",
    emergencyContactPhone: row.emergency_contact_phone ?? "",
    allergies: row.allergies ?? "",
    conditions: row.conditions ?? "",
    medications: row.medications ?? "",
    consentSigned: row.consent_signed === true,
    notes: row.notes ?? "",
    createdAt: row.created_at,
  };
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    patientId: row.patient_id,
    date: row.date,
    reason: row.reason ?? "",
    treatment: row.treatment ?? "",
    pending: row.pending ?? "",
    nextAppointment: row.next_appointment,
    vitals: {
      systolic: row.systolic,
      diastolic: row.diastolic,
      heartRate: row.heart_rate,
      respiratoryRate: row.respiratory_rate,
      temperature: row.temperature == null ? null : Number(row.temperature),
      spo2: row.spo2,
      glucose: row.glucose,
    },
    notes: row.notes ?? "",
    createdAt: row.created_at,
  };
}

/* ---------------- Acceso (correo y contraseña) ---------------- */

// A dónde regresa el enlace del correo de verificación: a esta misma app
// ya publicada. Para que Supabase acepte esa dirección hay que ponerla en
// el panel de Supabase → Authentication → URL Configuration (Site URL y
// Redirect URLs), como explica el README de esta carpeta.
function appOrigin(): string | undefined {
  return typeof window !== "undefined" ? window.location.origin : undefined;
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    throw new Error(error?.message ?? "No se pudo iniciar sesión. Inténtalo de nuevo.");
  }
  return { id: data.user.id, email: data.user.email ?? email };
}

export async function signUp(
  email: string,
  password: string,
): Promise<{ user: AuthUser | null; needsConfirmation: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: appOrigin() },
  });
  if (error) throw new Error(error.message);
  // Protección contra enumeración de Supabase: si el correo ya tenía cuenta,
  // el alta «funciona» pero devuelve un usuario sin identities y sin sesión.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error("Ya existe una cuenta con ese correo. Inicia sesión con ella.");
  }
  if (!data.session || !data.user) {
    // Sin sesión = la cuenta quedó pendiente de verificar el correo.
    return { user: null, needsConfirmation: true };
  }
  // Con sesión inmediata: solo se acepta si el correo consta como verificado
  // (confirmación automática). Si no, se cierra y se pide verificación.
  const confirmationFieldPresent =
    "email_confirmed_at" in data.user || "confirmed_at" in data.user;
  const confirmedAt = data.user.email_confirmed_at ?? data.user.confirmed_at;
  if (confirmationFieldPresent && !(typeof confirmedAt === "string" && confirmedAt)) {
    await supabase.auth.signOut().catch(() => undefined);
    return { user: null, needsConfirmation: true };
  }
  return {
    user: { id: data.user.id, email: data.user.email ?? email },
    needsConfirmation: false,
  };
}

export async function resendConfirmation(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: appOrigin() },
  });
  if (error) throw new Error(error.message);
}

export async function restoreSession(): Promise<AuthUser | null> {
  // getSession también procesa el regreso del enlace de verificación:
  // cuando el estudiante toca el enlace del correo, Supabase lo trae a la
  // app con su sesión en la dirección y queda dentro sin pasos extra.
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (!user) return null;
  return { id: user.id, email: user.email ?? "" };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut().catch(() => undefined);
}

async function requireUser(): Promise<AuthUser> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Tu sesión expiró. Inicia sesión de nuevo.");
  return { id: data.user.id, email: data.user.email ?? "" };
}

export async function deleteAccount(
  password: string,
): Promise<{ authDeleted: boolean }> {
  const me = await requireUser();
  if (!me.email) throw new Error("Tu sesión expiró. Inicia sesión de nuevo.");

  // Re-verificación de identidad: la contraseña debe ser la de la cuenta.
  const verify = await supabase.auth.signInWithPassword({ email: me.email, password });
  if (verify.error || verify.data.user?.id !== me.id) {
    throw new Error(
      "La contraseña no es correcta. Escríbela de nuevo para confirmar que eres tú.",
    );
  }

  // 1) Borrar los archivos de cada paciente en el bucket privado.
  const { data: patientRows, error: listError } = await supabase
    .from("patients")
    .select("id");
  if (listError) throw new Error("No se pudo eliminar la cuenta.");
  for (const row of (patientRows ?? []) as { id: string }[]) {
    const folder = `${me.id}/${row.id}`;
    const { data: files } = await supabase.storage
      .from(FILES_BUCKET)
      .list(folder, { limit: 100, offset: 0 });
    const names = (files ?? [])
      .filter((f) => f.id != null)
      .map((f) => `${folder}/${f.name}`);
    if (names.length > 0) {
      await supabase.storage.from(FILES_BUCKET).remove(names);
    }
  }

  // 2) Borrar sesiones y pacientes del estudiante.
  const delSessions = await supabase.from("sessions").delete().eq("owner_id", me.id);
  if (delSessions.error) throw new Error("No se pudo eliminar la cuenta.");
  const delPatients = await supabase.from("patients").delete().eq("owner_id", me.id);
  if (delPatients.error) throw new Error("No se pudo eliminar la cuenta.");

  // 3) Intentar eliminar el propio usuario de Auth (DELETE /auth/v1/user
  //    con su propio token). Si el proyecto no lo permite, los datos ya
  //    quedaron borrados y la sesión se cierra igual; authDeleted lo dice.
  let authDeleted = false;
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (token) {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${token}`,
        },
      });
      authDeleted = res.ok;
    }
  } catch {
    authDeleted = false;
  }
  await supabase.auth.signOut().catch(() => undefined);
  return { authDeleted };
}

/* ---------------- Pacientes ---------------- */

export interface PatientPayload {
  fullName: string;
  birthDate: string | null;
  phone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  allergies: string;
  conditions: string;
  medications: string;
  consentSigned: boolean;
  notes: string;
}

function patientBody(payload: PatientPayload, ownerId: string) {
  return {
    owner_id: ownerId,
    full_name: payload.fullName,
    birth_date: payload.birthDate,
    phone: payload.phone,
    emergency_contact_name: payload.emergencyContactName,
    emergency_contact_phone: payload.emergencyContactPhone,
    allergies: payload.allergies,
    conditions: payload.conditions,
    medications: payload.medications,
    consent_signed: payload.consentSigned,
    notes: payload.notes,
  };
}

export async function listPatients(): Promise<{ patients: PatientListItem[] }> {
  const { data: patientData, error: pError } = await supabase
    .from("patients")
    .select("*")
    .order("full_name", { ascending: true });
  if (pError) throw new Error("No se pudo cargar la lista de pacientes.");
  const { data: sessionData, error: sError } = await supabase
    .from("sessions")
    .select("patient_id,date,next_appointment")
    .order("date", { ascending: false })
    .order("created_at", { ascending: false });
  if (sError) throw new Error("No se pudieron cargar las sesiones.");

  const sessionRows = (sessionData ?? []) as {
    patient_id: string;
    date: string;
    next_appointment: string | null;
  }[];
  const byPatient = new Map<string, { date: string; next_appointment: string | null }[]>();
  for (const s of sessionRows) {
    const list = byPatient.get(s.patient_id) ?? [];
    list.push(s);
    byPatient.set(s.patient_id, list);
  }
  return {
    patients: ((patientData ?? []) as PatientRow[]).map((row) => {
      const list = byPatient.get(row.id) ?? [];
      const latest = list[0];
      return {
        ...toPatient(row),
        sessionCount: list.length,
        lastSessionDate: latest ? latest.date : null,
        nextAppointment: latest ? latest.next_appointment : null,
      };
    }),
  };
}

export async function getPatient(
  id: string,
): Promise<{ patient: Patient | null; sessions: Session[] }> {
  const { data: patientData, error: pError } = await supabase
    .from("patients")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (pError) throw new Error("No se pudo cargar la ficha del paciente.");
  if (!patientData) return { patient: null, sessions: [] };
  const { data: sessionData, error: sError } = await supabase
    .from("sessions")
    .select("*")
    .eq("patient_id", id)
    .order("date", { ascending: false })
    .order("created_at", { ascending: false });
  if (sError) throw new Error("No se pudieron cargar las sesiones.");
  return {
    patient: toPatient(patientData as PatientRow),
    sessions: ((sessionData ?? []) as SessionRow[]).map(toSession),
  };
}

export async function createPatient(payload: PatientPayload): Promise<{ id: string }> {
  const me = await requireUser();
  const { data, error } = await supabase
    .from("patients")
    .insert(patientBody(payload, me.id))
    .select("id")
    .single();
  if (error || !data) throw new Error("No se pudo registrar el paciente.");
  return { id: (data as { id: string }).id };
}

export async function updatePatient(
  id: string,
  payload: PatientPayload,
): Promise<{ ok: true }> {
  const me = await requireUser();
  const { error } = await supabase
    .from("patients")
    .update(patientBody(payload, me.id))
    .eq("id", id);
  if (error) throw new Error("No se pudo guardar la ficha.");
  return { ok: true };
}

export async function deletePatient(id: string): Promise<{ ok: true }> {
  const me = await requireUser();
  const folder = `${me.id}/${id}`;
  const { data: files } = await supabase.storage
    .from(FILES_BUCKET)
    .list(folder, { limit: 100, offset: 0 });
  const names = (files ?? [])
    .filter((f) => f.id != null)
    .map((f) => `${folder}/${f.name}`);
  if (names.length > 0) {
    await supabase.storage.from(FILES_BUCKET).remove(names);
  }
  const delSessions = await supabase.from("sessions").delete().eq("patient_id", id);
  if (delSessions.error) throw new Error("No se pudo eliminar el paciente.");
  const delPatient = await supabase.from("patients").delete().eq("id", id);
  if (delPatient.error) throw new Error("No se pudo eliminar el paciente.");
  return { ok: true };
}

/* ---------------- Sesiones ---------------- */

export interface SessionPayload {
  date: string;
  reason: string;
  treatment: string;
  pending: string;
  nextAppointment: string | null;
  systolic: number | null;
  diastolic: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperature: number | null;
  spo2: number | null;
  glucose: number | null;
  notes: string;
}

function sessionBody(payload: SessionPayload, ownerId: string, patientId?: string) {
  return {
    owner_id: ownerId,
    ...(patientId ? { patient_id: patientId } : {}),
    date: payload.date,
    reason: payload.reason,
    treatment: payload.treatment,
    pending: payload.pending,
    next_appointment: payload.nextAppointment,
    systolic: payload.systolic,
    diastolic: payload.diastolic,
    heart_rate: payload.heartRate,
    respiratory_rate: payload.respiratoryRate,
    temperature: payload.temperature,
    spo2: payload.spo2,
    glucose: payload.glucose,
    notes: payload.notes,
  };
}

export async function createSession(
  patientId: string,
  payload: SessionPayload,
): Promise<{ id: string }> {
  const me = await requireUser();
  const { data, error } = await supabase
    .from("sessions")
    .insert(sessionBody(payload, me.id, patientId))
    .select("id")
    .single();
  if (error || !data) throw new Error("No se pudo registrar la sesión.");
  return { id: (data as { id: string }).id };
}

export async function updateSession(
  id: string,
  payload: SessionPayload,
): Promise<{ ok: true }> {
  const me = await requireUser();
  const { error } = await supabase
    .from("sessions")
    .update(sessionBody(payload, me.id))
    .eq("id", id);
  if (error) throw new Error("No se pudo guardar la sesión.");
  return { ok: true };
}

export async function deleteSession(id: string): Promise<{ ok: true }> {
  const { error } = await supabase.from("sessions").delete().eq("id", id);
  if (error) throw new Error("No se pudo eliminar la sesión.");
  return { ok: true };
}

/* ---------------- Archivos del paciente ---------------- */

export async function listPatientFiles(patientId: string): Promise<PatientFile[]> {
  const me = await requireUser();
  const folder = `${me.id}/${patientId}`;
  const { data, error } = await supabase.storage.from(FILES_BUCKET).list(folder, {
    limit: 100,
    offset: 0,
    sortBy: { column: "created_at", order: "desc" },
  });
  if (error) throw new Error("No se pudieron cargar los archivos.");
  return (data ?? [])
    .filter((f) => f.id != null)
    .map((f) => ({
      name: f.name,
      path: `${folder}/${f.name}`,
      size: f.metadata?.size ?? null,
      createdAt: f.created_at ?? null,
    }));
}

export async function uploadPatientFile(patientId: string, file: File): Promise<void> {
  const me = await requireUser();
  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${me.id}/${patientId}/${Date.now()}-${safeName}`;
  // Subida directa a Supabase Storage (sin pasar por un servidor), así que
  // ya no aplica el límite de 8 MB del puente de la versión de Muse.
  const { error } = await supabase.storage.from(FILES_BUCKET).upload(path, file, {
    contentType: file.type || "application/octet-stream",
  });
  if (error) throw new Error("No se pudo subir el archivo.");
}

export async function deletePatientFile(path: string): Promise<void> {
  const { error } = await supabase.storage.from(FILES_BUCKET).remove([path]);
  if (error) throw new Error("No se pudo eliminar el archivo.");
}

export async function patientFileUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(FILES_BUCKET)
    .createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) {
    throw new Error("No se pudo generar el enlace del archivo.");
  }
  return data.signedUrl;
}
