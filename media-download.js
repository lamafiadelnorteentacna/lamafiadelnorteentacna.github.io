'use strict';
(() => {
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
  function bindDownload(buttonId, mediaId, viewerId, statusId, kind) {
    const button = document.getElementById(buttonId);
    const media = document.getElementById(mediaId);
    const viewer = document.getElementById(viewerId);
    const status = document.getElementById(statusId);
    if (!button || !media || !viewer || !status) return;
    let controller = null;
    const open = () => kind === 'video' ? viewer.open : !viewer.hidden;
    const source = () => media.currentSrc || media.getAttribute('src') || '';
    new MutationObserver(() => {
      if (!open()) { controller?.abort(); status.textContent = ''; }
    }).observe(viewer, { attributes: true, attributeFilter: ['hidden', 'open'] });
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (controller || !open()) return;
      const src = source(); if (!src) return;
      const label = button.querySelector('span');
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 120000);
      button.disabled = true; label.textContent = 'DESCARGANDO…'; status.textContent = '';
      let objectUrl;
      try {
        // A Blob enables downloading cross-origin media instead of navigating away.
        const downloadUrl = new URL(src, location.href);
        if (['http:', 'https:'].includes(downloadUrl.protocol)) {
          downloadUrl.searchParams.set('_download', Date.now().toString());
        }
        const response = await fetch(downloadUrl.href, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const blob = await response.blob();
        if (!blob.size) throw new Error('Archivo vacío');
        if (!open() || source() !== src) return;
        const extension = extensions[blob.type.split(';')[0].toLowerCase()] || (kind === 'video' ? 'mp4' : 'jpg');
        const caption = document.getElementById(kind === 'video' ? 'gallery-video-caption' : 'gallery-lightbox-caption').textContent;
        const name = (caption || (kind === 'video' ? 'video-galeria' : 'foto-galeria')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 100) || 'galeria';
        objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = objectUrl; link.download = name + '.' + extension;
        document.body.append(link); link.click(); link.remove();
        status.textContent = 'Descarga iniciada.';
      } catch (error) {
        console.error('Error al descargar ' + kind + ':', error);
        if (open()) status.textContent = error.name === 'AbortError' ? 'La descarga se interrumpió. Puedes reintentar.' : 'No se pudo descargar el archivo' + (error.message.startsWith('HTTP ') ? ' (' + error.message + ')' : '') + '. Recarga la página y vuelve a intentar.';
      } finally {
        clearTimeout(timeout); controller = null; button.disabled = false; label.textContent = 'DESCARGAR';
        if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      }
    });
  }
  bindDownload('gallery-photo-download', 'gallery-lightbox-image', 'gallery-lightbox', 'gallery-photo-download-status', 'photo');
  bindDownload('gallery-video-download', 'gallery-video-player', 'gallery-video-dialog', 'gallery-video-download-status', 'video');
})();
