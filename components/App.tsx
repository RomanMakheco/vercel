import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jsPDF } from "jspdf";
import * as db from "../lib/data";
import type { AuthUser, Patient, Session, Vitals } from "../lib/data";

// La plataforma muestra sus propios mensajes genéricos en inglés cuando una
// acción falla sin detalle (p. ej. «Something went wrong. Please try again.»
// o «The app is busy right now…»). Aquí se traducen a un aviso claro en
// español; cualquier otro mensaje (los de la app ya están en español) pasa
// tal cual.
export function mensajeAmable(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes("something went wrong"))
    return "Algo salió mal al contactar el servidor. Espera unos segundos e inténtalo de nuevo; si sigue fallando, cierra la app y vuelve a abrirla.";
  if (m.includes("app is busy"))
    return "El servidor está ocupado en este momento. Espera unos segundos e inténtalo de nuevo.";
  if (m.includes("could not confirm the result"))
    return "No se pudo confirmar el resultado. Recarga la app para revisar tus datos antes de intentarlo de nuevo.";
  if (m.includes("session has been refreshed"))
    return "Tu sesión se renovó. Recarga la app para revisar tus datos antes de intentarlo de nuevo.";
  return raw;
}

// Límites de los campos del formulario: son los mismos que valida la app
// (nombre máximo 120 caracteres, notas 2000, rangos de signos vitales, etc.).
// En la versión de Muse venían de las acciones del servidor; aquí quedan
// declarados en el cliente y Supabase aplica sus propias reglas (RLS).
const FIELDS = {
  createPatient: {
    fullName: { maxLength: 120, required: true },
    phone: { maxLength: 30 },
    emergencyContactName: { maxLength: 120 },
    emergencyContactPhone: { maxLength: 30 },
    allergies: { maxLength: 1000 },
    conditions: { maxLength: 1000 },
    medications: { maxLength: 1000 },
    notes: { maxLength: 2000 },
  },
  createSession: {
    reason: { maxLength: 500 },
    treatment: { maxLength: 2000 },
    pending: { maxLength: 1000 },
    notes: { maxLength: 2000 },
    systolic: { min: 40, max: 300 },
    diastolic: { min: 20, max: 200 },
    heartRate: { min: 20, max: 250 },
    respiratoryRate: { min: 4, max: 80 },
    temperature: { min: 30, max: 45 },
    spo2: { min: 50, max: 100 },
    glucose: { min: 20, max: 600 },
  },
  deleteAccount: {
    password: { maxLength: 200, required: true },
  },
} as const;

type PatientData = Patient;
type SessionData = Session;

/* ---------------- Fechas ---------------- */

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

function ageFrom(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const birth = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/* ---------------- Signos vitales ---------------- */

type VitalStatus = "ok" | "warn" | "critical";

interface VitalDef {
  key: keyof Vitals;
  label: string;
  unit: string;
  status: (v: number) => VitalStatus;
}

const VITALS: VitalDef[] = [
  {
    key: "systolic",
    label: "Presión sistólica",
    unit: "mmHg",
    status: (v) => (v >= 180 || v <= 80 ? "critical" : v < 90 || v > 140 ? "warn" : "ok"),
  },
  {
    key: "diastolic",
    label: "Presión diastólica",
    unit: "mmHg",
    status: (v) => (v >= 120 || v <= 50 ? "critical" : v < 60 || v > 90 ? "warn" : "ok"),
  },
  {
    key: "heartRate",
    label: "Frecuencia cardiaca",
    unit: "lpm",
    status: (v) => (v >= 130 || v <= 40 ? "critical" : v < 60 || v > 100 ? "warn" : "ok"),
  },
  {
    key: "respiratoryRate",
    label: "Frecuencia respiratoria",
    unit: "rpm",
    status: (v) => (v >= 30 || v <= 8 ? "critical" : v < 12 || v > 20 ? "warn" : "ok"),
  },
  {
    key: "temperature",
    label: "Temperatura",
    unit: "°C",
    status: (v) => (v >= 39.5 || v <= 35 ? "critical" : v < 36 || v > 37.5 ? "warn" : "ok"),
  },
  {
    key: "spo2",
    label: "Saturación de oxígeno",
    unit: "%",
    status: (v) => (v <= 90 ? "critical" : v < 95 ? "warn" : "ok"),
  },
  {
    key: "glucose",
    label: "Glucosa",
    unit: "mg/dL",
    status: (v) => (v >= 250 || v <= 60 ? "critical" : v < 70 || v > 140 ? "warn" : "ok"),
  },
];

function vitalsAlerts(vitals: Vitals): { def: VitalDef; value: number; status: VitalStatus }[] {
  const out: { def: VitalDef; value: number; status: VitalStatus }[] = [];
  for (const def of VITALS) {
    const value = vitals[def.key];
    if (value == null) continue;
    const status = def.status(value);
    if (status !== "ok") out.push({ def, value, status });
  }
  return out;
}

function VitalGrid({ vitals }: { vitals: Vitals }) {
  const present = VITALS.filter((def) => vitals[def.key] != null);
  if (present.length === 0) return null;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {present.map((def) => {
          const value = vitals[def.key] as number;
          const status = def.status(value);
          const cls =
            status === "critical"
              ? "bg-[var(--danger-soft)] text-[var(--danger)]"
              : status === "warn"
                ? "bg-[var(--warn-soft)] text-[var(--warn)]"
                : "bg-[var(--surface-alt)] text-[var(--text)]";
          return (
            <div key={def.key} className={`rounded-lg px-3 py-2 ${cls}`}>
              <p className="text-[11px] font-medium leading-tight opacity-80">{def.label}</p>
              <p className="mt-0.5 text-base font-semibold leading-tight">
                {def.key === "temperature" ? value.toFixed(1) : value}
                <span className="ml-1 text-[11px] font-normal opacity-80">{def.unit}</span>
              </p>
              {status !== "ok" && (
                <p className="text-[11px] font-semibold">
                  {status === "critical" ? "Valor crítico" : "Fuera de rango"}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-[var(--dim)]">
        Rangos de referencia para adultos; la valoración final es del estudiante y su supervisor.
      </p>
    </div>
  );
}

/* ---------------- Piezas pequeñas ---------------- */

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-[var(--text)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--dim)]">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";
const textareaCls = `${inputCls} min-h-20`;

function PrimaryButton({
  children,
  onClick,
  disabled,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "submit" | "button";
}) {
  return (
    <button
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
  danger,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
        danger
          ? "border-[var(--danger)] text-[var(--danger)]"
          : "border-[var(--border)] text-[var(--text)]"
      }`}
    >
      {children}
    </button>
  );
}

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/45 sm:items-center">
      <div className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-5 pb-safe sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-semibold text-[var(--text)]">{title}</h2>
          <button
            type="button"
            aria-label="Cerrar formulario"
            onClick={onClose}
            className="rounded-full border border-[var(--border)] px-3 text-[var(--dim)]"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmDelete({
  text,
  onConfirm,
  onCancel,
  busy,
}: {
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-lg bg-[var(--danger-soft)] p-3">
      <p className="text-sm text-[var(--danger)]">{text}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-lg bg-[var(--danger)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Sí, eliminar
        </button>
        <GhostButton onClick={onCancel}>Cancelar</GhostButton>
      </div>
    </div>
  );
}

/* ---------------- Formulario de paciente ---------------- */

interface PatientFormValues {
  fullName: string;
  birthDate: string;
  phone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  allergies: string;
  conditions: string;
  medications: string;
  consentSigned: boolean;
  notes: string;
}

function PatientForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: PatientData | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [values, setValues] = useState<PatientFormValues>({
    fullName: initial?.fullName ?? "",
    birthDate: initial?.birthDate ?? "",
    phone: initial?.phone ?? "",
    emergencyContactName: initial?.emergencyContactName ?? "",
    emergencyContactPhone: initial?.emergencyContactPhone ?? "",
    allergies: initial?.allergies ?? "",
    conditions: initial?.conditions ?? "",
    medications: initial?.medications ?? "",
    consentSigned: initial?.consentSigned ?? false,
    notes: initial?.notes ?? "",
  });
  const [nameError, setNameError] = useState("");
  const [saveError, setSaveError] = useState("");

  const set = (patch: Partial<PatientFormValues>) =>
    setValues((v) => ({ ...v, ...patch }));

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        fullName: values.fullName.trim(),
        birthDate: values.birthDate ? values.birthDate : null,
        phone: values.phone,
        emergencyContactName: values.emergencyContactName,
        emergencyContactPhone: values.emergencyContactPhone,
        allergies: values.allergies,
        conditions: values.conditions,
        medications: values.medications,
        consentSigned: values.consentSigned,
        notes: values.notes,
      };
      if (initial) {
        await db.updatePatient(initial.id, payload);
        return initial.id;
      }
      const created = await db.createPatient(payload);
      return created.id;
    },
    onSuccess: (id) => onSaved(id),
    onError: (error) =>
      setSaveError(error instanceof Error ? error.message : "Inténtalo de nuevo."),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!values.fullName.trim()) {
      setNameError("Escribe el nombre completo del paciente.");
      return;
    }
    setNameError("");
    setSaveError("");
    mutation.mutate();
  };

  return (
    <Sheet
      title={initial ? "Editar ficha del paciente" : "Nuevo paciente"}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nombre completo *">
          <input
            {...FIELDS.createPatient.fullName}
            className={inputCls}
            value={values.fullName}
            onChange={(e) => set({ fullName: e.target.value })}
            placeholder="Ej. María González López"
            autoComplete="off"
          />
          {nameError && <span className="mt-1 block text-xs text-[var(--danger)]">{nameError}</span>}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Fecha de nacimiento">
            <input
              type="date"
              aria-label="Fecha de nacimiento"
              className={inputCls}
              value={values.birthDate}
              onChange={(e) => set({ birthDate: e.target.value })}
            />
          </Field>
          <Field label="Teléfono / WhatsApp">
            <input
              {...FIELDS.createPatient.phone}
              type="tel"
              className={inputCls}
              value={values.phone}
              onChange={(e) => set({ phone: e.target.value })}
              placeholder="Ej. 999 123 4567"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Contacto de emergencia">
            <input
              {...FIELDS.createPatient.emergencyContactName}
              className={inputCls}
              value={values.emergencyContactName}
              onChange={(e) => set({ emergencyContactName: e.target.value })}
              placeholder="Nombre"
            />
          </Field>
          <Field label="Teléfono de emergencia">
            <input
              {...FIELDS.createPatient.emergencyContactPhone}
              type="tel"
              className={inputCls}
              value={values.emergencyContactPhone}
              onChange={(e) => set({ emergencyContactPhone: e.target.value })}
              placeholder="Teléfono"
            />
          </Field>
        </div>

        <Field label="Alergias" hint="Se muestran como alerta en la ficha. Si no tiene, escribe «Ninguna conocida».">
          <textarea
            {...FIELDS.createPatient.allergies}
            className={textareaCls}
            value={values.allergies}
            onChange={(e) => set({ allergies: e.target.value })}
            placeholder="Ej. Penicilina, látex…"
          />
        </Field>

        <Field label="Enfermedades / padecimientos">
          <textarea
            {...FIELDS.createPatient.conditions}
            className={textareaCls}
            value={values.conditions}
            onChange={(e) => set({ conditions: e.target.value })}
            placeholder="Ej. Diabetes tipo 2, hipertensión…"
          />
        </Field>

        <Field label="Medicamentos actuales">
          <textarea
            {...FIELDS.createPatient.medications}
            className={textareaCls}
            value={values.medications}
            onChange={(e) => set({ medications: e.target.value })}
            placeholder="Ej. Metformina 850 mg, losartán 50 mg…"
          />
        </Field>

        <label className="flex min-h-11 items-center gap-3 rounded-lg bg-[var(--surface-alt)] px-3 py-2">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[var(--accent)]"
            checked={values.consentSigned}
            onChange={(e) => set({ consentSigned: e.target.checked })}
          />
          <span className="text-sm text-[var(--text)]">
            El paciente firmó el consentimiento informado
          </span>
        </label>

        <Field label="Notas generales">
          <textarea
            {...FIELDS.createPatient.notes}
            className={textareaCls}
            value={values.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Observaciones que no van en una sesión…"
          />
        </Field>

        {saveError && <p className="text-sm text-[var(--danger)]">{saveError}</p>}

        <div className="flex gap-2 pt-1">
          <PrimaryButton type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : initial ? "Guardar cambios" : "Registrar paciente"}
          </PrimaryButton>
          <GhostButton onClick={onClose}>Cancelar</GhostButton>
        </div>
      </form>
    </Sheet>
  );
}

/* ---------------- Formulario de sesión ---------------- */

interface SessionFormValues {
  date: string;
  reason: string;
  treatment: string;
  pending: string;
  nextAppointment: string;
  notes: string;
  systolic: string;
  diastolic: string;
  heartRate: string;
  respiratoryRate: string;
  temperature: string;
  spo2: string;
  glucose: string;
}

function numOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function SessionForm({
  patientId,
  patientName,
  initial,
  onClose,
  onSaved,
}: {
  patientId: string;
  patientName: string;
  initial: SessionData | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<SessionFormValues>({
    date: initial?.date ?? todayStr(),
    reason: initial?.reason ?? "",
    treatment: initial?.treatment ?? "",
    pending: initial?.pending ?? "",
    nextAppointment: initial?.nextAppointment ?? "",
    notes: initial?.notes ?? "",
    systolic: initial?.vitals.systolic != null ? String(initial.vitals.systolic) : "",
    diastolic: initial?.vitals.diastolic != null ? String(initial.vitals.diastolic) : "",
    heartRate: initial?.vitals.heartRate != null ? String(initial.vitals.heartRate) : "",
    respiratoryRate:
      initial?.vitals.respiratoryRate != null ? String(initial.vitals.respiratoryRate) : "",
    temperature: initial?.vitals.temperature != null ? String(initial.vitals.temperature) : "",
    spo2: initial?.vitals.spo2 != null ? String(initial.vitals.spo2) : "",
    glucose: initial?.vitals.glucose != null ? String(initial.vitals.glucose) : "",
  });
  const [saveError, setSaveError] = useState("");

  const set = (patch: Partial<SessionFormValues>) =>
    setValues((v) => ({ ...v, ...patch }));

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        date: values.date || todayStr(),
        reason: values.reason,
        treatment: values.treatment,
        pending: values.pending,
        nextAppointment: values.nextAppointment ? values.nextAppointment : null,
        systolic: numOrNull(values.systolic),
        diastolic: numOrNull(values.diastolic),
        heartRate: numOrNull(values.heartRate),
        respiratoryRate: numOrNull(values.respiratoryRate),
        temperature: numOrNull(values.temperature),
        spo2: numOrNull(values.spo2),
        glucose: numOrNull(values.glucose),
        notes: values.notes,
      };
      if (initial) {
        await db.updateSession(initial.id, payload);
      } else {
        await db.createSession(patientId, payload);
      }
    },
    onSuccess: () => onSaved(),
    onError: (error) =>
      setSaveError(error instanceof Error ? error.message : "Inténtalo de nuevo."),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaveError("");
    mutation.mutate();
  };

  const vitalInput = (
    label: string,
    field: keyof SessionFormValues,
    fieldProps: InputHTMLAttributes<HTMLInputElement>,
    step?: string,
  ) => (
    <Field label={label}>
      <input
        {...fieldProps}
        type="number"
        aria-label={label}
        inputMode="decimal"
        step={step}
        className={inputCls}
        value={values[field]}
        onChange={(e) => set({ [field]: e.target.value } as Partial<SessionFormValues>)}
      />
    </Field>
  );

  return (
    <Sheet
      title={initial ? `Editar sesión · ${patientName}` : `Nueva sesión · ${patientName}`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Fecha de la sesión">
            <input
              type="date"
              aria-label="Fecha de la sesión"
              className={inputCls}
              value={values.date}
              onChange={(e) => set({ date: e.target.value })}
            />
          </Field>
          <Field label="Próxima cita">
            <input
              type="date"
              aria-label="Próxima cita"
              className={inputCls}
              value={values.nextAppointment}
              onChange={(e) => set({ nextAppointment: e.target.value })}
            />
          </Field>
        </div>

        <Field label="Motivo de la consulta">
          <input
            {...FIELDS.createSession.reason}
            className={inputCls}
            value={values.reason}
            onChange={(e) => set({ reason: e.target.value })}
            placeholder="Ej. Dolor en molar inferior derecho"
          />
        </Field>

        <Field label="Trabajo realizado">
          <textarea
            {...FIELDS.createSession.treatment}
            className={textareaCls}
            value={values.treatment}
            onChange={(e) => set({ treatment: e.target.value })}
            placeholder="Procedimiento, materiales, observaciones clínicas…"
          />
        </Field>

        <Field label="Pendiente para la siguiente sesión">
          <textarea
            {...FIELDS.createSession.pending}
            className={textareaCls}
            value={values.pending}
            onChange={(e) => set({ pending: e.target.value })}
            placeholder="Ej. Retirar puntos, tomar impresión…"
          />
        </Field>

        <fieldset className="rounded-xl border border-[var(--border)] p-3">
          <legend className="px-1 text-sm font-semibold text-[var(--text)]">
            Signos vitales
          </legend>
          <p className="mb-3 text-xs text-[var(--dim)]">
            Deja en blanco lo que no se haya medido. Al guardar, la ficha marca en ámbar o rojo
            lo que quede fuera del rango de referencia.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {vitalInput("Sistólica (mmHg)", "systolic", FIELDS.createSession.systolic)}
            {vitalInput("Diastólica (mmHg)", "diastolic", FIELDS.createSession.diastolic)}
            {vitalInput("Frec. cardiaca (lpm)", "heartRate", FIELDS.createSession.heartRate)}
            {vitalInput("Frec. respiratoria (rpm)", "respiratoryRate", FIELDS.createSession.respiratoryRate)}
            {vitalInput("Temperatura (°C)", "temperature", FIELDS.createSession.temperature, "0.1")}
            {vitalInput("SpO₂ (%)", "spo2", FIELDS.createSession.spo2)}
            {vitalInput("Glucosa (mg/dL)", "glucose", FIELDS.createSession.glucose)}
          </div>
        </fieldset>

        <Field label="Notas de la sesión">
          <textarea
            {...FIELDS.createSession.notes}
            className={textareaCls}
            value={values.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Cualquier detalle útil para la próxima visita…"
          />
        </Field>

        {saveError && <p className="text-sm text-[var(--danger)]">{saveError}</p>}

        <div className="flex gap-2 pt-1">
          <PrimaryButton type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : initial ? "Guardar cambios" : "Registrar sesión"}
          </PrimaryButton>
          <GhostButton onClick={onClose}>Cancelar</GhostButton>
        </div>
      </form>
    </Sheet>
  );
}

/* ---------------- Tarjeta de sesión ---------------- */

function SessionCard({
  session,
  onEdit,
  onDelete,
}: {
  session: SessionData;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const alerts = vitalsAlerts(session.vitals);
  const hasVitals = VITALS.some((d) => session.vitals[d.key] != null);
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-display text-base font-semibold text-[var(--text)]">
            {formatDate(session.date)}
          </p>
          {session.reason && (
            <p className="mt-0.5 text-sm text-[var(--dim)]">{session.reason}</p>
          )}
        </div>
        {alerts.length > 0 && (
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              alerts.some((a) => a.status === "critical")
                ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                : "bg-[var(--warn-soft)] text-[var(--warn)]"
            }`}
          >
            {alerts.length} {alerts.length === 1 ? "signo" : "signos"} fuera de rango
          </span>
        )}
      </div>

      {session.treatment && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
            Trabajo realizado
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--text)]">{session.treatment}</p>
        </div>
      )}

      {hasVitals && (
        <div className="mt-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
            Signos vitales
          </p>
          <VitalGrid vitals={session.vitals} />
        </div>
      )}

      {session.pending && (
        <div className="mt-3 rounded-lg bg-[var(--accent-soft)] px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--accent-strong)]">
            Pendiente
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--text)]">{session.pending}</p>
        </div>
      )}

      {session.notes && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--dim)]">{session.notes}</p>
      )}

      {session.nextAppointment && (
        <p className="mt-3 text-sm font-medium text-[var(--accent-strong)]">
          Próxima cita: {formatDate(session.nextAppointment)}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <GhostButton onClick={onEdit}>Editar sesión</GhostButton>
        <GhostButton onClick={onDelete} danger>
          Eliminar
        </GhostButton>
      </div>
    </article>
  );
}

/* ---------------- Archivos del paciente (bucket de Supabase) ---------------- */

function formatFileSize(size: number | null): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function PatientFiles({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState("");
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  const filesQuery = useQuery({
    queryKey: ["patient-files", patientId],
    queryFn: () => db.listPatientFiles(patientId),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["patient-files", patientId] });

  const upload = useMutation({
    mutationFn: (file: File) => db.uploadPatientFile(patientId, file),
    onSuccess: () => {
      setFileError("");
      invalidate();
    },
    onError: (error) =>
      setFileError(error instanceof Error ? error.message : "No se pudo subir el archivo."),
  });

  const remove = useMutation({
    mutationFn: (path: string) => db.deletePatientFile(path),
    onSuccess: () => {
      setDeletingPath(null);
      invalidate();
    },
    onError: (error) =>
      setFileError(error instanceof Error ? error.message : "No se pudo eliminar el archivo."),
  });

  const openFile = async (path: string) => {
    setFileError("");
    try {
      const url = await db.patientFileUrl(path);
      window.open(url, "_blank", "noopener");
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "No se pudo abrir el archivo.");
    }
  };

  const files = filesQuery.data ?? [];

  return (
    <section className="mt-4 rounded-2xl bg-[var(--surface)] p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold text-[var(--text)]">
            Archivos del paciente
          </h2>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            Radiografías, fotos y consentimientos. Solo tú puedes verlos.
          </p>
        </div>
        <PrimaryButton
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
        >
          {upload.isPending ? "Subiendo…" : "Subir archivo"}
        </PrimaryButton>
        <input
          ref={fileInputRef}
          type="file"
          aria-label="Elegir archivo del paciente"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) upload.mutate(file);
          }}
        />
      </div>

      {filesQuery.isPending && (
        <p className="mt-3 text-sm text-[var(--dim)]">Cargando archivos…</p>
      )}
      {filesQuery.isSuccess && files.length === 0 && (
        <p className="mt-3 text-sm text-[var(--dim)]">
          Todavía no hay archivos. Sube la primera radiografía o foto con el botón de arriba.
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-3 space-y-2">
          {files.map((f) => (
            <li key={f.path}>
              {deletingPath === f.path ? (
                <ConfirmDelete
                  text={`Se eliminará el archivo ${f.name.replace(/^\d+-/, "")}.`}
                  onConfirm={() => remove.mutate(f.path)}
                  onCancel={() => setDeletingPath(null)}
                  busy={remove.isPending}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface-alt)] px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--text)]">
                      {f.name.replace(/^\d+-/, "")}
                    </p>
                    <p className="text-xs text-[var(--dim)]">
                      {formatFileSize(f.size)}
                      {f.createdAt
                        ? ` · ${new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric" }).format(new Date(f.createdAt))}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <GhostButton onClick={() => void openFile(f.path)}>Abrir</GhostButton>
                    <GhostButton onClick={() => setDeletingPath(f.path)} danger>
                      Eliminar
                    </GhostButton>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {fileError && <p className="mt-3 text-sm text-[var(--danger)]">{fileError}</p>}
    </section>
  );
}

/* ---------------- Ficha del paciente ---------------- */

/* ---------------- PDF de la ficha (tamaño carta) ----------------
   Replica el formato de la pantalla: tarjeta del paciente con alerta de
   alergias, insignia de consentimiento, últimos signos vitales con los
   mismos colores de rango y una tarjeta por sesión. Hoja carta
   (215.9 × 279.4 mm), márgenes de 14 mm. */

const PDF_COLORS = {
  bg: [244, 248, 247] as const,
  surface: [255, 255, 255] as const,
  surfaceAlt: [233, 242, 240] as const,
  text: [18, 49, 45] as const,
  dim: [91, 115, 112] as const,
  border: [215, 228, 225] as const,
  accent: [15, 118, 110] as const,
  accentStrong: [11, 90, 83] as const,
  accentSoft: [224, 240, 237] as const,
  warn: [180, 83, 9] as const,
  warnSoft: [253, 243, 227] as const,
  danger: [185, 28, 28] as const,
  dangerSoft: [253, 238, 238] as const,
};

type Rgb = readonly [number, number, number];

function generateFichaPdf(patient: PatientData, sessions: SessionData[]): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "letter", orientation: "portrait" });
  const PAGE_W = 215.9;
  const PAGE_H = 279.4;
  const MARGIN = 14;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const BOTTOM = PAGE_H - MARGIN - 6; // deja sitio para el pie de página
  let y = MARGIN;

  const lh = (size: number) => size * 0.47;
  const setFill = (c: Rgb) => doc.setFillColor(c[0], c[1], c[2]);
  const setStroke = (c: Rgb) => doc.setDrawColor(c[0], c[1], c[2]);
  const setInk = (c: Rgb) => doc.setTextColor(c[0], c[1], c[2]);
  const font = (size: number, style: "normal" | "bold" = "normal") => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
  };
  const wrapped = (text: string, width: number, size: number, style: "normal" | "bold" = "normal") => {
    font(size, style);
    return doc.splitTextToSize(text, width) as string[];
  };
  const textHeight = (text: string, width: number, size: number, style: "normal" | "bold" = "normal") =>
    wrapped(text, width, size, style).length * lh(size);

  const paintPageBg = () => {
    setFill(PDF_COLORS.bg);
    doc.rect(0, 0, PAGE_W, PAGE_H, "F");
  };
  paintPageBg();

  const newPage = () => {
    doc.addPage("letter", "portrait");
    paintPageBg();
    y = MARGIN;
  };
  const ensureSpace = (needed: number) => {
    if (y + needed > BOTTOM) newPage();
  };

  const drawText = (
    text: string,
    x: number,
    width: number,
    size: number,
    color: Rgb,
    style: "normal" | "bold" = "normal",
  ): number => {
    const lines = wrapped(text, width, size, style);
    setInk(color);
    font(size, style);
    doc.text(lines, x, y + size * 0.36);
    const h = lines.length * lh(size);
    y += h;
    return h;
  };

  const label = (text: string) => {
    font(7.5, "bold");
    setInk(PDF_COLORS.dim);
    doc.text(text.toUpperCase(), MARGIN + 4, y + 2.7);
    y += 4.2;
  };

  /* Dibuja la rejilla de signos vitales (igual que VitalGrid en pantalla).
     Devuelve la altura ocupada sin mover el cursor global. */
  const vitalsGridHeight = (vitals: Vitals, _width: number): number => {
    const present = VITALS.filter((d) => vitals[d.key] != null);
    if (present.length === 0) return 0;
    const cols = 3;
    const gap = 2;
    const rows = Math.ceil(present.length / cols);
    return rows * 15 + (rows - 1) * gap + 4.5; // + nota de rangos
  };

  const drawVitalsGrid = (vitals: Vitals, x0: number, width: number) => {
    const present = VITALS.filter((d) => vitals[d.key] != null);
    if (present.length === 0) return;
    const cols = 3;
    const gap = 2;
    const boxW = (width - gap * (cols - 1)) / cols;
    const boxH = 15;
    present.forEach((def, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const bx = x0 + col * (boxW + gap);
      const by = y + row * (boxH + gap);
      const value = vitals[def.key] as number;
      const status = def.status(value);
      const bg =
        status === "critical"
          ? PDF_COLORS.dangerSoft
          : status === "warn"
            ? PDF_COLORS.warnSoft
            : PDF_COLORS.surfaceAlt;
      const ink =
        status === "critical"
          ? PDF_COLORS.danger
          : status === "warn"
            ? PDF_COLORS.warn
            : PDF_COLORS.text;
      setFill(bg);
      doc.roundedRect(bx, by, boxW, boxH, 1.8, 1.8, "F");
      font(7);
      setInk(ink);
      doc.text(def.label, bx + 2.5, by + 4);
      font(11.5, "bold");
      const shown = def.key === "temperature" ? value.toFixed(1) : String(value);
      doc.text(shown, bx + 2.5, by + 9.6);
      const valueW = doc.getTextWidth(shown);
      font(7.5);
      doc.text(def.unit, bx + 2.5 + valueW + 1.2, by + 9.6);
      if (status !== "ok") {
        font(7, "bold");
        doc.text(status === "critical" ? "Valor crítico" : "Fuera de rango", bx + 2.5, by + 13.2);
      }
    });
    y += vitalsGridHeight(vitals, width);
    font(7);
    setInk(PDF_COLORS.dim);
    doc.text(
      "Rangos de referencia para adultos; la valoración final es del estudiante y su supervisor.",
      x0,
      y - 1.2,
    );
  };

  const card = (height: number) => {
    setFill(PDF_COLORS.surface);
    setStroke(PDF_COLORS.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(MARGIN, y, CONTENT_W, height, 3, 3, "FD");
  };

  /* ----- Encabezado del documento ----- */
  font(8, "bold");
  setInk(PDF_COLORS.accent);
  doc.text("FICHA DEL PACIENTE", MARGIN, y + 3);
  font(8);
  setInk(PDF_COLORS.dim);
  const generated = new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());
  doc.text(`Generada el ${generated}`, PAGE_W - MARGIN, y + 3, { align: "right" });
  y += 7;

  /* ----- Tarjeta del paciente ----- */
  const age = ageFrom(patient.birthDate);
  const innerW = CONTENT_W - 8;
  const detailItems: { label: string; value: string }[] = [];
  if (patient.conditions.trim())
    detailItems.push({ label: "Enfermedades", value: patient.conditions });
  if (patient.medications.trim())
    detailItems.push({ label: "Medicamentos", value: patient.medications });
  if (patient.emergencyContactName.trim() || patient.emergencyContactPhone.trim())
    detailItems.push({
      label: "Contacto de emergencia",
      value: [patient.emergencyContactName, patient.emergencyContactPhone]
        .filter(Boolean)
        .join(" · "),
    });
  if (patient.notes.trim()) detailItems.push({ label: "Notas", value: patient.notes });

  const colW = (innerW - 4) / 2;
  let detailsH = 0;
  for (let i = 0; i < detailItems.length; i += 2) {
    const pair = detailItems.slice(i, i + 2);
    detailsH +=
      Math.max(...pair.map((d) => 4.2 + textHeight(d.value, colW, 9.5))) + 2.5;
  }

  let headerH = 5 + 9 + 5.5; // relleno sup. + nombre + línea de edad/teléfono
  if (patient.allergies.trim())
    headerH += 3 + 4.2 + textHeight(patient.allergies, innerW - 5, 9.5, "bold") + 3.5;
  if (detailItems.length > 0) headerH += 2 + detailsH;
  headerH += 5; // relleno inferior

  ensureSpace(headerH);
  card(headerH);
  y += 5;
  const contentX = MARGIN + 4;
  // Nombre + insignia de consentimiento en la misma línea si cabe
  const badgeText = patient.consentSigned ? "Consentimiento firmado" : "Sin consentimiento firmado";
  font(8, "bold");
  const badgeW = doc.getTextWidth(badgeText) + 6;
  const badgeBg = patient.consentSigned ? PDF_COLORS.accentSoft : PDF_COLORS.warnSoft;
  const badgeInk = patient.consentSigned ? PDF_COLORS.accentStrong : PDF_COLORS.warn;
  const nameLines = wrapped(patient.fullName, innerW - badgeW - 3, 17, "bold");
  setFill(badgeBg);
  doc.roundedRect(MARGIN + CONTENT_W - 4 - badgeW, y + 0.5, badgeW, 7, 3.5, 3.5, "F");
  font(8, "bold");
  setInk(badgeInk);
  doc.text(badgeText, MARGIN + CONTENT_W - 4 - badgeW / 2, y + 5.2, { align: "center" });
  setInk(PDF_COLORS.text);
  font(17, "bold");
  doc.text(nameLines, contentX, y + 6.2);
  y += Math.max(nameLines.length * lh(17), 9);

  const subParts: string[] = [
    age != null ? `${age} años` : "Edad sin registrar",
    ...(patient.birthDate ? [`Nació el ${formatDate(patient.birthDate)}`] : []),
    ...(patient.phone ? [patient.phone] : []),
  ];
  drawText(subParts.join("  ·  "), contentX, innerW, 9.5, PDF_COLORS.dim);
  y += 1;

  if (patient.allergies.trim()) {
    y += 2;
    const lines = wrapped(patient.allergies, innerW - 5, 9.5, "bold");
    const boxH = 1 + 4.2 + lines.length * lh(9.5) + 2.5;
    setFill(PDF_COLORS.dangerSoft);
    doc.roundedRect(contentX, y, innerW, boxH, 2, 2, "F");
    font(7.5, "bold");
    setInk(PDF_COLORS.danger);
    doc.text("ALERGIAS", contentX + 2.5, y + 3.7);
    setInk(PDF_COLORS.text);
    font(9.5, "bold");
    doc.text(lines, contentX + 2.5, y + 1 + 4.2 + 3.4);
    y += boxH + 1;
  }

  if (detailItems.length > 0) {
    y += 2;
    for (let i = 0; i < detailItems.length; i += 2) {
      const pair = detailItems.slice(i, i + 2);
      const rowStart = y;
      let rowH = 0;
      pair.forEach((d, j) => {
        const x = contentX + j * (colW + 4);
        font(7.5, "bold");
        setInk(PDF_COLORS.dim);
        doc.text(d.label.toUpperCase(), x, rowStart + 2.7);
        const lines = wrapped(d.value, colW, 9.5);
        setInk(PDF_COLORS.text);
        font(9.5);
        doc.text(lines, x, rowStart + 4.2 + 3.4);
        rowH = Math.max(rowH, 4.2 + lines.length * lh(9.5));
      });
      y = rowStart + rowH + 2.5;
    }
  }
  y += 3;

  /* ----- Últimos signos vitales ----- */
  const lastSession = sessions[0];
  if (lastSession && VITALS.some((d) => lastSession.vitals[d.key] != null)) {
    const secH = 5 + 6.5 + 5 + vitalsGridHeight(lastSession.vitals, innerW) + 4;
    y += 4;
    ensureSpace(secH);
    card(secH);
    y += 5;
    font(12, "bold");
    setInk(PDF_COLORS.text);
    doc.text("Últimos signos vitales", contentX, y + 4.4);
    y += 6.5;
    font(8);
    setInk(PDF_COLORS.dim);
    doc.text(`Sesión del ${formatDate(lastSession.date)}`, contentX, y + 3);
    y += 5;
    drawVitalsGrid(lastSession.vitals, contentX, innerW);
    y += 4;
  }

  /* ----- Historial de sesiones ----- */
  y += 5;
  ensureSpace(10);
  font(13, "bold");
  setInk(PDF_COLORS.text);
  doc.text("Historial de sesiones", MARGIN, y + 4.8);
  const titleW = doc.getTextWidth("Historial de sesiones");
  const countText = `${sessions.length} ${sessions.length === 1 ? "registrada" : "registradas"}`;
  font(9);
  setInk(PDF_COLORS.dim);
  doc.text(countText, MARGIN + titleW + 4, y + 4.8);
  y += 9;

  if (sessions.length === 0) {
    ensureSpace(14);
    setStroke(PDF_COLORS.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(MARGIN, y, CONTENT_W, 14, 3, 3, "D");
    font(9.5);
    setInk(PDF_COLORS.dim);
    doc.text("Todavía no hay sesiones registradas para este paciente.", PAGE_W / 2, y + 8.5, {
      align: "center",
    });
    y += 14;
  }

  for (const s of sessions) {
    const alerts = vitalsAlerts(s.vitals);
    const hasVitals = VITALS.some((d) => s.vitals[d.key] != null);
    // Medir la tarjeta antes de dibujarla para no partirla entre páginas
    let h = 5 + 6; // relleno + fecha
    if (s.reason) h += textHeight(s.reason, innerW, 9.5) + 0.5;
    if (s.treatment) h += 3 + 4.2 + textHeight(s.treatment, innerW, 9.5);
    if (hasVitals) h += 3 + 4.2 + vitalsGridHeight(s.vitals, innerW);
    if (s.pending) h += 3 + 4.2 + textHeight(s.pending, innerW - 5, 9.5) + 3.5;
    if (s.notes) h += 3 + textHeight(s.notes, innerW, 9.5);
    if (s.nextAppointment) h += 3 + 5;
    h += 4;
    if (h <= BOTTOM - MARGIN) ensureSpace(h + 3);

    const cardTop = y;
    // Si la tarjeta es más alta que una página, se dibuja sin marco continuo.
    const singlePage = h <= BOTTOM - MARGIN;
    if (singlePage) card(h);
    y += 5;
    const dateText = formatDate(s.date);
    font(12, "bold");
    setInk(PDF_COLORS.text);
    doc.text(dateText, contentX, y + 4.4);
    if (alerts.length > 0) {
      const pill = `${alerts.length} ${alerts.length === 1 ? "signo" : "signos"} fuera de rango`;
      font(8, "bold");
      const pillW = doc.getTextWidth(pill) + 6;
      const critical = alerts.some((a) => a.status === "critical");
      setFill(critical ? PDF_COLORS.dangerSoft : PDF_COLORS.warnSoft);
      doc.roundedRect(MARGIN + CONTENT_W - 4 - pillW, y, pillW, 7, 3.5, 3.5, "F");
      setInk(critical ? PDF_COLORS.danger : PDF_COLORS.warn);
      doc.text(pill, MARGIN + CONTENT_W - 4 - pillW / 2, y + 4.7, { align: "center" });
    }
    y += 6;
    if (s.reason) {
      drawText(s.reason, contentX, innerW, 9.5, PDF_COLORS.dim);
      y += 0.5;
    }
    if (s.treatment) {
      y += 3;
      label("Trabajo realizado");
      // label() usa MARGIN+4; el contenido de la tarjeta empieza en contentX (igual)
      drawText(s.treatment, contentX, innerW, 9.5, PDF_COLORS.text);
    }
    if (hasVitals) {
      y += 3;
      label("Signos vitales");
      drawVitalsGrid(s.vitals, contentX, innerW);
    }
    if (s.pending) {
      y += 3;
      const boxH = 4.2 + textHeight(s.pending, innerW - 5, 9.5) + 3.5;
      if (!singlePage) ensureSpace(boxH);
      setFill(PDF_COLORS.accentSoft);
      doc.roundedRect(contentX, y, innerW, boxH, 2, 2, "F");
      font(7.5, "bold");
      setInk(PDF_COLORS.accentStrong);
      doc.text("PENDIENTE", contentX + 2.5, y + 3.7);
      const lines = wrapped(s.pending, innerW - 5, 9.5);
      setInk(PDF_COLORS.text);
      font(9.5);
      doc.text(lines, contentX + 2.5, y + 4.2 + 3.4);
      y += boxH;
    }
    if (s.notes) {
      y += 3;
      if (!singlePage) ensureSpace(textHeight(s.notes, innerW, 9.5));
      drawText(s.notes, contentX, innerW, 9.5, PDF_COLORS.dim);
    }
    if (s.nextAppointment) {
      y += 3;
      font(9.5, "bold");
      setInk(PDF_COLORS.accentStrong);
      doc.text(`Próxima cita: ${formatDate(s.nextAppointment)}`, contentX, y + 3.4);
      y += 5;
    }
    y = Math.max(y, cardTop + h) + 3;
  }

  /* ----- Pie de página en todas las hojas ----- */
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    setStroke(PDF_COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, PAGE_H - MARGIN - 1, PAGE_W - MARGIN, PAGE_H - MARGIN - 1);
    font(7.5);
    setInk(PDF_COLORS.dim);
    doc.text(`Ficha de ${patient.fullName}`, MARGIN, PAGE_H - MARGIN + 3.5);
    doc.text(`Página ${i} de ${total}`, PAGE_W - MARGIN, PAGE_H - MARGIN + 3.5, {
      align: "right",
    });
  }
  return doc;
}

function PatientDetail({
  patientId,
  onBack,
}: {
  patientId: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => db.getPatient(patientId),
  });
  const [editingPatient, setEditingPatient] = useState(false);
  const [sessionForm, setSessionForm] = useState<
    { mode: "new" } | { mode: "edit"; session: SessionData } | null
  >(null);
  const [confirmDeletePatient, setConfirmDeletePatient] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
    void queryClient.invalidateQueries({ queryKey: ["patients"] });
  };

  const deletePatient = useMutation({
    mutationFn: () => db.deletePatient(patientId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["patients"] });
      onBack();
    },
    onError: (error) =>
      setActionError(error instanceof Error ? error.message : "No se pudo eliminar."),
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => db.deleteSession(id),
    onSuccess: () => {
      setDeletingSessionId(null);
      invalidate();
    },
    onError: (error) =>
      setActionError(error instanceof Error ? error.message : "No se pudo eliminar."),
  });

  if (detail.isPending) {
    return <p className="py-10 text-center text-sm text-[var(--dim)]">Cargando ficha…</p>;
  }
  if (detail.error || !detail.data?.patient) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-[var(--danger)]">No se encontró la ficha de este paciente.</p>
        <div className="mt-4">
          <GhostButton onClick={onBack}>Volver a la lista</GhostButton>
        </div>
      </div>
    );
  }

  const patient = detail.data.patient;
  const sessions = detail.data.sessions;
  const age = ageFrom(patient.birthDate);
  const lastSession = sessions[0];

  const downloadFicha = () => {
    setPdfError("");
    setGeneratingPdf(true);
    try {
      const doc = generateFichaPdf(patient, sessions);
      const safeName = patient.fullName
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
      doc.save(`ficha-${safeName || "paciente"}.pdf`);
    } catch {
      setPdfError("No se pudo generar el PDF. Inténtalo de nuevo.");
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 text-sm font-medium text-[var(--accent-strong)]"
      >
        ← Todos los pacientes
      </button>

      <header className="rounded-2xl bg-[var(--surface)] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-[var(--text)]">
              {patient.fullName}
            </h1>
            <p className="mt-1 text-sm text-[var(--dim)]">
              {age != null ? `${age} años` : "Edad sin registrar"}
              {patient.birthDate ? ` · Nació el ${formatDate(patient.birthDate)}` : ""}
            </p>
            {patient.phone && (
              <p className="mt-1 text-sm">
                <a
                  href={`tel:${patient.phone.replace(/\s+/g, "")}`}
                  className="font-medium text-[var(--accent-strong)] underline"
                >
                  {patient.phone}
                </a>
              </p>
            )}
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              patient.consentSigned
                ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                : "bg-[var(--warn-soft)] text-[var(--warn)]"
            }`}
          >
            {patient.consentSigned ? "Consentimiento firmado" : "Sin consentimiento firmado"}
          </span>
        </div>

        {patient.allergies.trim() && (
          <div className="mt-4 rounded-lg bg-[var(--danger-soft)] px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--danger)]">
              Alergias
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm font-medium text-[var(--text)]">
              {patient.allergies}
            </p>
          </div>
        )}

        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          {patient.conditions.trim() && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
                Enfermedades
              </dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-[var(--text)]">{patient.conditions}</dd>
            </div>
          )}
          {patient.medications.trim() && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
                Medicamentos
              </dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-[var(--text)]">{patient.medications}</dd>
            </div>
          )}
          {(patient.emergencyContactName.trim() || patient.emergencyContactPhone.trim()) && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
                Contacto de emergencia
              </dt>
              <dd className="mt-0.5 text-[var(--text)]">
                {patient.emergencyContactName}
                {patient.emergencyContactPhone ? ` · ${patient.emergencyContactPhone}` : ""}
              </dd>
            </div>
          )}
          {patient.notes.trim() && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
                Notas
              </dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-[var(--text)]">{patient.notes}</dd>
            </div>
          )}
        </dl>

        <div className="mt-5 flex flex-wrap gap-2">
          <PrimaryButton onClick={() => setSessionForm({ mode: "new" })}>
            + Registrar sesión
          </PrimaryButton>
          <GhostButton onClick={() => setEditingPatient(true)}>Editar ficha</GhostButton>
          <GhostButton onClick={downloadFicha} disabled={generatingPdf}>
            {generatingPdf ? "Generando PDF…" : "Descargar ficha (PDF)"}
          </GhostButton>
          {!confirmDeletePatient && (
            <GhostButton onClick={() => setConfirmDeletePatient(true)} danger>
              Eliminar paciente
            </GhostButton>
          )}
        </div>
        {confirmDeletePatient && (
          <div className="mt-3">
            <ConfirmDelete
              text={`Se eliminará a ${patient.fullName} y sus ${sessions.length} sesiones. Esta acción no se puede deshacer.`}
              onConfirm={() => deletePatient.mutate()}
              onCancel={() => setConfirmDeletePatient(false)}
              busy={deletePatient.isPending}
            />
          </div>
        )}
        {actionError && <p className="mt-3 text-sm text-[var(--danger)]">{actionError}</p>}
        {pdfError && <p className="mt-3 text-sm text-[var(--danger)]">{pdfError}</p>}
      </header>

      {lastSession && VITALS.some((d) => lastSession.vitals[d.key] != null) && (
        <section className="mt-4 rounded-2xl bg-[var(--surface)] p-5 shadow-sm">
          <h2 className="font-display text-base font-semibold text-[var(--text)]">
            Últimos signos vitales
          </h2>
          <p className="mb-3 text-xs text-[var(--dim)]">
            Sesión del {formatDate(lastSession.date)}
          </p>
          <VitalGrid vitals={lastSession.vitals} />
        </section>
      )}

      <PatientFiles patientId={patient.id} />

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold text-[var(--text)]">
          Historial de sesiones
          <span className="ml-2 text-sm font-normal text-[var(--dim)]">
            {sessions.length} {sessions.length === 1 ? "registrada" : "registradas"}
          </span>
        </h2>
        {sessions.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center">
            <p className="text-sm text-[var(--dim)]">
              Todavía no hay sesiones registradas para este paciente.
            </p>
            <div className="mt-3">
              <PrimaryButton onClick={() => setSessionForm({ mode: "new" })}>
                Registrar la primera sesión
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {sessions.map((s) =>
              deletingSessionId === s.id ? (
                <ConfirmDelete
                  key={s.id}
                  text={`Se eliminará la sesión del ${formatDate(s.date)}.`}
                  onConfirm={() => deleteSession.mutate(s.id)}
                  onCancel={() => setDeletingSessionId(null)}
                  busy={deleteSession.isPending}
                />
              ) : (
                <SessionCard
                  key={s.id}
                  session={s}
                  onEdit={() => setSessionForm({ mode: "edit", session: s })}
                  onDelete={() => setDeletingSessionId(s.id)}
                />
              ),
            )}
          </div>
        )}
      </section>

      {editingPatient && (
        <PatientForm
          initial={patient}
          onClose={() => setEditingPatient(false)}
          onSaved={() => {
            setEditingPatient(false);
            invalidate();
          }}
        />
      )}
      {sessionForm && (
        <SessionForm
          patientId={patient.id}
          patientName={patient.fullName}
          initial={sessionForm.mode === "edit" ? sessionForm.session : null}
          onClose={() => setSessionForm(null)}
          onSaved={() => {
            setSessionForm(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

/* ---------------- Eliminar la cuenta ---------------- */

function DeleteAccountSheet({
  email,
  patientCount,
  onClose,
  onDeleted,
}: {
  email: string;
  patientCount: number | null;
  onClose: () => void;
  onDeleted: (authDeleted: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: async () => db.deleteAccount(password),
    onSuccess: (result) => onDeleted(result.authDeleted),
    onError: (err) =>
      setError(
        err instanceof Error
          ? mensajeAmable(err.message)
          : "No se pudo eliminar la cuenta. Inténtalo de nuevo.",
      ),
  });

  const canDelete =
    password.length > 0 &&
    confirmText.trim().toUpperCase() === "ELIMINAR" &&
    !mutation.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!password) {
      setError("Escribe tu contraseña para confirmar que eres tú.");
      return;
    }
    if (confirmText.trim().toUpperCase() !== "ELIMINAR") {
      setError("Escribe la palabra ELIMINAR para confirmar.");
      return;
    }
    mutation.mutate();
  };

  return (
    <Sheet title="Eliminar mi cuenta" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-[var(--danger-soft)] px-3 py-2">
          <p className="text-sm font-medium text-[var(--danger)]">
            Esta acción no se puede deshacer.
          </p>
          <p className="mt-1 text-sm text-[var(--text)]">
            Se eliminarán para siempre todos los datos de la cuenta de{" "}
            <span className="font-semibold">{email}</span>
            {patientCount != null
              ? `: sus ${patientCount} ${patientCount === 1 ? "paciente" : "pacientes"}`
              : ": todos sus pacientes"}
            , todas las sesiones clínicas y todos los archivos guardados
            (radiografías, fotos y consentimientos). Tu sesión se cerrará y la
            cuenta quedará vacía.
          </p>
        </div>

        <Field label="Tu contraseña" hint="La pedimos para confirmar que eres tú.">
          <input
            {...FIELDS.deleteAccount.password}
            type="password"
            autoComplete="current-password"
            className={inputCls}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Tu contraseña"
          />
        </Field>

        <Field
          label="Confirmación"
          hint="Escribe la palabra ELIMINAR en mayúsculas para activar el botón."
        >
          <input
            type="text"
            aria-label="Escribe ELIMINAR para confirmar"
            className={inputCls}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="ELIMINAR"
            autoComplete="off"
          />
        </Field>

        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="submit"
            disabled={!canDelete}
            className="rounded-lg bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {mutation.isPending ? "Eliminando…" : "Eliminar mi cuenta para siempre"}
          </button>
          <GhostButton onClick={onClose}>Cancelar</GhostButton>
        </div>
      </form>
    </Sheet>
  );
}

/* ---------------- Acceso con Supabase (correo y contraseña) ---------------- */

function authErrorMessage(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes("failed to fetch") || m.includes("network") || m.includes("load failed"))
    return "No se pudo contactar el servidor. Revisa tu conexión e inténtalo de nuevo.";
  if (m.includes("invalid login credentials"))
    return "Correo o contraseña incorrectos. Revisa tus datos e inténtalo de nuevo.";
  if (m.includes("email not confirmed") || m.includes("aún no está verificado"))
    return "Tu correo aún no está verificado. Toca el enlace del correo de verificación que te envió Supabase: te traerá de vuelta a esta app y tu cuenta quedará verificada en ese momento, para que ya puedas iniciar sesión. Si no te llegó, pide un reenvío con el botón de abajo.";
  if (m.includes("user already registered"))
    return "Ya existe una cuenta con ese correo. Inicia sesión con ella.";
  if (m.includes("password should be at least"))
    return "La contraseña debe tener al menos 6 caracteres.";
  if (m.includes("unable to validate email") || m.includes("invalid email"))
    return "Ese correo no parece válido. Revísalo e inténtalo de nuevo.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
  if (!raw) return "Algo salió mal. Inténtalo de nuevo.";
  return mensajeAmable(raw);
}

function AuthScreen({
  onSignedIn,
  banner,
}: {
  onSignedIn: (user: AuthUser) => void;
  banner?: string;
}) {
  const [mode, setMode] = useState<"login" | "register" | "verify">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Verificación de correo: tras crear la cuenta se muestra la pantalla de
  // verificación (pendingEmail); si alguien intenta entrar sin verificar,
  // unconfirmed activa el panel de reenvío bajo el formulario de acceso.
  const [pendingEmail, setPendingEmail] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState("");
  const [resendError, setResendError] = useState("");

  const resend = async (target: string) => {
    setResendNotice("");
    setResendError("");
    if (!target.trim()) {
      setResendError("Escribe tu correo para poder reenviar la verificación.");
      return;
    }
    setResendBusy(true);
    try {
      await db.resendConfirmation(target.trim());
      setResendNotice(
        `Correo de verificación reenviado a ${target.trim()}. Revisa tu bandeja de entrada y también la carpeta de spam.`,
      );
    } catch (err) {
      setResendError(
        authErrorMessage(err instanceof Error ? err.message : "Algo salió mal."),
      );
    } finally {
      setResendBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setUnconfirmed(false);
    setResendNotice("");
    setResendError("");
    if (!email.trim() || !password) {
      setError("Escribe tu correo y tu contraseña.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") {
        const user = await db.signIn(email.trim(), password);
        onSignedIn(user);
      } else {
        const result = await db.signUp(email.trim(), password);
        if (result.user) {
          onSignedIn(result.user);
        } else {
          // La cuenta quedó creada pero pendiente de verificación: no se
          // entra hasta tocar el enlace del correo de verificación.
          setPendingEmail(email.trim());
          setPassword("");
          setMode("verify");
        }
      }
    } catch (error) {
      const friendly = authErrorMessage(
        error instanceof Error ? error.message : "Algo salió mal.",
      );
      setError(friendly);
      if (friendly.includes("aún no está verificado")) setUnconfirmed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-start justify-center bg-[var(--bg)] px-4 pt-14 sm:items-center sm:pt-0">
      <main className="w-full max-w-sm rounded-2xl bg-[var(--surface)] p-6 shadow-sm">
        <h1 className="font-display text-2xl font-bold text-[var(--text)]">
          {mode === "login"
            ? "Inicia sesión"
            : mode === "register"
              ? "Crea tu cuenta"
              : "Verifica tu correo"}
        </h1>
        <p className="mt-1 text-sm text-[var(--dim)]">
          {mode === "verify"
            ? "Tu cuenta ya se creó, pero falta un paso: comprobar que el correo es tuyo."
            : "Con tu cuenta, tus pacientes y sesiones se guardan en la nube y solo tú puedes verlos."}
        </p>

        {banner && mode !== "verify" && (
          <p className="mt-4 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent-strong)]">
            {banner}
          </p>
        )}

        {mode !== "verify" && (
          <div className="mt-5 grid grid-cols-2 gap-2" role="tablist" aria-label="Acceso">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              onClick={() => {
                setMode("login");
                setError("");
                setNotice("");
                setUnconfirmed(false);
                setResendNotice("");
                setResendError("");
              }}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                mode === "login"
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--border)] text-[var(--text)]"
              }`}
            >
              Iniciar sesión
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              onClick={() => {
                setMode("register");
                setError("");
                setNotice("");
                setUnconfirmed(false);
                setResendNotice("");
                setResendError("");
              }}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                mode === "register"
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--border)] text-[var(--text)]"
              }`}
            >
              Crear cuenta
            </button>
          </div>
        )}

        {mode === "verify" ? (
          <div className="mt-5 space-y-4">
            <p className="rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent-strong)]">
              Te enviamos un correo de verificación a{" "}
              <span className="font-semibold">{pendingEmail}</span>. Hasta que lo
              verifiques, la cuenta no podrá entrar.
            </p>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--text)]">
              <li>Abre ese correo (revisa también la carpeta de spam).</li>
              <li>Toca el enlace de verificación que trae.</li>
              <li>
                El enlace te trae de vuelta a esta app y tu cuenta queda
                verificada en ese momento.
              </li>
              <li>Ya puedes iniciar sesión con tu correo y tu contraseña.</li>
            </ol>
            {resendNotice && (
              <p className="rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent-strong)]">
                {resendNotice}
              </p>
            )}
            {resendError && <p className="text-sm text-[var(--danger)]">{resendError}</p>}
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                onClick={() => {
                  setMode("login");
                  setError("");
                  setNotice("");
                  setResendNotice("");
                  setResendError("");
                }}
              >
                Ya verifiqué, iniciar sesión
              </PrimaryButton>
              <GhostButton
                onClick={() => void resend(pendingEmail)}
                disabled={resendBusy}
              >
                {resendBusy ? "Reenviando…" : "Reenviar correo"}
              </GhostButton>
              <GhostButton
                onClick={() => {
                  setMode("register");
                  setResendNotice("");
                  setResendError("");
                }}
              >
                Usar otro correo
              </GhostButton>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="mt-5 space-y-4">
            <Field
              label="Correo electrónico"
              hint={
                mode === "register"
                  ? "Puede ser cualquier correo, el personal o el de tu universidad. Te enviaremos un enlace para verificar que es tuyo y no podrás entrar hasta verificarlo."
                  : undefined
              }
            >
              <input
                type="email"
                autoComplete="email"
                className={inputCls}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tucorreo@ejemplo.com"
              />
            </Field>
          <Field
            label="Contraseña"
            hint={mode === "register" ? "Mínimo 6 caracteres." : undefined}
          >
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Tu contraseña"
            />
          </Field>

            {notice && (
              <p className="rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent-strong)]">
                {notice}
              </p>
            )}
            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

            {unconfirmed && mode === "login" && (
              <div className="rounded-lg bg-[var(--warn-soft)] px-3 py-2">
                <p className="text-sm text-[var(--text)]">
                  ¿No te llegó el correo de verificación o el enlace ya venció?
                  Pide que te lo enviemos otra vez a{" "}
                  <span className="font-semibold">{email.trim()}</span>.
                </p>
                {resendNotice && (
                  <p className="mt-2 text-sm font-medium text-[var(--accent-strong)]">
                    {resendNotice}
                  </p>
                )}
                {resendError && (
                  <p className="mt-2 text-sm text-[var(--danger)]">{resendError}</p>
                )}
                <div className="mt-2">
                  <GhostButton
                    onClick={() => void resend(email)}
                    disabled={resendBusy}
                  >
                    {resendBusy ? "Reenviando…" : "Reenviar correo de verificación"}
                  </GhostButton>
                </div>
              </div>
            )}

            <PrimaryButton type="submit" disabled={busy}>
              {busy
                ? "Espera un momento…"
                : mode === "login"
                  ? "Entrar"
                  : "Crear mi cuenta"}
            </PrimaryButton>
          </form>
        )}
      </main>
    </div>
  );
}

/* ---------------- App: lista de pacientes ---------------- */

export function App() {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [onlyUpcoming, setOnlyUpcoming] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletedBanner, setDeletedBanner] = useState("");

  useEffect(() => {
    let active = true;
    void db
      .restoreSession()
      .then((restored) => {
        if (active) setUser(restored);
      })
      .catch(() => {
        if (active) setUser(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSignOut = async () => {
    await db.signOut();
    setUser(null);
    setSelectedId(null);
    queryClient.clear();
  };

  const handleAccountDeleted = (authDeleted: boolean) => {
    setShowDeleteAccount(false);
    setSelectedId(null);
    setCreating(false);
    queryClient.clear();
    setDeletedBanner(
      authDeleted
        ? "Tu cuenta y todos tus datos fueron eliminados."
        : "Todos tus datos (pacientes, sesiones y archivos) fueron eliminados y tu sesión se cerró.",
    );
    setUser(null);
  };

  const patientsQuery = useQuery({
    queryKey: ["patients"],
    queryFn: () => db.listPatients(),
    enabled: user != null,
  });

  const today = todayStr();

  const filtered = useMemo(() => {
    const all = patientsQuery.data?.patients ?? [];
    const q = search.trim().toLowerCase();
    let list = all.filter(
      (p) =>
        !q ||
        p.fullName.toLowerCase().includes(q) ||
        p.phone.replace(/\s+/g, "").includes(q.replace(/\s+/g, "")),
    );
    if (onlyUpcoming) {
      list = list
        .filter((p) => p.nextAppointment != null && p.nextAppointment >= today)
        .sort((a, b) => (a.nextAppointment ?? "").localeCompare(b.nextAppointment ?? ""));
    }
    return list;
  }, [patientsQuery.data, search, onlyUpcoming, today]);

  const upcomingCount = useMemo(
    () =>
      (patientsQuery.data?.patients ?? []).filter(
        (p) => p.nextAppointment != null && p.nextAppointment >= today,
      ).length,
    [patientsQuery.data, today],
  );

  if (user === undefined) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <p className="py-16 text-center text-sm text-[var(--dim)]">Cargando…</p>
      </div>
    );
  }
  if (user === null) {
    return (
      <AuthScreen
        onSignedIn={(u) => {
          setDeletedBanner("");
          setUser(u);
        }}
        banner={deletedBanner || undefined}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--surface)] px-4 py-2.5 shadow-sm">
          <p className="min-w-0 truncate text-sm text-[var(--dim)]">
            Sesión de <span className="font-medium text-[var(--text)]">{user.email}</span>
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text)]"
            >
              Cerrar sesión
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteAccount(true)}
              className="rounded-lg border border-[var(--danger)] px-3 py-1.5 text-sm font-medium text-[var(--danger)]"
            >
              Eliminar cuenta
            </button>
          </div>
        </div>
        {selectedId != null ? (
          <PatientDetail patientId={selectedId} onBack={() => setSelectedId(null)} />
        ) : (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="font-display text-2xl font-bold text-[var(--text)]">Pacientes</h1>
                <p className="mt-0.5 text-sm text-[var(--dim)]">
                  {patientsQuery.data
                    ? `${patientsQuery.data.patients.length} ${
                        patientsQuery.data.patients.length === 1
                          ? "paciente registrado"
                          : "pacientes registrados"
                      }`
                    : "Cargando…"}
                </p>
              </div>
              <PrimaryButton onClick={() => setCreating(true)}>+ Nuevo paciente</PrimaryButton>
            </div>

            <div className="mt-4">
              <input
                type="search"
                aria-label="Buscar paciente por nombre o teléfono"
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-base text-[var(--text)] shadow-sm outline-none focus:border-[var(--accent)]"
                placeholder="Buscar por nombre o teléfono…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                aria-pressed={!onlyUpcoming}
                onClick={() => setOnlyUpcoming(false)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  !onlyUpcoming
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                }`}
              >
                Todos
              </button>
              <button
                type="button"
                aria-pressed={onlyUpcoming}
                onClick={() => setOnlyUpcoming(true)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  onlyUpcoming
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                }`}
              >
                Próximas citas ({upcomingCount})
              </button>
            </div>

            {patientsQuery.isPending && (
              <p className="py-10 text-center text-sm text-[var(--dim)]">Cargando pacientes…</p>
            )}
            {patientsQuery.error && (
              <p className="py-10 text-center text-sm text-[var(--danger)]">
                No se pudo cargar la lista de pacientes.
              </p>
            )}

            {patientsQuery.data && patientsQuery.data.patients.length === 0 && (
              <div className="mt-6 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
                <p className="font-display text-lg font-semibold text-[var(--text)]">
                  Aún no hay pacientes registrados
                </p>
                <p className="mx-auto mt-2 max-w-md text-sm text-[var(--dim)]">
                  Registra al primer paciente con su ficha clínica —alergias, enfermedades,
                  medicamentos y consentimiento— y después ve agregando cada sesión con sus
                  signos vitales para llevar el seguimiento completo.
                </p>
                <div className="mt-4">
                  <PrimaryButton onClick={() => setCreating(true)}>
                    Registrar el primer paciente
                  </PrimaryButton>
                </div>
              </div>
            )}

            {patientsQuery.data &&
              patientsQuery.data.patients.length > 0 &&
              filtered.length === 0 && (
                <p className="py-10 text-center text-sm text-[var(--dim)]">
                  {onlyUpcoming
                    ? "Ningún paciente tiene una próxima cita programada."
                    : "Ningún paciente coincide con esa búsqueda."}
                </p>
              )}

            <ul className="mt-4 space-y-3">
              {filtered.map((p) => {
                const age = ageFrom(p.birthDate);
                const hasUpcoming =
                  p.nextAppointment != null && p.nextAppointment >= today;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className="w-full rounded-2xl bg-[var(--surface)] p-4 text-left shadow-sm"
                      aria-label={`Abrir ficha de ${p.fullName}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-display truncate text-base font-semibold text-[var(--text)]">
                            {p.fullName}
                          </p>
                          <p className="mt-0.5 text-sm text-[var(--dim)]">
                            {age != null ? `${age} años` : "Edad sin registrar"}
                            {p.phone ? ` · ${p.phone}` : ""}
                          </p>
                        </div>
                        {!p.consentSigned && (
                          <span className="shrink-0 rounded-full bg-[var(--warn-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--warn)]">
                            Sin consentimiento
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
                        <span>
                          {p.sessionCount} {p.sessionCount === 1 ? "sesión" : "sesiones"}
                        </span>
                        {p.lastSessionDate && (
                          <span>Última sesión: {formatDate(p.lastSessionDate)}</span>
                        )}
                        {hasUpcoming && (
                          <span className="font-semibold text-[var(--accent-strong)]">
                            Próxima cita: {formatDate(p.nextAppointment)}
                          </span>
                        )}
                        {p.allergies.trim() && (
                          <span className="font-semibold text-[var(--danger)]">
                            Alergias registradas
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </main>

      {creating && (
        <PatientForm
          initial={null}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
        />
      )}

      {showDeleteAccount && (
        <DeleteAccountSheet
          email={user.email}
          patientCount={patientsQuery.data ? patientsQuery.data.patients.length : null}
          onClose={() => setShowDeleteAccount(false)}
          onDeleted={handleAccountDeleted}
        />
      )}
    </div>
  );
}
