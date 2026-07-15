import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN    = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID      = Deno.env.get("TELEGRAM_CHAT_ID")!;
const CRON_SECRET  = Deno.env.get("CRON_SECRET"); // opcional: si está configurado, se exige

function escapeHtml(str: string): string {
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

async function tg(text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
}

const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

serve(async (req) => {
  // Si hay CRON_SECRET configurado, exigirlo — evita que cualquiera
  // dispare este aviso repetidamente llamando a la URL pública.
  if (CRON_SECRET) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
  const hoyDate = new Date(hoy + "T12:00:00");
  const dow = hoyDate.getDay();
  const diaLabel = DIAS[dow];

  // ── Agenda del día ──
  const { data: reservasHoy } = await db.from("reservas")
    .select("hora,estado,cliente_id,servicio_id")
    .eq("fecha", hoy)
    .in("estado", ["pendiente","confirmada"])
    .order("hora");

  const total      = (reservasHoy || []).length;
  const pendientes = (reservasHoy || []).filter(r => r.estado === "pendiente").length;

  if (total === 0) {
    await tg(`📓 <b>Buenos días!</b>\n${diaLabel} sin citas — día libre ✌️`);
  } else {
    const clienteIds = [...new Set((reservasHoy || []).map((r: any) => r.cliente_id))];
    const servicioIds = [...new Set((reservasHoy || []).map((r: any) => r.servicio_id))];
    const [{ data: clientes }, { data: servicios }] = await Promise.all([
      db.from("clientes").select("id,nombre").in("id", clienteIds),
      db.from("servicios").select("id,nombre").in("id", servicioIds),
    ]);
    const cMap: Record<string, string> = {};
    (clientes || []).forEach((c: any) => { cMap[c.id] = escapeHtml(c.nombre); });
    const sMap: Record<string, string> = {};
    (servicios || []).forEach((s: any) => { sMap[s.id] = escapeHtml(s.nombre); });

    const lineas = (reservasHoy || []).map((r: any) =>
      `${r.estado === "confirmada" ? "✅" : "⏳"} <b>${r.hora?.slice(0,5)}</b>  ${cMap[r.cliente_id] || "—"} · ${sMap[r.servicio_id] || "—"}`
    ).join("\n");

    const aviso = pendientes > 0
      ? `\n\n⚠️ <i>${pendientes} cita${pendientes > 1 ? "s" : ""} sin confirmar</i>`
      : "";

    await tg(
      `📓 <b>AGENDA — ${diaLabel.toUpperCase()}</b>\n\n` +
      lineas +
      `\n\n<i>${total} cita${total > 1 ? "s" : ""} hoy</i>` +
      aviso
    );
  }

  // ── Stats de la semana anterior (solo los lunes) ──
  if (dow === 1) {
    const lunesAnt = new Date(hoyDate);
    lunesAnt.setDate(hoyDate.getDate() - 7);
    const desde = lunesAnt.toLocaleDateString("en-CA");
    const hasta = new Date(lunesAnt.getTime() + 6 * 86400000).toLocaleDateString("en-CA");

    const { data: semana } = await db.from("reservas")
      .select("estado,servicio_id").gte("fecha", desde).lte("fecha", hasta);
    const { data: svcs } = await db.from("servicios").select("id,precio_desde");
    const pMap: Record<string, number> = {};
    (svcs || []).forEach((s: any) => { pMap[s.id] = s.precio_desde || 0; });

    const sTotal       = semana?.length || 0;
    const sCompletadas = semana?.filter((r: any) => r.estado === "completada").length || 0;
    const sCanceladas  = semana?.filter((r: any) => r.estado === "cancelada").length  || 0;
    const ingreso      = (semana || [])
      .filter((r: any) => ["confirmada","completada"].includes(r.estado))
      .reduce((s: number, r: any) => s + (pMap[r.servicio_id] || 0), 0);

    const lunesLbl = lunesAnt.toLocaleDateString("es", { day: "numeric", month: "short" });
    const hastaLbl = new Date(lunesAnt.getTime() + 6*86400000).toLocaleDateString("es", { day: "numeric", month: "short" });

    await tg(
      `📊 <b>SEMANA ANTERIOR — ${lunesLbl} al ${hastaLbl}</b>\n\n` +
      `📋 Total reservas: <b>${sTotal}</b>\n` +
      `🎉 Completadas: ${sCompletadas}\n` +
      `❌ Canceladas: ${sCanceladas}\n\n` +
      `💰 Ingreso estimado: <b>${ingreso}€</b>`
    );
  }

  return new Response("OK");
});
