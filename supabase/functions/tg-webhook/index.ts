import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID   = Deno.env.get("TELEGRAM_CHAT_ID")!;

async function tg(chatId: string | number, text: string, reply_markup?: object) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", reply_markup }),
  });
}

async function answerCallback(callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function editMessage(chatId: string | number, messageId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }),
  });
}

function isoMadrid(offsetDias = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
}

function parseFecha(texto: string): string | null {
  const t = texto.toLowerCase().trim();
  if (t === "hoy") return isoMadrid();
  if (t === "mañana" || t === "manana") return isoMadrid(1);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) {
    const [d, m, y] = t.split("/");
    return `${y}-${m}-${d}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

function slotsDelDia(diaSem: number): string[] {
  if (diaSem === 0 || diaSem === 1) return [];
  if (diaSem === 6) return ["10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30"];
  return ["10:00","10:30","11:00","11:30","12:00","12:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30"];
}

const DIAS_CORTO = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const DIAS_LARGO = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

async function reservasDelDia(db: ReturnType<typeof createClient>, fecha: string) {
  const { data: reservas } = await db.from("reservas")
    .select("id,hora,estado,cliente_id,servicio_id")
    .eq("fecha", fecha)
    .in("estado", ["pendiente","confirmada"])
    .order("hora");
  if (!reservas?.length) return [];

  const clienteIds = [...new Set(reservas.map((r: any) => r.cliente_id))];
  const servicioIds = [...new Set(reservas.map((r: any) => r.servicio_id))];
  const [{ data: clientes }, { data: servicios }] = await Promise.all([
    db.from("clientes").select("id,nombre").in("id", clienteIds),
    db.from("servicios").select("id,nombre").in("id", servicioIds),
  ]);
  const cMap: Record<string, string> = {};
  (clientes || []).forEach((c: any) => { cMap[c.id] = c.nombre; });
  const sMap: Record<string, string> = {};
  (servicios || []).forEach((s: any) => { sMap[s.id] = s.nombre; });

  return reservas.map((r: any) => ({
    ...r,
    clienteNombre: cMap[r.cliente_id] || "—",
    servicioNombre: sMap[r.servicio_id] || "—",
    shortId: r.id.split("-")[0],
  }));
}

serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body) return new Response("OK");

  // ── Botones inline (callback_query) ─────────────────────
  if (body.callback_query) {
    const cbq    = body.callback_query;
    const chatId = String(cbq.message?.chat?.id);
    if (chatId !== CHAT_ID) return new Response("OK");

    const [accion, reservaId] = (cbq.data || "").split(":");
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (accion === "confirmar" || accion === "cancelar") {
      const nuevoEstado = accion === "confirmar" ? "confirmada" : "cancelada";
      const { data: r } = await db.from("reservas")
        .select("id,estado,cliente_id,fecha,hora")
        .eq("id", reservaId).single();

      if (!r) {
        await answerCallback(cbq.id, "❌ Reserva no encontrada");
      } else if (r.estado === nuevoEstado) {
        await answerCallback(cbq.id, `Ya estaba ${nuevoEstado}`);
      } else {
        await db.from("reservas").update({ estado: nuevoEstado }).eq("id", reservaId);
        const { data: c } = await db.from("clientes").select("nombre").eq("id", r.cliente_id).single();
        const ico = nuevoEstado === "confirmada" ? "✅" : "❌";
        await answerCallback(cbq.id, `${ico} ${nuevoEstado.charAt(0).toUpperCase() + nuevoEstado.slice(1)}`);
        // Actualizar el mensaje original quitando los botones
        const textoOriginal = cbq.message?.text || "";
        const cabecera = nuevoEstado === "confirmada"
          ? `✅ <b>CONFIRMADA</b> — ${c?.nombre || "—"}  🕐 ${r.hora?.slice(0,5)} · ${r.fecha}`
          : `❌ <b>CANCELADA</b> — ${c?.nombre || "—"}  🕐 ${r.hora?.slice(0,5)} · ${r.fecha}`;
        await editMessage(chatId, cbq.message.message_id,
          textoOriginal.split("\n\n")[0] + "\n\n" + cabecera
        );
      }
    }

    return new Response("OK");
  }

  const msg = body.message || body.edited_message;
  if (!msg?.text) return new Response("OK");

  const chatId = String(msg.chat.id);
  if (chatId !== CHAT_ID) return new Response("OK");

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const parts = msg.text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().split("@")[0];

  // ── /hoy ────────────────────────────────────────────────
  if (cmd === "/hoy" || cmd === "/citas") {
    const hoy = isoMadrid();
    const rs = await reservasDelDia(db, hoy);
    if (!rs.length) {
      await tg(chatId, `📓 Hoy no hay citas.`);
    } else {
      const dia = DIAS_LARGO[new Date(hoy + "T12:00:00").getDay()];
      const lineas = rs.map(r =>
        `${r.estado === "confirmada" ? "✅" : "⏳"} <b>${r.hora?.slice(0,5)}</b>  ${r.clienteNombre} · ${r.servicioNombre}  <code>#${r.shortId}</code>`
      ).join("\n");
      await tg(chatId, `📓 <b>HOY — ${dia.toUpperCase()}</b>\n\n${lineas}\n\n<i>${rs.length} cita${rs.length > 1 ? "s" : ""}</i>`);
    }

  // ── /manana ─────────────────────────────────────────────
  } else if (cmd === "/manana") {
    const manana = isoMadrid(1);
    const rs = await reservasDelDia(db, manana);
    if (!rs.length) {
      await tg(chatId, `📅 Mañana no hay citas.`);
    } else {
      const dia = DIAS_LARGO[new Date(manana + "T12:00:00").getDay()];
      const lineas = rs.map(r =>
        `${r.estado === "confirmada" ? "✅" : "⏳"} <b>${r.hora?.slice(0,5)}</b>  ${r.clienteNombre} · ${r.servicioNombre}`
      ).join("\n");
      await tg(chatId, `📅 <b>MAÑANA — ${dia.toUpperCase()}</b>\n\n${lineas}\n\n<i>${rs.length} cita${rs.length > 1 ? "s" : ""}</i>`);
    }

  // ── /semana ─────────────────────────────────────────────
  } else if (cmd === "/semana") {
    const hoyStr = isoMadrid();
    const hoyDate = new Date(hoyStr + "T12:00:00");
    const dow = hoyDate.getDay();
    const lunes = new Date(hoyDate);
    lunes.setDate(hoyDate.getDate() - (dow === 0 ? 6 : dow - 1));
    const desde = lunes.toLocaleDateString("en-CA");
    const hasta = new Date(lunes.getTime() + 6 * 86400000).toLocaleDateString("en-CA");

    const { data: reservas } = await db.from("reservas")
      .select("fecha,hora,estado,cliente_id")
      .gte("fecha", desde).lte("fecha", hasta)
      .in("estado", ["pendiente","confirmada"])
      .order("fecha").order("hora");

    if (!reservas?.length) {
      await tg(chatId, `📅 Esta semana no hay citas.`);
    } else {
      const clienteIds = [...new Set(reservas.map((r: any) => r.cliente_id))];
      const { data: clientes } = await db.from("clientes").select("id,nombre").in("id", clienteIds);
      const cMap: Record<string, string> = {};
      (clientes || []).forEach((c: any) => { cMap[c.id] = c.nombre; });

      const porDia: Record<string, any[]> = {};
      reservas.forEach((r: any) => { (porDia[r.fecha] ??= []).push(r); });

      const bloques = Object.entries(porDia).map(([fecha, rs]) => {
        const d = new Date(fecha + "T12:00:00");
        const header = `<b>${DIAS_CORTO[d.getDay()]} ${d.getDate()}</b>`;
        const lineas = rs.map((r: any) =>
          `  ${r.estado === "confirmada" ? "✅" : "⏳"} ${r.hora?.slice(0,5)}  ${cMap[r.cliente_id] || "—"}`
        ).join("\n");
        return `${header}\n${lineas}`;
      }).join("\n\n");

      await tg(chatId, `📅 <b>ESTA SEMANA</b>\n\n${bloques}\n\n<i>${reservas.length} citas en total</i>`);
    }

  // ── /proxima ─────────────────────────────────────────────
  } else if (cmd === "/proxima") {
    const hoy = isoMadrid();
    const ahora = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
    const { data: reservas } = await db.from("reservas")
      .select("id,fecha,hora,estado,cliente_id,servicio_id")
      .eq("fecha", hoy)
      .in("estado", ["pendiente","confirmada"])
      .gte("hora", ahora + ":00")
      .order("hora")
      .limit(1);

    if (!reservas?.length) {
      await tg(chatId, `⏭ No hay más citas hoy.`);
    } else {
      const r = reservas[0];
      const [{ data: cliente }, { data: servicio }] = await Promise.all([
        db.from("clientes").select("nombre,telefono").eq("id", r.cliente_id).single(),
        db.from("servicios").select("nombre").eq("id", r.servicio_id).single(),
      ]);
      const sid = r.id.split("-")[0];
      await tg(chatId,
        `⏭ <b>PRÓXIMA CITA</b>\n\n` +
        `🕐 <b>${r.hora?.slice(0,5)}</b> — ${r.estado === "confirmada" ? "✅ confirmada" : "⏳ pendiente"}\n` +
        `👤 ${cliente?.nombre || "—"}\n` +
        `📱 ${cliente?.telefono || "—"}\n` +
        `💈 ${servicio?.nombre || "—"}\n\n` +
        `/confirmar ${sid}  ·  /cancelar ${sid}`
      );
    }

  // ── /confirmar [id] ──────────────────────────────────────
  } else if (cmd === "/confirmar") {
    if (!parts[1]) {
      const { data: pendientes } = await db.from("reservas")
        .select("id,fecha,hora,cliente_id")
        .eq("estado", "pendiente")
        .gte("fecha", isoMadrid())
        .order("fecha").order("hora")
        .limit(8);

      if (!pendientes?.length) {
        await tg(chatId, `✅ No hay reservas pendientes de confirmar.`);
      } else {
        const ids = [...new Set(pendientes.map((r: any) => r.cliente_id))];
        const { data: clientes } = await db.from("clientes").select("id,nombre,telefono").in("id", ids);
        const cMap: Record<string, any> = {};
        (clientes || []).forEach((c: any) => { cMap[c.id] = c; });
        // Enviar un mensaje por reserva, cada uno con sus botones
        for (const r of pendientes) {
          const c = cMap[r.cliente_id];
          const d = new Date(r.fecha + "T12:00:00").toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
          const texto =
            `⏳ <b>PENDIENTE</b>\n\n` +
            `👤 ${c?.nombre || "—"}\n` +
            `📱 ${c?.telefono || "—"}\n` +
            `📅 ${d.charAt(0).toUpperCase() + d.slice(1)}\n` +
            `🕐 ${r.hora?.slice(0,5)}`;
          await tg(chatId, texto, {
            inline_keyboard: [[
              { text: "✅ Confirmar", callback_data: `confirmar:${r.id}` },
              { text: "❌ Cancelar",  callback_data: `cancelar:${r.id}` },
            ]],
          });
        }
      }
    } else {
      const sid = parts[1];
      const { data: rs } = await db.from("reservas")
        .select("id,estado,cliente_id,fecha,hora")
        .filter("id::text", "ilike", `${sid}%`)
        .limit(1);
      const r = rs?.[0];
      if (!r) {
        await tg(chatId, `❌ No encontré la reserva <code>#${sid}</code>`);
      } else if (r.estado === "confirmada") {
        await tg(chatId, `ℹ️ La reserva <code>#${sid}</code> ya está confirmada.`);
      } else {
        await db.from("reservas").update({ estado: "confirmada" }).eq("id", r.id);
        const { data: c } = await db.from("clientes").select("nombre").eq("id", r.cliente_id).single();
        await tg(chatId, `✅ Confirmada\n👤 ${c?.nombre || "—"}  🕐 ${r.hora?.slice(0,5)} · ${r.fecha}`);
      }
    }

  // ── /cancelar id ─────────────────────────────────────────
  } else if (cmd === "/cancelar") {
    if (!parts[1]) {
      await tg(chatId, `Uso: /cancelar <code>id</code>\n\nEl id aparece en la notificación de reserva o en /hoy`);
    } else {
      const sid = parts[1];
      const { data: rs } = await db.from("reservas")
        .select("id,estado,cliente_id,fecha,hora")
        .filter("id::text", "ilike", `${sid}%`)
        .limit(1);
      const r = rs?.[0];
      if (!r) {
        await tg(chatId, `❌ No encontré la reserva <code>#${sid}</code>`);
      } else if (r.estado === "cancelada") {
        await tg(chatId, `ℹ️ La reserva <code>#${sid}</code> ya está cancelada.`);
      } else {
        await db.from("reservas").update({ estado: "cancelada" }).eq("id", r.id);
        const { data: c } = await db.from("clientes").select("nombre").eq("id", r.cliente_id).single();
        await tg(chatId, `❌ Cancelada\n👤 ${c?.nombre || "—"}  🕐 ${r.hora?.slice(0,5)} · ${r.fecha}`);
      }
    }

  // ── /libre [fecha] hora ───────────────────────────────────
  } else if (cmd === "/libre") {
    let fecha: string | null = null;
    let hora: string | null = null;
    if (parts.length === 2) { fecha = isoMadrid(); hora = parts[1]; }
    else if (parts.length >= 3) { fecha = parseFecha(parts[1]); hora = parts[2]; }

    if (!fecha || !hora) {
      await tg(chatId, `Uso: /libre [fecha] hora\n\nEjemplos:\n/libre 17:00\n/libre mañana 10:00\n/libre 2026-07-05 16:30`);
    } else {
      const slots = slotsDelDia(new Date(fecha + "T12:00:00").getDay());
      if (!slots.length) {
        await tg(chatId, `🚫 Ese día está cerrado.`);
      } else if (!slots.includes(hora)) {
        await tg(chatId, `⚠️ ${hora} no es un horario válido.\n\nSlots ese día: ${slots.join(" · ")}`);
      } else {
        const { data } = await db.from("reservas")
          .select("id").eq("fecha", fecha).eq("hora", hora + ":00")
          .in("estado", ["pendiente","confirmada"]).limit(1);
        const d = new Date(fecha + "T12:00:00").toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
        const label = d.charAt(0).toUpperCase() + d.slice(1);
        await tg(chatId, data?.length
          ? `🔴 ${label} a las ${hora} ya está ocupado.`
          : `✅ ${label} a las ${hora} está libre.`
        );
      }
    }

  // ── /buscar nombre ───────────────────────────────────────
  } else if (cmd === "/buscar") {
    const nombre = parts.slice(1).join(" ");
    if (!nombre) {
      await tg(chatId, `Uso: /buscar <nombre>\n\nEjemplo: /buscar Juan`);
    } else {
      const { data: clientes } = await db.from("clientes")
        .select("id,nombre,telefono").ilike("nombre", `%${nombre}%`).limit(5);
      if (!clientes?.length) {
        await tg(chatId, `🔍 Sin resultados para "${nombre}".`);
      } else {
        const bloques = await Promise.all(clientes.map(async (c: any) => {
          const { data: rs } = await db.from("reservas")
            .select("fecha,hora,estado,servicio_id")
            .eq("cliente_id", c.id).order("fecha", { ascending: false }).limit(4);
          const sIds = [...new Set((rs || []).map((r: any) => r.servicio_id))];
          const { data: svcs } = await db.from("servicios").select("id,nombre").in("id", sIds);
          const sMap: Record<string, string> = {};
          (svcs || []).forEach((s: any) => { sMap[s.id] = s.nombre; });
          const hist = (rs || []).map((r: any) => {
            const ico = { confirmada:"✅", completada:"🎉", cancelada:"❌", pendiente:"⏳" }[r.estado] || "•";
            return `  ${ico} ${r.fecha} ${r.hora?.slice(0,5)} ${sMap[r.servicio_id] || ""}`;
          }).join("\n");
          return `👤 <b>${c.nombre}</b>  📱 ${c.telefono}\n${hist || "  Sin reservas"}`;
        }));
        await tg(chatId, `🔍 <b>Clientes: "${nombre}"</b>\n\n${bloques.join("\n\n")}`);
      }
    }

  // ── /bloquear fecha [motivo] ──────────────────────────────
  } else if (cmd === "/bloquear") {
    const fecha = parseFecha(parts[1] || "");
    if (!fecha) {
      await tg(chatId, `Uso: /bloquear <fecha> [motivo]\n\nEjemplos:\n/bloquear 2026-07-15\n/bloquear mañana festivo\n/bloquear 2026-08-01 Agosto`);
    } else {
      const motivo = parts.slice(2).join(" ") || null;
      const { error } = await db.from("dias_bloqueados").insert({ fecha, motivo });
      if (error?.code === "23505") {
        await tg(chatId, `ℹ️ El ${fecha} ya estaba bloqueado.`);
      } else if (error) {
        await tg(chatId, `❌ Error: ${error.message}`);
      } else {
        const d = new Date(fecha + "T12:00:00").toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
        await tg(chatId, `🔒 Bloqueado: ${d.charAt(0).toUpperCase() + d.slice(1)}${motivo ? ` — ${motivo}` : ""}`);
      }
    }

  // ── /desbloquear fecha ────────────────────────────────────
  } else if (cmd === "/desbloquear") {
    const fecha = parseFecha(parts[1] || "");
    if (!fecha) {
      await tg(chatId, `Uso: /desbloquear <fecha>\n\nEjemplo: /desbloquear 2026-07-15`);
    } else {
      await db.from("dias_bloqueados").delete().eq("fecha", fecha);
      const d = new Date(fecha + "T12:00:00").toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
      await tg(chatId, `🔓 Desbloqueado: ${d.charAt(0).toUpperCase() + d.slice(1)}`);
    }

  // ── /stats ───────────────────────────────────────────────
  } else if (cmd === "/stats") {
    const hoyStr = isoMadrid();
    const hoyDate = new Date(hoyStr + "T12:00:00");
    const dow = hoyDate.getDay();
    const lunes = new Date(hoyDate);
    lunes.setDate(hoyDate.getDate() - (dow === 0 ? 6 : dow - 1));
    const desde = lunes.toLocaleDateString("en-CA");
    const hasta = new Date(lunes.getTime() + 6 * 86400000).toLocaleDateString("en-CA");

    const { data: reservas } = await db.from("reservas")
      .select("estado,servicio_id").gte("fecha", desde).lte("fecha", hasta);
    const { data: svcs } = await db.from("servicios").select("id,precio_desde");
    const pMap: Record<string, number> = {};
    (svcs || []).forEach((s: any) => { pMap[s.id] = s.precio_desde || 0; });

    const total        = reservas?.length || 0;
    const confirmadas  = reservas?.filter((r: any) => r.estado === "confirmada").length  || 0;
    const completadas  = reservas?.filter((r: any) => r.estado === "completada").length  || 0;
    const pendientes   = reservas?.filter((r: any) => r.estado === "pendiente").length   || 0;
    const canceladas   = reservas?.filter((r: any) => r.estado === "cancelada").length   || 0;
    const ingreso      = (reservas || [])
      .filter((r: any) => ["confirmada","completada"].includes(r.estado))
      .reduce((s: number, r: any) => s + (pMap[r.servicio_id] || 0), 0);

    const lunesLbl = lunes.toLocaleDateString("es", { day: "numeric", month: "short" });
    const hastaLbl = new Date(lunes.getTime() + 6*86400000).toLocaleDateString("es", { day: "numeric", month: "short" });

    await tg(chatId,
      `📊 <b>STATS — ${lunesLbl} al ${hastaLbl}</b>\n\n` +
      `📋 Total: <b>${total}</b>\n` +
      `✅ Confirmadas: ${confirmadas}\n` +
      `🎉 Completadas: ${completadas}\n` +
      `⏳ Pendientes:  ${pendientes}\n` +
      `❌ Canceladas:  ${canceladas}\n\n` +
      `💰 Ingreso estimado: <b>${ingreso}€</b>`
    );

  // ── /ayuda /start /help ───────────────────────────────────
  } else if (["/ayuda","/start","/help"].includes(cmd)) {
    await tg(chatId,
      `✂️ <b>WTJ Barber Shop Bot</b>\n\n` +
      `<b>Agenda</b>\n` +
      `/hoy · /manana · /semana\n` +
      `/proxima — siguiente cita de hoy\n\n` +
      `<b>Gestionar citas</b>\n` +
      `/confirmar [id] — confirmar (sin id muestra pendientes)\n` +
      `/cancelar id — cancelar\n\n` +
      `<b>Consultas</b>\n` +
      `/libre [fecha] hora — ej: /libre mañana 17:00\n` +
      `/buscar nombre — historial de cliente\n` +
      `/stats — estadísticas de la semana\n\n` +
      `<b>Días bloqueados</b>\n` +
      `/bloquear fecha [motivo]\n` +
      `/desbloquear fecha`
    );
  }

  return new Response("OK");
});
