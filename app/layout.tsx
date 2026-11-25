import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pacientes Odontología",
  description:
    "Seguimiento de pacientes para estudiantes de odontología: fichas, sesiones, signos vitales y archivos, con tu cuenta de Supabase.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
