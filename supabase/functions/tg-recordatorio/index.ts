import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID   = Deno.env.get("TELEGRAM_CHAT_ID")!;

async function tg(text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
}

serve(async () => {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Fecha de hoy en timezone de España
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
  const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const diaLabel = DIAS[new Date(hoy + "T12:00:00").getDay()];

  const { data: reservas } = await db
    .from("reservas")
    .select("hora,estado,clientes(nombre),servicios(nombre)")
    .eq("fecha", hoy)
    .in("estado", ["pendiente", "confirmada"])
    .order("hora");

  const total      = (reservas || []).length;
  const pendientes = (reservas || []).filter(r => r.estado === "pendiente").length;

  if (total === 0) {
    await tg(`📓 <b>Buenos días!</b>\n${diaLabel} sin citas — día libre ✌️`);
    return new Response("OK");
  }

  const lineas = (reservas || []).map(r => {
    const icono = r.estado === "confirmada" ? "✅" : "⏳";
    return `${icono} <b>${r.hora?.slice(0, 5)}</b>  ${r.clientes?.nombre} · ${r.servicios?.nombre}`;
  }).join("\n");

  const aviso = pendientes > 0
    ? `\n\n⚠️ <i>${pendientes} cita${pendientes > 1 ? "s" : ""} pendiente${pendientes > 1 ? "s" : ""} de confirmar</i>`
    : "";

  await tg(
    `📓 <b>AGENDA — ${diaLabel.toUpperCase()}</b>\n\n` +
    lineas +
    `\n\n<i>${total} cita${total > 1 ? "s" : ""} hoy</i>` +
    aviso
  );

  return new Response("OK");
});
