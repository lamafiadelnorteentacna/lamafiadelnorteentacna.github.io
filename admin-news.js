'use strict';
// Shares the existing admin session, request helper and operation lock.
window.createNewsAdmin = ({ request, setBusy, isBusy, notify, hasSession }) => {
  const create = document.getElementById('news-create');
  const list = document.getElementById('news-list');
  const status = document.getElementById('news-list-status');
  const refreshButton = document.getElementById('news-refresh');
  const types = [['principal', 'Principal / grande'], ['mediana', 'Mediana'], ['pequena', 'Pequeña'], ['tipografica', 'Tipográfica']];
  const objectUrls = new Set();
  let generation = 0;
  let currentRows = [];
  const previews = new Map();
  function disposePreview(form) {
    const state = previews.get(form);
    if (!state) return;
    state.observer?.disconnect();
    if (state.url) URL.revokeObjectURL(state.url);
    previews.delete(form);
  }
  function previewLayout(row, form) {
    const order = Number(form.elements.sort_order.value) || 0;
    const created = row?.created_at || new Date().toISOString();
    const index = currentRows.filter((item) => item.id !== row?.id && item.published && (item.sort_order < order || item.sort_order === order && (item.created_at > created || item.created_at === created && item.id > (row?.id || Infinity)))).length;
    const variants = { principal: ['lead'], mediana: ['photo', 'wide', 'feature'], pequena: ['brief', 'dispatch', 'signal'], tipografica: ['manifesto', 'quote'] };
    const choices = variants[form.elements.visual_type.value] || variants.mediana;
    return { layout: choices[index % choices.length], index };
  }
  function generatePreview(form, row, target) {
    if (isBusy() || !hasSession()) return;
    const fields = form.elements;
    const file = fields.image.files[0];
    if (file && (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024)) { notify('Usa una imagen JPG, PNG, WebP o GIF de hasta 10 MB.', 'error'); return; }
    disposePreview(form);
    const state = { url: null, observer: null }; previews.set(form, state);
    const { layout, index } = previewLayout(row, form);
    const canvas = document.createElement('div'); canvas.className = 'news-preview-canvas';
    const article = document.createElement('article'); article.className = 'news-story news-story--' + layout;
    if (layout === 'brief' && index % 2) article.style.borderTopColor = '#80caff';
    const link = document.createElement('div'); link.className = 'news-story-link';
    let imageUrl = '';
    if (fields.visual_type.value !== 'tipografica' && !fields.remove_image?.checked) {
      if (file) { state.url = URL.createObjectURL(file); imageUrl = state.url; }
      else imageUrl = form.dataset.currentImage || '';
    }
    if (imageUrl) {
      const img = document.createElement('img'); img.src = imageUrl; img.alt = ''; img.width = 1200; img.height = 800;
      article.classList.add('news-story--image'); link.append(img);
    }
    const copy = document.createElement('div'); copy.className = 'news-story-copy';
    const meta = document.createElement('div'); meta.className = 'news-story-meta';
    const number = document.createElement('span'); number.textContent = 'NOTA / ' + String(index + 1).padStart(2, '0'); meta.append(number);
    if (fields.date.value) { const time = document.createElement('time'); time.dateTime = fields.date.value; time.textContent = fields.date.value.slice(8) + '.' + fields.date.value.slice(5, 7) + '.' + fields.date.value.slice(2, 4); meta.append(time); }
    const headline = document.createElement('h3'); headline.textContent = fields.title.value.trim() || 'Tu titular aparecerá aquí';
    const arrow = document.createElement('span'); arrow.className = 'news-story-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
    copy.append(meta, headline, arrow); link.append(copy); article.append(link); canvas.append(article);
    target.replaceChildren(canvas);
    // Scale the existing public tile; resizing changes size, never the snapshot's content.
    const desktop = window.innerWidth >= 700;
    const fullWidth = Math.min(window.innerWidth, 1320) - (desktop ? 48 : 24);
    const columns = { lead: 8, photo: 4, wide: 7, feature: 6, manifesto: 4, quote: 4, brief: 4, dispatch: 4, signal: 4 };
    const span = columns[layout];
    const naturalWidth = desktop ? (fullWidth - 11 * 16) / 12 * span + (span - 1) * 16 : ['lead', 'wide', 'feature'].includes(layout) ? fullWidth : (fullWidth - 9) / 2;
    canvas.style.width = Math.max(100, naturalWidth) + 'px';
    const resize = () => {
      const scale = Math.min(1, target.clientWidth / Math.max(100, naturalWidth));
      canvas.style.transform = 'scale(' + scale + ')'; target.style.height = Math.ceil(canvas.offsetHeight * scale) + 'px';
    };
    if (typeof ResizeObserver === 'function') { state.observer = new ResizeObserver(resize); state.observer.observe(target); state.observer.observe(canvas); }
    resize();
  }
  const revoke = () => { objectUrls.forEach((url) => URL.revokeObjectURL(url)); objectUrls.clear(); };
  function field(form, text, name, type, value = '') {
    const label = document.createElement('label'); label.textContent = text;
    const input = document.createElement(type === 'select' ? 'select' : 'input');
    if (type === 'select') types.forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); });
    else input.type = type;
    input.name = name; input.value = value ?? '';
    if (type === 'select') Array.from(input.options).forEach((option) => { option.defaultSelected = option.value === input.value; });
    else if (type !== 'file') input.defaultValue = input.value;
    label.append(input); form.append(label); return input;
  }
  async function preview(form, row, version) {
    if (!row.has_image) return;
    try {
      const blob = await request('/api/admin/news/' + row.id + '/image', { raw: true });
      if (version !== generation || !hasSession()) return;
      const url = URL.createObjectURL(blob); objectUrls.add(url); form.dataset.currentImage = url;
    } catch (_) {
      if (version !== generation) return;
      const message = document.createElement('p'); message.textContent = 'No se pudo cargar la imagen actual. Puedes elegir un archivo local para la vista previa.'; form.querySelector('.news-editor-fields').append(message);
    }
  }
  function makeForm(row = null) {
    const form = document.createElement('form'); form.className = 'photo-card news-editor';
    const fieldsPanel = document.createElement('div'); fieldsPanel.className = 'news-editor-fields';
    const heading = document.createElement('h3'); heading.textContent = row ? 'Noticia #' + row.id + (row.published ? ' · Publicada' : ' · Borrador') : 'Crear noticia'; form.append(heading);
    const title = field(form, 'Titular', 'title', 'text', row?.title); title.required = true; title.maxLength = 300;
    const url = field(form, 'URL externa (HTTP/HTTPS)', 'url', 'url', row?.url); url.required = true; url.maxLength = 2048;
    field(form, 'Fecha (opcional)', 'date', 'date', row?.date);
    field(form, 'Tipo visual', 'visual_type', 'select', row?.visual_type || 'mediana');
    const order = field(form, 'Orden (menor primero)', 'sort_order', 'number', row?.sort_order ?? 0); order.required = true; order.step = '1'; order.min = '-2147483647'; order.max = '2147483647';
    const image = field(form, row?.has_image ? 'Reemplazar imagen (opcional)' : 'Imagen (opcional)', 'image', 'file'); image.accept = 'image/jpeg,image/png,image/webp,image/gif';
    const help = document.createElement('p'); help.className = 'item-status'; help.textContent = 'JPG, PNG, WebP o GIF · hasta 10 MB. El tipo tipográfico no muestra la imagen en la portada.'; form.append(help);
    const checkbox = (text, name, checked) => {
      const label = document.createElement('label'); label.className = 'inline';
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = name; input.checked = Boolean(checked); input.value = '1';
      label.append(input, document.createTextNode(text)); form.append(label); return input;
    };
    const published = checkbox('Publicada', 'published', row?.published);
    const removeImage = row?.has_image ? checkbox('Quitar imagen actual', 'remove_image', false) : null;
    const actions = document.createElement('div'); actions.className = 'actions';
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = row ? 'Guardar cambios' : 'Crear noticia'; actions.append(save);
    if (row) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = 'Eliminar'; actions.append(remove);
      remove.addEventListener('click', async () => {
        if (isBusy() || !hasSession() || !confirm('¿Eliminar la noticia «' + row.title + '» y su imagen?')) return;
        setBusy(true);
        try { await request('/api/admin/news/' + row.id, { method: 'DELETE' }); if (hasSession()) { await refresh(); notify('Noticia eliminada.'); } }
        catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      });
    }
    const previewButton = document.createElement('button'); previewButton.type = 'button'; previewButton.className = 'secondary news-generate-preview'; previewButton.textContent = 'GENERAR VISTA PREVIA'; actions.prepend(previewButton);
    form.append(actions);
    fieldsPanel.append(...Array.from(form.children));
    const previewPanel = document.createElement('aside'); previewPanel.className = 'news-editor-preview'; previewPanel.setAttribute('aria-label', 'Vista previa de la noticia');
    const previewTitle = document.createElement('h3'); previewTitle.textContent = 'VISTA PREVIA';
    const previewHelp = document.createElement('p'); previewHelp.textContent = 'Se actualiza solo al pulsar GENERAR VISTA PREVIA. No guarda ni publica.';
    const previewTarget = document.createElement('div'); previewTarget.className = 'news-preview-frame'; previewTarget.setAttribute('aria-live', 'polite');
    const placeholder = document.createElement('p'); placeholder.textContent = 'Completa los campos y genera la vista previa.'; previewTarget.append(placeholder);
    previewPanel.append(previewTitle, previewHelp, previewTarget); form.append(fieldsPanel, previewPanel);
    previewButton.addEventListener('click', () => generatePreview(form, row, previewTarget));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (isBusy() || !hasSession()) return;
      const file = image.files[0];
      if (file && (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024)) { notify('Usa una imagen JPG, PNG, WebP o GIF de hasta 10 MB.', 'error'); return; }
      if (file && removeImage?.checked) { notify('Elige reemplazar o quitar la imagen, no ambas opciones.', 'error'); return; }
      const body = new FormData(form);
      if (!file) body.delete('image');
      body.set('published', published.checked ? '1' : '0');
      body.set('remove_image', removeImage?.checked ? '1' : '0');
      setBusy(true);
      try {
        await request('/api/admin/news' + (row ? '/' + row.id : ''), { method: row ? 'PATCH' : 'POST', body });
        if (hasSession()) { if (!row) form.reset(); await refresh(); notify(row ? 'Noticia actualizada.' : 'Noticia creada.'); }
      } catch (error) { notify(error.message, 'error'); }
      finally { setBusy(false); }
    });
    return form;
  }
  async function refresh() {
    if (!hasSession()) return;
    const version = ++generation;
    status.textContent = 'Cargando noticias…';
    try {
      const data = await request('/api/admin/news');
      if (version !== generation || !hasSession()) return;
      if (!Array.isArray(data.items)) throw new Error('Respuesta de noticias inválida.');
      currentRows = data.items;
      Array.from(previews.keys()).filter((form) => list.contains(form)).forEach(disposePreview);
      revoke(); list.replaceChildren();
      data.items.forEach((row) => { const form = makeForm(row); list.append(form); void preview(form, row, version); });
      status.textContent = data.items.length ? data.items.length + ' noticias · Publica las que quieras mostrar en la web.' : 'Todavía no hay noticias. Crea la primera arriba.';
    } catch (error) { if (version === generation) status.textContent = 'No se pudo cargar el archivo. ' + error.message; throw error; }
  }
  create.append(makeForm());
  refreshButton.addEventListener('click', async () => {
    if (isBusy() || !hasSession()) return;
    setBusy(true);
    try { await refresh(); } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  });
  return { refresh, reset() { generation++; currentRows = []; Array.from(previews.keys()).forEach(disposePreview); revoke(); list.replaceChildren(); create.replaceChildren(makeForm()); status.textContent = ''; } };
};
