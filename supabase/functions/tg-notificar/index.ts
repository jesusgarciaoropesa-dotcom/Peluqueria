import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID   = Deno.env.get("TELEGRAM_CHAT_ID")!;

function escapeHtml(str: string): string {
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

async function tg(text: string, reply_markup?: object) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", reply_markup }),
  });
}

const TIPOS_VALIDOS = ["nueva", "cancelada", "confirmada", "completada"];

serve(async (req) => {
  if (req.method !== "POST") return new Response("OK");

  const body = await req.json().catch(() => null);
  if (!body) return new Response("OK");
  const { tipo, reserva_id } = body;

  if (!TIPOS_VALIDOS.includes(tipo) || !reserva_id) {
    return new Response("OK");
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: reserva } = await db
    .from("reservas")
    .select("id,fecha,hora,estado,notas,cliente_id,servicio_id,created_at,notificaciones_enviadas")
    .eq("id", reserva_id)
    .single();

  if (!reserva) return new Response("not found", { status: 404 });

  // ── Anti-abuso: nadie puede usar este endpoint público para mandar
  //    avisos falsos o repetidos con IDs de reserva ajenos ──────────
  if ((reserva.notificaciones_enviadas || []).includes(tipo)) {
    return new Response(JSON.stringify({ ok: true, skipped: "ya notificado" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (tipo === "nueva") {
    // Solo justo tras crearse (la web la dispara al momento)
    const creada = new Date(reserva.created_at).getTime();
    if (Date.now() - creada > 5 * 60 * 1000) {
      return new Response(JSON.stringify({ ok: true, skipped: "fuera de plazo" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  } else if (reserva.estado !== tipo) {
    // El tipo notificado debe coincidir con el estado real actual de la reserva
    return new Response(JSON.stringify({ ok: true, skipped: "estado no coincide" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const [{ data: cliente }, { data: servicio }] = await Promise.all([
    db.from("clientes").select("nombre,telefono").eq("id", reserva.cliente_id).single(),
    db.from("servicios").select("nombre,precio_desde").eq("id", reserva.servicio_id).single(),
  ]);

  const nombre    = escapeHtml(cliente?.nombre       || "—");
  const tel       = escapeHtml(cliente?.telefono     || "—");
  const svcNombre = escapeHtml(servicio?.nombre      || "—");
  const precio    = servicio?.precio_desde ? ` · desde ${servicio.precio_desde}€` : "";
  const fecha     = new Date(reserva.fecha + "T12:00:00").toLocaleDateString("es", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Madrid",
  });
  const hora    = reserva.hora?.slice(0, 5) || "—";

  let enviado = false;

  if (tipo === "nueva") {
    const texto =
      `✂️ <b>NUEVA RESERVA</b>\n\n` +
      `👤 ${nombre}\n` +
      `📱 ${tel}\n` +
      `💈 ${svcNombre}${precio}\n` +
      `📅 ${fecha.charAt(0).toUpperCase() + fecha.slice(1)}\n` +
      `🕐 ${hora}` +
      (reserva.notas ? `\n📝 ${escapeHtml(reserva.notas)}` : "");

    await tg(texto, {
      inline_keyboard: [[
        { text: "✅ Confirmar", callback_data: `confirmar:${reserva_id}` },
        { text: "❌ Cancelar",  callback_data: `cancelar:${reserva_id}` },
      ]],
    });
    enviado = true;
  } else {
    const mensajes: Record<string, string> = {
      cancelada:
        `❌ <b>RESERVA CANCELADA</b>\n\n` +
        `👤 ${nombre}\n` +
        `💈 ${svcNombre}\n` +
        `📅 ${fecha.charAt(0).toUpperCase() + fecha.slice(1)}\n` +
        `🕐 ${hora}`,

      confirmada:
        `✅ <b>CITA CONFIRMADA</b>\n\n` +
        `👤 ${nombre}\n` +
        `💈 ${svcNombre}\n` +
        `📅 ${fecha.charAt(0).toUpperCase() + fecha.slice(1)}\n` +
        `🕐 ${hora}`,

      completada:
        `🎉 <b>CITA COMPLETADA</b>\n\n` +
        `👤 ${nombre}\n` +
        `💈 ${svcNombre}${precio}`,
    };

    const texto = mensajes[tipo];
    if (texto) { await tg(texto); enviado = true; }
  }

  if (enviado) {
    await db.from("reservas")
      .update({ notificaciones_enviadas: [...(reserva.notificaciones_enviadas || []), tipo] })
      .eq("id", reserva_id);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
