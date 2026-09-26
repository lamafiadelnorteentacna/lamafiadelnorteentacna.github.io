'use strict';
(() => {
  const view = document.querySelector('#news-view');
  const collage = document.querySelector('#news-collage');
  const nav = document.querySelector('#news-nav-link');
  const back = document.querySelector('#news-back');
  const poster = document.querySelector('#poster');
  if (!view || !collage || !nav || !back) return;

  // Temporary fallback when the API is unavailable or has no published news.
  const newsItems = [
    { title: 'La ciudad también se escribe después de medianoche', image: 'img/news-city.svg', date: '2026-09-26', url: 'https://example.org/#ciudad' },
    { title: 'Un archivo vecinal rescata las voces del barrio', date: '2026-09-25', url: 'https://example.org/#archivo' },
    { title: 'Luces encendidas: una noche para mirar el cielo', image: 'img/news-night.svg', url: 'https://example.org/#cielo' },
    { title: 'Menos ruido. Más espacio para escucharnos.', url: 'https://example.org/#escuchar' },
    { title: 'Las paredes se convierten en un mapa de historias', image: 'img/news-city.svg', date: '2026-09-24', url: 'https://example.org/#murales' },
    { title: 'Libros que cambian de manos, historias que continúan', date: '2026-09-23', url: 'https://example.org/#libros' },
    { title: 'Una radio pequeña, una conversación enorme', url: 'https://example.org/#radio' },
    { title: 'El próximo encuentro empieza en la plaza', date: '2026-09-22', url: 'https://example.org/#plaza' },
    { title: 'Otra forma de recorrer las calles: caminar sin prisa', image: 'img/news-night.svg', date: '2026-09-21', url: 'https://example.org/#caminar' },
    { title: 'Crear juntos también es una forma de habitar', url: 'https://example.org/#crear' },
    { title: 'Taller abierto: reparar antes de reemplazar', date: '2026-09-20', url: 'https://example.org/#taller' },
    { title: 'Pequeñas ideas para un domingo distinto', url: 'https://example.org/#domingo' }
  ];
  const layouts = ['lead', 'dispatch', 'photo', 'manifesto', 'wide', 'brief', 'signal', 'brief', 'feature', 'quote', 'brief', 'brief'];
  let active = false;
  let switching = false;
  let loading = null;
  const endpoint = new URL('/api/news', galleryEndpoint).href;
  const demoLabel = document.querySelector('.news-demo');
  const visualLayouts = { principal: ['lead'], mediana: ['photo', 'wide', 'feature'], pequena: ['brief', 'dispatch', 'signal'], tipografica: ['manifesto', 'quote'] };
  async function loadNews() {
    if (loading) return loading;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    loading = (async () => {
      if (demoLabel) demoLabel.textContent = 'CARGANDO NOTICIAS…';
      try {
        const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error('News API HTTP ' + response.status);
        const data = await response.json();
        if (!Array.isArray(data.items)) throw new Error('Invalid news response');
        const items = data.items.filter((item) => item && [1, true].includes(item.published) && typeof item.title === 'string' && item.title.trim() && typeof item.url === 'string');
        if (items.length) {
          renderNews(items.map((item) => ({ ...item, image: item.image_url ? new URL(item.image_url, endpoint).href : null })));
          if (demoLabel) demoLabel.textContent = 'ARCHIVO / NOTICIAS PUBLICADAS';
        } else {
          renderNews(newsItems);
          if (demoLabel) demoLabel.textContent = 'PORTADA DE PRUEBA · Todavía no hay noticias publicadas.';
        }
      } catch (_) {
        renderNews(newsItems);
        if (demoLabel) demoLabel.textContent = 'PORTADA DE PRUEBA · No se pudo consultar el archivo. Vuelve a entrar para reintentar.';
      } finally { clearTimeout(timeout); loading = null; }
    })();
    return loading;
  }
  const fade = () => new Promise((resolve) => setTimeout(resolve, galleryReducedMotion.matches ? 0 : 360));

  function renderNews(items) {
    const articles = [];
    const entries = items.map((item, index) => {
      const choices = visualLayouts[item?.visual_type];
      return { item, layout: choices ? choices[index % choices.length] : layouts[index % layouts.length] };
    });
    // Shuffle presentation only; keep the saved order and each item's visual type.
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    let typographyIndex = 0;
    entries.forEach(({ item, layout }, index) => {
      if (!item || typeof item.title !== 'string' || !item.title.trim()) return;
      let url;
      try { url = new URL(item.url, location.href); } catch (_) { return; }
      if (!['http:', 'https:'].includes(url.protocol)) return;
      if (layout === 'manifesto' || layout === 'quote') {
        layout = typographyIndex++ % 2 === 0 ? 'quote' : 'manifesto';
      }
      const article = document.createElement('article');
      article.className = 'news-story news-story--' + layout;
      article.style.setProperty('--news-delay', Math.min(index, 5) * 45 + 'ms');
      const link = document.createElement('a');
      link.className = 'news-story-link';
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', item.title + ' (abre en una pestaña nueva)');
      if (item.visual_type !== 'tipografica' && typeof item.image === 'string' && item.image.trim()) {
        try {
          const imageUrl = new URL(item.image, location.href);
          if (['http:', 'https:', 'file:'].includes(imageUrl.protocol)) {
            const image = document.createElement('img');
            image.src = imageUrl.href; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
            image.width = 1200; image.height = 800;
            article.classList.add('news-story--image');
            image.addEventListener('error', () => { image.remove(); article.classList.remove('news-story--image'); }, { once: true });
            link.append(image);
          }
        } catch (_) { /* Missing images never hide a headline. */ }
      }
      const content = document.createElement('div'); content.className = 'news-story-copy';
      const meta = document.createElement('div'); meta.className = 'news-story-meta';
      const number = document.createElement('span'); number.textContent = 'NOTA / ' + String(index + 1).padStart(2, '0'); meta.append(number);
      if (typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
        const time = document.createElement('time'); time.dateTime = item.date;
        time.textContent = item.date.slice(8) + '.' + item.date.slice(5, 7) + '.' + item.date.slice(2, 4); meta.append(time);
      }
      const headline = document.createElement('h3'); headline.textContent = item.title;
      const arrow = document.createElement('span'); arrow.className = 'news-story-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
      content.append(meta, headline, arrow); link.append(content); article.append(link); articles.push(article);
    });
    collage.replaceChildren(...articles);
  }

  async function showNews() {
    if (active || switching || gallerySwitching) return;
    switching = true;
    try {
      // Existing exit handles lightbox, video presence/motion and home restoration.
      if (galleryActive) await showHome();
      active = true;
      poster.classList.add('view-switching', 'news-open');
      await fade();
      galleryHomeParts.forEach((part) => { part.hidden = true; });
      poster.classList.add('news-layout');
      void loadNews();
      view.hidden = false;
      // Commit the opacity start state before fading the section in.
      void view.offsetWidth;
      view.classList.add('is-visible');
      nav.setAttribute('aria-current', 'page');
      view.scrollIntoView({ behavior: 'instant', block: 'start' });
      back.focus({ preventScroll: true });
    } finally { switching = false; }
  }

  async function hideNews(forGallery = false) {
    view.classList.remove('is-visible');
    await fade();
    view.hidden = true;
    active = false;
    poster.classList.remove('news-layout');
    galleryHomeParts.forEach((part) => { part.hidden = false; });
    poster.classList.remove('news-open');
    nav.removeAttribute('aria-current');
    if (!forGallery) {
      poster.scrollIntoView({ behavior: galleryReducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
      poster.focus({ preventScroll: true });
    }
  }

  nav.addEventListener('click', (event) => { event.preventDefault(); void showNews(); });
  back.addEventListener('click', async () => {
    if (!active || switching) return;
    switching = true;
    try { await hideNews(); } finally { switching = false; }
  });
  // Intercept only transitions involving News; ordinary gallery navigation is unchanged.
  galleryNavLink.addEventListener('click', async (event) => {
    if (!active && !switching) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (switching) return;
    switching = true;
    try { await hideNews(true); await showGallery(); } finally { switching = false; }
  }, true);
})();
