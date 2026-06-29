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

async function editMessage(chatId: string | number, messageId: number, text: string, reply_markup?: object) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup }),
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
const MESES_CORTO = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

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

async function proximosDiasHabiles(db: ReturnType<typeof createClient>, n = 7): Promise<string[]> {
  const from = isoMadrid(1);
  const to = isoMadrid(30);
  const { data: bloqueados } = await db.from("dias_bloqueados")
    .select("fecha").gte("fecha", from).lte("fecha", to);
  const bloqSet = new Set((bloqueados || []).map((b: any) => b.fecha));

  const dias: string[] = [];
  let offset = 1;
  while (dias.length < n && offset <= 30) {
    const fecha = isoMadrid(offset);
    const dow = new Date(fecha + "T12:00:00").getDay();
    if (dow !== 0 && dow !== 1 && !bloqSet.has(fecha)) dias.push(fecha);
    offset++;
  }
  return dias;
}

function buildGrid(items: { text: string; data: string }[], cancelBtn = true): object {
  const rows: any[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    const row = [{ text: items[i].text, callback_data: items[i].data }];
    if (items[i + 1]) row.push({ text: items[i + 1].text, callback_data: items[i + 1].data });
    rows.push(row);
  }
  if (cancelBtn) rows.push([{ text: "❌ Cancelar", callback_data: "n:x" }]);
  return { inline_keyboard: rows };
}

function fechaLabel(fecha: string): string {
  const d = new Date(fecha + "T12:00:00");
  const l = d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  return l.charAt(0).toUpperCase() + l.slice(1);
}

serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body) return new Response("OK");

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── Botones inline (callback_query) ─────────────────────
  if (body.callback_query) {
    const cbq    = body.callback_query;
    const chatId = String(cbq.message?.chat?.id);
    if (chatId !== CHAT_ID) return new Response("OK");

    const data = cbq.data || "";

    // ── Wizard de nueva cita ─────────────────────────────
    if (data.startsWith("n:")) {
      if (data === "n:x") {
        await db.from("bot_sesiones").delete().eq("chat_id", chatId);
        await answerCallback(cbq.id, "Cancelado");
        await editMessage(chatId, cbq.message.message_id, "❌ <b>Cita cancelada</b>");
        return new Response("OK");
      }

      const { data: sesion } = await db.from("bot_sesiones")
        .select("paso,datos").eq("chat_id", chatId).single();

      if (!sesion) {
        await answerCallback(cbq.id, "Sesión expirada — usa /nueva");
        return new Response("OK");
      }

      const paso  = sesion.paso;
      const datos = sesion.datos as Record<string, any>;

      // ── Selección de servicio ───────────────────────
      if (data.startsWith("n:s:") && paso === "servicio") {
        const servicioId = data.slice(4);
        const { data: svc } = await db.from("servicios")
          .select("nombre,precio_desde").eq("id", servicioId).single();
        if (!svc) { await answerCallback(cbq.id, "Servicio no encontrado"); return new Response("OK"); }

        const diasHabiles = await proximosDiasHabiles(db);
        const items = diasHabiles.map(f => {
          const d = new Date(f + "T12:00:00");
          return { text: `${DIAS_CORTO[d.getDay()]} ${d.getDate()} ${MESES_CORTO[d.getMonth()]}`, data: `n:d:${f}` };
        });

        await db.from("bot_sesiones").update({
          paso: "fecha",
          datos: { ...datos, servicio_id: servicioId, servicio_nombre: svc.nombre, precio: svc.precio_desde || 0 },
          updated_at: new Date().toISOString(),
        }).eq("chat_id", chatId);

        await answerCallback(cbq.id, `✂️ ${svc.nombre}`);
        await editMessage(chatId, cbq.message.message_id,
          `✂️ <b>${svc.nombre}</b>\n\n📅 ¿Qué día?`,
          buildGrid(items)
        );
      }

      // ── Selección de fecha ──────────────────────────
      else if (data.startsWith("n:d:") && paso === "fecha") {
        const fecha = data.slice(4);
        const dow = new Date(fecha + "T12:00:00").getDay();
        const todosSlots = slotsDelDia(dow);

        const { data: ocupadas } = await db.from("reservas")
          .select("hora").eq("fecha", fecha).in("estado", ["pendiente","confirmada"]);
        const ocupSet = new Set((ocupadas || []).map((r: any) => r.hora?.slice(0, 5)));
        const libres = todosSlots.filter(s => !ocupSet.has(s));

        if (!libres.length) {
          await answerCallback(cbq.id, "Ese día está completo");
          const diasHabiles = await proximosDiasHabiles(db);
          const items = diasHabiles.map(f => {
            const d = new Date(f + "T12:00:00");
            return { text: `${DIAS_CORTO[d.getDay()]} ${d.getDate()} ${MESES_CORTO[d.getMonth()]}`, data: `n:d:${f}` };
          });
          await editMessage(chatId, cbq.message.message_id,
            `⚠️ Ese día está completo. Elige otro:`,
            buildGrid(items)
          );
          return new Response("OK");
        }

        await db.from("bot_sesiones").update({
          paso: "hora",
          datos: { ...datos, fecha },
          updated_at: new Date().toISOString(),
        }).eq("chat_id", chatId);

        const items = libres.map(h => ({ text: h, data: `n:h:${h}` }));
        await answerCallback(cbq.id, fechaLabel(fecha));
        await editMessage(chatId, cbq.message.message_id,
          `📅 <b>${fechaLabel(fecha)}</b>\n\n🕐 ¿A qué hora?`,
          buildGrid(items)
        );
      }

      // ── Selección de hora ───────────────────────────
      else if (data.startsWith("n:h:") && paso === "hora") {
        const hora = data.slice(4);
        const nuevosDatos = { ...datos, hora };

        await db.from("bot_sesiones").update({
          paso: "confirmar",
          datos: nuevosDatos,
          updated_at: new Date().toISOString(),
        }).eq("chat_id", chatId);

        const resumen =
          `📋 <b>NUEVA CITA</b>\n\n` +
          `👤 ${nuevosDatos.nombre}\n` +
          `📱 ${nuevosDatos.telefono}\n` +
          `💈 ${nuevosDatos.servicio_nombre}${nuevosDatos.precio ? ` · desde ${nuevosDatos.precio}€` : ""}\n` +
          `📅 ${fechaLabel(nuevosDatos.fecha)}\n` +
          `🕐 ${hora}\n\n` +
          `¿Confirmar?`;

        await answerCallback(cbq.id, hora);
        await editMessage(chatId, cbq.message.message_id, resumen, {
          inline_keyboard: [[
            { text: "✅ Crear cita", callback_data: "n:ok" },
            { text: "❌ Cancelar",  callback_data: "n:x" },
          ]],
        });
      }

      // ── Confirmar creación ──────────────────────────
      else if (data === "n:ok" && paso === "confirmar") {
        const { nombre, telefono, servicio_id, servicio_nombre, precio, fecha, hora } = datos;

        // Upsert client by phone
        let clienteId: string | null = null;
        const { data: existente } = await db.from("clientes")
          .update({ nombre }).eq("telefono", telefono).select("id").single();
        if (existente?.id) {
          clienteId = existente.id;
        } else {
          const { data: nuevo } = await db.from("clientes")
            .insert({ nombre, telefono }).select("id").single();
          clienteId = nuevo?.id || null;
        }

        if (!clienteId) {
          await answerCallback(cbq.id, "Error al guardar cliente");
          return new Response("OK");
        }

        const { data: resData, error: resErr } = await db.from("reservas")
          .insert({ cliente_id: clienteId, servicio_id, fecha, hora: hora + ":00", estado: "confirmada" })
          .select("id").single();

        if (resErr) {
          await answerCallback(cbq.id, "Error al crear la cita");
          await editMessage(chatId, cbq.message.message_id, `❌ Error: ${resErr.message}`);
          return new Response("OK");
        }

        await db.from("bot_sesiones").delete().eq("chat_id", chatId);
        await answerCallback(cbq.id, "✅ Cita creada");
        await editMessage(chatId, cbq.message.message_id,
          `✅ <b>CITA CREADA</b>\n\n` +
          `👤 ${nombre}\n` +
          `📱 ${telefono}\n` +
          `💈 ${servicio_nombre}${precio ? ` · desde ${precio}€` : ""}\n` +
          `📅 ${fechaLabel(fecha)}\n` +
          `🕐 ${hora}`
        );

        // Notify via tg-notificar (don't await to keep response fast)
        if (resData?.id) {
          fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/tg-notificar`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({ tipo: "confirmada", reserva_id: resData.id }),
          }).catch(() => {});
        }
      } else {
        await answerCallback(cbq.id, "Sesión expirada — usa /nueva");
      }

      return new Response("OK");
    }

    // ── Confirmar / Cancelar reservas existentes ─────────
    const [accion, reservaId] = data.split(":");

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

  const parts = msg.text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().split("@")[0];

  // ── Captura de texto libre (wizard en curso) ─────────
  if (!cmd.startsWith("/")) {
    const { data: sesion } = await db.from("bot_sesiones")
      .select("paso,datos").eq("chat_id", chatId).single();

    if (sesion?.paso === "nombre") {
      const toks = msg.text.trim().split(/\s+/);
      const last = toks[toks.length - 1];
      const esPhone = /^[+\d]{9,}$/.test(last.replace(/[\s\-().]/g, ""));

      if (toks.length < 2 || !esPhone) {
        await tg(chatId,
          `✏️ Escribe nombre y teléfono separados por espacio:\n\n` +
          `Ejemplo: <code>Juan García 666123456</code>\n\n` +
          `O escribe /nueva para empezar de nuevo.`
        );
        return new Response("OK");
      }

      const telefono = last;
      const nombre   = toks.slice(0, -1).join(" ");

      const { data: servicios } = await db.from("servicios")
        .select("id,nombre,precio_desde").order("nombre");

      if (!servicios?.length) {
        await tg(chatId, `❌ No hay servicios configurados.`);
        await db.from("bot_sesiones").delete().eq("chat_id", chatId);
        return new Response("OK");
      }

      await db.from("bot_sesiones").upsert({
        chat_id: chatId,
        paso: "servicio",
        datos: { nombre, telefono },
        updated_at: new Date().toISOString(),
      });

      const items = servicios.map((s: any) => ({
        text: s.precio_desde ? `${s.nombre} (${s.precio_desde}€)` : s.nombre,
        data: `n:s:${s.id}`,
      }));

      await tg(chatId,
        `👤 <b>${nombre}</b>  📱 ${telefono}\n\n💈 ¿Qué servicio?`,
        buildGrid(items)
      );
    }

    return new Response("OK");
  }

  // ── /nueva ────────────────────────────────────────────
  if (cmd === "/nueva") {
    await db.from("bot_sesiones").upsert({
      chat_id: chatId,
      paso: "nombre",
      datos: {},
      updated_at: new Date().toISOString(),
    });
    await tg(chatId,
      `✂️ <b>Nueva cita</b>\n\n` +
      `Escribe el nombre y teléfono del cliente:\n\n` +
      `Ejemplo: <code>Juan García 666123456</code>`
    );

  // ── /hoy ─────────────────────────────────────────────
  } else if (cmd === "/hoy" || cmd === "/citas") {
    const hoy = isoMadrid();
    const rs = await reservasDelDia(db, hoy);
    if (!rs.length) {
      await tg(chatId, `📓 Hoy no hay citas.`);
    } else {
      const dia = DIAS_LARGO[new Date(hoy + "T12:00:00").getDay()];
      const lineas = rs.map((r: any) =>
        `${r.estado === "confirmada" ? "✅" : "⏳"} <b>${r.hora?.slice(0,5)}</b>  ${r.clienteNombre} · ${r.servicioNombre}  <code>#${r.shortId}</code>`
      ).join("\n");
      await tg(chatId, `📓 <b>HOY — ${dia.toUpperCase()}</b>\n\n${lineas}\n\n<i>${rs.length} cita${rs.length > 1 ? "s" : ""}</i>`);
    }

  // ── /manana ───────────────────────────────────────────
  } else if (cmd === "/manana") {
    const manana = isoMadrid(1);
    const rs = await reservasDelDia(db, manana);
    if (!rs.length) {
      await tg(chatId, `📅 Mañana no hay citas.`);
    } else {
      const dia = DIAS_LARGO[new Date(manana + "T12:00:00").getDay()];
      const lineas = rs.map((r: any) =>
        `${r.estado === "confirmada" ? "✅" : "⏳"} <b>${r.hora?.slice(0,5)}</b>  ${r.clienteNombre} · ${r.servicioNombre}`
      ).join("\n");
      await tg(chatId, `📅 <b>MAÑANA — ${dia.toUpperCase()}</b>\n\n${lineas}\n\n<i>${rs.length} cita${rs.length > 1 ? "s" : ""}</i>`);
    }

  // ── /semana ───────────────────────────────────────────
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

  // ── /proxima ──────────────────────────────────────────
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

  // ── /confirmar [id] ───────────────────────────────────
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
        for (const r of pendientes) {
          const c = cMap[r.cliente_id];
          const d = new Date(r.fecha + "T12:00:00").toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
          await tg(chatId,
            `⏳ <b>PENDIENTE</b>\n\n` +
            `👤 ${c?.nombre || "—"}\n` +
            `📱 ${c?.telefono || "—"}\n` +
            `📅 ${d.charAt(0).toUpperCase() + d.slice(1)}\n` +
            `🕐 ${r.hora?.slice(0,5)}`,
            { inline_keyboard: [[
              { text: "✅ Confirmar", callback_data: `confirmar:${r.id}` },
              { text: "❌ Cancelar",  callback_data: `cancelar:${r.id}` },
            ]] }
          );
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

  // ── /cancelar id ──────────────────────────────────────
  } else if (cmd === "/cancelar") {
    if (!parts[1]) {
      await tg(chatId, `Uso: /cancelar <code>id</code>`);
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

  // ── /libre [fecha] hora ───────────────────────────────
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
        await tg(chatId, data?.length
          ? `🔴 ${fechaLabel(fecha)} a las ${hora} ya está ocupado.`
          : `✅ ${fechaLabel(fecha)} a las ${hora} está libre.`
        );
      }
    }

  // ── /buscar nombre ────────────────────────────────────
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

  // ── /bloquear fecha [motivo] ──────────────────────────
  } else if (cmd === "/bloquear") {
    const fecha = parseFecha(parts[1] || "");
    if (!fecha) {
      await tg(chatId, `Uso: /bloquear <fecha> [motivo]\n\nEjemplos:\n/bloquear 2026-07-15\n/bloquear mañana festivo`);
    } else {
      const motivo = parts.slice(2).join(" ") || null;
      const { error } = await db.from("dias_bloqueados").insert({ fecha, motivo });
      if (error?.code === "23505") {
        await tg(chatId, `ℹ️ El ${fecha} ya estaba bloqueado.`);
      } else if (error) {
        await tg(chatId, `❌ Error: ${error.message}`);
      } else {
        await tg(chatId, `🔒 Bloqueado: ${fechaLabel(fecha)}${motivo ? ` — ${motivo}` : ""}`);
      }
    }

  // ── /desbloquear fecha ────────────────────────────────
  } else if (cmd === "/desbloquear") {
    const fecha = parseFecha(parts[1] || "");
    if (!fecha) {
      await tg(chatId, `Uso: /desbloquear <fecha>\n\nEjemplo: /desbloquear 2026-07-15`);
    } else {
      await db.from("dias_bloqueados").delete().eq("fecha", fecha);
      await tg(chatId, `🔓 Desbloqueado: ${fechaLabel(fecha)}`);
    }

  // ── /stats ────────────────────────────────────────────
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

    const total       = reservas?.length || 0;
    const confirmadas = reservas?.filter((r: any) => r.estado === "confirmada").length  || 0;
    const completadas = reservas?.filter((r: any) => r.estado === "completada").length  || 0;
    const pendientes  = reservas?.filter((r: any) => r.estado === "pendiente").length   || 0;
    const canceladas  = reservas?.filter((r: any) => r.estado === "cancelada").length   || 0;
    const ingreso     = (reservas || [])
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

  // ── /ayuda /start /help ───────────────────────────────
  } else if (["/ayuda","/start","/help"].includes(cmd)) {
    await tg(chatId,
      `✂️ <b>WTJ Barber Shop Bot</b>\n\n` +
      `<b>Agenda</b>\n` +
      `/hoy · /manana · /semana\n` +
      `/proxima — siguiente cita de hoy\n\n` +
      `<b>Gestionar citas</b>\n` +
      `/nueva — crear cita desde el bot ✨\n` +
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
