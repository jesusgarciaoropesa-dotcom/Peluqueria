import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID   = Deno.env.get("TELEGRAM_CHAT_ID")!;

async function tg(chatId: string | number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

function isoMadrid(offsetDias = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
}

const DIAS_CORTO = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const DIAS_LARGO = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body) return new Response("OK");

  const msg = body.message || body.edited_message;
  if (!msg?.text) return new Response("OK");

  const chatId = String(msg.chat.id);
  if (chatId !== CHAT_ID) return new Response("OK");   // solo el barbero

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const cmd = msg.text.trim().toLowerCase().split("@")[0].split(" ")[0];

  // ── /hoy ────────────────────────────────────────────────
  if (cmd === "/hoy" || cmd === "/citas") {
    const hoy = isoMadrid();
    const { data } = await db.from("reservas")
      .select("hora,estado,clientes(nombre),servicios(nombre)")
      .eq("fecha", hoy)
      .in("estado", ["pendiente","confirmada"])
      .order("hora");

    if (!data?.length) {
      await tg(chatId, `📓 Hoy no hay citas.`);
    } else {
      const diaLabel = DIAS_LARGO[new Date(hoy + "T12:00:00").getDay()];
      const lineas = data.map(r =>
        `${r.estado === "confirmada" ? "✅" : "⏳"} <b>${r.hora?.slice(0,5)}</b>  ${r.clientes?.nombre} · ${r.servicios?.nombre}`
      ).join("\n");
      await tg(chatId,
        `📓 <b>HOY — ${diaLabel.toUpperCase()}</b>\n\n${lineas}\n\n<i>${data.length} cita${data.length > 1 ? "s" : ""}</i>`
      );
    }

  // ── /manana ─────────────────────────────────────────────
  } else if (cmd === "/manana") {
    const manana = isoMadrid(1);
    const { data } = await db.from("reservas")
      .select("hora,estado,clientes(nombre),servicios(nombre)")
      .eq("fecha", manana)
      .in("estado", ["pendiente","confirmada"])
      .order("hora");

    if (!data?.length) {
      await tg(chatId, `📅 Mañana no hay citas.`);
    } else {
      const diaLabel = DIAS_LARGO[new Date(manana + "T12:00:00").getDay()];
      const lineas = data.map(r =>
        `${r.estado === "confirmada" ? "✅" : "⏳"} <b>${r.hora?.slice(0,5)}</b>  ${r.clientes?.nombre} · ${r.servicios?.nombre}`
      ).join("\n");
      await tg(chatId,
        `📅 <b>MAÑANA — ${diaLabel.toUpperCase()}</b>\n\n${lineas}\n\n<i>${data.length} cita${data.length > 1 ? "s" : ""}</i>`
      );
    }

  // ── /semana ─────────────────────────────────────────────
  } else if (cmd === "/semana") {
    const hoyStr = isoMadrid();
    const hoyDate = new Date(hoyStr + "T12:00:00");
    const dow = hoyDate.getDay();
    const lunes = new Date(hoyDate);
    lunes.setDate(hoyDate.getDate() - (dow === 0 ? 6 : dow - 1));
    const desde = lunes.toLocaleDateString("en-CA");
    const hasta  = new Date(lunes.getTime() + 6 * 86400000).toLocaleDateString("en-CA");

    const { data } = await db.from("reservas")
      .select("fecha,hora,estado,clientes(nombre),servicios(nombre)")
      .gte("fecha", desde).lte("fecha", hasta)
      .in("estado", ["pendiente","confirmada"])
      .order("fecha").order("hora");

    if (!data?.length) {
      await tg(chatId, `📅 Esta semana no hay citas.`);
    } else {
      const porDia: Record<string, typeof data> = {};
      data.forEach(r => { (porDia[r.fecha] ??= []).push(r); });

      const bloques = Object.entries(porDia).map(([fecha, rs]) => {
        const d = new Date(fecha + "T12:00:00");
        const header = `<b>${DIAS_CORTO[d.getDay()]} ${d.getDate()}</b>`;
        const lineas = rs.map(r =>
          `  ${r.estado === "confirmada" ? "✅" : "⏳"} ${r.hora?.slice(0,5)}  ${r.clientes?.nombre}`
        ).join("\n");
        return `${header}\n${lineas}`;
      }).join("\n\n");

      await tg(chatId,
        `📅 <b>ESTA SEMANA</b>\n\n${bloques}\n\n<i>${data.length} citas en total</i>`
      );
    }

  // ── /ayuda / /start ──────────────────────────────────────
  } else if (["/ayuda","/start","/help"].includes(cmd)) {
    await tg(chatId,
      `✂️ <b>WTJ Barber Shop Bot</b>\n\n` +
      `/hoy — agenda de hoy\n` +
      `/manana — agenda de mañana\n` +
      `/semana — agenda de esta semana\n\n` +
      `Las notificaciones llegan automáticamente cuando hay reservas nuevas, cancelaciones y cambios de estado.`
    );
  }

  return new Response("OK");
});
