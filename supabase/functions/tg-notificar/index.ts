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

serve(async (req) => {
  if (req.method !== "POST") return new Response("OK");

  const { tipo, reserva_id } = await req.json();

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: r } = await db
    .from("reservas")
    .select("id,fecha,hora,estado,notas,clientes(nombre,telefono),servicios(nombre,precio)")
    .eq("id", reserva_id)
    .single();

  if (!r) return new Response("not found", { status: 404 });

  const nombre   = r.clientes?.nombre   || "—";
  const tel      = r.clientes?.telefono || "—";
  const servicio = r.servicios?.nombre  || "—";
  const precio   = r.servicios?.precio  ? ` · ${r.servicios.precio}€` : "";
  const fecha    = new Date(r.fecha + "T12:00:00").toLocaleDateString("es", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Madrid",
  });
  const hora = r.hora?.slice(0, 5) || "—";

  const mensajes: Record<string, string> = {
    nueva:
      `✂️ <b>NUEVA RESERVA</b>\n\n` +
      `👤 ${nombre}\n` +
      `📱 ${tel}\n` +
      `💈 ${servicio}${precio}\n` +
      `📅 ${fecha.charAt(0).toUpperCase() + fecha.slice(1)}\n` +
      `🕐 ${hora}` +
      (r.notas ? `\n📝 ${r.notas}` : ""),

    cancelada:
      `❌ <b>RESERVA CANCELADA</b>\n\n` +
      `👤 ${nombre}\n` +
      `💈 ${servicio}\n` +
      `📅 ${fecha.charAt(0).toUpperCase() + fecha.slice(1)}\n` +
      `🕐 ${hora}`,

    confirmada:
      `✅ <b>CITA CONFIRMADA</b>\n\n` +
      `👤 ${nombre}\n` +
      `💈 ${servicio}\n` +
      `📅 ${fecha.charAt(0).toUpperCase() + fecha.slice(1)}\n` +
      `🕐 ${hora}`,

    completada:
      `🎉 <b>CITA COMPLETADA</b>\n\n` +
      `👤 ${nombre}\n` +
      `💈 ${servicio}${precio}`,
  };

  const texto = mensajes[tipo];
  if (texto) await tg(texto);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
