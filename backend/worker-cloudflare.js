// Statistics are independent of votes, IPs and R2. All timestamps are server-side.
const ANALYTICS_WINDOW = 30 * 60 * 1000;
const analyticsDay = (time) => new Date(time - 5 * 3600000).toISOString().slice(0, 10);
async function analyticsHash(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function handleAnalyticsRequest(request, env, helpers) {
  const { json, isAdmin, origin, allowedOrigin } = helpers;
  const path = new URL(request.url).pathname;
  if (!['/api/analytics/visit', '/api/analytics/heartbeat', '/api/admin/stats'].includes(path)) return null;
  const respond = (data, status = 200) => json(data, status, origin);
  const admin = path === '/api/admin/stats';
  if (admin && !isAdmin(request, env)) return respond({ error: 'No autorizado.' }, 401);
  if (request.method !== (admin ? 'GET' : 'POST')) return respond({ error: 'Método no permitido.' }, 405);
  const now = Date.now();
  const today = analyticsDay(now);
  const since = analyticsDay(now - 6 * 86400000);
  if (admin) {
    // Keep only short-lived identifiers; daily aggregate counts are never deleted.
    const result = await env.DB.batch([
      env.DB.prepare('DELETE FROM analytics_presence WHERE last_seen < ?').bind(now - 86400000),
      env.DB.prepare('DELETE FROM analytics_uniques WHERE day < ?').bind(since),
      env.DB.prepare('SELECT COALESCE(SUM(visits), 0) AS total, COALESCE(SUM(CASE WHEN day = ? THEN visits ELSE 0 END), 0) AS today FROM analytics_daily').bind(today),
      env.DB.prepare('SELECT COUNT(*) AS count FROM analytics_uniques WHERE day = ?').bind(today),
      env.DB.prepare('SELECT COUNT(*) AS count FROM analytics_presence WHERE last_seen >= ?').bind(now - 300000),
      env.DB.prepare('SELECT day, visits FROM analytics_daily WHERE day >= ? AND day <= ? ORDER BY day').bind(since, today)
    ]);
    const counts = new Map(result[5].results.map((row) => [row.day, Number(row.visits)]));
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = analyticsDay(now - (6 - i) * 86400000);
      return { day, visits: counts.get(day) || 0 };
    });
    return respond({ today: Number(result[2].results[0].today), total: Number(result[2].results[0].total), uniqueToday: Number(result[3].results[0].count), online: Number(result[4].results[0].count), days, timezone: 'America/Lima' });
  }
  if (![allowedOrigin, 'null'].includes(origin)) return respond({ error: 'Origen no permitido.' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return respond({ error: 'Se requiere JSON.' }, 415);
  // Read a bounded body even if Content-Length is absent or dishonest.
  const reader = request.body?.getReader();
  if (!reader) return respond({ error: 'Cuerpo requerido.' }, 400);
  let bytes = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 256) { await reader.cancel(); return respond({ error: 'Cuerpo demasiado grande.' }, 413); }
    chunks.push(value);
  }
  let body;
  try { body = JSON.parse(chunks.map((chunk) => new TextDecoder().decode(chunk)).join('')); }
  catch (_) { return respond({ error: 'JSON inválido.' }, 400); }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body?.visitorId || '')) return respond({ error: 'Identificador inválido.' }, 400);
  const id = await analyticsHash(body.visitorId.toLowerCase());
  if (path.endsWith('/heartbeat')) {
    await env.DB.prepare(`INSERT INTO analytics_presence (visitor_id, last_visit, last_seen) VALUES (?, 0, ?) ON CONFLICT(visitor_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen) WHERE last_seen < ?`).bind(id, now, now - 60000).run();
    return respond({ success: true });
  }
  const dailyId = await analyticsHash(today + ':' + id);
  // D1 batch is atomic: reloads and simultaneous tabs share the same rolling window.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO analytics_daily (day, visits)
      SELECT ?, 1 WHERE NOT EXISTS (SELECT 1 FROM analytics_presence WHERE visitor_id = ? AND last_visit > ?)
      ON CONFLICT(day) DO UPDATE SET visits = visits + 1`).bind(today, id, now - ANALYTICS_WINDOW),
    env.DB.prepare('INSERT OR IGNORE INTO analytics_uniques (day, visitor_id) VALUES (?, ?)').bind(today, dailyId),
    env.DB.prepare(`INSERT INTO analytics_presence (visitor_id, last_visit, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(visitor_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen),
      last_visit = CASE WHEN last_visit <= ? THEN excluded.last_visit ELSE last_visit END`).bind(id, now, now, now - ANALYTICS_WINDOW)
  ]);
  return respond({ success: true });
}

// News has its own additive table; the legacy news table is left intact.
const NEWS_TYPES = new Set(['principal', 'mediana', 'pequena', 'tipografica']);
const NEWS_IMAGE_TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']]);
const NEWS_IMAGE_LIMIT = 10 * 1024 * 1024;
function newsImageSignature(buffer, type) {
  const b = new Uint8Array(buffer);
  const text = (start, length) => String.fromCharCode(...b.subarray(start, start + length));
  if (type === 'image/jpeg') return b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (type === 'image/png') return b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => b[i] === n);
  if (type === 'image/webp') return b.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP';
  return type === 'image/gif' && ['GIF87a', 'GIF89a'].includes(text(0, 6));
}
function newsRecord(request, row, admin = false) {
  const item = { id: row.id, title: row.title, date: row.date, url: row.external_url, visual_type: row.visual_type, sort_order: row.sort_order, published: row.published, created_at: row.created_at, updated_at: row.updated_at,
    image_url: row.r2_key && row.published ? new URL('/api/news/image/' + row.id, request.url).href : null };
  if (admin) item.has_image = Boolean(row.r2_key);
  return item;
}
// Preserve unknown parameters, their encoding/order, and the fragment verbatim.
function cleanNewsUrl(url) {
  const parts = url.search.slice(1).split('&');
  const clean = parts.filter((part) => {
    let key;
    try { key = decodeURIComponent(part.split('=', 1)[0].replace(/\+/g, ' ')).toLowerCase(); }
    catch (_) { return true; }
    return key !== 'fbclid' && key !== 'mibextid' && !key.startsWith('utm_');
  });
  if (clean.length !== parts.length) url.search = clean.length ? '?' + clean.join('&') : '';
  return url.href;
}
function validateNews(body, existing = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Datos inválidos.');
  const get = (name, fallback) => Object.prototype.hasOwnProperty.call(body, name) ? body[name] : existing[name] ?? fallback;
  const title = get('title', '');
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 300 || /[\u0000-\u001f]/.test(title)) throw new Error('El titular es obligatorio y admite hasta 300 caracteres.');
  const rawUrl = Object.prototype.hasOwnProperty.call(body, 'url') ? body.url : existing.external_url;
  let url;
  try { url = new URL(rawUrl); } catch (_) { throw new Error('Introduce una URL externa absoluta.'); }
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('La URL debe usar HTTP o HTTPS, sin credenciales.');
  const rawDate = get('date', null);
  const date = rawDate === '' || rawDate === null ? null : rawDate;
  if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date)) throw new Error('Fecha inválida.');
  const type = get('visual_type', 'mediana');
  if (!NEWS_TYPES.has(type)) throw new Error('Tipo visual inválido.');
  const rawOrder = get('sort_order', 0);
  const order = typeof rawOrder === 'number' || typeof rawOrder === 'string' && /^-?\d+$/.test(rawOrder) ? Number(rawOrder) : NaN;
  if (!Number.isSafeInteger(order) || Math.abs(order) > 2147483647) throw new Error('El orden debe ser un entero válido.');
  const flag = get('published', 0);
  if (![true, false, 1, 0, '1', '0'].includes(flag)) throw new Error('Estado de publicación inválido.');
  const remove = body.remove_image ?? false;
  if (![true, false, 1, 0, '1', '0'].includes(remove)) throw new Error('Estado de imagen inválido.');
  return { title: title.trim(), url: cleanNewsUrl(url), date, type, order, published: [true, 1, '1'].includes(flag) ? 1 : 0, remove: [true, 1, '1'].includes(remove) };
}
async function readNewsBody(request) {
  const type = request.headers.get('Content-Type') || '';
  const multipart = type.startsWith('multipart/form-data');
  if (!multipart && !type.startsWith('application/json')) throw Object.assign(new Error('Usa JSON o multipart/form-data.'), { status: 415 });
  const limit = multipart ? NEWS_IMAGE_LIMIT + 16384 : 8192;
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Cuerpo requerido.');
  const parts = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw Object.assign(new Error('La imagen supera 10 MB o el formulario es demasiado grande.'), { status: 413 }); }
    parts.push(value);
  }
  const buffer = new Uint8Array(size); let offset = 0;
  parts.forEach((part) => { buffer.set(part, offset); offset += part.byteLength; });
  if (!multipart) {
    try { return { body: JSON.parse(new TextDecoder().decode(buffer)), file: null }; }
    catch (_) { throw new Error('JSON inválido.'); }
  }
  let form;
  try { form = await new Response(buffer, { headers: { 'Content-Type': type } }).formData(); }
  catch (_) { throw new Error('Formulario inválido.'); }
  const body = {};
  for (const name of ['title', 'url', 'date', 'visual_type', 'sort_order', 'published', 'remove_image']) {
    if (form.has(name)) { const value = form.get(name); if (typeof value !== 'string') throw new Error('Campo inválido.'); body[name] = value; }
  }
  const file = form.get('image');
  if (file !== null && (typeof file === 'string' || typeof file.arrayBuffer !== 'function')) throw new Error('Imagen inválida.');
  if (file && !file.size) throw new Error('La imagen está vacía.');
  return { body, file };
}
async function handleNewsRequest(request, env, helpers) {
  const { json, isAdmin, origin, allowedOrigin } = helpers;
  const path = new URL(request.url).pathname;
  const adminMatch = path.match(/^\/api\/admin\/news(?:\/(\d+)(?:\/(image))?)?$/);
  const publicImage = path.match(/^\/api\/news\/image\/(\d+)$/);
  const list = path === '/api/news';
  if (!adminMatch && !publicImage && !list) return null;
  const respond = (body, status = 200) => json(body, status, origin);
  if (adminMatch && !isAdmin(request, env)) return respond({ error: 'No autorizado.' }, 401);
  const id = Number(adminMatch?.[1] || publicImage?.[1] || 0);
  if ((adminMatch?.[1] || publicImage) && (!Number.isSafeInteger(id) || id <= 0)) return respond({ error: 'ID inválido.' }, 400);
  const image = publicImage || adminMatch?.[2];
  const methods = image ? ['GET', 'HEAD'] : list ? ['GET'] : id ? ['PATCH', 'DELETE'] : ['GET', 'POST'];
  if (!methods.includes(request.method)) return respond({ error: 'Método no permitido.' }, 405);
  if (image) {
    const row = await env.DB.prepare('SELECT r2_key, published FROM news_entries WHERE id = ?').bind(id).first();
    if (!row?.r2_key || !adminMatch && !row.published) return respond({ error: 'Imagen no encontrada.' }, 404);
    if (!env.GALLERY_BUCKET) return respond({ error: 'GALLERY_BUCKET no configurado.' }, 500);
    const object = await env.GALLERY_BUCKET.get(row.r2_key);
    if (!object) return respond({ error: 'Imagen no encontrada.' }, 404);
    const headers = new Headers({ 'Access-Control-Allow-Origin': origin === allowedOrigin ? allowedOrigin : 'null', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  }
  if (request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM news_entries ' + (list ? 'WHERE published = 1 ' : '') + 'ORDER BY sort_order ASC, created_at DESC, id DESC').all();
    return respond({ items: (rows.results || []).map((row) => newsRecord(request, row, Boolean(adminMatch))) });
  }
  const existing = id ? await env.DB.prepare('SELECT * FROM news_entries WHERE id = ?').bind(id).first() : null;
  if (id && !existing) return respond({ error: 'Noticia no encontrada.' }, 404);
  if (request.method === 'DELETE') {
    if (existing.r2_key && !env.GALLERY_BUCKET) return respond({ error: 'GALLERY_BUCKET no configurado.' }, 500);
    // Unpublish before object removal; an R2 failure can be retried safely.
    await env.DB.prepare("UPDATE news_entries SET published = 0, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    if (existing.r2_key) await env.GALLERY_BUCKET.delete(existing.r2_key);
    await env.DB.prepare('DELETE FROM news_entries WHERE id = ?').bind(id).run();
    return respond({ success: true, deletedId: id });
  }
  let input, data, buffer, extension;
  try {
    input = await readNewsBody(request); data = validateNews(input.body, existing || {});
    if (input.file) {
      extension = NEWS_IMAGE_TYPES.get(input.file.type);
      if (!extension) throw new Error('Usa JPG, PNG, WebP o GIF.');
      if (input.file.size > NEWS_IMAGE_LIMIT) throw Object.assign(new Error('La imagen supera 10 MB.'), { status: 413 });
      if (data.remove) throw new Error('No puedes quitar y subir una imagen a la vez.');
      buffer = await input.file.arrayBuffer();
      if (!newsImageSignature(buffer, input.file.type)) throw new Error('El archivo no coincide con su formato de imagen.');
    }
  } catch (error) { return respond({ error: error.message }, error.status || 400); }
  if ((input.file || data.remove && existing?.r2_key) && !env.GALLERY_BUCKET) return respond({ error: 'GALLERY_BUCKET no configurado.' }, 500);
  const uploadedKey = input.file ? 'news/' + crypto.randomUUID() + '.' + extension : null;
  const key = uploadedKey || (data.remove ? null : existing?.r2_key || null);
  if (uploadedKey) await env.GALLERY_BUCKET.put(uploadedKey, buffer, { httpMetadata: { contentType: input.file.type, cacheControl: 'no-store' } });
  const timestamp = new Date().toISOString();
  let savedId = id;
  try {
    if (id) {
      const result = await env.DB.prepare(`UPDATE news_entries SET title = ?, date = ?, external_url = ?, visual_type = ?, sort_order = ?, published = ?, r2_key = ?, updated_at = ? WHERE id = ? AND r2_key IS ?`)
        .bind(data.title, data.date, data.url, data.type, data.order, data.published, key, timestamp, id, existing.r2_key).run();
      if (result.meta?.changes === 0) throw Object.assign(new Error('La noticia cambió. Actualiza la lista antes de reintentar.'), { status: 409 });
    } else {
      const result = await env.DB.prepare(`INSERT INTO news_entries (title, date, external_url, visual_type, sort_order, published, r2_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(data.title, data.date, data.url, data.type, data.order, data.published, key, timestamp, timestamp).run();
      savedId = result.meta?.last_row_id;
      if (!savedId) throw new Error('No se pudo crear la noticia.');
    }
  } catch (error) {
    if (uploadedKey) await env.GALLERY_BUCKET.delete(uploadedKey);
    if (error.status) return respond({ error: error.message }, error.status);
    throw error;
  }
  if (existing?.r2_key && existing.r2_key !== key) {
    try { await env.GALLERY_BUCKET.delete(existing.r2_key); } catch (error) { console.error('News old image cleanup failed:', error); }
  }
  const row = await env.DB.prepare('SELECT * FROM news_entries WHERE id = ?').bind(savedId).first();
  return respond({ success: true, item: newsRecord(request, row, true) }, id ? 200 : 201);
}

const MAX_VIDEO_SIZE = 80 * 1024 * 1024;
const TYPES = new Map([['video/mp4', 'mp4'], ['video/webm', 'webm']]);
const urlFor = (request, id) => new URL('/api/gallery/video/' + id, request.url).href;
const itemFor = (request, row) => ({ id: row.id, title: row.title, description: row.description, sort_order: row.sort_order, active: row.active, created_at: row.created_at, video_url: urlFor(request, row.id) });

async function handleVideoRequest(request, env, helpers) {
  const { json, isAdmin, origin, allowedOrigin } = helpers;
  const path = new URL(request.url).pathname;
  const adminMatch = path.match(/^\/api\/admin\/videos(?:\/(\d+))?$/);
  const mediaMatch = path.match(/^\/api\/gallery\/video\/(\d+)$/);
  const publicList = path === '/api/gallery/videos';
  if (!adminMatch && !mediaMatch && !publicList) return null;
  const respond = (data, status = 200) => json(data, status, origin);
  if (adminMatch && !isAdmin(request, env)) return respond({ error: 'No autorizado.' }, 401);
  if (request.method === 'GET' && (publicList || adminMatch && !adminMatch[1])) {
    const result = await env.DB.prepare('SELECT * FROM gallery_videos ' + (publicList ? 'WHERE active = 1 ' : '') + 'ORDER BY sort_order ASC, created_at DESC').all();
    return respond({ items: (result.results || []).map((row) => itemFor(request, row)) });
  }
  if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) {
    const row = await env.DB.prepare('SELECT r2_key, active FROM gallery_videos WHERE id = ?').bind(Number(mediaMatch[1])).first();
    if (!row || !row.active) return respond({ error: 'Video no encontrado.' }, 404);
    const head = await env.GALLERY_BUCKET.head(row.r2_key);
    if (!head) return respond({ error: 'Archivo no encontrado.' }, 404);
    const headers = new Headers({ 'Access-Control-Allow-Origin': origin === allowedOrigin ? allowedOrigin : 'null', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600', 'ETag': head.httpEtag, 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    head.writeHttpMetadata(headers);
    headers.set('Content-Length', String(head.size));
    if (request.method === 'HEAD') return new Response(null, { headers });
    let range;
    const rawRange = request.headers.get('Range');
    if (rawRange) {
      const match = rawRange.match(/^bytes=(\d*)-(\d*)$/);
      let start, end;
      if (match && (match[1] || match[2])) {
        if (!match[1]) { start = Math.max(0, head.size - Number(match[2])); end = head.size - 1; }
        else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1; }
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= head.size || end < start) {
        headers.set('Content-Range', 'bytes */' + head.size);
        headers.delete('Content-Length');
        return new Response(null, { status: 416, headers });
      }
      range = { offset: start, length: end - start + 1 };
      headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + head.size);
      headers.set('Content-Length', String(range.length));
    }
    const object = await env.GALLERY_BUCKET.get(row.r2_key, range ? { range } : undefined);
    if (!object) return respond({ error: 'Archivo no encontrado.' }, 404);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  }
  if (adminMatch && !adminMatch[1] && request.method === 'POST') {
    if (!env.GALLERY_BUCKET) return respond({ error: 'GALLERY_BUCKET no configurado.' }, 500);
    if (!(request.headers.get('Content-Type') || '').includes('multipart/form-data')) return respond({ error: 'Se requiere multipart/form-data.' }, 400);
    let form;
    try { form = await request.formData(); } catch (_) { return respond({ error: 'Formulario inválido.' }, 400); }
    const file = form.get('video');
    if (!file || typeof file === 'string' || typeof file.stream !== 'function') return respond({ error: 'Selecciona un video.' }, 400);
    const extension = TYPES.get(file.type);
    if (!extension) return respond({ error: 'Usa MP4 o WebM.' }, 400);
    if (!file.size || file.size > MAX_VIDEO_SIZE) return respond({ error: 'El video debe pesar entre 1 byte y 80 MB.' }, 413);
    const supplied = form.get('sort_order');
    let order;
    if (supplied !== null && supplied !== '') order = Number(supplied);
    else { const row = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM gallery_videos').first(); order = Number(row?.max_order ?? -1) + 1; }
    if (!Number.isSafeInteger(order)) return respond({ error: 'El orden debe ser entero.' }, 400);
    const title = String(form.get('title') || '').trim().slice(0, 300);
    const description = String(form.get('description') || '').trim().slice(0, 5000);
    const key = 'videos/' + crypto.randomUUID() + '.' + extension;
    await env.GALLERY_BUCKET.put(key, file, { httpMetadata: { contentType: file.type } });
    let result;
    try {
      result = await env.DB.prepare('INSERT INTO gallery_videos (title, description, sort_order, active, r2_key) VALUES (?, ?, ?, 1, ?)').bind(title || null, description || null, order, key).run();
      if (!result.meta?.last_row_id) throw new Error('Insert failed');
    } catch (error) { await env.GALLERY_BUCKET.delete(key); throw error; }
    return respond({ success: true, item: { id: result.meta.last_row_id, video_url: urlFor(request, result.meta.last_row_id), title, description, sort_order: order, active: 1 } }, 201);
  }
  if (adminMatch?.[1] && ['PATCH', 'DELETE'].includes(request.method)) {
    const id = Number(adminMatch[1]);
    const row = await env.DB.prepare('SELECT * FROM gallery_videos WHERE id = ?').bind(id).first();
    if (!row) return respond({ error: 'Video no encontrado.' }, 404);
    if (request.method === 'DELETE') {
      // Hide before removing the object; a failed object deletion can be retried.
      await env.DB.prepare('UPDATE gallery_videos SET active = 0 WHERE id = ?').bind(id).run();
      await env.GALLERY_BUCKET.delete(row.r2_key);
      await env.DB.prepare('DELETE FROM gallery_videos WHERE id = ?').bind(id).run();
      return respond({ success: true, deletedId: id });
    }
    let body;
    try { body = await request.json(); } catch (_) { return respond({ error: 'JSON inválido.' }, 400); }
    if (!body || typeof body !== 'object') return respond({ error: 'JSON inválido.' }, 400);
    const order = body.sort_order === undefined ? row.sort_order : Number(body.sort_order);
    if (!Number.isSafeInteger(order)) return respond({ error: 'El orden debe ser entero.' }, 400);
    let active = row.active;
    if (body.active !== undefined) {
      if ([true, 1, '1'].includes(body.active)) active = 1;
      else if ([false, 0, '0'].includes(body.active)) active = 0;
      else return respond({ error: 'active debe ser 1 o 0.' }, 400);
    }
    const title = body.title === undefined ? row.title : String(body.title ?? '').trim().slice(0, 300);
    const description = body.description === undefined ? row.description : String(body.description ?? '').trim().slice(0, 5000);
    await env.DB.prepare('UPDATE gallery_videos SET title = ?, description = ?, sort_order = ?, active = ? WHERE id = ?').bind(title || null, description || null, order, active, id).run();
    return respond({ success: true, item: itemFor(request, { ...row, title, description, sort_order: order, active }) });
  }
  return respond({ error: 'Método no permitido.' }, 405);
}

const ALLOWED_ORIGIN = "https://lamafiadelnorteentacna.github.io";

/* =========================================
   RESPUESTAS / CORS
========================================= */

function corsHeaders(origin = "") {
  return {
    "Access-Control-Allow-Origin":
      origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(origin),
  });
}

/* =========================================
   HASH DE IP
   La IP no se guarda directamente en D1.
========================================= */

async function hashIP(ip, secret) {
  const data = new TextEncoder().encode(`${secret}:${ip}`);
  const hash = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/* =========================================
   ADMIN
========================================= */

function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    return false;
  }

  const authorization =
    request.headers.get("Authorization") || "";

  return authorization === `Bearer ${env.ADMIN_TOKEN}`;
}

/* =========================================
   GALERÍA - UTILIDADES
========================================= */

const MAX_GALLERY_FILE_SIZE = 10 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);

function hasImageSignature(buffer, type) {
  const bytes = new Uint8Array(buffer);
  const ascii = (offset, length) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));

  if (type === "image/jpeg") {
    return bytes.length >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (type === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length &&
      signature.every((value, index) => bytes[index] === value);
  }

  if (type === "image/webp") {
    return bytes.length >= 12 &&
      ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  }

  if (type === "image/gif") {
    if (bytes.length < 6) return false;
    const signature = ascii(0, 6);
    return signature === "GIF87a" || signature === "GIF89a";
  }

  if (type === "image/avif") {
    if (bytes.length < 12 || ascii(4, 4) !== "ftyp") return false;
    for (let offset = 8; offset + 4 <= bytes.length && offset < 64; offset += 4) {
      const brand = ascii(offset, 4);
      if (brand === "avif" || brand === "avis") return true;
    }
  }

  return false;
}

function methodNotAllowed(origin, allowedMethods) {
  const headers = new Headers(corsHeaders(origin));
  headers.set("Allow", allowedMethods.join(", "));
  return new Response(JSON.stringify({ error: "Método no permitido." }), {
    status: 405,
    headers,
  });
}

function galleryImageUrl(request, id) {
  const url = new URL(request.url);
  return `${url.origin}/api/gallery/image/${id}`;
}

/* =========================================
   WORKER
========================================= */

// Automatic additions are separate from actual votes and never modify counter/votes.
const START = Date.parse('2026-09-28T11:00:00-05:00');
const END = Date.parse('2026-10-05T00:00:00-05:00');
const HOUR = 3600000;
function randomAddition() {
  const values = new Uint32Array(1);
  // Rejection sampling avoids modulo bias for the 41 possible values.
  do { crypto.getRandomValues(values); } while (values[0] >= 4294967259);
  return 80 + values[0] % 41;
}
async function addScheduledSimulation(env, scheduledTime) {
  const hour = Math.floor(scheduledTime / HOUR) * HOUR;
  if (!Number.isFinite(hour) || hour < START || hour >= END) return;
  await env.DB.prepare('INSERT OR IGNORE INTO counter_simulated_hours_v2 (hour_utc, amount) VALUES (?, ?)')
    .bind(hour, randomAddition()).run();
}
async function counterSummary(env, baseValue) {
  let simulated = 0;
  try {
    const row = await env.DB.prepare('SELECT (SELECT COALESCE(SUM(amount), 0) FROM counter_simulated_hours) + (SELECT COALESCE(SUM(amount), 0) FROM counter_simulated_hours_v2) AS total').first();
    simulated = Number(row?.total || 0);
  } catch (error) {
    // Preserve the existing counter if this Worker is deployed before the migration.
    if (!String(error.message).includes('no such table: counter_simulated_hours')) throw error;
  }
  const votes = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes').first();
  return { value: Number(baseValue || 0) + simulated, base_value: Number(baseValue || 0),
    real_votes: Number(votes?.total || 0), automated_value: simulated, includes_automatic_increments: true };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(addScheduledSimulation(env, event.scheduledTime));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    /* ---------- PREFLIGHT ---------- */

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    try {
      const newsResponse = await handleNewsRequest(request, env, { json, isAdmin, origin, allowedOrigin: ALLOWED_ORIGIN });
      if (newsResponse) return newsResponse;
      const analyticsResponse = await handleAnalyticsRequest(request, env, { json, isAdmin, origin, allowedOrigin: ALLOWED_ORIGIN });
      if (analyticsResponse) return analyticsResponse;
      const videoResponse = await handleVideoRequest(request, env, { json, isAdmin, origin, allowedOrigin: ALLOWED_ORIGIN });
      if (videoResponse) return videoResponse;
      /* =====================================
         HEALTH CHECK
      ===================================== */

      if (url.pathname === "/" && request.method === "GET") {
        return json(
          {
            ok: true,
            service: "mafia-tacna-api",
          },
          200,
          origin
        );
      }

      /* =====================================
         CONTADOR - OBTENER VALOR
      ===================================== */

      if (
        url.pathname === "/api/counter" &&
        request.method === "GET"
      ) {
        const row = await env.DB
          .prepare("SELECT value FROM counter WHERE id = 1")
          .first();

        return json(
          {
            ...(await counterSummary(env, row?.value ?? 0)),
          },
          200,
          origin
        );
      }

      /* =====================================
         COMPROBAR SI ESTA IP YA PARTICIPÓ
      ===================================== */

      if (
        url.pathname === "/api/counter/status" &&
        request.method === "GET"
      ) {
        const ip = request.headers.get("CF-Connecting-IP");

        if (!ip || !env.IP_HASH_SECRET) {
          return json(
            {
              alreadyVoted: false,
            },
            200,
            origin
          );
        }

        const ipHash = await hashIP(
          ip,
          env.IP_HASH_SECRET
        );

        const vote = await env.DB
          .prepare(
            "SELECT id FROM votes WHERE ip_hash = ? LIMIT 1"
          )
          .bind(ipHash)
          .first();

        return json(
          {
            alreadyVoted: Boolean(vote),
          },
          200,
          origin
        );
      }

      /* =====================================
         CONTADOR - +1
         SOLO UNA VEZ POR IP
      ===================================== */

      if (
        url.pathname === "/api/counter/increment" &&
        request.method === "POST"
      ) {
        const ip = request.headers.get("CF-Connecting-IP");

        if (!ip) {
          return json(
            {
              success: false,
              error: "No se pudo identificar la conexión.",
            },
            400,
            origin
          );
        }

        if (!env.IP_HASH_SECRET) {
          console.error(
            "IP_HASH_SECRET no está configurado."
          );

          return json(
            {
              success: false,
              error: "Configuración incompleta del servidor.",
            },
            500,
            origin
          );
        }

        const ipHash = await hashIP(
          ip,
          env.IP_HASH_SECRET
        );

        const voteResult = await env.DB
          .prepare(`
            INSERT OR IGNORE INTO votes (ip_hash)
            VALUES (?)
          `)
          .bind(ipHash)
          .run();

        /* ----- YA PARTICIPÓ ----- */

        if (!voteResult.meta?.changes) {
          const row = await env.DB
            .prepare(
              "SELECT value FROM counter WHERE id = 1"
            )
            .first();

          return json(
            {
              success: false,
              alreadyVoted: true,
              ...(await counterSummary(env, row?.value ?? 0)),
            },
            200,
            origin
          );
        }

        /* ----- NUEVA PARTICIPACIÓN ----- */

        await env.DB
          .prepare(`
            UPDATE counter
            SET value = value + 1
            WHERE id = 1
          `)
          .run();

        const row = await env.DB
          .prepare(
            "SELECT value FROM counter WHERE id = 1"
          )
          .first();

        return json(
          {
            success: true,
            alreadyVoted: false,
            ...(await counterSummary(env, row?.value ?? 0)),
          },
          200,
          origin
        );
      }

      /* =====================================
         ADMIN - MODIFICAR CONTADOR
      ===================================== */

      if (
        url.pathname === "/api/admin/counter" &&
        request.method === "POST"
      ) {
        if (!env.ADMIN_TOKEN) {
          return json(
            {
              error: "ADMIN_TOKEN no configurado.",
            },
            500,
            origin
          );
        }

        if (!isAdmin(request, env)) {
          return json(
            {
              error: "No autorizado.",
            },
            401,
            origin
          );
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json(
            {
              error: "JSON inválido.",
            },
            400,
            origin
          );
        }

        const action = body.action;
        const value = Number(body.value);

        if (
          !Number.isInteger(value) ||
          value < 0
        ) {
          return json(
            {
              error:
                "El valor debe ser un entero igual o mayor a 0.",
            },
            400,
            origin
          );
        }

        /* PONER VALOR EXACTO */

        if (action === "set") {
          await env.DB
            .prepare(`
              UPDATE counter
              SET value = ?
              WHERE id = 1
            `)
            .bind(value)
            .run();
        }

        /* SUMAR */

        else if (action === "add") {
          await env.DB
            .prepare(`
              UPDATE counter
              SET value = value + ?
              WHERE id = 1
            `)
            .bind(value)
            .run();
        }

        /* RESTAR */

        else if (action === "subtract") {
          await env.DB
            .prepare(`
              UPDATE counter
              SET value = MAX(0, value - ?)
              WHERE id = 1
            `)
            .bind(value)
            .run();
        }

        else {
          return json(
            {
              error:
                "Acción inválida. Usa set, add o subtract.",
            },
            400,
            origin
          );
        }

        const row = await env.DB
          .prepare(
            "SELECT value FROM counter WHERE id = 1"
          )
          .first();

        return json(
          {
            success: true,
            action,
            ...(await counterSummary(env, row?.value ?? 0)),
          },
          200,
          origin
        );
      }

      /* =====================================
         GALERÍA - LISTA PÚBLICA
      ===================================== */

      if (
        url.pathname === "/api/gallery" &&
        request.method === "GET"
      ) {
        const result = await env.DB
          .prepare(`
            SELECT
              id,
              title,
              description,
              image_url,
              sort_order,
              active,
              created_at
            FROM gallery
            WHERE active = 1
            ORDER BY sort_order ASC, created_at DESC
          `)
          .all();

        const items = (result.results ?? []).map((item) => ({
          ...item,
          image_url: galleryImageUrl(request, item.id),
        }));

        return json(
          {
            items,
          },
          200,
          origin
        );
      }

      /* =====================================
         GALERÍA - SERVIR IMAGEN DESDE R2
      ===================================== */

      const publicImageMatch =
        url.pathname.match(/^\/api\/gallery\/image\/(\d+)$/);

      if (
        publicImageMatch &&
        request.method === "GET"
      ) {
        const id = Number(publicImageMatch[1]);

        const row = await env.DB
          .prepare(`
            SELECT r2_key, active
            FROM gallery
            WHERE id = ?
            LIMIT 1
          `)
          .bind(id)
          .first();

        if (!row || !row.active || !row.r2_key) {
          return json(
            {
              error: "Imagen no encontrada.",
            },
            404,
            origin
          );
        }

        const object = await env.GALLERY_BUCKET.get(row.r2_key);

        if (!object) {
          return json(
            {
              error: "Archivo no encontrado.",
            },
            404,
            origin
          );
        }

        const headers = new Headers();

        object.writeHttpMetadata(headers);

        if (!headers.get("Content-Type")) {
          headers.set(
            "Content-Type",
            object.httpMetadata?.contentType ||
              "application/octet-stream"
          );
        }

        headers.set(
          "Cache-Control",
          "public, max-age=86400"
        );

        headers.set("ETag", object.httpEtag);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

        headers.set(
          "Access-Control-Allow-Origin",
          origin === ALLOWED_ORIGIN
            ? ALLOWED_ORIGIN
            : "null"
        );

        return new Response(object.body, {
          status: 200,
          headers,
        });
      }

      /* =====================================
         ADMIN GALERÍA - LISTAR TODO
      ===================================== */

      if (
        url.pathname === "/api/admin/gallery" &&
        request.method === "GET"
      ) {
        if (!env.ADMIN_TOKEN) {
          return json(
            {
              error: "ADMIN_TOKEN no configurado.",
            },
            500,
            origin
          );
        }

        if (!isAdmin(request, env)) {
          return json(
            {
              error: "No autorizado.",
            },
            401,
            origin
          );
        }

        const result = await env.DB
          .prepare(`
            SELECT
              id,
              title,
              description,
              image_url,
              sort_order,
              active,
              created_at,
              r2_key
            FROM gallery
            ORDER BY sort_order ASC, created_at DESC
          `)
          .all();

        const items = (result.results ?? []).map((item) => ({
          ...item,
          image_url: item.r2_key
            ? galleryImageUrl(request, item.id)
            : item.image_url,
        }));

        return json(
          {
            items,
          },
          200,
          origin
        );
      }

      /* =====================================
         ADMIN GALERÍA - SUBIR IMAGEN
      ===================================== */

      if (
        url.pathname === "/api/admin/gallery" &&
        request.method === "POST"
      ) {
        if (!env.ADMIN_TOKEN) {
          return json(
            {
              error: "ADMIN_TOKEN no configurado.",
            },
            500,
            origin
          );
        }

        if (!isAdmin(request, env)) {
          return json(
            {
              error: "No autorizado.",
            },
            401,
            origin
          );
        }

        if (!env.GALLERY_BUCKET) {
          return json(
            {
              error: "GALLERY_BUCKET no configurado.",
            },
            500,
            origin
          );
        }

        const contentType =
          request.headers.get("Content-Type") || "";

        if (!contentType.includes("multipart/form-data")) {
          return json(
            {
              error: "Se requiere multipart/form-data.",
            },
            400,
            origin
          );
        }

        let formData;

        try {
          formData = await request.formData();
        } catch {
          return json(
            {
              error: "No se pudo procesar el formulario.",
            },
            400,
            origin
          );
        }

        const image = formData.get("image");
        const title = String(
          formData.get("title") || ""
        ).trim();

        const description = String(
          formData.get("description") || ""
        ).trim();

        const requestedSortOrder =
          formData.get("sort_order");

        if (
          !image ||
          typeof image === "string" ||
          typeof image.arrayBuffer !== "function"
        ) {
          return json(
            {
              error: "Debes seleccionar una imagen.",
            },
            400,
            origin
          );
        }

        const extension =
          ALLOWED_IMAGE_TYPES.get(image.type);

        if (!extension) {
          return json(
            {
              error:
                "Formato no permitido. Usa JPG, PNG, WebP, GIF o AVIF.",
            },
            400,
            origin
          );
        }

        if (image.size <= 0) {
          return json(
            {
              error: "La imagen está vacía.",
            },
            400,
            origin
          );
        }

        if (image.size > MAX_GALLERY_FILE_SIZE) {
          return json(
            {
              error: "La imagen supera el límite de 10 MB.",
            },
            413,
            origin
          );
        }

        let sortOrder;

        if (
          requestedSortOrder !== null &&
          requestedSortOrder !== ""
        ) {
          sortOrder = Number(requestedSortOrder);

          if (!Number.isInteger(sortOrder)) {
            return json(
              {
                error: "sort_order debe ser un número entero.",
              },
              400,
              origin
            );
          }
        } else {
          const maxRow = await env.DB
            .prepare(`
              SELECT COALESCE(MAX(sort_order), -1) AS max_order
              FROM gallery
            `)
            .first();

          sortOrder =
            Number(maxRow?.max_order ?? -1) + 1;
        }

        const r2Key =
          `gallery/${crypto.randomUUID()}.${extension}`;

        const buffer = await image.arrayBuffer();

        if (!hasImageSignature(buffer, image.type)) {
          return json(
            {
              error: "El contenido del archivo no coincide con el formato de imagen declarado.",
            },
            400,
            origin
          );
        }

        await env.GALLERY_BUCKET.put(
          r2Key,
          buffer,
          {
            httpMetadata: {
              contentType: image.type,
              cacheControl:
                "public, max-age=86400",
            },
            customMetadata: {
              uploadedAt: new Date().toISOString(),
            },
          }
        );

        try {
          const insertResult = await env.DB
            .prepare(`
              INSERT INTO gallery (
                title,
                description,
                image_url,
                sort_order,
                active,
                r2_key
              )
              VALUES (?, ?, ?, ?, 1, ?)
            `)
            .bind(
              title || null,
              description || null,
              "",
              sortOrder,
              r2Key
            )
            .run();

          const id =
            insertResult.meta?.last_row_id;

          if (!id) {
            throw new Error(
              "No se pudo obtener el ID del registro."
            );
          }

          const imageUrl =
            galleryImageUrl(request, id);

          await env.DB
            .prepare(`
              UPDATE gallery
              SET image_url = ?
              WHERE id = ?
            `)
            .bind(imageUrl, id)
            .run();

          const row = await env.DB
            .prepare(`
              SELECT
                id,
                title,
                description,
                image_url,
                sort_order,
                active,
                created_at
              FROM gallery
              WHERE id = ?
            `)
            .bind(id)
            .first();

          return json(
            {
              success: true,
              item: row,
            },
            201,
            origin
          );
        } catch (error) {
          await env.GALLERY_BUCKET.delete(r2Key);
          throw error;
        }
      }

      /* =====================================
         ADMIN GALERÍA - EDITAR
      ===================================== */

      const adminGalleryMatch =
        url.pathname.match(/^\/api\/admin\/gallery\/(\d+)$/);

      if (
        adminGalleryMatch &&
        request.method === "PATCH"
      ) {
        if (!env.ADMIN_TOKEN) {
          return json(
            {
              error: "ADMIN_TOKEN no configurado.",
            },
            500,
            origin
          );
        }

        if (!isAdmin(request, env)) {
          return json(
            {
              error: "No autorizado.",
            },
            401,
            origin
          );
        }

        const id = Number(adminGalleryMatch[1]);

        const existing = await env.DB
          .prepare(`
            SELECT *
            FROM gallery
            WHERE id = ?
            LIMIT 1
          `)
          .bind(id)
          .first();

        if (!existing) {
          return json(
            {
              error: "Imagen no encontrada.",
            },
            404,
            origin
          );
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json(
            {
              error: "JSON inválido.",
            },
            400,
            origin
          );
        }

        const title =
          Object.prototype.hasOwnProperty.call(body, "title")
            ? String(body.title ?? "").trim()
            : existing.title;

        const description =
          Object.prototype.hasOwnProperty.call(body, "description")
            ? String(body.description ?? "").trim()
            : existing.description;

        let sortOrder = existing.sort_order;

        if (
          Object.prototype.hasOwnProperty.call(
            body,
            "sort_order"
          )
        ) {
          sortOrder = Number(body.sort_order);

          if (!Number.isInteger(sortOrder)) {
            return json(
              {
                error: "sort_order debe ser un número entero.",
              },
              400,
              origin
            );
          }
        }

        let active = existing.active;

        if (
          Object.prototype.hasOwnProperty.call(
            body,
            "active"
          )
        ) {
          if (
            body.active === true ||
            body.active === 1 ||
            body.active === "1"
          ) {
            active = 1;
          } else if (
            body.active === false ||
            body.active === 0 ||
            body.active === "0"
          ) {
            active = 0;
          } else {
            return json(
              {
                error: "active debe ser true/false o 1/0.",
              },
              400,
              origin
            );
          }
        }

        await env.DB
          .prepare(`
            UPDATE gallery
            SET
              title = ?,
              description = ?,
              sort_order = ?,
              active = ?
            WHERE id = ?
          `)
          .bind(
            title || null,
            description || null,
            sortOrder,
            active,
            id
          )
          .run();

        const updated = await env.DB
          .prepare(`
            SELECT
              id,
              title,
              description,
              image_url,
              sort_order,
              active,
              created_at
            FROM gallery
            WHERE id = ?
          `)
          .bind(id)
          .first();

        if (updated?.id) {
          updated.image_url =
            galleryImageUrl(request, updated.id);
        }

        return json(
          {
            success: true,
            item: updated,
          },
          200,
          origin
        );
      }

      /* =====================================
         ADMIN GALERÍA - ELIMINAR
      ===================================== */

      if (
        adminGalleryMatch &&
        request.method === "DELETE"
      ) {
        if (!env.ADMIN_TOKEN) {
          return json(
            {
              error: "ADMIN_TOKEN no configurado.",
            },
            500,
            origin
          );
        }

        if (!isAdmin(request, env)) {
          return json(
            {
              error: "No autorizado.",
            },
            401,
            origin
          );
        }

        if (!env.GALLERY_BUCKET) {
          return json(
            {
              error: "GALLERY_BUCKET no configurado.",
            },
            500,
            origin
          );
        }

        const id = Number(adminGalleryMatch[1]);

        const existing = await env.DB
          .prepare(`
            SELECT id, r2_key
            FROM gallery
            WHERE id = ?
            LIMIT 1
          `)
          .bind(id)
          .first();

        if (!existing) {
          return json(
            {
              error: "Imagen no encontrada.",
            },
            404,
            origin
          );
        }

        if (existing.r2_key) {
          await env.GALLERY_BUCKET.delete(
            existing.r2_key
          );
        }

        await env.DB
          .prepare(`
            DELETE FROM gallery
            WHERE id = ?
          `)
          .bind(id)
          .run();

        return json(
          {
            success: true,
            deletedId: id,
          },
          200,
          origin
        );
      }

      const routeMethods = new Map([
        ["/", ["GET"]],
        ["/api/counter", ["GET"]],
        ["/api/counter/status", ["GET"]],
        ["/api/counter/increment", ["POST"]],
        ["/api/admin/counter", ["POST"]],
        ["/api/news", ["GET"]],
        ["/api/gallery", ["GET"]],
        ["/api/admin/gallery", ["GET", "POST"]],
      ]);
      const allowedMethods = routeMethods.get(url.pathname) ||
        (publicImageMatch ? ["GET"] : null) ||
        (adminGalleryMatch ? ["PATCH", "DELETE"] : null);

      if (allowedMethods) {
        return methodNotAllowed(origin, allowedMethods);
      }

      /* =====================================
         404
      ===================================== */

      return json(
        {
          error: "Not found",
        },
        404,
        origin
      );
    } catch (error) {
      console.error("Worker error:", error);

      return json(
        {
          error: "Internal server error",
        },
        500,
        origin
      );
    }
  },
};